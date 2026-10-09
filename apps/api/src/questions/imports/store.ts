import {
  persistWarningArtifact,
  type OwnedDiagnosticPlan,
  type WarningStorage,
} from "./parser-warnings";
import { answerKeyCacheScope } from "./answer-key-scope";
import { questionFeatures } from "../runtime/config";
import { createLogger } from "@remoa/log";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  questionImportStatuses,
  QUESTION_PDF_OCR_VERSION,
} from "@remoa/contracts";
import { dbm } from "../../db";
import {
  getBytes,
  putBytes,
  headObject,
  deleteObject,
} from "../../storage/storage";
import {
  fingerprint,
  normalizedProvenance,
  PARSER_VERSION,
  sha256,
} from "./domain";
import type { ImportWorkerStore, ImportJob } from "./worker";
import type { PdfLayoutPage, QuestionCandidate } from "../pdf";
const lease = () => new Date(Date.now() + 5 * 60_000);
async function cacheVersion(id: string) {
  const { db, questionImports: t } = await dbm();
  const [r] = await db
    .select({
      excludedPages: t.excludedPages,
      ocrEnabled: t.ocrEnabled,
      answerKeyPages: t.answerKeyPages,
    })
    .from(t)
    .where(eq(t.id, id));
  if (!r) throw Error("import_not_found");
  return `${PARSER_VERSION}:${sha256(JSON.stringify({ excludedPages: r.excludedPages, ocrEnabled: r.ocrEnabled, ocrVersion: QUESTION_PDF_OCR_VERSION, extractionPolicy: "font-metrics-ocr-v1", ...answerKeyCacheScope(r.answerKeyPages) })).slice(0, 12)}`;
}
/** One shared ten-second deadline covers all fixed-phase IO, not ten seconds per request. */
export function parserWarningStorage(
  signal = AbortSignal.timeout(10000),
): WarningStorage {
  return {
    head: (key) => headObject(key, signal),
    read: (key, maxBytes) => getBytes(key, { maxBytes, signal }),
    put: async (key, bytes) => {
      await putBytes(key, Buffer.from(bytes), "application/json", signal);
    },
    remove: async (key) => {
      await deleteObject(key, signal);
    },
  };
}

