import { describe, it, expect } from "vitest";
import { parseExam } from "./parser";
import type { PdfLayoutPage } from "./types";
const item = (text: string, x: number, y: number) => ({
  text,
  x,
  y,
  width: Math.min(220, text.length * 5),
  height: 10,
});
const page = (
  number: number,
  lines: ReturnType<typeof item>[],
): PdfLayoutPage => ({ page: number, width: 600, height: 800, items: lines });
describe("v2 margin evidence before column ordering", () => {
  it("omits repeated top margins before columns and preserves their original region as review evidence", () => {
    const pages = [1, 2].map((n) =>
      page(n, [
        item("PROVA C10", 10, 15),
        item("CADERNO ESPECIAL", 330, 15),
        item(`Questão ${n * 2 - 1}`, 10, 80),
        item("Stem left", 10, 100),
        item("(A) One", 10, 120),
        item("(B) Two", 10, 140),
        item(`Questão ${n * 2}`, 330, 80),
        item("Stem right", 330, 100),
        item("(A) One", 330, 120),
        item("(B) Two", 330, 140),
        item(`Página ${n}`, 10, 780),
      ]),
    );
    const result = parseExam(pages);
    expect(result.candidates).toHaveLength(4);
    expect(
      result.candidates.every(
        (c) => c.alternatives[1]!.text === "Two" && c.provenance.length === 1,
      ),
    ).toBe(true);
    expect(
      result.removedMargins?.filter((m) => m.text === "CADERNO ESPECIAL"),
    ).toHaveLength(2);
    expect(result.removedMargins?.[0]).toMatchObject({
      page: 1,
      bbox: { x: 10, y: 15, width: 45, height: 10 },
      reason: "known_margin",
    });
    expect(result.warnings).toContain("margin_omitted:1:repeated_margin");
  });
  it("retains body text starting PROVA or CADERNO and genuine alternatives continuing on another page", () => {
    const first = page(1, [
      item("Questão 1", 10, 40),
      item("PROVA negativa; não trocar 2 kg.", 10, 55),
      item("CADERNO clínico completo.", 10, 100),
      item("(A) First", 10, 140),
    ]);
    const second = page(2, [
      item("PROVA negativa permanece no enunciado.", 10, 30),
      item("(B) Second", 10, 100),
      item("CADERNO do relato continua.", 10, 120),
    ]);
    const result = parseExam([first, second]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.stem).toBe(
      "PROVA negativa; não trocar 2 kg. CADERNO clínico completo.",
    );
    expect(result.candidates[0]!.alternatives).toEqual([
      { key: "A", text: "First PROVA negativa permanece no enunciado." },
      { key: "B", text: "Second CADERNO do relato continua." },
    ]);
    expect(result.candidates[0]!.provenance.map((p) => p.page)).toEqual([1, 2]);
    expect(result.removedMargins).toEqual([]);
  });
  it("preserves one-off top notes and body page labels outside the footer band", () => {
    const result = parseExam([
      page(1, [
        item("Questão 1", 10, 40),
        item("Processo Seletivo é o tema desta questão.", 10, 60),
        item("Página 2", 10, 100),
        item("(A) First", 10, 120),
        item("(B) Second", 10, 140),
      ]),
    ]);
    expect(result.candidates[0]!.stem).toBe(
      "Processo Seletivo é o tema desta questão. Página 2",
    );
    expect(result.removedMargins).toEqual([]);
  });
  it("preserves metadata-like clinical text above the next marker on a continuation page", () => {
    const first = page(1, [
      item("Questão 1", 10, 100),
      item("Stem", 10, 120),
      item("(A) First", 10, 150),
    ]);
    const second = page(2, [
      item("PROVA ABC1 negativa; não trocar 2 kg.", 10, 30),
      item("Processo Seletivo ocorre neste relato; dose 2 kg.", 10, 45),
      item("(B) Second", 10, 120),
      item("Questão 2", 10, 180),
      item("Next stem", 10, 200),
      item("(A) One", 10, 230),
      item("(B) Two", 10, 250),
    ]);
    const result = parseExam([first, second]);
    expect(result.candidates[0]!.alternatives[0]!.text).toBe(
      "First PROVA ABC1 negativa; não trocar 2 kg. Processo Seletivo ocorre neste relato; dose 2 kg.",
    );
    expect(result.removedMargins).toEqual([]);
  });
  it("never omits a repeated clinical negation on continuation pages merely because of matching coordinates", () => {
    const pages = [
      page(1, [
        item("Questão 1", 10, 100),
        item("Stem", 10, 120),
        item("(A) First", 10, 150),
      ]),
      page(2, [
        item("Não substituir 2 kg.", 10, 30),
        item("(B) Second", 10, 120),
      ]),
      page(3, [item("Não substituir 2 kg.", 10, 30)]),
    ];
    const result = parseExam(pages);
    expect(result.candidates[0]!.alternatives).toEqual([
      { key: "A", text: "First Não substituir 2 kg." },
      { key: "B", text: "Second Não substituir 2 kg." },
    ]);
    expect(result.removedMargins).toEqual([]);
    expect(result.candidates[0]!.provenance.map((p) => p.page)).toEqual([
      1, 2, 3,
    ]);
  });
  it("learns a repeated custom title only from the first question page's paired metadata cluster", () => {
    const title = "Processo Seletivo - título autoral completo";
    const pages = [1, 2].map((n) =>
      page(n, [
        item("PROVA ABC1", 10, 15),
        item(title, 10, 30),
        item("Questão " + n, 10, 100),
        item("Stem", 10, 120),
        item("(A) One", 10, 140),
        item("(B) Two", 10, 160),
      ]),
    );
    const result = parseExam(pages);
    expect(result.candidates[0]!.alternatives[1]!.text).toBe("Two");
    expect(result.removedMargins?.filter((m) => m.text === title)).toHaveLength(
      2,
    );
  });
  it("preserves title-like clinical repetitions that occur only on continuation pages", () => {
    const first = page(1, [
      item("Questão 1", 10, 100),
      item("Stem", 10, 120),
      item("(A) First", 10, 140),
    ]);
    const second = page(2, [
      item("PROVA ABC1", 10, 15),
      item("Processo Seletivo - não substituir 2 kg.", 10, 30),
      item("(B) Second", 10, 100),
    ]);
    const third = page(3, [
      item("PROVA ABC1", 10, 15),
      item("Processo Seletivo - não substituir 2 kg.", 10, 30),
    ]);
    const result = parseExam([first, second, third]);
    expect(result.candidates[0]!.alternatives.map((a) => a.text)).toEqual([
      "First Processo Seletivo - não substituir 2 kg.",
      "Second Processo Seletivo - não substituir 2 kg.",
    ]);
    expect(
      result.removedMargins?.some((m) => m.text.startsWith("Processo")),
    ).toBe(false);
  });
  it("does not infer custom titles below markers, away from the label, larger than it or without a paired label", () => {
    for (const [x, y, height, label] of [
      [10, 110, 10, true],
      [200, 30, 10, true],
      [10, 50, 20, true],
      [10, 30, 20, true],
      [10, 30, 10, false],
    ] as const) {
      const title = {
        ...item("Processo Seletivo - enunciado integral", x, y),
        height,
      };
      const pages = [1, 2].map((n) =>
        page(n, [
          ...(label ? [item("PROVA ABC1", 10, 15)] : []),
          title,
          item("Questão " + n, 10, 100),
          item("Stem", 10, 130),
          item("(A) One", 10, 160),
          item("(B) Two", 10, 180),
        ]),
      );
      expect(
        parseExam(pages).removedMargins?.some((m) =>
          m.text.startsWith("Processo"),
        ),
      ).toBe(false);
    }
  });
});
