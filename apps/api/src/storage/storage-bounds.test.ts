import { beforeEach, afterAll, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...(await original<object>()),
  S3Client: class {
    middlewareStack = { add: vi.fn() };
    send = mocks.send;
  },
}));
vi.mock("../perf", () => ({
  timeExternal: (_name: string, operation: () => unknown) => operation(),
}));
import { getBytes, headObject, putBytes, deleteObject } from "./storage";
beforeEach(() => {
  mocks.send.mockReset();
  for (const key of [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_BUCKET",
  ])
    vi.stubEnv(
      key,
      key === "S3_ENDPOINT" ? "http://localhost:9000" : "synthetic",
    );
});
afterAll(() => vi.unstubAllEnvs());
describe("private object IO optional bounds", () => {
  it("preserves legacy byte reads and existing write/delete/head defaults", async () => {
    mocks.send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2]) },
    });
    expect(await getBytes("legacy")).toEqual(Buffer.from([1, 2]));
    mocks.send.mockResolvedValueOnce({
      ContentLength: 2,
      ContentType: "image/png",
    });
    expect(await headObject("legacy")).toEqual({ size: 2, mime: "image/png" });
    mocks.send.mockResolvedValue({});
    await putBytes("legacy", Buffer.from([1]), "image/png");
    await deleteObject("legacy");
    expect(mocks.send).toHaveBeenCalledTimes(4);
  });
  it("enforces streaming byte caps and destroys the stream without consuming following chunks", async () => {
    const consumed: number[] = [],
      destroy = vi.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        for (const n of [1, 2, 3]) {
          consumed.push(n);
          yield Buffer.alloc(2);
        }
      },
    };
    mocks.send.mockResolvedValue({ Body: body });
    await expect(getBytes("bounded", { maxBytes: 3 })).rejects.toThrow(
      "storage_byte_limit",
    );
    expect(consumed).toEqual([1, 2]);
    expect(destroy).toHaveBeenCalledOnce();
    await expect(getBytes("bounded", { maxBytes: -1 })).rejects.toThrow(
      "invalid_storage_byte_limit",
    );
  });
  it("aborts streaming reads and forwards cancellation to all SDK operations", async () => {
    const controller = new AbortController(),
      destroy = vi.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from([1]);
        controller.abort();
        yield Buffer.from([2]);
      },
    };
    mocks.send.mockResolvedValueOnce({ Body: body });
    await expect(
      getBytes("abort", { signal: controller.signal, maxBytes: 10 }),
    ).rejects.toThrow("storage_read_aborted");
    expect(destroy).toHaveBeenCalled();
    expect(mocks.send.mock.calls[0]![1]).toEqual({
      abortSignal: controller.signal,
    });
    const fresh = new AbortController();
    mocks.send.mockResolvedValue({});
    await headObject("a", fresh.signal);
    await putBytes("a", Buffer.from([1]), "image/png", fresh.signal);
    await deleteObject("a", fresh.signal);
    for (const args of mocks.send.mock.calls.slice(1))
      expect(args[1]).toEqual({ abortSignal: fresh.signal });
  });
  it("handles pre-aborted and response-resolution abort races and declared oversized bodies before iteration", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      getBytes("a", { signal: controller.signal, maxBytes: 1 }),
    ).rejects.toThrow("storage_read_aborted");
    expect(mocks.send).not.toHaveBeenCalled();
    const race = new AbortController(),
      destroy = vi.fn(),
      iterated = vi.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        iterated();
        yield Buffer.from([1]);
      },
    };
    mocks.send.mockImplementationOnce(async () => {
      race.abort();
      return { Body: body };
    });
    await expect(
      getBytes("race", { signal: race.signal, maxBytes: 1 }),
    ).rejects.toThrow("storage_read_aborted");
    expect(destroy).toHaveBeenCalledOnce();
    expect(iterated).not.toHaveBeenCalled();
    mocks.send.mockResolvedValueOnce({ Body: body, ContentLength: 2 });
    await expect(getBytes("large", { maxBytes: 1 })).rejects.toThrow(
      "storage_byte_limit",
    );
    expect(iterated).not.toHaveBeenCalled();
  });
  it("returns null only for a missing object and propagates outages", async () => {
    mocks.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    expect(await headObject("missing")).toBeNull();
    mocks.send.mockRejectedValueOnce(Error("outage"));
    await expect(headObject("a")).rejects.toThrow("outage");
  });
});
