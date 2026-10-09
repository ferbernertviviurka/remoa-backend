import { describe, it, expect, vi } from "vitest";
import {
  persistWarningArtifact,
  readWarningArtifact,
  summarizeWarnings,
  warningArtifactKey,
  warningPlanHash,
  WARNING_BYTES,
  type OwnedDiagnosticPlan,
  type WarningStorage,
} from "./parser-warnings";
const plan = (): OwnedDiagnosticPlan => ({
  importId: "00000000-0000-4000-8000-000000000001",
  parserVersion: "v5-historical",
  ocrVersion: "best180",
  documentId: "doc",
  documentSha256: "a".repeat(64),
  answerKeyDocumentId: "key",
  answerKeySha256: "b".repeat(64),
  booklet: "1",
  excludedPages: [38],
  answerKeyPages: [3],
  ocrEnabled: true,
  attempt: 2,
  workerId: "owned",
  leaseUntil: new Date(Date.now() + 60000),
  status: "segmenting",
});
function memory() {
  const objects = new Map<string, Uint8Array>();
  const storage: WarningStorage = {
    head: vi.fn(async (k) =>
      objects.has(k)
        ? { size: objects.get(k)!.length, mime: "application/json" }
        : null,
    ),
    read: vi.fn(async (k, max) => {
      const b = objects.get(k)!;
      if (b.length > max) throw Error("too_big");
      return b;
    }),
    put: vi.fn(async (k, b) => {
      objects.set(k, b);
    }),
    remove: vi.fn(async (k) => {
      objects.delete(k);
    }),
  };
  return { objects, storage };
}
const parsed = {
  phase: "parsed" as const,
  complete: true,
  examWarnings: ["no_questions_detected"],
  detectedCandidates: 0,
  detectedContexts: 0,
};
describe("immutable attempt diagnostics", () => {
  it("counts both sources, truncation and unknowns without retaining their raw text", () => {
    const p = plan(),
      warnings = Array.from(
        { length: 250 },
        (_, i) => `expected_question_unmatched:${i + 1}`,
      );
    warnings.push("dose/patient/raw body", "missing_question:1000");
    const s = summarizeWarnings(p, 2, {
      ...parsed,
      examWarnings: warnings,
      keyWarnings: ["conflicting_key:7", "conflicting_key:7"],
    });
    expect(s.items).toHaveLength(200);
    expect(s.total).toBe(254);
    expect(s.knownCount).toBe(252);
    expect(s.unknownCount).toBe(2);
    expect(s.truncated).toBe(true);
    expect(
      s.items.reduce((a, i) => a + i.count, 0) + s.omittedKnownCount!,
    ).toBe(252);
    expect(JSON.stringify(s)).not.toContain("patient");
  });
  it("preserves immutable phases and current post-claim attempt; never resurrects prior receipt", async () => {
    const p = plan(),
      m = memory();
    await persistWarningArtifact(
      p,
      "owned",
      {
        phase: "key_parse",
        complete: false,
        keyWarnings: ["conflicting_key:2"],
      },
      async () => p,
      m.storage,
    );
    await persistWarningArtifact(p, "owned", parsed, async () => p, m.storage);
    expect(m.objects.size).toBe(2);
    expect((await readWarningArtifact(p, 2, "failed", m.storage)).phase).toBe(
      "parsed",
    );
    expect((await readWarningArtifact(p, 3, "queued", m.storage)).reason).toBe(
      "pending",
    );
    const absent = await readWarningArtifact(p, 3, "failed", m.storage);
    expect(absent.reason).toBe("not_recorded");
    expect(absent.total).toBeNull();
    expect(warningArtifactKey(p, 2, "parsed")).toContain(
      "attempt-2/parsed.json",
    );
    expect(warningPlanHash({ ...p, parserVersion: "v6" })).not.toBe(
      warningPlanHash(p),
    );
  });
  it("replays exact same phase without rewriting and rejects changed same-phase body", async () => {
    const p = plan(),
      m = memory();
    await persistWarningArtifact(p, "owned", parsed, async () => p, m.storage);
    await persistWarningArtifact(p, "owned", parsed, async () => p, m.storage);
    expect(m.storage.put).toHaveBeenCalledOnce();
    await expect(
      persistWarningArtifact(
        p,
        "owned",
        { ...parsed, examWarnings: [] },
        async () => p,
        m.storage,
      ),
    ).rejects.toThrow("warning_immutable_conflict");
    expect(m.storage.remove).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "expired", "token", "attempt", "plan"])(
    "rejects %s before private IO",
    async (change) => {
      const p = plan(),
        r = { ...p };
      if (change === "cancelled") r.status = "cancelled";
      if (change === "expired") r.leaseUntil = new Date(0);
      if (change === "token") r.workerId = "other";
      if (change === "attempt") r.attempt++;
      if (change === "plan") r.answerKeyPages = [4];
      const m = memory();
      await expect(
        persistWarningArtifact(p, "owned", parsed, async () => r, m.storage),
      ).rejects.toThrow();
      expect(m.storage.put).not.toHaveBeenCalled();
      expect(m.storage.head).not.toHaveBeenCalled();
    },
  );
  it("cancel/attempt loss after PUT cleans only own newly created orphan, no current-attempt reuse", async () => {
    const p = plan(),
      m = memory();
    let read = 0;
    await expect(
      persistWarningArtifact(
        p,
        "owned",
        parsed,
        async () => (++read === 1 ? p : { ...p, attempt: 3, workerId: "new" }),
        m.storage,
      ),
    ).rejects.toThrow("lease_lost");
    expect(m.storage.remove).toHaveBeenCalledWith(
      warningArtifactKey(p, 2, "parsed"),
    );
    expect(m.objects.size).toBe(0);
  });
  it("storage verification failure is explicit and cleanup is bounded to new key", async () => {
    const p = plan(),
      m = memory();
    m.storage.put = vi.fn(async (k) => {
      m.objects.set(k, new Uint8Array([1]));
    });
    await expect(
      persistWarningArtifact(p, "owned", parsed, async () => p, m.storage),
    ).rejects.toThrow("warning_artifact_invalid");
    expect(m.storage.remove).toHaveBeenCalledOnce();
  });
  it("rejects oversized, malformed and mismatched artifact, never turns failure into available zero", async () => {
    const p = plan(),
      m = memory(),
      k = warningArtifactKey(p, 2, "parsed");
    m.objects.set(k, new Uint8Array(WARNING_BYTES + 1));
    await expect(
      readWarningArtifact(p, 2, "review", m.storage),
    ).rejects.toThrow("warning_artifact_invalid");
    m.objects.set(k, new TextEncoder().encode("{}"));
    await expect(
      readWarningArtifact(p, 2, "review", m.storage),
    ).rejects.toThrow();
    m.objects.set(
      k,
      new TextEncoder().encode(
        JSON.stringify({
          ...summarizeWarnings(p, 2, parsed),
          planHash: "c".repeat(64),
        }),
      ),
    );
    await expect(
      readWarningArtifact(p, 2, "review", m.storage),
    ).rejects.toThrow("warning_plan_mismatch");
  });
  it("key parse incomplete snapshot reports known warnings and typed failure with unknown totals", () => {
    const s = summarizeWarnings(plan(), 2, {
      phase: "exam_parse",
      complete: false,
      keyWarnings: ["unknown_or_ambiguous_key:7"],
      errorCode: "secret SQL body",
    });
    expect(s.errorCode).toBe("parser_failed");
    expect(s.knownCount).toBe(1);
    expect(s.total).toBeNull();
    expect(s.detectedCandidates).toBeNull();
    expect(JSON.stringify(s)).not.toContain("secret");
  });
});

