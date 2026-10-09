import { afterAll, describe, expect, it } from "vitest";
import { contentHash } from "./domain";

const url = process.env.DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    target.pathname !== "/remoa_f33_test_20261008"
  )
    throw Error("local isolated f33_test required");
}

describe.skipIf(!url)("CCR119 actual JSONB content hash roundtrip", () => {
  let db: typeof import("@remoa/db").db.$client;
  afterAll(async () => {
    if (db) await db.end({ timeout: 1 });
  });
  it("retains the input hash after JSONB recursively reorders object keys", async () => {
    db = (await import("@remoa/db")).db.$client;
    const input = {
      stem: "Synthetic unchanged content 2 kg. Não alterar.",
      alternatives: [
        { key: "A", text: "One" },
        { key: "B", text: "Two" },
      ],
      correctKey: "A",
      explanation: "Synthetic explanation",
      areaId: null,
      topicId: null,
      annulled: false,
      assets: [
        {
          id: "synthetic-image",
          objectKey: "questions/imports/synthetic.png",
          alt: "Original diagram",
          provenance: {
            documentId: "synthetic-document",
            page: 1,
            bbox: [0, 0, 1, 1],
          },
        },
      ],
    };
    // PostgreSQL is the independent roundtrip here; no question or signature is rewritten.
    const [row] =
      await db`SELECT ${JSON.stringify(input.assets)}::jsonb AS assets, ${JSON.stringify(input.alternatives)}::jsonb AS alternatives`;
    expect(
      contentHash({
        ...input,
        assets: row!.assets,
        alternatives: row!.alternatives,
      }),
    ).toBe(contentHash(input));
  });
});