export async function storedDiagnosticPlan(
  id: string,
): Promise<OwnedDiagnosticPlan> {
  const {
    db,
    questionImports: i,
    questionDocuments: d,
    examPapers: p,
  } = await dbm();
  const [r] = await db
    .select({
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
    })
    .from(i)
    .innerJoin(d, eq(i.documentId, d.id))
    .innerJoin(p, eq(i.paperId, p.id))
    .where(eq(i.id, id));
  if (!r) throw Error("import_not_found");
  const [key] = r.answerKeyDocumentId
    ? await db
        .select({ sha256: d.sha256 })
        .from(d)
        .where(eq(d.id, r.answerKeyDocumentId))
    : [];
  if (r.answerKeyDocumentId && !key) throw Error("warning_plan_invalid");
  return { ...r, answerKeySha256: key?.sha256 ?? null };
}
export function importWorkerStore(): ImportWorkerStore {
  let token = "";
  return {
    async load(id) {
      const {
        db,
        questionImports: i,
        questionDocuments: d,
        examPapers: p,
      } = await dbm();
      const [row] = await db
        .select({
          id: i.id,
          parserVersion: i.parserVersion,
          ocrVersion: i.ocrVersion,
          documentId: i.documentId,
          answerKeyDocumentId: i.answerKeyDocumentId,
          answerKeyPages: i.answerKeyPages,
          objectKey: d.objectKey,
          sha256: d.sha256,
          booklet: p.booklet,
          ocrEnabled: i.ocrEnabled,
          excludedPages: i.excludedPages,
          budgetCents: i.budgetCents,
          costCents: i.costCents,
        })
        .from(i)
        .innerJoin(d, eq(i.documentId, d.id))
        .innerJoin(p, eq(i.paperId, p.id))
        .where(eq(i.id, id));
      if (!row) return null;
      const [key] = row.answerKeyDocumentId
        ? await db
            .select({
              objectKey: d.objectKey,
              sha256: d.sha256,
              pages: d.pages,
            })
            .from(d)
            .where(eq(d.id, row.answerKeyDocumentId))
        : [];
      return {
        ...row,
        answerKeyObjectKey: key?.objectKey ?? null,
        answerKeySha256: key?.sha256 ?? null,
        answerKeyDocumentPages: key?.pages ?? null,
      } as ImportJob;
    },
    async claim(id, worker) {
      const { db, questionImports: t } = await dbm();
      const [r] = await db
        .update(t)
        .set({
          workerId: worker,
          leaseUntil: lease(),
          attempts: sql`${t.attempts}+1`,
        })
        .where(
          and(
            eq(t.id, id),
            inArray(t.status, [
              "queued",
              "validating",
              "extracting",
              "ocr",
              "segmenting",
              "matching",
            ]),
            or(isNull(t.leaseUntil), lt(t.leaseUntil, new Date())),
          ),
        )
        .returning({ id: t.id });
      if (r) token = worker;
      return Boolean(r);
    },
    async cancelled(id) {
      const { db, questionImports: t } = await dbm();
      const [r] = await db
        .select({ status: t.status, workerId: t.workerId })
        .from(t)
        .where(eq(t.id, id));
      if (r && r.status !== "cancelled" && r.workerId !== token)
        throw Error("lease_lost");
      return !r || r.status === "cancelled";
    },
    async state(id, status, total, completed) {
      if (
        !questionImportStatuses.includes(
          status as (typeof questionImportStatuses)[number],
        )
      )
        throw Error("unknown_import_state");
      const { db, questionImports: t } = await dbm();
      await db
        .update(t)
        .set({
          status: status as (typeof questionImportStatuses)[number],
          leaseUntil: lease(),
          ...(total === undefined ? {} : { totalPages: total }),
          ...(completed === undefined ? {} : { completedPages: completed }),
        })
        .where(
          and(
            eq(t.id, id),
            sql`${t.status}<>'cancelled'`,
            eq(t.workerId, token),
          ),
        );
    },
    async chunk(id, documentId, first, last) {
      const { db, questionImportChunks: t } = await dbm();
      const version = await cacheVersion(id);
      const [r] = await db
        .select({ key: t.payloadObjectKey })
        .from(t)
        .where(
          and(
            eq(t.documentId, documentId),
            eq(t.parserVersion, version),
            eq(t.firstPage, first),
            eq(t.lastPage, last),
            eq(t.status, "completed"),
          ),
        );
      if (!r?.key) return null;
      return JSON.parse((await getBytes(r.key)).toString()) as PdfLayoutPage[];
    },
    async saveChunk(id, documentId, first, last, pages) {
      const { db, questionImportChunks: t, questionImports: i } = await dbm();
      const parserVersion = await cacheVersion(id);
      const key = `questions/imports/${id}/chunks/${documentId}-${first}-${last}-${sha256(parserVersion).slice(0, 12)}.json`;
      await putBytes(
        key,
        Buffer.from(JSON.stringify(pages)),
        "application/json",
      );
      await db.transaction(async (tx) => {
        const [job] = await tx
          .select({ status: i.status, workerId: i.workerId })
          .from(i)
          .where(eq(i.id, id))
          .for("update");
        if (!job || job.status === "cancelled") throw Error("cancelled");
        if (job.workerId !== token) throw Error("lease_lost");
        await tx
          .insert(t)
          .values({
            importId: id,
            documentId,
            parserVersion,
            firstPage: first,
            lastPage: last,
            status: "completed",
            payloadObjectKey: key,
            attempts: 1,
          })
          .onConflictDoUpdate({
            target: [t.documentId, t.parserVersion, t.firstPage, t.lastPage],
            set: { status: "completed", payloadObjectKey: key },
          });
      });
    },
    async reserveOcr(id, documentId, page, cents) {
      const { db, questionImports: i, questionImportChunks: c } = await dbm();
      const version = await cacheVersion(id);
      return db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(i)
          .where(eq(i.id, id))
          .for("update");
        if (!job || job.status === "cancelled" || job.workerId !== token)
          return false;
        const [existing] = await tx
          .select({ id: c.id })
          .from(c)
          .where(
            and(
              eq(c.documentId, documentId),
              eq(c.parserVersion, version),
              eq(c.firstPage, page),
              eq(c.lastPage, page),
            ),
          );
        if (existing) return true;
        if (job.costCents + cents > job.budgetCents) return false;
        await tx.insert(c).values({
          importId: id,
          documentId,
          parserVersion: version,
          firstPage: page,
          lastPage: page,
          status: "ocr_reserved",
          attempts: 1,
        });
        await tx
          .update(i)
          .set({ costCents: job.costCents + cents })
          .where(eq(i.id, id));
        return true;
      });
    },
    async candidates(id, items, pages, contexts = []) {
      const {
        db,
        questionImports: i,
        questionImportCandidates: c,
        questionBank: q,
        questionImportContexts: contextTable,
        examPapers: paperTable,
      } = await dbm();
      await db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(i)
          .where(eq(i.id, id))
          .for("update");
        if (!job || job.status === "cancelled") throw Error("cancelled");
        if (job.workerId !== token) throw Error("lease_lost");
        if (job.paperId)
          await tx
            .select({ id: paperTable.id })
            .from(paperTable)
            .where(eq(paperTable.id, job.paperId))
            .for("update");
        let changed = false;
        for (const context of contexts) {
          if (
            !context.evidenceObjectKey?.startsWith(
              `questions/imports/${id}/contexts/`,
            )
          )
            throw Error("missing_context_evidence");
          const provenance = normalizedProvenance(
            { provenance: context.provenance },
            pages,
            job.documentId,
          );
          const imageRefs = (context.privateImageRefs ?? []).map((ref) => ({
            ...ref,
            provenance: normalizedProvenance(
              { provenance: [ref] },
              pages,
              job.documentId,
            )[0],
          }));
          const inserted = await tx
            .insert(contextTable)
            .values({
              importId: id,
              documentId: job.documentId,
              evidenceHash: context.evidenceHash,
              evidenceObjectKey: context.evidenceObjectKey,
              originalText:
                context.originalText.length <= 100000
                  ? context.originalText
                  : null,
              declaredNumbers: context.declaredNumbers,
              provenance,
              imageRefs,
              status: "unresolved",
            })
            .onConflictDoNothing()
            .returning({ id: contextTable.id });
          changed ||= inserted.length > 0;
        }
        for (const [index, item] of items.entries()) {
          const hash = fingerprint(item.stem, item.alternatives);
          const [duplicate] = await tx
            .select({ id: q.id })
            .from(q)
            .where(
              and(
                eq(q.fingerprint, hash),
                eq(q.visibility, "public"),
                isNull(q.userId),
                sql`not exists(select 1 from question_bank n where n.supersedes_id=${q.id})`,
              ),
            )
            .limit(1);
          const provenance = normalizedProvenance(item, pages, job.documentId);
          const privateImageRefs = (
            (
              item as QuestionCandidate & {
                privateImageRefs?: QuestionCandidate["provenance"];
              }
            ).privateImageRefs ?? []
          ).map((ref) => ({
            ...ref,
            provenance: normalizedProvenance(
              { ...item, provenance: [ref] },
              pages,
              job.documentId,
            )[0],
          }));
          const inserted = await tx
            .insert(c)
            .values({
              importId: id,
              ordinal: index + 1,
              originalNumber: String(item.originalNumber),
              payload: {
                ...item,
                ownStem: item.ownStem ?? item.stem,
                ownProvenance: provenance,
                ownImageRefs: privateImageRefs,
                contextBindings: [],
                imageRefs: privateImageRefs,
                imagesConfirmed: false,
                keyFinal: false,
                integrityConfirmed: false,
              },
              confidence: item.confidence,
              provenance,
              issues: item.issues,
              fingerprint: hash,
              duplicateOf: duplicate?.id ?? null,
              state: "needs_review",
            })
            .onConflictDoNothing()
            .returning({ id: c.id });
          changed ||= inserted.length > 0;
        }
        if (changed)
          await tx
            .update(i)
            .set({ revision: sql`${i.revision}+1` })
            .where(eq(i.id, id));
      });
    },
    async saveParserWarnings(id, snapshot) {
      const current = await storedDiagnosticPlan(id);
      await persistWarningArtifact(
        current,
        token,
        snapshot,
        () => storedDiagnosticPlan(id),
        parserWarningStorage(),
        () =>
          createLogger({ requestId: "question-import" }).warn(
            "question diagnostic orphan cleanup pending",
            {
              importId: id,
              attempt: current.attempt,
              phase: snapshot.phase,
              code: "warning_orphan_cleanup_pending",
            },
          ),
      );
    },
    async failed(id, code) {
      const { db, questionImports: t } = await dbm();
      await db
        .update(t)
        .set({
          status:
            code === "cancelled"
              ? "cancelled"
              : code === "budget_paused"
                ? "budget_paused"
                : "failed",
          errorCode: code.slice(0, 200),
          workerId: null,
          leaseUntil: null,
        })
        .where(
          and(
            eq(t.id, id),
            sql`${t.status}<>'cancelled'`,
            eq(t.workerId, token),
          ),
        );
    },
    async completed(id) {
      const { db, questionImports: t } = await dbm();
      await db
        .update(t)
        .set({
          status: "review",
          errorCode: null,
          workerId: null,
          leaseUntil: null,
        })
        .where(
          and(
            eq(t.id, id),
            sql`${t.status}<>'cancelled'`,
            eq(t.workerId, token),
          ),
        );
    },
  };
}
export async function runStoredQuestionImport(id: string) {
  if (!questionFeatures().import) return { status: "disabled" };
  const started = Date.now();
  const { runQuestionImport } = await import("./worker");
  const result = await runQuestionImport(id, {
    store: importWorkerStore(),
    read: async (key) => new Uint8Array(await getBytes(key)),
    exists: async (key) => Boolean(await headObject(key)),
    put: async (key, bytes, mime) => {
      await putBytes(key, Buffer.from(bytes), mime);
    },
  });
  createLogger({ requestId: "question-import" }).info(
    "question import attempt complete",
    {
      importId: id,
      durationMs: Date.now() - started,
      status: result.status,
      candidates: result.candidates ?? 0,
      errorCode: result.errorCode,
    },
  );
  return result;
}
