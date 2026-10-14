import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { readPdfLayout } from "@remoa/ai";
import {
  parseEnade2023AnswerKey,
  EnadeAnswerKeyError,
  type EnadeAnswerKeyScope,
} from "./enade-answer-key";
import type { PdfLayoutPage, PdfLayoutItem } from "./types";
const sha = "b75fefac9643c2622f28785b1849b1aaad1077724123f084a4d74d7a9cf31d6d";
const scope = (
  objective = [1, 2],
  discursive = [1, 2],
): EnadeAnswerKeyScope => ({
  documentId: "11111111-1111-4111-8111-111111111111",
  documentSha256: sha,
  year: 2023,
  course: "Medicina",
  bookletIdentity: { code: "18", label: "MEDICINA" },
  identityVerified: true,
  finality: "final",
  expectedObjectiveNumbers: objective,
  expectedDiscursiveNumbers: discursive,
});
const item = (
  text: string,
  x: number,
  y: number,
  width = 80,
): PdfLayoutItem => ({ text, x, y, width, height: 10 });
const p = (rows: [string, string][]): PdfLayoutPage => ({
  page: 1,
  width: 600,
  height: 850,
  items: [
    item("GABARITO DEFINITIVO", 200, 50, 130),
    item("Item", 180, 80, 30),
    item("Gabarito", 350, 80, 50),
    ...rows.flatMap(([q, k], i) => [
      item(q, 150, 110 + i * 20, 150),
      item(k, 355, 110 + i * 20, 40),
    ]),
  ],
});
const valid = () =>
  p([
    ["QUESTÃO DISCURSIVA 1", "***"],
    ["QUESTÃO 1", "D"],
    ["QUESTÃO 2", "A"],
    ["QUESTÃO DISCURSIVA 2", "***"],
  ]);
