import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../admin/core/require-admin", () => ({
  accountState: async (id: string) => ({ email: id === "staff" ? "Contato@Remoa.com.br" : "aluno@x.com" }),
}));
import { questionStudentEmails } from "./config";
import { questionFeaturesFor } from "./admission";
afterEach(() => vi.unstubAllEnvs());
describe("D-1838 student allowlist", () => {
  it("parses a trimmed, lower-cased comma list", () => {
    expect(questionStudentEmails({ QUESTIONS_STUDENT_EMAILS: " A@b.com, ,c@d.com " })).toEqual(["a@b.com", "c@d.com"]);
    expect(questionStudentEmails({})).toEqual([]);
  });
  it("closes the student flags outside the list and keeps them for listed accounts", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QUESTIONS_SESSIONS_ENABLED", "1");
    vi.stubEnv("QUESTIONS_BANK_STUDENT_ENABLED", "1");
    vi.stubEnv("QUESTIONS_STUDENT_EMAILS", "contato@remoa.com.br");
    expect(await questionFeaturesFor("staff")).toEqual({ import: false, catalog: true, sessions: true, bankStudent: true });
    expect(await questionFeaturesFor("aluno")).toEqual({ import: false, catalog: false, sessions: false, bankStudent: false });
    vi.stubEnv("QUESTIONS_STUDENT_EMAILS", "");
    expect((await questionFeaturesFor("aluno")).bankStudent).toBe(true);
  });
});
