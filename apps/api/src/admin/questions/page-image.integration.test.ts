/** CCR118: actual unpdf/Poppler on a rotated synthetic PDF; private memory storage, isolated DB. */
import { randomUUID as uuid } from "node:crypto";
import { Hono } from "hono";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { fakeToken, fakeVerifier } from "../core/test-helpers";
import type { AdminEnv } from "../core";
import { questionCandidateSchema } from "@remoa/contracts";
import { parseExam } from "../../questions/pdf";
import { sha256, PARSER_VERSION } from "../../questions/imports/domain";
const objects = new Map<string, { bytes: Buffer; mime: string }>();
const control = vi.hoisted(() => ({
  put: vi.fn(),
  onPut: undefined as undefined | (() => Promise<void>),
  fail: false,
}));
vi.mock("../../storage/storage", () => ({
  getBytes: vi.fn(async (k: string) => {
    const r = objects.get(k);
    if (!r) throw Error("missing_object");
    return r.bytes;
  }),
  headObject: vi.fn(async (k: string) => {
    const r = objects.get(k);
    return r ? { size: r.bytes.length, mime: r.mime } : null;
  }),
  putBytes: control.put.mockImplementation(
    async (k: string, bytes: Buffer, mime: string) => {
      if (control.fail) throw Error("synthetic_storage_failure");
      objects.set(k, { bytes, mime });
      await control.onPut?.();
    },
  ),
  deleteObject: vi.fn(async (k: string) => objects.delete(k)),
  presignGet: vi.fn(async (k: string) => "https://example.org/private/" + k),
}));
vi.mock("../../cache", () => ({ invalidate: vi.fn(async () => {}) }));
vi.mock("../../inngest/client", () => ({
  dispatchQuestionImport: vi.fn(async () => false),
}));
function syntheticPdf() {
  const content =
    "0 0 0 rg 10 20 25 30 re f BT /F1 8 Tf 5 100 Td (Synthetic exam page) Tj ET";
  const parts = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 144] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let result = "%PDF-1.7\n";
  const offsets = [0];
  for (const [i, part] of parts.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${part}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((x) => String(x).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
const url = process.env.DATABASE_URL;
if (url && !new URL(url).pathname.includes("f33_test"))
  throw Error("isolated f33_test required");
describe.skipIf(!url)("CCR118 manual private page image", () => {
  const admin = uuid(),
    student = uuid(),
    reviewer = uuid(),
    source = uuid(),
    doc = uuid(),
    keyDoc = uuid(),
    paper = uuid(),
    job = uuid(),
    area = uuid(),
    topic = uuid(),
    bytes = syntheticPdf(),
    key = "questions/documents/" + admin + "/" + doc + ".pdf";
  let db: typeof import("@remoa/db").db.$client, app: Hono<AdminEnv>;
  const candidateIds: string[] = [];
  let current: string,
    currentRevision = 0,
    question: string;
  const reason = "Conferir imagem descoberta na página original";
  const call = async (
    id: string,
    input: unknown,
    user = admin,
    age = 60000,
  ) => {
    const response = await app.request(
      `/admin/imports/${job}/candidates/${id}/page-image`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + fakeToken(user, age),
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        data?: {
          candidate: unknown;
          questionId: string | null;
          audit: { after: unknown };
        };
        error?: { message: string };
      },
    };
  };
  async function freshCandidate() {
    const id = uuid();
    candidateIds.push(id);
    const parsed = parseExam([
      {
        page: 1,
        width: 144,
        height: 72,
        items: [
          "Questão 1",
          "Enunciado sintético com dados adicionais",
          "(A) Primeira opção",
          "(B) Segunda opção",
        ].map((text, i) => ({
          text,
          x: 1,
          y: 1 + i * 12,
          width: 120,
          height: 8,
        })),
      },
    ]).candidates[0]!;
    expect(parsed.imageRefs).toEqual([]);
    expect(parsed.issues).toContain("figure_geometry_unknown");
    await db`INSERT INTO question_import_candidates(id,import_id,ordinal,payload,provenance,issues) VALUES(${id},${job},${candidateIds.length},${JSON.stringify(parsed)}::jsonb,${JSON.stringify([{ documentId: doc, page: 1, bbox: [0, 0, 1, 1] }])}::jsonb,${parsed.issues})`;
    return id;
  }
  beforeAll(async () => {
    vi.stubEnv("QUESTIONS_IMPORT_ENABLED", "true");
    db = (await import("@remoa/db")).db.$client;
    for (const id of [admin, student, reviewer])
      await db`INSERT INTO auth.users(id,email) VALUES(${id},${id + "@manual-image.example"})`;
    await db`UPDATE profiles SET role='admin' WHERE user_id=${admin}`;
    await db`UPDATE profiles SET role='reviewer',crm='12345-SP',name='Synthetic image reviewer' WHERE user_id=${reviewer}`;
    await db`INSERT INTO question_sources(id,name,publisher,url,rights_status) VALUES(${source},'Synthetic manual image','Synthetic','https://example.org','pending')`;
    for (const [id, kind] of [
      [doc, "exam"],
      [keyDoc, "answer_key"],
    ])
      await db`INSERT INTO question_documents(id,user_id,source_id,kind,object_key,sha256,bytes,pages) VALUES(${id!},${admin},${source},${kind!},${key},${sha256(bytes)},${bytes.length},1)`;
    await db`INSERT INTO exam_papers(id,source_id,document_id,name,institution,year,edition,booklet) VALUES(${paper},${source},${doc},'Synthetic exam','Synthetic',2026,${paper},'AD1')`;
    await db`INSERT INTO question_imports(id,user_id,source_id,paper_id,document_id,answer_key_document_id,idempotency_key,parser_version,status,total_pages,completed_pages) VALUES(${job},${admin},${source},${paper},${doc},${keyDoc},${job},${PARSER_VERSION},'review',1,1)`;
    await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','Synthetic')`;
    await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','Synthetic',${area})`;
    objects.set(key, { bytes, mime: "application/pdf" });
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
      c.set("requestId", uuid());
      await next();
    });
    app.use("/admin/*", requireAdmin(fakeVerifier([admin, student, reviewer])));
    app.route("/admin", questionAdminRoutes);
    const { questionEditorialRoutes } =
      await import("../../routes/question-editorial");
    app.use("/editorial/*", async (c, next) => {
      const id = await fakeVerifier([admin, student, reviewer])(
        c.req.header("authorization")!.replace("Bearer ", ""),
      );
      if (typeof id !== "string") return c.json({ error: "unauthorized" }, 401);
      c.set("userId", id);
      c.set("sessionId", null);
      await next();
    });
    app.route("/editorial", questionEditorialRoutes);
    current = await freshCandidate();
  });
  afterAll(async () => {
    control.onPut = undefined;
    vi.unstubAllEnvs();
    await db`DELETE FROM question_imports WHERE id=${job}`;
    await db`DELETE FROM exam_papers WHERE id=${paper}`;
    await db`DELETE FROM question_bank WHERE source_id=${source}`;
    await db`DELETE FROM question_documents WHERE id IN(${doc},${keyDoc})`;
    await db`DELETE FROM question_sources WHERE id=${source}`;
    await db`DELETE FROM enamed_taxonomy WHERE id=${topic}`;
    await db`DELETE FROM enamed_taxonomy WHERE id=${area}`;
    await db`DELETE FROM auth.users WHERE id IN(${admin},${student},${reviewer})`;
    objects.clear();
    await db.end({ timeout: 1 });
  });
  it("denies student/reviewer, missing reason, stale reauth and disabled flag before expensive IO", async () => {
    const input = { page: 1, revision: 0, reason };
    expect((await call(current, input, student)).status).toBe(404);
    expect((await call(current, input, reviewer)).status).toBe(404);
    expect((await call(current, { ...input, reason: "" })).status).toBe(422);
    expect((await call(current, input, admin, 30 * 60000)).status).toBe(403);
    vi.stubEnv("QUESTIONS_IMPORT_ENABLED", "false");
    expect((await call(current, input)).status).toBe(404);
    vi.stubEnv("QUESTIONS_IMPORT_ENABLED", "true");
    expect(control.put).not.toHaveBeenCalled();
  });
  it("associates a rotated full-page private PNG with unknown geometry, preserves content and demands explicit alt/review", async () => {
    const [auditBefore] =
      await db`SELECT count(*)::int n FROM admin_audit_log WHERE actor_id=${admin} AND action='question.candidate_update' AND target_id=${current}`;
    const response = await call(current, { page: 1, revision: 0, reason });
    const [auditAfter] =
      await db`SELECT count(*)::int n FROM admin_audit_log WHERE actor_id=${admin} AND action='question.candidate_update' AND target_id=${current}`;
    expect(auditAfter!.n - auditBefore!.n).toBe(1);
    expect(response.status).toBe(200);
    const candidate = questionCandidateSchema.parse(
      response.body.data!.candidate,
    );
    currentRevision = candidate.revision;
    expect(candidate).toMatchObject({ state: "needs_review", revision: 1 });
    expect(candidate.payload.imageRefs).toHaveLength(1);
    expect(candidate.payload.assets).toEqual([]);
    expect(candidate.payload.imagesConfirmed).toBe(false);
    const ref = candidate.payload.imageRefs[0]!;
    expect(ref).toMatchObject({
      method: "manual_page",
      bbox: { x: 0, y: 0, width: 144, height: 72 },
      provenance: { documentId: doc, page: 1, bbox: [0, 0, 1, 1] },
    });
    expect(objects.get(ref.objectKey)?.mime).toBe("image/png");
    const input = {
      stem: candidate.payload.stem,
      alternatives: candidate.payload.alternatives,
      correctKey: "A",
      explanation: "Comentário sintético",
      topicId: topic,
      areaId: area,
      annulled: false,
      keyFinal: true,
      integrityConfirmed: true,
      imagesConfirmed: true,
      state: "accepted",
      duplicateOf: null,
      revision: currentRevision,
      reason,
    };
    const patch = async (body: unknown) => {
      const r = await app.request(
        `/admin/imports/${job}/candidates/${current}`,
        {
          method: "PATCH",
          headers: {
            authorization: "Bearer " + fakeToken(admin),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      return { status: r.status, body: await r.json() };
    };
    expect((await patch(input)).status).toBe(422);
    expect(
      (
        await patch({
          ...input,
          assets: [
            {
              id: uuid(),
              objectKey: ref.objectKey,
              alt: "",
              provenance: ref.provenance,
            },
          ],
        })
      ).status,
    ).toBe(422);
    const duplicate = await patch({
      ...input,
      state: "duplicate",
      duplicateOf: uuid(),
      assets: [
        {
          id: uuid(),
          objectKey: ref.objectKey,
          alt: "Ilustração sintética",
          provenance: ref.provenance,
        },
      ],
    });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.error.message).toBe(
      "manual_page_requires_preserved_asset_and_new_medical_review",
    );
    const accepted = await patch({
      ...input,
      assets: [
        {
          id: uuid(),
          objectKey: ref.objectKey,
          alt: "Ilustração da página original sintética",
          provenance: ref.provenance,
        },
      ],
    });
    expect(accepted.status).toBe(200);
    question = accepted.body.data.questionId;
    currentRevision = accepted.body.data.candidate.revision;
    const [row] =
      await db`SELECT catalog_status,reviewed_hash,assets FROM question_bank WHERE id=${question}`;
    expect(row!.catalog_status).toBe("in_review");
    expect(row!.reviewed_hash).toBeNull();
    expect(row!.assets).toHaveLength(1);
    const publish = await app.request(`/admin/${question}/publish`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + fakeToken(admin),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: 1,
        expectedContentHash: (
          await db`SELECT content_hash FROM question_bank WHERE id=${question}`
        )[0]!.content_hash,
        reason,
      }),
    });
    expect(publish.status).toBe(409);
    expect((await publish.json()).error.message).toBe("content_hash_changed");
  });
  it("idempotent repeat with current revision skips rendering/PUT; stale revision returns409", async () => {
    const before = control.put.mock.calls.length;
    const repeated = await call(current, {
      page: 1,
      revision: currentRevision,
      reason,
    });
    expect(repeated.status).toBe(200);
    expect(
      questionCandidateSchema.parse(repeated.body.data!.candidate).revision,
    ).toBe(currentRevision);
    expect(control.put.mock.calls.length).toBe(before);
    expect((await call(current, { page: 1, revision: 0, reason })).status).toBe(
      409,
    );
  });
  it("rejects non-provenance pages, expired source, cancellation and answer-key substitution without adding refs", async () => {
    const id = await freshCandidate();
    expect((await call(id, { page: 2, revision: 0, reason })).status).toBe(422);
    await db`UPDATE question_sources SET rights_expires_at=now()-interval '1 second' WHERE id=${source}`;
    expect((await call(id, { page: 1, revision: 0, reason })).status).toBe(409);
    await db`UPDATE question_sources SET rights_expires_at=null WHERE id=${source}`;
    await db`UPDATE question_imports SET status='cancelled' WHERE id=${job}`;
    expect((await call(id, { page: 1, revision: 0, reason })).status).toBe(409);
    await db`UPDATE question_imports SET status='review',document_id=${keyDoc} WHERE id=${job}`;
    expect((await call(id, { page: 1, revision: 0, reason })).status).toBe(422);
    await db`UPDATE question_imports SET document_id=${doc} WHERE id=${job}`;
  });
  it("detects concurrent revision changes after rendering, removes only its new unreferenced object and releases claim", async () => {
    const id = await freshCandidate();
    control.onPut = async () => {
      await db`UPDATE question_import_candidates SET revision=revision+1 WHERE id=${id}`;
    };
    const response = await call(id, { page: 1, revision: 0, reason });
    control.onPut = undefined;
    expect(response.status).toBe(409);
    expect(
      [...objects.keys()].some((k) => k.includes("manual-" + id + "-")),
    ).toBe(false);
    const [row] =
      await db`SELECT worker_id,lease_until FROM question_imports WHERE id=${job}`;
    expect(row).toMatchObject({ worker_id: null, lease_until: null });
  });
  it("fails explicitly on storage error and a lost lease never deletes another claimant’s evidence", async () => {
    const id = await freshCandidate();
    control.fail = true;
    expect((await call(id, { page: 1, revision: 0, reason })).status).toBe(503);
    control.fail = false;
    control.onPut = async () => {
      await db`UPDATE question_imports SET worker_id='manual-page:other-claimant',lease_until=now()+interval '3 minutes' WHERE id=${job}`;
    };
    expect((await call(id, { page: 1, revision: 0, reason })).status).toBe(409);
    control.onPut = undefined;
    expect(
      [...objects.keys()].some((k) => k.includes("manual-" + id + "-")),
    ).toBe(true);
    await db`UPDATE question_imports SET worker_id=null,lease_until=null WHERE id=${job}`;
  });
  it("reviews the accepted image through JSONB without rewriting a signature or publishing", async () => {
    const [before] =
      await db`SELECT content_hash FROM question_bank WHERE id=${question}`;
    const response = await app.request(`/editorial/${question}/review`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + fakeToken(reviewer),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: "approved",
        contentHash: before!.content_hash,
        referenceDate: "2026-10-08",
        reason,
      }),
    });
    expect(response.status).toBe(200);
    const [after] =
      await db`SELECT content_hash,reviewed_hash,catalog_status,published_at FROM question_bank WHERE id=${question}`;
    expect(after).toMatchObject({
      content_hash: before!.content_hash,
      reviewed_hash: before!.content_hash,
      catalog_status: "approved",
      published_at: null,
    });
    const changed = await app.request(`/editorial/${question}/review`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + fakeToken(reviewer),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: "approved",
        contentHash: "0".repeat(64),
        referenceDate: "2026-10-08",
        reason,
      }),
    });
    expect(changed.status).toBe(409);
    const [still] =
      await db`SELECT reviewed_hash FROM question_bank WHERE id=${question}`;
    expect(still!.reviewed_hash).toBe(before!.content_hash);
  });
  it("recovers an expired manual lease without rerunning the parser or changing review status", async () => {
    const id = await freshCandidate();
    await db`UPDATE question_imports SET worker_id='manual-page:crashed',lease_until=now()+interval '3 minutes' WHERE id=${job}`;
    expect((await call(id, { page: 1, revision: 0, reason })).status).toBe(409);
    await db`UPDATE question_imports SET lease_until=now()-interval '1 second' WHERE id=${job}`;
    expect((await call(id, { page: 1, revision: 0, reason })).status).toBe(200);
    const [state] =
      await db`SELECT status,attempts,worker_id,lease_until FROM question_imports WHERE id=${job}`;
    expect(state).toMatchObject({
      status: "review",
      attempts: 0,
      worker_id: null,
      lease_until: null,
    });
  });
  it("enforces the global two-claim admission limit across distinct import rows", async () => {
    const id = await freshCandidate(),
      extra = [uuid(), uuid()];
    try {
      for (const row of extra)
        await db`INSERT INTO question_imports(id,user_id,source_id,paper_id,document_id,idempotency_key,parser_version,status,worker_id,lease_until) VALUES(${row},${admin},${source},${paper},${doc},${row},${PARSER_VERSION},'review',${"manual-page:" + row},now()+interval '3 minutes')`;
      expect((await call(id, { page: 1, revision: 0, reason })).status).toBe(
        429,
      );
    } finally {
      await db`DELETE FROM question_imports WHERE id IN(${extra[0]!},${extra[1]!}) AND source_id=${source}`;
    }
  });
  it("freezes published candidates and does not infer publication or bypass current medical review", async () => {
    const [before] =
      await db`SELECT count(*)::int n FROM question_bank WHERE source_id=${source} AND catalog_status='published'`;
    expect(before!.n).toBe(0);
    await db`UPDATE exam_papers SET status='published' WHERE id=${paper}`;
    expect(
      (await call(current, { page: 1, revision: currentRevision, reason }))
        .status,
    ).toBe(409);
    await db`UPDATE exam_papers SET status='draft' WHERE id=${paper}`;
  });
  it("refuses an incompatible historically published asset hash without rewriting its signature", async () => {
    const [row] =
      await db`SELECT stem,alternatives,correct_key,explanation,enamed_area_id,enamed_topic_id,assets FROM question_bank WHERE id=${question}`;
    const legacy = sha256(
      JSON.stringify({
        stem: row!.stem,
        alternatives: row!.alternatives,
        correctKey: row!.correct_key,
        explanation: row!.explanation,
        areaId: row!.enamed_area_id,
        topicId: row!.enamed_topic_id,
        annulled: false,
        assets: row!.assets,
      }),
    );
    // Emulate a synthetic pre-upgrade signature. Production code never performs this rewrite.
    await db`UPDATE question_sources SET rights_status='authorized',rights_evidence='Synthetic QA permission' WHERE id=${source}`;
    await db`UPDATE question_bank SET content_hash=${legacy},reviewed_hash=${legacy},rights_status='authorized' WHERE id=${question}`;
    await db`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reference_date,reason) VALUES(${question},${reviewer},'Synthetic image reviewer','12345-SP',${legacy},'approved','2026-10-08','Synthetic historic fixture')`;
    await db`UPDATE question_bank SET catalog_status='published',published_at=now() WHERE id=${question}`;
    const before = (
      await db`SELECT content_hash,reviewed_hash,reviewer_name,reviewer_crm,reference_date,published_at FROM question_bank WHERE id=${question}`
    )[0]!;
    const response = await app.request(`/editorial/${question}/review`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + fakeToken(reviewer),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        decision: "approved",
        contentHash: legacy,
        referenceDate: "2026-10-08",
        reason,
      }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toBe("content_hash_changed");
    expect(
      (
        await db`SELECT content_hash,reviewed_hash,reviewer_name,reviewer_crm,reference_date,published_at FROM question_bank WHERE id=${question}`
      )[0],
    ).toEqual(before);
  });
});