describe("diagnostic bounds and conservative orphan cleanup", () => {
  it("whitelists margin and reviewed-page metadata, counts invalid bounds only as unknown", () => {
    const p = plan(),
      s = summarizeWarnings(p, 2, {
        phase: "key_parse",
        complete: false,
        errorCode: "ambiguous_key_geometry",
        examWarnings: [
          "reviewed_non_question_page:38",
          "reviewed_non_question_page:501",
          "margin_omitted:1:known_margin",
          "margin_omitted:2:repeated_margin",
          "margin_omitted:501:known_margin",
        ],
        keyWarnings: ["no_answer_keys_detected"],
      });
    expect(s.knownCount).toBe(4);
    expect(s.unknownCount).toBe(2);
    expect(s.errorCode).toBe("ambiguous_key_geometry");
    expect(s.items).toContainEqual({
      source: "exam",
      code: "margin_omitted",
      page: 1,
      reason: "known_margin",
      count: 1,
    });
    expect(s.total).toBeNull();
    expect(
      warningPlanHash({ ...p, excludedPages: [2, 1], answerKeyPages: [4, 3] }),
    ).toBe(
      warningPlanHash({ ...p, excludedPages: [1, 2], answerKeyPages: [3, 4] }),
    );
  });
  it("rejects an invalid UUID or fractional attempt and never queries an unclaimed attempt", async () => {
    const p = plan(),
      m = memory();
    expect(() =>
      warningArtifactKey({ ...p, importId: "-".repeat(36) }, 2, "parsed"),
    ).toThrow("warning_plan_invalid");
    expect(() => warningArtifactKey(p, 1.5, "parsed")).toThrow(
      "warning_plan_invalid",
    );
    const absent = await readWarningArtifact(p, 0, "queued", m.storage);
    expect(absent.reason).toBe("pending");
    expect(m.storage.head).not.toHaveBeenCalled();
  });
  it("records a cleanup failure safely without masking the lease error or deleting preexisting receipts", async () => {
    const p = plan(),
      m = memory(),
      pending = vi.fn();
    let count = 0;
    m.storage.remove = vi.fn(async () => {
      throw Error("storage down");
    });
    await expect(
      persistWarningArtifact(
        p,
        "owned",
        parsed,
        async () => (++count === 1 ? p : { ...p, status: "cancelled" }),
        m.storage,
        pending,
      ),
    ).rejects.toThrow("cancelled");
    expect(pending).toHaveBeenCalledOnce();
    expect(m.objects.size).toBe(1);
  });
  it("keeps an uncertain same-attempt object if a different live owner could use it, and signals cleanup pending", async () => {
    const p = plan(),
      m = memory(),
      pending = vi.fn();
    let count = 0;
    await expect(
      persistWarningArtifact(
        p,
        "owned",
        parsed,
        async () => (++count === 1 ? p : { ...p, workerId: "different" }),
        m.storage,
        pending,
      ),
    ).rejects.toThrow("lease_lost");
    expect(pending).toHaveBeenCalledOnce();
    expect(m.storage.remove).not.toHaveBeenCalled();
  });
  it("rejects a valid JSON receipt with wrong content type or read length", async () => {
    const p = plan(),
      m = memory();
    await persistWarningArtifact(p, "owned", parsed, async () => p, m.storage);
    const original = m.storage.head;
    m.storage.head = async (k) => {
      const h = await original(k);
      return h ? { ...h, mime: "text/plain" } : null;
    };
    await expect(
      readWarningArtifact(p, 2, "review", m.storage),
    ).rejects.toThrow("warning_artifact_invalid");
    m.storage.head = original;
    m.storage.read = async () => new Uint8Array([1, 2]);
    await expect(
      readWarningArtifact(p, 2, "review", m.storage),
    ).rejects.toThrow("warning_artifact_invalid");
  });
});
