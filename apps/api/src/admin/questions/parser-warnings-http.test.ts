import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { err, ok, errorHttpStatus } from "@remoa/contracts";
import type { AdminEnv } from "../core";
const f = vi.hoisted(() => ({
  actor: {} as Record<string, unknown>,
  rows: [] as unknown[],
  head: vi.fn(),
  read: vi.fn(),
  fresh: true,
  tx: false,
  queries: 0,
  outcomes: [] as string[],
}));
const chain = () => {
  const q = {
    innerJoin: () => q,
    where: async () => {
      f.queries++;
      return f.rows;
    },
  };
  return { from: () => q };
};
vi.mock("../../db", () => ({
  dbm: async () => ({
    db: { select: chain },
    questionImports: {},
    questionDocuments: {},
    examPapers: {},
    questionSourcesCatalog: {},
  }),
}));
vi.mock("../../questions/imports/store", () => ({
  parserWarningStorage: () => ({ head: f.head, read: f.read }),
}));
const audit = {
  id: 1,
  createdAt: new Date(),
  actorType: "admin",
  actor: null,
  action: "question.import_view",
  targetType: "question_import",
  targetId: "import",
  targetLabel: null,
  reason: "Conferência autorizada",
  result: "success",
  denial: null,
  before: null,
  after: null,
  ipHash: null,
  userAgent: null,
  requestId: null,
};
vi.mock("../core", () => ({
  accountState: async () => f.actor,
  isFresh: () => f.fresh,
  send: (r: { ok: boolean; error: { code: keyof typeof errorHttpStatus } }) =>
    Response.json(r.ok ? r : { error: r.error }, {
      status: r.ok ? 200 : errorHttpStatus[r.error.code],
    }),
  withAdmin: async (
    _c: unknown,
    _a: unknown,
    _o: unknown,
    run: (tx: unknown, a: unknown) => Promise<{ ok: boolean; data?: object }>,
  ) => {
    f.tx = true;
    try {
      if (!f.fresh) {
        f.outcomes.push("denied");
        return err("forbidden", "reauth");
      }
      const r = await run({ select: chain }, { after: () => {} });
      f.outcomes.push(r.ok ? "success" : "denied");
      return r.ok ? ok({ ...r.data, audit }) : r;
    } finally {
      f.tx = false;
    }
  },
}));
import {
  parserWarningsResponse,
  type WarningMetadata,
} from "./parser-warnings";
import {
  summarizeWarnings,
  type DiagnosticPlan,
} from "../../questions/imports/parser-warnings";
const id = "00000000-0000-4000-8000-000000000001",
  doc = "00000000-0000-4000-8000-000000000002";
