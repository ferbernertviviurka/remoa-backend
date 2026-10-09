/** Opt-in real compressed PDFs + real private crops; no clinical publication or authorization granted. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { fakeToken, fakeVerifier } from "../core/test-helpers";
import type { AdminEnv } from "../core";
import {
  questionImportDetailSchema,
  QUESTION_PDF_PARSER_VERSION,
} from "@remoa/contracts";
const objects = new Map<string, Buffer>();
vi.mock("../../storage/storage", () => ({
  putBytes: vi.fn(async (k: string, b: Buffer) => {
    objects.set(k, b);
  }),
  getBytes: vi.fn(async (k: string) => {
    const b = objects.get(k);
    if (!b) throw Error("missing_object");
    return b;
  }),
  deleteObject: vi.fn(async (k: string) => {
    objects.delete(k);
  }),
  headObject: vi.fn(async (k: string) => (objects.has(k) ? {} : null)),
  presignGet: vi.fn(async (k: string) => "https://example.org/private/" + k),
}));
vi.mock("../../cache", () => ({ invalidate: vi.fn(async () => {}) }));
vi.mock("../../inngest/client", () => ({
  dispatchQuestionImport: vi.fn(async () => false),
}));
const url = process.env.DATABASE_URL;
if (url && !new URL(url).pathname.includes("f33_test"))
  throw Error("Requires isolated f33_test database");
describe.skipIf(!url || process.env.PARSER_PDF_PILOT !== "1")(
  "F33 real AD1 upload and staging only",
  () => {
    const actor = randomUUID();
    let db: typeof import("@remoa/db"), app: Hono<AdminEnv>, source: string;
    beforeAll(async () => {
      db = await import("@remoa/db");
      await db.db
        .$client`INSERT INTO auth.users(id,email) VALUES(${actor},${actor + "@f33.example"})`;
      await db.db
        .$client`UPDATE profiles SET role='admin',name='Synthetic Pilot Admin' WHERE user_id=${actor}`;
      const { questionAdminRoutes } = await import("./routes");
      const { requireAdmin } = await import("../core");
      app = new Hono<AdminEnv>();
      app.use("*", async (c, next) => {
        c.set("log", {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        } as AdminEnv["Variables"]["log"]);
        c.set("requestId", randomUUID());
        await next();
      });
      app.use("*", requireAdmin(fakeVerifier([actor])));
      app.route("/", questionAdminRoutes);
    });
    afterAll(async () => {
      if (!db) return;
      await db.db
        .$client`DELETE FROM question_imports WHERE source_id=${source ?? randomUUID()}`;
      await db.db
        .$client`DELETE FROM exam_papers WHERE source_id=${source ?? randomUUID()}`;
      await db.db
        .$client`DELETE FROM question_documents WHERE user_id=${actor}`;
      await db.db
        .$client`DELETE FROM question_sources WHERE id=${source ?? randomUUID()}`;
      await db.db.$client`DELETE FROM auth.users WHERE id=${actor}`;
      await db.db.$client.end({ timeout: 1 });
      objects.clear();
    });
    it("extracts 120 provenance-linked staging candidates with retification ambiguities and annulments", async () => {
      const reason = "Piloto privado de parser sem publicação";
      const res = await app.request("/sources", {
        method: "POST",
        headers: {
          authorization: "Bearer " + fakeToken(actor),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Fuvest AD1 piloto privado",
          publisher: "Fuvest",
          url: "https://www.fuvest.br/residencia-medica-provas-e-gabarito/",
          rightsStatus: "pending",
          reason,
        }),
      });
      expect(res.status).toBe(200);
      source = (await res.json()).data.source.id;
      const root = fileURLToPath(
        new URL(
          "../../../../../../docs/content/questions/pdfs/",
          import.meta.url,
        ),
      );
      async function upload(filename: string, kind: string) {
        const bytes = await readFile(root + filename),
          form = new FormData();
        form.set(
          "file",
          new File([bytes], filename, { type: "application/pdf" }),
        );
        form.set("sourceId", source);
        form.set("kind", kind);
        form.set("reason", reason);
        const uploaded = await app.request("/documents", {
          method: "POST",
          headers: { authorization: "Bearer " + fakeToken(actor) },
          body: form,
        });
        expect(uploaded.status).toBe(200);
        return (await uploaded.json()).data.document.id as string;
      }
      const documentId = await upload(
          "rm2026-prova-AD1-areasbasicas-acessodireto.pdf",
          "exam",
        ),
        answerKeyDocumentId = await upload(
          "rm2026-gabarito-AD-areasbasicas-acessodireto-retificado.pdf",
          "answer_key",
        );
      const created = await app.request("/imports", {
        method: "POST",
        headers: {
          authorization: "Bearer " + fakeToken(actor),
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          sourceId: source,
          documentId,
          answerKeyDocumentId,
          exam: {
            name: "AD1 privado",
            institution: "USP/Fuvest",
            year: 2025,
            edition: "piloto privado",
            booklet: "AD1",
            durationSec: null,
          },
          ocr: false,
          excludedPages: [39, 40],
          budgetCents: 0,
          parserVersion: QUESTION_PDF_PARSER_VERSION,
          reason,
        }),
      });
      expect(created.status).toBe(200);
      const id = (await created.json()).data.import.id;
      const { runStoredQuestionImport } =
        await import("../../questions/imports/store");
      const result = await runStoredQuestionImport(id);
      expect(result).toMatchObject({ status: "review", candidates: 120 });
      const detailed = await app.request("/imports/" + id, {
        headers: { authorization: "Bearer " + fakeToken(actor) },
      });
      expect(detailed.status).toBe(200);
      const detail = questionImportDetailSchema.parse(
        (await detailed.json()).data,
      );
      expect(detail.candidates).toHaveLength(120);
      expect(
        detail.candidates.every(
          (c) =>
            c.state === "needs_review" &&
            c.questionId === null &&
            c.provenance.length > 0,
        ),
      ).toBe(true);
      expect(
        detail.candidates
          .filter((c) => c.issues.includes("ambiguous_answer_key"))
          .map((c) => Number(c.originalNumber)),
      ).toEqual([109, 110, 114]);
      expect(
        detail.candidates
          .filter((c) => c.payload.annulled)
          .map((c) => Number(c.originalNumber)),
      ).toEqual([54, 120]);
      expect(
        detail.candidates.every((c) =>
          c.provenance.every(
            (p) =>
              p.documentId === documentId &&
              p.bbox?.every((n) => n >= 0 && n <= 1),
          ),
        ),
      ).toBe(true);
      expect(
        detail.candidates.some((c) =>
          c.payload.imageRefs.some(
            (ref) => ref.objectKey && objects.has(ref.objectKey),
          ),
        ),
      ).toBe(true);
      const [published] = await db.db
        .$client`SELECT count(*)::int n FROM question_bank WHERE source_id=${source} AND catalog_status='published'`;
      expect(published!.n).toBe(0);
      const [s] = await db.db
        .$client`SELECT rights_status FROM question_sources WHERE id=${source}`;
      expect(s!.rights_status).toBe("pending");
    }, 120000);
  },
);
