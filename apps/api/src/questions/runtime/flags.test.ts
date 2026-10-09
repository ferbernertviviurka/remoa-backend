import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  legacy: vi.fn(() => Response.json({ ok: true, data: { legacy: true } })),
  catalog: vi.fn(() => Response.json({ ok: true, data: { catalog: true } })),
  sessions: vi.fn(() => Response.json({ ok: true, data: { session: true } })),
}));
vi.mock("../../routes/challenge-ai", () => ({
  challengeAiRoutes: () => new Hono().get("/bank", mocks.legacy),
}));
vi.mock("../../routes/questions", () => ({
  questionsRoutes: () => new Hono().get("/", mocks.catalog),
  examsRoutes: () => new Hono().get("/", mocks.catalog),
  questionInstitutionsRoutes: () => new Hono().get("/", mocks.catalog),
}));
vi.mock("../../routes/question-sessions", () => ({
  questionSessionsRoutes: () =>
    new Hono().get("/", mocks.sessions).post("/", mocks.sessions),
}));
import { Hono } from "hono";
import { createApp } from "../../app";
const app = createApp({
  webOrigin: "http://localhost:3000",
  verifyToken: async (token) =>
    token === "valid"
      ? {
          userId: "00000000-0000-4000-8000-000000000001",
          sessionId: null,
          account: { hasProfile: true, deletedAt: null, suspendedAt: null },
        }
      : null,
});
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      authorization: "Bearer valid",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
afterEach(() => vi.unstubAllEnvs());
describe("F33 HTTP switches preserve F32", () => {
  it("flags exposure requires auth and returns booleans only", async () => {
    expect((await app.request("/v1/question-features")).status).toBe(401);
    vi.stubEnv("QUESTIONS_IMPORT_ENABLED", "0");
    const res = await request("/v1/question-features");
    expect((await res.json()).data).toEqual({
      import: false,
      catalog: true,
      sessions: true,
    });
  });
  it("disabled catalog and exams return404 while legacy and independent sessions continue", async () => {
    vi.stubEnv("QUESTIONS_CATALOG_ENABLED", "0");
    expect((await request("/v1/questions")).status).toBe(404);
    expect((await request("/v1/exams")).status).toBe(404);
    expect((await request("/v1/question-institutions")).status).toBe(404);
    expect((await request("/v1/challenge-ai/bank")).status).toBe(200);
    expect((await request("/v1/question-sessions")).status).toBe(200);
    expect(
      (
        await request("/v1/question-sessions", "POST", {
          mode: "study",
          examId: "00000000-0000-4000-8000-000000000002",
          count: 1,
        })
      ).status,
    ).toBe(404);
  });
  it("disabled sessions do not disable catalog or legacy", async () => {
    vi.stubEnv("QUESTIONS_SESSIONS_ENABLED", "0");
    expect((await request("/v1/question-sessions")).status).toBe(404);
    expect((await request("/v1/questions")).status).toBe(200);
    expect((await request("/v1/challenge-ai/bank")).status).toBe(200);
  });
});
