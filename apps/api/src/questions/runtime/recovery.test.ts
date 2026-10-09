import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  imports: vi.fn(async () => ({ dispatched: 2 })),
  generation: vi.fn(async () => ({ claimed: 1, delivered: 1, failed: 0 })),
}));
vi.mock("../../inngest/question-import", () => ({
  reconcileQuestionImports: m.imports,
}));
vi.mock("../generation/reconcile", () => ({
  reconcileQuestionGenerations: m.generation,
}));
vi.mock("@remoa/log", () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));
import { reconcileQuestionRuntime } from "./recovery";
beforeEach(() => vi.clearAllMocks());
describe("startup and maintenance recovery", () => {
  it("runs both bounded repositories without provider calls", async () => {
    expect(await reconcileQuestionRuntime()).toEqual({
      generation: { claimed: 1, delivered: 1, failed: 0 },
      imports: { dispatched: 2 },
    });
    expect(m.generation).toHaveBeenCalledOnce();
    expect(m.imports).toHaveBeenCalledOnce();
  });
  it("one pipeline failure does not skip the other and fails the cron step visibly", async () => {
    m.generation.mockRejectedValueOnce(Error("db failed"));
    await expect(reconcileQuestionRuntime()).rejects.toThrow(
      "question_recovery_failed",
    );
    expect(m.imports).toHaveBeenCalledOnce();
  });
});
