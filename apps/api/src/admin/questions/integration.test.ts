/** End-to-end ingestion uses a dedicated synthetic database and in-memory private object storage. */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
vi.mock("@remoa/ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPdfLayout: vi.fn(async (bytes: Uint8Array) => ({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        items: (new TextDecoder().decode(bytes).includes("answerkey")
          ? ["PROVA AD1", "1 A texto auxiliar de chave"]
          : [
              "Questão 1",
              "Enunciado sintético sem conteúdo clínico completo",
              "(A) Primeira resposta sintética",
              "(B) Segunda resposta sintética",
            ]
        ).map((text, i) => ({
          text,
          x: 10,
          y: 50 + i * 20,
          width: 250,
          height: 12,
        })),
      },
    ],
  })),
}));
const url = process.env.DATABASE_URL;
if (url && !new URL(url).pathname.includes("f33_test"))
  throw Error("Requires isolated f33_test database");
describe.skipIf(!url)("F33 admin upload to medical publication", () => {
  const admin = randomUUID(),
    reviewer = randomUUID(),
    reviewer2 = randomUUID(),
    student = randomUUID(),
    area = randomUUID(),
    topic = randomUUID(),
    wrongArea = randomUUID();
  let db: typeof import("@remoa/db"),
    app: Hono<AdminEnv>,
    source: string,
    examDoc: string,
    keyDoc: string,
    importId: string,
    candidateId: string,
    questionId: string;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    user = admin,
    key?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; data: any; error: any }> {
    const r = await app.request(path, {
      method,
      headers: {
        authorization: "Bearer " + fakeToken(user),
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json();
    return { status: r.status, data: json.data, error: json.error };
  }
  beforeAll(async () => {
    vi.stubEnv("QUESTIONS_RATE_IMPORT", "100");
    vi.stubEnv("QUESTIONS_RATE_UPLOAD", "100");
    db = await import("@remoa/db");
    for (const id of [admin, reviewer, reviewer2, student])
      await db.db
        .$client`INSERT INTO auth.users(id,email) VALUES(${id},${id + "@f33.example"})`;
    await db.db
      .$client`UPDATE profiles SET role='admin',name='Synthetic Admin' WHERE user_id=${admin}`;
    await db.db
      .$client`UPDATE profiles SET role='reviewer',name='Synthetic Reviewer',crm='12345-SP' WHERE user_id=${reviewer}`;
    await db.db
      .$client`UPDATE profiles SET role='reviewer',name='Synthetic Reviewer Two',crm='54321-SP' WHERE user_id=${reviewer2}`;
    await db.db
      .$client`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','Synthetic CM'),(${wrongArea},${wrongArea},'area','GO','Synthetic GO')`;
    await db.db
      .$client`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','Synthetic topic',${area})`;
    const { questionAdminRoutes } = await import("./routes");
    const { requireAdmin } = await import("../core");
    const { questionEditorialRoutes } =
      await import("../../routes/question-editorial");
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
    app.use(
      "/admin/*",
      requireAdmin(fakeVerifier([admin, reviewer, reviewer2, student])),
    );
    app.route("/admin", questionAdminRoutes);
    app.use("/editorial/*", async (c, next) => {
      const id = await fakeVerifier([admin, reviewer, reviewer2, student])(
        c.req.header("authorization")!.replace("Bearer ", ""),
      );
      if (typeof id !== "string") return c.json({ error: "unauthorized" }, 401);
      c.set("userId", id);
      c.set("sessionId", null);
      await next();
    });
    app.route("/editorial", questionEditorialRoutes);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!db) return;
    await db.db
      .$client`DELETE FROM question_imports WHERE source_id=${source ?? randomUUID()}`;
    await db.db
      .$client`DELETE FROM exam_papers WHERE source_id=${source ?? randomUUID()}`;
    await db.db
      .$client`DELETE FROM question_bank WHERE source_id=${source ?? randomUUID()}`;
    await db.db.$client`DELETE FROM question_documents WHERE user_id=${admin}`;
    await db.db
      .$client`DELETE FROM question_sources WHERE id=${source ?? randomUUID()}`;
    await db.db.$client`DELETE FROM enamed_taxonomy WHERE id=${topic}`;
    await db.db
      .$client`DELETE FROM enamed_taxonomy WHERE id IN (${area},${wrongArea})`;
    await db.db
      .$client`DELETE FROM auth.users WHERE id IN (${admin},${reviewer},${reviewer2},${student})`;
    await db.db.$client.end({ timeout: 1 });
  });
  const reason = "Conferência sintética de integração";
  it("denies non-admin and missing reasons with exactly one operation audit", async () => {
    expect(
      (await request("/admin/sources", "GET", undefined, student)).status,
    ).toBe(404);
    expect(
      (await request("/admin/sources", "POST", { name: "x" })).status,
    ).toBe(422);
    const rows = await db.db
      .$client`SELECT count(*)::int n FROM admin_audit_log WHERE actor_id=${admin} AND action='question.source_update' AND result='denied'`;
    expect(rows[0]!.n).toBe(1);
  });
  it("uploads private PDF documents, deduplicates bytes, and creates durable import/outbox atomically", async () => {
    const created = await request("/admin/sources", "POST", {
      name: "Synthetic source",
      publisher: "Synthetic publisher",
      url: "https://example.org",
      rightsStatus: "pending",
      rightsEvidence: null,
      rightsScope: null,
      reason,
    });
    expect(created.status).toBe(200);
    source = created.data.source.id;
    async function upload(kind: string, payload: string) {
      const form = new FormData();
      form.set(
        "file",
        new File([payload], "synthetic.pdf", { type: "application/pdf" }),
      );
      form.set("sourceId", source);
      form.set("kind", kind);
      form.set("reason", reason);
      const r = await app.request("/admin/documents", {
        method: "POST",
        headers: { authorization: "Bearer " + fakeToken(admin) },
        body: form,
      });
      expect(r.status).toBe(200);
      return (await r.json()).data.document.id as string;
    }
    examDoc = await upload("exam", "%PDF-1.7 synthetic exam");
    expect(await upload("exam", "%PDF-1.7 synthetic exam")).toBe(examDoc);
    keyDoc = await upload("answer_key", "%PDF-1.7 answerkey");
    expect(objects.size).toBe(2);
    const input = {
      sourceId: source,
      documentId: examDoc,
      answerKeyDocumentId: keyDoc,
      exam: {
        name: "Synthetic exam",
        institution: "Synthetic institution",
        year: 2026,
        edition: "test",
        booklet: "AD1",
        durationSec: null,
      },
      ocr: false,
      excludedPages: [],
      budgetCents: 0,
      parserVersion: QUESTION_PDF_PARSER_VERSION,
      reason,
    };
    const key = randomUUID();
    const createdImport = await request(
      "/admin/imports",
      "POST",
      input,
      admin,
      key,
    );
    expect(createdImport.status).toBe(200);
    importId = createdImport.data.import.id;
    expect(
      (await request("/admin/imports", "POST", input, admin, key)).data.import
        .id,
    ).toBe(importId);
    const rows = await db.db
      .$client`SELECT count(*)::int n FROM question_outbox WHERE import_id=${importId}`;
    expect(rows[0]!.n).toBe(1);
    const { runStoredQuestionImport } =
      await import("../../questions/imports/store");
    expect((await runStoredQuestionImport(importId)).status).toBe("review");
    const detail = await request("/admin/imports/" + importId);
    const typed = questionImportDetailSchema.parse(detail.data);
    expect(typed.candidates).toHaveLength(1);
    candidateId = typed.candidates[0]!.id;
    expect(typed.candidates[0]!.state).toBe("needs_review");
    expect(typed.candidates[0]!.issues).toContain("figure_geometry_unknown");
  });
  it("requires visual confirmation and correct area ancestry before accepting staging candidate", async () => {
    const candidate = (await request("/admin/imports/" + importId)).data
      .candidates[0];
    const input = {
      stem: candidate.payload.stem,
      alternatives: candidate.payload.alternatives,
      correctKey: "A",
      explanation: "Comentário sintético revisado",
      areaId: area,
      topicId: topic,
      annulled: false,
      keyFinal: true,
      integrityConfirmed: true,
      imagesConfirmed: false,
      state: "accepted",
      duplicateOf: null,
      revision: 0,
      reason,
    };
    const path = "/admin/imports/" + importId + "/candidates/" + candidateId;
    expect((await request(path, "PATCH", input)).status).toBe(422);
    expect(
      (
        await request(path, "PATCH", {
          ...input,
          imagesConfirmed: true,
          areaId: wrongArea,
        })
      ).status,
    ).toBe(422);
    const accepted = await request(path, "PATCH", {
      ...input,
      imagesConfirmed: true,
    });
    expect(accepted.status).toBe(200);
    questionId = accepted.data.questionId;
    const rows = await db.db
      .$client`SELECT catalog_status,status,user_id FROM question_bank WHERE id=${questionId}`;
    expect(rows[0]).toMatchObject({
      catalog_status: "in_review",
      status: "draft",
      user_id: null,
    });
    expect(
      (await request(path, "PATCH", { ...input, imagesConfirmed: true }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(path, "PATCH", {
          ...input,
          imagesConfirmed: true,
          correctKey: "B",
          revision: 1,
        })
      ).status,
    ).toBe(200);
    const [occurrence] = await db.db
      .$client`SELECT original_keys FROM exam_question_occurrences WHERE question_id=${questionId}`;
    expect(occurrence!.original_keys.correctKey).toBe("B");
  });
  it("only physician reviewer may decide; rights and latest review block publishing", async () => {
    const detail = (await request("/editorial/" + questionId)).data;
    const review = {
      decision: "approved",
      contentHash: detail.question.contentHash,
      referenceDate: "2026-10-08",
      reason,
    };
    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          review,
          admin,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          review,
          student,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          review,
          reviewer,
        )
      ).status,
    ).toBe(200);
    const publish = {
      expectedContentHash: detail.question.contentHash,
      revision: 1,
      reason,
    };
    expect(
      (await request("/admin/" + questionId + "/publish", "POST", publish))
        .status,
    ).toBe(409);
    const sourceRow = (await request("/admin/sources")).data.items.find(
      (s: { id: string }) => s.id === source,
    );
    const fields = {
      name: sourceRow.name,
      publisher: sourceRow.publisher,
      url: sourceRow.url,
      rightsScope: sourceRow.rightsScope,
      rightsExpiresAt: sourceRow.rightsExpiresAt,
    };
    expect(
      (
        await request("/admin/sources/" + source, "PATCH", {
          ...fields,
          rightsStatus: "authorized",
          rightsEvidence: "Synthetic permission only",
          reason,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request("/admin/" + questionId + "/publish", "POST", publish))
        .status,
    ).toBe(200);
    const firstSignature = (await request("/editorial/" + questionId)).data
      .question;
    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          review,
          reviewer2,
        )
      ).status,
    ).toBe(200);
    const afterSecond = (await request("/editorial/" + questionId)).data
      .question;
    expect(afterSecond).toMatchObject({
      catalogStatus: "published",
      reviewerName: firstSignature.reviewerName,
      reviewerCrm: firstSignature.reviewerCrm,
      referenceDate: firstSignature.referenceDate,
      reviewedHash: firstSignature.reviewedHash,
    });
    const frozen = {
      stem: detail.question.stem,
      alternatives: detail.question.alternatives,
      correctKey: detail.question.correctKey,
      explanation: detail.question.explanation,
      areaId: area,
      topicId: topic,
      annulled: false,
      keyFinal: true,
      integrityConfirmed: true,
      imagesConfirmed: true,
      state: "rejected",
      duplicateOf: null,
      revision: 2,
      reason,
    };
    expect(
      (
        await request(
          "/admin/imports/" + importId + "/candidates/" + candidateId,
          "PATCH",
          frozen,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          "/admin/imports/" + importId + "/candidates/" + candidateId,
          "PATCH",
          { ...frozen, state: "duplicate", duplicateOf: questionId },
        )
      ).status,
    ).toBe(409);

    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          { ...review, decision: "rejected" },
          reviewer,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request("/admin/" + questionId + "/publish", "POST", publish))
        .status,
    ).toBe(409);
    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          review,
          reviewer2,
        )
      ).status,
    ).toBe(200);
    const reapproved = (await request("/editorial/" + questionId)).data;
    expect(reapproved.question).toMatchObject({
      catalogStatus: "withdrawn",
      reviewerName: firstSignature.reviewerName,
      reviewerCrm: firstSignature.reviewerCrm,
      referenceDate: firstSignature.referenceDate,
      reviewedHash: firstSignature.reviewedHash,
    });
    expect(reapproved.latestReview).toMatchObject({
      decision: "approved",
      reviewerName: "Synthetic Reviewer Two",
    });
    const differentSignerPublish = await request(
      "/admin/" + questionId + "/publish",
      "POST",
      publish,
    );
    expect(differentSignerPublish.status).toBe(409);
    expect(differentSignerPublish.error.message).toBe(
      "medical_signature_changed_create_version",
    );
    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          { ...review, contentHash: "0".repeat(64) },
          reviewer2,
        )
      ).status,
    ).toBe(409);
  });
  it("recovers a delivered job after a database-persisted OCR page and expired lease in a new worker", async () => {
    const input = {
      sourceId: source,
      documentId: examDoc,
      answerKeyDocumentId: keyDoc,
      exam: {
        name: "Synthetic recovery",
        institution: "Synthetic institution",
        year: 2026,
        edition: "recovery",
        booklet: "AD1",
        durationSec: null,
      },
      ocr: true,
      excludedPages: [],
      budgetCents: 100,
      parserVersion: QUESTION_PDF_PARSER_VERSION,
      reason,
    };
    const created = await request(
      "/admin/imports",
      "POST",
      input,
      admin,
      randomUUID(),
    );
    expect(created.status).toBe(200);
    const id = created.data.import.id;
    const { importWorkerStore, runStoredQuestionImport } =
      await import("../../questions/imports/store");
    const first = importWorkerStore();
    expect(await first.claim(id, "crashed-process")).toBe(true);
    expect(await importWorkerStore().claim(id, "competing-process")).toBe(
      false,
    );
    await first.state(id, "ocr");
    expect(await first.reserveOcr(id, examDoc, 1, 10)).toBe(true);
    expect(await first.reserveOcr(id, examDoc, 1, 10)).toBe(true);
    const { readPdfLayout } = await import("@remoa/ai");
    const raw = await readPdfLayout(
      new TextEncoder().encode("%PDF-1.7 synthetic exam"),
    );
    await first.saveChunk(id, examDoc, 1, 1, raw.pages);
    await db.db
      .$client`UPDATE question_outbox SET delivered_at=now() WHERE import_id=${id}`;
    expect(
      (await request("/admin/imports/" + id + "/retry", "POST", { reason }))
        .status,
    ).toBe(409);
    await db.db
      .$client`UPDATE question_imports SET lease_until=now()-interval '1 second' WHERE id=${id}`;
    expect(
      (await request("/admin/imports/" + id + "/retry", "POST", { reason }))
        .status,
    ).toBe(200);
    expect((await runStoredQuestionImport(id)).status).toBe("review");
    const [row] = await db.db
      .$client`SELECT cost_cents,status FROM question_imports WHERE id=${id}`;
    expect(row).toMatchObject({ cost_cents: 10, status: "review" });
    const [chunks] = await db.db
      .$client`SELECT count(*)::int n FROM question_import_chunks WHERE import_id=${id} AND status='completed'`;
    expect(chunks!.n).toBe(2);
  });
  it("audited cancellation prevents queued job from taking a lease or staging candidates", async () => {
    const input = {
      sourceId: source,
      documentId: examDoc,
      answerKeyDocumentId: null,
      exam: {
        name: "Synthetic cancel",
        institution: "Synthetic",
        year: 2026,
        edition: "cancel",
        booklet: "AD1",
        durationSec: null,
      },
      ocr: false,
      excludedPages: [],
      budgetCents: 0,
      parserVersion: QUESTION_PDF_PARSER_VERSION,
      reason,
    };
    const created = await request(
      "/admin/imports",
      "POST",
      input,
      admin,
      randomUUID(),
    );
    expect(created.status).toBe(200);
    const id = created.data.import.id;
    expect(
      (await request("/admin/imports/" + id + "/cancel", "POST", { reason }))
        .status,
    ).toBe(200);
    const { runStoredQuestionImport } =
      await import("../../questions/imports/store");
    expect((await runStoredQuestionImport(id)).status).toBe("not_claimed");
    const [count] = await db.db
      .$client`SELECT count(*)::int n FROM question_import_candidates WHERE import_id=${id}`;
    expect(count!.n).toBe(0);
  });
  it("UUID and real calendar validation return domain errors instead of database failures", async () => {
    expect(
      (await request("/admin/documents/" + "-".repeat(36) + "/preview")).status,
    ).toBe(404);
    const detail = (await request("/editorial/" + questionId)).data;
    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          {
            decision: "approved",
            contentHash: detail.question.contentHash,
            referenceDate: "2026-02-30",
            reason,
          },
          reviewer,
        )
      ).status,
    ).toBe(422);
  });
  it("rectification clones immutable published content and material edits invalidate medical review", async () => {
    let detail = (await request("/editorial/" + questionId)).data;
    expect(
      (
        await request(
          "/editorial/" + questionId + "/review",
          "POST",
          {
            decision: "approved",
            contentHash: detail.question.contentHash,
            referenceDate: "2026-10-08",
            reason,
          },
          reviewer,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/admin/" + questionId + "/publish", "POST", {
          expectedContentHash: detail.question.contentHash,
          revision: 1,
          reason,
        })
      ).status,
    ).toBe(200);
    detail = (await request("/editorial/" + questionId)).data;
    const input = {
      expectedContentHash: detail.question.contentHash,
      revision: 1,
      reason,
    };
    const capacityBefore = (await request("/admin/metrics")).data;
    const clone = await request(
      "/admin/" + questionId + "/rectify",
      "POST",
      input,
    );
    expect(clone.status).toBe(200);
    expect(clone.data.version).toBe(2);
    const capacityAfter = (await request("/admin/metrics")).data;
    expect(capacityAfter.publicCanonical).toBe(capacityBefore.publicCanonical);
    expect(
      capacityAfter.publicByOrigin.reduce(
        (n: number, row: { count: number }) => n + row.count,
        0,
      ),
    ).toBe(capacityAfter.publicCanonical);
    expect(
      capacityAfter.coverageByArea.find(
        (row: { areaId: string }) => row.areaId === area,
      )?.count,
    ).toBe(1);
    expect(
      capacityAfter.coverageByTopic.find(
        (row: { topicId: string }) => row.topicId === topic,
      )?.count,
    ).toBe(1);

    const [stillActive] = await db.db
      .$client`SELECT availability,catalog_status FROM question_bank WHERE id=${questionId}`;
    expect(stillActive).toMatchObject({
      availability: "active",
      catalog_status: "published",
    });

    const edit = {
      stem: "Novo enunciado sintético corrigido",
      alternatives: detail.question.alternatives,
      correctKey: "A",
      explanation: "Novo comentário sintético",
      areaId: area,
      topicId: topic,
      annulled: false,
      keyFinal: true,
      integrityConfirmed: true,
      imagesConfirmed: true,
      state: "accepted",
      duplicateOf: null,
      revision: 2,
      reason,
    };
    const updated = await request("/admin/" + clone.data.id, "PATCH", {
      expectedContentHash: detail.question.contentHash,
      content: edit,
    });
    expect(updated.status).toBe(200);
    expect(updated.data.question.contentHash).not.toBe(
      detail.question.contentHash,
    );
    const rows = await db.db
      .$client`SELECT stem,reviewed_hash,catalog_status FROM question_bank WHERE id=${clone.data.id}`;
    expect(rows[0]).toMatchObject({
      stem: edit.stem,
      reviewed_hash: null,
      catalog_status: "in_review",
    });
    const [old] = await db.db
      .$client`SELECT stem FROM question_bank WHERE id=${questionId}`;
    expect(old!.stem).toBe(detail.question.stem);
    expect(
      (
        await request("/admin/" + clone.data.id + "/publish", "POST", {
          expectedContentHash: updated.data.question.contentHash,
          revision: 2,
          reason,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          "/editorial/" + clone.data.id + "/review",
          "POST",
          {
            decision: "approved",
            contentHash: updated.data.question.contentHash,
            referenceDate: "2026-10-08",
            reason,
          },
          reviewer,
        )
      ).status,
    ).toBe(200);
    const published = await request(
      "/admin/" + clone.data.id + "/publish",
      "POST",
      {
        expectedContentHash: updated.data.question.contentHash,
        revision: 2,
        reason,
      },
    );
    expect(published.status).toBe(200);
    expect(published.data.audit.after.withdrawnPaperIds.length).toBeGreaterThan(
      0,
    );
    const [superOld] = await db.db
      .$client`SELECT availability FROM question_bank WHERE id=${questionId}`;
    expect(superOld!.availability).toBe("superseded");
    const [papers] = await db.db
      .$client`SELECT count(*)::int n FROM exam_papers p JOIN exam_question_occurrences o ON o.paper_id=p.id WHERE o.question_id=${questionId} AND p.status='published'`;
    expect(papers!.n).toBe(0);
  });
  it("import flag disables admission and fresh workers without cancelling or erasing durable jobs", async () => {
    const input = {
      sourceId: source,
      documentId: examDoc,
      answerKeyDocumentId: null,
      exam: {
        name: "Synthetic paused rollout",
        institution: "Synthetic",
        year: 2026,
        edition: "flag-off",
        booklet: "AD1",
        durationSec: null,
      },
      ocr: false,
      excludedPages: [],
      budgetCents: 0,
      parserVersion: QUESTION_PDF_PARSER_VERSION,
      reason,
    };
    const created = await request(
      "/admin/imports",
      "POST",
      input,
      admin,
      randomUUID(),
    );
    expect(created.status).toBe(200);
    const id = created.data.import.id;
    vi.stubEnv("QUESTIONS_IMPORT_ENABLED", "0");
    try {
      expect(
        (await request("/admin/imports", "POST", input, admin, randomUUID()))
          .status,
      ).toBe(404);
      expect(
        (await request("/admin/imports/" + id + "/retry", "POST", { reason }))
          .status,
      ).toBe(404);
      expect((await request("/admin/documents", "POST", {})).status).toBe(404);
      const { runStoredQuestionImport } =
        await import("../../questions/imports/store");
      expect((await runStoredQuestionImport(id)).status).toBe("disabled");
      const [row] = await db.db
        .$client`SELECT status,worker_id,cost_cents FROM question_imports WHERE id=${id}`;
      expect(row).toMatchObject({
        status: "queued",
        worker_id: null,
        cost_cents: 0,
      });
    } finally {
      vi.stubEnv("QUESTIONS_IMPORT_ENABLED", "1");
    }
  });
});