const error = (fn: () => unknown, code: string) => {
  try {
    fn();
    throw Error("expected error");
  } catch (e) {
    expect(e).toBeInstanceOf(EnadeAnswerKeyError);
    expect(e).toMatchObject({ code });
  }
};
describe("scoped ENADE2023 final key helper", () => {
  it("separates discursive1/2 from objective1/2 with rawgeometry", () => {
    const r = parseEnade2023AnswerKey([valid()], scope());
    expect(r.entries.map((e) => [e.number, e.key])).toEqual([
      [1, "D"],
      [2, "A"],
    ]);
    expect(r.discursiveRows.map((e) => [e.number, e.raw])).toEqual([
      [1, "***"],
      [2, "***"],
    ]);
    expect(r.structuralNeedsReview).toBe(false);
    expect(r.entries[0]!.provenance).toMatchObject({
      page: 1,
      method: "text",
      bbox: { x: 150, y: 130, width: 245, height: 10 },
    });
  });
  it.each(["unknown", "preliminary"] as const)(
    "blocks %s finality",
    (finality) =>
      error(
        () => parseEnade2023AnswerKey([valid()], { ...scope(), finality }),
        "finality_pending",
      ),
  );
  it("2010 finalityunknown remains unsupported", () =>
    error(
      () =>
        parseEnade2023AnswerKey([valid()], {
          ...scope(),
          year: 2010,
          finality: "unknown",
        }),
      "unsupported_year",
    ));
  it.each([
    { identityVerified: false },
    { documentSha256: "bad" },
    { documentId: "-".repeat(36) },
    { course: "" },
    { expectedObjectiveNumbers: [2, 1] },
    { expectedObjectiveNumbers: [1, 1] },
    { expectedObjectiveNumbers: [] },
    { expectedDiscursiveNumbers: [0] },
    { bookletIdentity: { code: "18", label: "PSICOLOGIA" } },
  ])("requires verified scope %#", (patch) =>
    error(
      () => parseEnade2023AnswerKey([valid()], { ...scope(), ...patch }),
      "scope_unverified",
    ),
  );
  it("does not mutate caller scope", () => {
    const s = scope(),
      r = parseEnade2023AnswerKey([valid()], s);
    r.scope.expectedObjectiveNumbers = [9];
    expect(s.expectedObjectiveNumbers).toEqual([1, 2]);
  });
  it.each(["GABARITO PRELIMINAR", "GABARITO DEFINITIVO RETIFICADO"])(
    "unsupported header %s blocks",
    (header) => {
      const page = valid();
      page.items[0]!.text = header;
      error(() => parseEnade2023AnswerKey([page], scope()), "ambiguous_header");
    },
  );
  it.each(["GABARITO PRELIMINAR", "PROVA 19", "ENADE 2010"])(
    "conflicting metadata %s blocks",
    (header) => {
      const page = valid();
      page.items.push(item(header, 10, 30, 160));
      error(() => parseEnade2023AnswerKey([page], scope()), "ambiguous_header");
    },
  );
  it("accepts corroborated supplied caderno/year without inferring role", () => {
    const page = valid();
    page.items.push(item("PROVA 18", 10, 20), item("ENADE 2023", 200, 35));
    expect(parseEnade2023AnswerKey([page], scope()).group).toBe("18");
  });
  it("preserves annulled and unresolved letters/retification", () => {
    const r = parseEnade2023AnswerKey(
      [
        p([
          ["QUESTÃO 1", "ANULADA"],
          ["QUESTÃO 2", "B A"],
          ["QUESTÃO 3", "B (ALTERADO)"],
        ]),
      ],
      scope([1, 2, 3], []),
    );
    expect(
      r.entries.map((e) => [e.raw, e.key, e.annulled, e.ambiguous]),
    ).toEqual([
      ["ANULADA", null, true, false],
      ["B A", null, false, true],
      ["B (ALTERADO)", null, false, true],
    ]);
    expect(r.retifications[0]!.raw).toBe("B (ALTERADO)");
    expect(r.structuralNeedsReview).toBe(true);
  });
  it("separate ALTERADO preserves evidence and invalidates previouslysingleletter key", () => {
    const page = p([["QUESTÃO 1", "B"]]);
    page.items.push(item("(ALTERADO)", 350, 125, 70));
    const r = parseEnade2023AnswerKey([page], scope([1], []));
    expect(r.entries[0]).toMatchObject({
      key: null,
      raw: "B",
      ambiguous: true,
    });
    expect(r.retifications[0]).toMatchObject({ number: 1, raw: "(ALTERADO)" });
  });
  it("unknown token is not guessed", () => {
    const r = parseEnade2023AnswerKey(
      [p([["QUESTÃO 1", "NULA"]])],
      scope([1], []),
    );
    expect(r.entries[0]).toMatchObject({
      raw: "NULA",
      key: null,
      annulled: false,
      ambiguous: true,
    });
  });
  it("fused number/letter without percell geometry blocks", () => {
    const page = valid();
    page.items = page.items.filter(
      (i) => i.text !== "QUESTÃO 1" && !(i.y === 130 && i.x === 355),
    );
    page.items.push(item("QUESTÃO 1 D", 150, 130, 245));
    error(() => parseEnade2023AnswerKey([page], scope()), "ambiguous_cells");
  });
  it.each(
    (
      [
        [
          ["QUESTÃO 1", "D"],
          ["QUESTÃO 1", "D"],
        ],
        [["QUESTÃO 1", "D"]],
        [
          ["QUESTÃO 1", "D"],
          ["QUESTÃO 3", "A"],
        ],
      ] as [string, string][][]
    ).map((rows) => ({ rows })),
  )("duplicate/missing/unexpected enumeration blocks %#", ({ rows }) =>
    error(
      () => parseEnade2023AnswerKey([p(rows)], scope([1, 2], [])),
      "ambiguous_enumeration",
    ),
  );
  it.each(["missing", "fused"])("column header %s blocks", (mode) => {
    const page = valid();
    page.items = page.items.filter((i) => i.y !== 80);
    if (mode === "fused") page.items.push(item("Item Gabarito", 180, 80, 220));
    error(
      () => parseEnade2023AnswerKey([page], scope()),
      mode === "missing" ? "table_header_missing" : "ambiguous_cells",
    );
  });
  it("extra intermediate cells are not silently discarded", () => {
    const page = valid();
    page.items.push(item("unexpected", 310, 130, 30));
    error(() => parseEnade2023AnswerKey([page], scope()), "ambiguous_cells");
  });
  it("everyrawitem geometry must be valid even after table", () => {
    const page = valid();
    page.items.push({ ...item("later", 0, 230), x: NaN });
    error(() => parseEnade2023AnswerKey([page], scope()), "invalid_geometry");
  });
  it("empty/duplicatepages/out-of-bound items block", () => {
    error(() => parseEnade2023AnswerKey([], scope()), "invalid_geometry");
    error(
      () => parseEnade2023AnswerKey([valid(), valid()], scope()),
      "invalid_geometry",
    );
    const page = valid();
    page.items.push(item("outside", 599, 400, 20));
    error(() => parseEnade2023AnswerKey([page], scope()), "invalid_geometry");
  });
  it("perception questionnaire never inflates objective keys", () => {
    const page = p([["QUESTÃO 1", "D"]]);
    page.items.push(
      item("QUESTIONÁRIO DE PERCEPÇÃO DA PROVA", 50, 160, 350),
      item("QUESTÃO 1", 150, 180, 100),
      item("A", 355, 180, 10),
    );
    const r = parseEnade2023AnswerKey([page], scope([1], []));
    expect(r.entries).toHaveLength(1);
    expect(r.excludedPerceptionRows).toHaveLength(2);
  });
  it.each(["2 A", "ALTERADO"])("unrecognized row %s cannot vanish", (text) => {
    const page = p([["QUESTÃO 1", "D"]]);
    page.items.push(item(text, 180, 200, 90));
    if (text === "ALTERADO")
      page.items.push(
        item("QUESTÃO DISCURSIVA 1", 150, 180, 150),
        item("***", 355, 180, 30),
      );
    error(
      () =>
        parseEnade2023AnswerKey(
          [page],
          scope([1], text === "ALTERADO" ? [1] : []),
        ),
      "unrecognized_row",
    );
  });
  it("realMD18 matches original independent8keys and all25visualgold cells", async () => {
    const base = new URL("./fixtures/enade-2023-medicine/", import.meta.url);
    const bytes = new Uint8Array(
      await readFile(new URL("answer-key.pdf", base)),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
    const layout = await readPdfLayout(bytes);
    const r = parseEnade2023AnswerKey(
      layout.pages,
      scope(Array.from({ length: 38 }, (_, i) => i + 1)),
    );
    const eight = [
      [11, "C"],
      [12, "D"],
      [13, "D"],
      [14, "D"],
      [15, "C"],
      [16, "A"],
      [17, "C"],
      [18, "C"],
    ];
    expect(
      r.entries
        .filter((e) => e.number >= 11 && e.number <= 18)
        .map((e) => [e.number, e.key]),
    ).toEqual(eight);
    const goldBytes = await readFile(new URL("visual-gold.json", base));
    expect(createHash("sha256").update(goldBytes).digest("hex")).toBe(
      "736188187c5cb679942ae92ca8168c6f0fc25de8461bdb4d8f9dbf95683fb477",
    );
    const gold = JSON.parse(goldBytes.toString());
    for (const e of gold.questions)
      expect(r.entries.find((k) => k.number === e.number)?.key).toBe(e.answer);
    expect(r.entries).toHaveLength(38);
    expect(r.discursiveRows.map((e) => e.raw)).toEqual(["***", "***"]);
    expect(r.warnings).toEqual([]);
  });
});
