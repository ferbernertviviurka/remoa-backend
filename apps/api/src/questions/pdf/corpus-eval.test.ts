import { describe, it, expect } from "vitest";
import { evaluateCorpusDocument, type CorpusGoldDocument } from "./corpus-eval";
import type { QuestionCandidate } from "./types";
const doc: CorpusGoldDocument = {
  id: "test",
  exam: "exam",
  answerKey: "key",
  feature: "unit",
  pageCount: 1,
  questions: [
    {
      number: 1,
      stem: "Não alterar 2 kg.",
      alternatives: [
        { key: "A", text: "2²" },
        { key: "B", text: "2" },
      ],
      finalKey: "A",
      annulled: false,
      expectedAmbiguity: false,
      requiresVisual: false,
      provenance: [{ page: 1, bbox: [0, 0, 1, 1], method: "text" }],
    },
  ],
};
const candidate: QuestionCandidate = {
  originalNumber: 1,
  stem: doc.questions[0]!.stem,
  alternatives: doc.questions[0]!.alternatives,
  correctKey: "A",
  annulled: false,
  provenance: [
    { page: 1, bbox: { x: 0, y: 0, width: 10, height: 10 }, method: "text" },
  ],
  imageRefs: [],
  confidence: { stem: 1, alternatives: 1, answerKey: 1 },
  issues: [],
  status: "staging",
};
describe("FR31 evaluator independent adversarial checks", () => {
  it("includes misses in every denominator and rejects duplicate segmentation", () => {
    const missing = evaluateCorpusDocument(doc, []);
    expect(missing.segmentation.recall).toBe(0);
    expect(missing.fields.exactStructure).toMatchObject({
      correct: 0,
      denominator: 1,
    });
    expect(
      evaluateCorpusDocument(doc, [candidate, candidate]).segmentation,
    ).toMatchObject({ truePositives: 0, falsePositives: 2, falseNegatives: 1 });
  });
  it("detects independent gold perturbation without consulting parser predictions", () => {
    expect(
      evaluateCorpusDocument(doc, [candidate]).fields.exactStructure?.recall,
    ).toBe(1);
    const changed = {
      ...doc,
      questions: [
        { ...doc.questions[0]!, finalKey: "B", stem: "Alterar 20 kg." },
      ],
    };
    expect(
      evaluateCorpusDocument(changed, [candidate]).fields.exactStructure
        ?.recall,
    ).toBe(0);
  });
  it("does not erase punctuation, negation, doses or units to inflate matches", () => {
    for (const stem of [
      "Alterar 2 kg.",
      "Não alterar 20 kg.",
      "Não alterar 2 g.",
      "Não alterar 2 kg!",
    ])
      expect(
        evaluateCorpusDocument(doc, [{ ...candidate, stem }]).fields.stem
          ?.correct,
      ).toBe(0);
  });
  it("reports safe ambiguity separately from final key correctness", () => {
    const gold = {
      ...doc,
      questions: [{ ...doc.questions[0]!, expectedAmbiguity: true }],
    };
    const result = evaluateCorpusDocument(gold, [
      { ...candidate, correctKey: null, issues: ["ambiguous_answer_key"] },
    ]);
    expect(result.safety.ambiguousBlocked).toBe(1);
    expect(result.fields.answerKey?.correct).toBe(0);
  });
  it("does not call a visually dependent item exact when neither image nor staging issue preserves review", () => {
    const visual = {
      ...doc,
      questions: [{ ...doc.questions[0]!, requiresVisual: true }],
    };
    expect(
      evaluateCorpusDocument(visual, [candidate]).fields.exactStructure
        ?.correct,
    ).toBe(0);
    expect(
      evaluateCorpusDocument(visual, [
        { ...candidate, issues: ["figure_geometry_unknown"] },
      ]).fields.exactStructure?.correct,
    ).toBe(1);
    expect(
      evaluateCorpusDocument(doc, [
        {
          ...candidate,
          provenance: [
            {
              ...candidate.provenance[0]!,
              bbox: { x: 0, y: 0, width: NaN, height: 10 },
            },
          ],
        },
      ]).fields.provenanceValid?.correct,
    ).toBe(0);
  });
  it("counts unexpected predictions in precision and invalid structure in rejection", () => {
    const extra = {
      ...candidate,
      originalNumber: 2,
      alternatives: [],
      issues: ["missing_stem" as const],
    };
    const report = evaluateCorpusDocument(doc, [candidate, extra]);
    expect(report.segmentation).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
      precision: 0.5,
      recall: 1,
    });
    expect(report.fields.stem?.precision).toBe(0.5);
    expect(report.structurallyRejected).toBe(1);
  });
  it("detects wrong provenance pages/methods and altered alternative ordering", () => {
    const changed = {
      ...candidate,
      alternatives: [...candidate.alternatives].reverse(),
      provenance: [
        { ...candidate.provenance[0]!, page: 2, method: "ocr" as const },
      ],
    };
    const report = evaluateCorpusDocument(doc, [changed]);
    for (const field of [
      "alternatives",
      "pages",
      "provenanceValid",
      "provenanceBounds",
      "provenanceMethod",
      "exactStructure",
    ])
      expect(report.fields[field]?.correct).toBe(0);
  });
  it("recognizes bounded visual references and explicit anulation without inventing a key", () => {
    const visual = {
      ...doc,
      questions: [
        {
          ...doc.questions[0]!,
          requiresVisual: true,
          annulled: true,
          finalKey: null,
        },
      ],
    };
    const valid = {
      ...candidate,
      annulled: true,
      correctKey: null,
      imageRefs: [candidate.provenance[0]!],
    };
    const report = evaluateCorpusDocument(visual, [valid]);
    expect(report.fields.exactStructure?.correct).toBe(1);
    expect(
      evaluateCorpusDocument(visual, [{ ...valid, annulled: false }]).fields
        .annulled?.correct,
    ).toBe(0);
  });
  it("rejects malformed visual evidence and an unresolved ambiguity without suppressing losses", () => {
    const dependent = { ...doc, questions: [{ ...doc.questions[0]!, requiresVisual: true, expectedAmbiguity: true }] };
    const broken = { ...candidate, correctKey: null, provenance: [], imageRefs: [{ ...candidate.provenance[0]!, bbox: { x: 0, y: 0, width: 0, height: 10 } }], issues: ["duplicate_alternative" as const] };
    const result = evaluateCorpusDocument(dependent, [broken]);
    expect(result.safety.ambiguousBlocked).toBe(0);
    expect(result.fields.provenanceValid?.correct).toBe(0);
    expect(result.fields.visualHandling?.correct).toBe(0);
    expect(result.structurallyRejected).toBe(1);
  });
});
