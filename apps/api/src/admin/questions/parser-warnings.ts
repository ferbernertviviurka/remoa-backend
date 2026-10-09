/** CCR135: engineering warnings read privately, outside transactions, with one final outcome audit. */
import { and, eq } from "drizzle-orm";
import {
  ADMIN_LIMITS,
  adminErrors,
  err,
  ok,
  idSchema,
  questionParserWarningsSchema,
  type Result,
  type QuestionParserWarningsData,
} from "@remoa/contracts";
import type { Tx } from "@remoa/db";
import type { Context } from "hono";
import { dbm } from "../../db";
import { accountState, isFresh, send, withAdmin, type AdminEnv } from "../core";
import { parserWarningStorage } from "../../questions/imports/store";
import {
  readWarningArtifact,
  warningPlanHash,
  type OwnedDiagnosticPlan,
} from "../../questions/imports/parser-warnings";
export interface WarningMetadata {
  plan: OwnedDiagnosticPlan;
  source: { id: string; rightsStatus: string; rightsExpiresAt: Date | null };
  document: { id: string; sourceId: string; kind: string; sha256: string };
  keyDocument: {
    id: string;
    sourceId: string;
    kind: string;
    sha256: string;
  } | null;
}
export function validateWarningMetadata(
  m: WarningMetadata | null,
): Result<WarningMetadata> {
  if (
    !m ||
    m.document.kind !== "exam" ||
    m.document.sourceId !== m.source.id ||
    m.document.id !== m.plan.documentId ||
    m.document.sha256 !== m.plan.documentSha256
  )
    return err("not_found", "import not found");
  if (
    m.plan.answerKeyDocumentId &&
    (!m.keyDocument ||
      m.keyDocument.id !== m.plan.answerKeyDocumentId ||
      m.keyDocument.sourceId !== m.source.id ||
      m.keyDocument.kind !== "answer_key" ||
      m.keyDocument.sha256 !== m.plan.answerKeySha256)
  )
    return err("not_found", "import not found");
  if (
    !["pending", "authorized"].includes(m.source.rightsStatus) ||
    (m.source.rightsExpiresAt &&
      m.source.rightsExpiresAt.getTime() <= Date.now())
  )
    return err("conflict", "source_rights_unavailable");
  return ok(m);
}
export async function parserWarningsMetadata(
  id: string,
  tx?: Tx,
): Promise<Result<WarningMetadata>> {
  const {
    db,
    questionImports: i,
    questionDocuments: d,
    examPapers: p,
    questionSourcesCatalog: s,
  } = await dbm();
  const [r] = await (tx ?? db)
    .select({
      plan: {
        importId: i.id,
        parserVersion: i.parserVersion,
        ocrVersion: i.ocrVersion,
        documentId: i.documentId,
        documentSha256: d.sha256,
        answerKeyDocumentId: i.answerKeyDocumentId,
        answerKeyPages: i.answerKeyPages,
        booklet: p.booklet,
        excludedPages: i.excludedPages,
        ocrEnabled: i.ocrEnabled,
        attempt: i.attempts,
        workerId: i.workerId,
        leaseUntil: i.leaseUntil,
        status: i.status,
      },
      source: {
        id: s.id,
        rightsStatus: s.rightsStatus,
        rightsExpiresAt: s.rightsExpiresAt,
      },
      document: {
        id: d.id,
        sourceId: d.sourceId,
        kind: d.kind,
        sha256: d.sha256,
      },
    })
    .from(i)
    .innerJoin(d, eq(i.documentId, d.id))
    .innerJoin(p, eq(i.paperId, p.id))
    .innerJoin(s, eq(i.sourceId, s.id))
    .where(and(eq(i.id, id), eq(p.sourceId, s.id)));
  if (!r) return err("not_found", "import not found");
  const [keyDocument] = r.plan.answerKeyDocumentId
    ? await (tx ?? db)
        .select({
          id: d.id,
          sourceId: d.sourceId,
          kind: d.kind,
          sha256: d.sha256,
        })
        .from(d)
        .where(eq(d.id, r.plan.answerKeyDocumentId))
    : [];
  return validateWarningMetadata({
    ...r,
    plan: { ...r.plan, answerKeySha256: keyDocument?.sha256 ?? null },
    keyDocument: keyDocument ?? null,
  });
}
async function activeAdmin(
  c: Context<AdminEnv>,
): Promise<Result<Record<string, never>>> {
  const a = await accountState(c.get("admin").id);
  if (!a || a.role !== "admin" || a.deletedAt || a.suspendedAt || !a.email)
    return err("not_found", "route not found");
  if (!isFresh(c.get("authAt"), ADMIN_LIMITS.reauthMinutes * 60000))
    return err("forbidden", adminErrors.reauth);
  return ok({});
}
export function warningMetadataUnchanged(
  a: WarningMetadata,
  b: WarningMetadata,
) {
  return (
    a.plan.attempt === b.plan.attempt &&
    warningPlanHash(a.plan) === warningPlanHash(b.plan) &&
    a.source.id === b.source.id
  );
}
const hits = new Map<string, number[]>();
let readers = 0;
export async function withWarningRead<T>(
  actor: string,
  read: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  if (hits.size > 10000)
    for (const [k, v] of hits)
      if (v.every((t) => now - t >= 60000)) hits.delete(k);
  const recent = (hits.get(actor) ?? []).filter((t) => now - t < 60000);
  if (recent.length >= 30 || readers >= 4) throw Error("warning_capacity");
  hits.set(actor, [...recent, now]);
  readers++;
  try {
    return await read();
  } finally {
    readers--;
  }
}
export async function parserWarningsResponse(c: Context<AdminEnv>) {
  const id = c.req.param("id") ?? "";
  if (!idSchema.safeParse(id).success) {
    const response = send(err("not_found", "import not found"));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const actor = await activeAdmin(c),
    initial = actor.ok ? await parserWarningsMetadata(id) : actor;
  let prepared: Result<QuestionParserWarningsData> = err(
    "internal",
    "parser_warnings_unavailable",
  );
  if (initial.ok)
    try {
      prepared = ok(
        await withWarningRead(c.get("admin").id, () =>
          readWarningArtifact(
            initial.data.plan,
            initial.data.plan.attempt,
            initial.data.plan.status,
            parserWarningStorage(),
          ),
        ),
      );
    } catch (e) {
      prepared =
        (e as Error)?.message === "warning_capacity"
          ? err("rate_limited", "parser_warnings_capacity")
          : err("internal", "parser_warnings_unavailable");
    }
  const result = await withAdmin<QuestionParserWarningsData>(
    c,
    "question.import_view",
    {
      reason: "Consultar avisos estruturais privados da importação",
      target: { type: "question_import", id },
    },
    async (tx, audit) => {
      if (!initial.ok) return initial;
      const actorNow = await activeAdmin(c);
      if (!actorNow.ok) return actorNow;
      const current = await parserWarningsMetadata(id, tx);
      if (!current.ok) return current;
      if (!warningMetadataUnchanged(initial.data, current.data))
        return err("conflict", "parser_warnings_attempt_changed");
      if (!prepared.ok) return prepared;
      // Absence classification may change from pending to final while the object is read.
      const dto =
        prepared.data.availability === "not_available"
          ? {
              ...prepared.data,
              reason: [
                "queued",
                "validating",
                "extracting",
                "ocr",
                "segmenting",
                "matching",
              ].includes(current.data.plan.status)
                ? ("pending" as const)
                : ("not_recorded" as const),
            }
          : prepared.data;
      audit.after({
        attempt: dto.attempt,
        planHash: dto.planHash,
        availability: dto.availability,
        phase: dto.phase,
        complete: dto.complete,
        total: dto.total,
        unknownCount: dto.unknownCount,
      });
      return ok(dto);
    },
  );
  if (!result.ok) {
    if (result.error.code === "internal")
      return Response.json(
        { error: result.error },
        {
          status: 503,
          headers: { "Retry-After": "5", "Cache-Control": "private, no-store" },
        },
      );
    const response = send(result);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  return Response.json(
    { ok: true, data: questionParserWarningsSchema.parse(result.data) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
