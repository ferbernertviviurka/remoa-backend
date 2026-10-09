import { beforeEach, describe, it, expect, vi } from "vitest";
const f = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  objects: new Map<string, Buffer>(),
  put: vi.fn(),
  read: vi.fn(),
  head: vi.fn(),
  remove: vi.fn(),
  tx: false,
}));
const query = () => {
  const q = { innerJoin: () => q, where: async () => [f.row] };
  return { from: () => q };
};
vi.mock("../../db", () => ({
  dbm: async () => ({
    db: {
      select: query,
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              f.row = {
                ...f.row,
                ...v,
                attempt: (f.row.attempt as number) + 1,
              };
              return [{ id: f.row.importId }];
            },
          }),
        }),
      }),
    },
    questionImports: {},
    questionDocuments: {},
    examPapers: {},
  }),
}));
vi.mock("../../storage/storage", () => ({
  headObject: f.head,
  getBytes: f.read,
  putBytes: f.put,
  deleteObject: f.remove,
}));
import { importWorkerStore, parserWarningStorage } from "./store";
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.clearAllMocks();
  f.objects.clear();
  f.row = {
    importId: id,
    parserVersion: "historic-version",
    ocrVersion: null,
    documentId: "doc",
    documentSha256: "a".repeat(64),
    answerKeyDocumentId: null,
    answerKeyPages: null,
    booklet: "1",
    excludedPages: [],
    ocrEnabled: true,
    attempt: 0,
    workerId: null,
    leaseUntil: null,
    status: "queued",
  };
  f.head.mockImplementation(async (k: string) =>
    f.objects.has(k)
      ? { size: f.objects.get(k)!.length, mime: "application/json" }
      : null,
  );
  f.read.mockImplementation(async (k: string) => f.objects.get(k)!);
  f.put.mockImplementation(async (k: string, b: Buffer) => {
    f.objects.set(k, b);
  });
  f.remove.mockImplementation(async (k: string) => {
    f.objects.delete(k);
  });
});
describe("production store warning ownership snapshot", () => {
  it("uses attempts returned by owned database metadata after claim, not a preclaim job snapshot", async () => {
    const store = importWorkerStore();
    await store.claim(id, "worker-one");
    await store.saveParserWarnings(id, {
      phase: "parsed",
      complete: true,
      detectedCandidates: 0,
      detectedContexts: 0,
      examWarnings: ["no_questions_detected"],
    });
    const [k, b] = [...f.objects.entries()][0]!;
    expect(k).toContain("/attempt-1/parsed.json");
    const dto = JSON.parse(b.toString());
    expect(dto.attempt).toBe(1);
    expect(dto.parserVersion).toBe("historic-version");
    expect(dto.ocrVersion).toBeNull();
  });
  it("refuses an expired or replaced owner after claim before PUT, without inventing a receipt", async () => {
    const store = importWorkerStore();
    await store.claim(id, "worker-one");
    f.row.workerId = "worker-two";
    await expect(
      store.saveParserWarnings(id, { phase: "key_parse", complete: false }),
    ).rejects.toThrow("lease_lost");
    expect(f.put).not.toHaveBeenCalled();
  });
});

it("shares a single caller deadline across every storage operation, with bounded streaming reads", async () => {
  const signal = AbortSignal.timeout(10000),
    storage = parserWarningStorage(signal),
    bytes = Buffer.from("{}");
  await storage.head("derived-key");
  await storage.read("derived-key", 128 * 1024);
  await storage.put("derived-key", bytes);
  await storage.remove("derived-key");
  expect(f.head).toHaveBeenCalledWith("derived-key", signal);
  expect(f.read).toHaveBeenCalledWith("derived-key", {
    maxBytes: 128 * 1024,
    signal,
  });
  expect(f.put).toHaveBeenCalledWith(
    "derived-key",
    bytes,
    "application/json",
    signal,
  );
  expect(f.remove).toHaveBeenCalledWith("derived-key", signal);
});