const plan = (): DiagnosticPlan => ({
  importId: id,
  parserVersion: "historic-v4",
  ocrVersion: "best180",
  documentId: doc,
  documentSha256: "a".repeat(64),
  answerKeyDocumentId: null,
  answerKeySha256: null,
  booklet: "1",
  excludedPages: [],
  answerKeyPages: null,
  ocrEnabled: true,
});
const row = () => ({
  plan: {
    ...plan(),
    attempt: 2,
    workerId: null,
    leaseUntil: null,
    status: "failed",
  },
  source: { id: "source", rightsStatus: "pending", rightsExpiresAt: null },
  document: {
    id: doc,
    sourceId: "source",
    kind: "exam",
    sha256: "a".repeat(64),
  },
});
function app() {
  const a = new Hono<AdminEnv>();
  a.use("*", async (c, next) => {
    c.set("admin", { id, name: "Synthetic", email: "synthetic@example.org" });
    c.set("authAt", Date.now());
    await next();
  });
  return a.get("/imports/:id/parser-warnings", parserWarningsResponse);
}
const request = () => app().request(`/imports/${id}/parser-warnings`);
beforeEach(() => {
  vi.clearAllMocks();
  f.tx = false;
  f.fresh = true;
  f.queries = 0;
  f.outcomes = [];
  f.actor = {
    role: "admin",
    email: "synthetic@example.org",
    deletedAt: null,
    suspendedAt: null,
  };
  f.rows = [row()];
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      summarizeWarnings(plan(), 2, {
        phase: "parsed",
        complete: true,
        detectedCandidates: 0,
        detectedContexts: 0,
        examWarnings: [
          "expected_question_unmatched:1",
          "no_questions_detected",
        ],
      }),
    ),
  );
  f.head.mockImplementation(async (key: string) => {
    expect(f.tx).toBe(false);
    return key.endsWith("/parsed.json")
      ? { size: bytes.length, mime: "application/json" }
      : null;
  });
  f.read.mockImplementation(async () => {
    expect(f.tx).toBe(false);
    return bytes;
  });
});
describe("fresh admin private warnings with real outcome audit", () => {
  it("serves failed-zero warnings with original stored version, private no-store and exactly one success", async () => {
    const r = await request();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.detectedCandidates).toBe(0);
    expect(body.data.total).toBe(2);
    expect(body.data.parserVersion).toBe("historic-v4");
    expect(JSON.stringify(body)).not.toMatch(/objectKey|https?:|PDF body/);
    expect(f.outcomes).toEqual(["success"]);
    expect(f.queries).toBe(2);
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("does no private IO before role/reauth denial and audits actual denial", async () => {
    f.actor.role = "student";
    expect((await request()).status).toBe(404);
    expect(f.queries).toBe(0);
    expect(f.head).not.toHaveBeenCalled();
    expect(f.outcomes).toEqual(["denied"]);
    f.actor.role = "admin";
    f.fresh = false;
    f.outcomes = [];
    expect((await request()).status).toBe(403);
    expect(f.outcomes).toEqual(["denied"]);
  });
  it.each(["role", "source", "attempt", "plan"])(
    "rechecks %s after bounded storage read before actual audit success",
    async (change) => {
      f.read.mockImplementationOnce(async () => {
        const r = f.rows[0] as WarningMetadata;
        if (change === "role") f.actor.role = "student";
        if (change === "source") r.source.rightsStatus = "revoked";
        if (change === "attempt")
          f.rows = [{ ...r, plan: { ...r.plan, attempt: 3 } }];
        if (change === "plan")
          f.rows = [{ ...r, plan: { ...r.plan, answerKeyPages: [3] } }];
        return new TextEncoder().encode(
          JSON.stringify(
            summarizeWarnings(plan(), 2, {
              phase: "parsed",
              complete: true,
              detectedCandidates: 0,
              detectedContexts: 0,
              examWarnings: [
                "expected_question_unmatched:1",
                "no_questions_detected",
              ],
            }),
          ),
        );
      });
      const r = await request();
      expect(r.status).toBe(change === "role" ? 404 : 409);
      expect(f.outcomes).toEqual(["denied"]);
    },
  );
  it("reports missing current artifact distinctly for queued and failed, never previous attempt", async () => {
    f.head.mockResolvedValue(null);
    let r = await request(),
      b = await r.json();
    expect(b.data.reason).toBe("not_recorded");
    expect(b.data.total).toBeNull();
    f.rows = [{ ...row(), plan: { ...row().plan, status: "queued" } }];
    r = await request();
    b = await r.json();
    expect(b.data.reason).toBe("pending");
    expect(b.data.knownCount).toBeNull();
    expect(f.read).not.toHaveBeenCalled();
    expect(
      f.head.mock.calls.every(([key]) => String(key).includes("attempt-2/")),
    ).toBe(true);
  });
  it("returns storage failure as 503 with one denied outcome and no fabricated zero", async () => {
    f.read.mockRejectedValueOnce(
      Error("private clinical text in storage error"),
    );
    const r = await request();
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("5");
    expect(JSON.stringify(await r.json())).not.toContain("clinical");
    expect(f.outcomes).toEqual(["denied"]);
  });
});
