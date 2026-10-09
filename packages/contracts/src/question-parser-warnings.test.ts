import { describe, it, expect } from "vitest";
import { questionParserWarningsDataSchema } from "./question-parser-warnings";
const base = {
  importId: "00000000-0000-4000-8000-000000000001",
  parserVersion: "historic-v5",
  ocrVersion: "best",
  attempt: 1,
  planHash: "a".repeat(64),
  availability: "available",
  reason: null,
  phase: "parsed",
  complete: true,
  errorCode: null,
  detectedCandidates: 0,
  detectedContexts: 0,
  total: 0,
  knownCount: 0,
  unknownCount: 0,
  omittedKnownCount: 0,
  items: [],
  truncated: false,
};
describe("private parser warnings contract", () => {
  it("distinguishes actual parsed zero from absent/null and incomplete key diagnostics", () => {
    expect(questionParserWarningsDataSchema.safeParse(base).success).toBe(true);
    const absent = {
      ...base,
      availability: "not_available",
      reason: "not_recorded",
      phase: null,
      complete: false,
      detectedCandidates: null,
      detectedContexts: null,
      total: null,
      knownCount: null,
      unknownCount: null,
      omittedKnownCount: null,
    };
    expect(questionParserWarningsDataSchema.safeParse(absent).success).toBe(
      true,
    );
    expect(
      questionParserWarningsDataSchema.safeParse({ ...absent, total: 0 })
        .success,
    ).toBe(false);
    expect(
      questionParserWarningsDataSchema.safeParse({
        ...base,
        phase: "key_parse",
        complete: false,
        total: null,
        detectedCandidates: null,
        detectedContexts: null,
        errorCode: "group_not_found",
      }).success,
    ).toBe(true);
    expect(
      questionParserWarningsDataSchema.safeParse({
        ...base,
        complete: false,
        phase: "key_parse",
      }).success,
    ).toBe(false);
  });
  it("validates coded-only metadata, bounded items and count/truncation consistency", () => {
    const item = {
      source: "exam",
      code: "missing_question",
      number: 2,
      count: 1,
    };
    const full = { ...base, items: [item], total: 1, knownCount: 1 };
    expect(questionParserWarningsDataSchema.safeParse(full).success).toBe(true);
    for (const changed of [
      { ...item, text: "sensitive" },
      { ...item, number: 0 },
      { ...item, page: 1 },
      { ...item, code: "free_body" },
    ])
      expect(
        questionParserWarningsDataSchema.safeParse({
          ...full,
          items: [changed],
        }).success,
      ).toBe(false);
    expect(
      questionParserWarningsDataSchema.safeParse({ ...full, knownCount: 2 })
        .success,
    ).toBe(false);
    expect(
      questionParserWarningsDataSchema.safeParse({
        ...full,
        items: Array(201).fill(item),
        knownCount: 201,
        total: 201,
      }).success,
    ).toBe(false);
    expect(
      questionParserWarningsDataSchema.safeParse({
        ...full,
        knownCount: 2,
        omittedKnownCount: 1,
        total: 2,
        truncated: true,
      }).success,
    ).toBe(true);
    expect(
      questionParserWarningsDataSchema.safeParse({
        ...base,
        errorCode: "SQL containing patient",
      }).success,
    ).toBe(false);
    expect(
      questionParserWarningsDataSchema.safeParse({
        ...base,
        objectKey: "private/key",
      }).success,
    ).toBe(false);
  });
});
