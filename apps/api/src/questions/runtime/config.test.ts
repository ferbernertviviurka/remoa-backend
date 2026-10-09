import { afterEach, describe, expect, it, vi } from "vitest";
import { questionFeatures, questionAdmissionLimits } from "./config";
import { createQuestionAdmission } from "./admission";
afterEach(() => vi.unstubAllEnvs());
describe("independent rollout and abuse admission", () => {
  it("keeps import and sessions closed in production and leaves the catalog available", () => {
    for (const NODE_ENV of [undefined, "production", "staging"])
      expect(questionFeatures({ NODE_ENV })).toEqual({
        import: false,
        catalog: true,
        sessions: false,
      });
    for (const NODE_ENV of ["test", "development"])
      expect(questionFeatures({ NODE_ENV })).toEqual({
        import: true,
        catalog: true,
        sessions: true,
      });
  });
  it("each flag is independent and malformed values fail closed at boot", () => {
    expect(
      questionFeatures({
        NODE_ENV: "production",
        QUESTIONS_IMPORT_ENABLED: "1",
        QUESTIONS_CATALOG_ENABLED: "false",
        QUESTIONS_SESSIONS_ENABLED: "true",
      }),
    ).toEqual({ import: true, catalog: false, sessions: true });
    expect(() => questionFeatures({ QUESTIONS_IMPORT_ENABLED: "yes" })).toThrow(
      "invalid QUESTIONS_IMPORT_ENABLED",
    );
  });
  it("validates rate config without changing business plan quotas", () => {
    expect(questionAdmissionLimits({})).toEqual({
      upload: 5,
      import: 3,
      session: 20,
      report: 5,
    });
    expect(questionAdmissionLimits({ QUESTIONS_RATE_UPLOAD: "2" }).upload).toBe(
      2,
    );
    for (const value of ["0", "-1", "NaN", "1001", "1.5"])
      expect(() =>
        questionAdmissionLimits({ QUESTIONS_RATE_IMPORT: value }),
      ).toThrow();
  });
  it("isolates owners, action scopes and question targets and expires the window", () => {
    vi.stubEnv("QUESTIONS_RATE_UPLOAD", "2");
    vi.stubEnv("QUESTIONS_RATE_REPORT", "1");
    const gate = createQuestionAdmission();
    expect(gate.take("upload", "owner", "", 0)).toBe(true);
    expect(gate.take("upload", "owner", "", 1)).toBe(true);
    expect(gate.take("upload", "owner", "", 2)).toBe(false);
    expect(gate.take("upload", "other", "", 2)).toBe(true);
    expect(gate.take("upload", "owner", "", 60_001)).toBe(true);
    expect(gate.take("report", "owner", "one", 0)).toBe(true);
    expect(gate.take("report", "owner", "one", 1)).toBe(false);
    expect(gate.take("report", "owner", "two", 1)).toBe(true);
    expect(gate.take("report", "owner", "one", 3_600_001)).toBe(true);
  });
});
