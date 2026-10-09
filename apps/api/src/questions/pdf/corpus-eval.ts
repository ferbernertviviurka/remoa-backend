import type { QuestionCandidate } from "./types";
export interface CorpusGoldQuestion {
  number: number;
  stem: string;
  alternatives: { key: string; text: string }[];
  finalKey: string | null;
  annulled: boolean;
  expectedAmbiguity: boolean;
  requiresVisual: boolean;
  provenance: { page: number; bbox: number[]; method: string }[];
}
export interface CorpusGoldDocument {
  id: string;
  exam: string;
  answerKey: string;
  feature: string;
  pageCount: number;
  questions: CorpusGoldQuestion[];
}
const text = (value: string) =>
  value.normalize("NFC").replace(/\s+/g, " ").trim();
const equalPages = (gold: CorpusGoldQuestion, c: QuestionCandidate) =>
  JSON.stringify(
    [...new Set(gold.provenance.map((p) => p.page))].sort((a, b) => a - b),
  ) ===
  JSON.stringify(
    [...new Set(c.provenance.map((p) => p.page))].sort((a, b) => a - b),
  );
export function evaluateCorpusDocument(
  doc: CorpusGoldDocument,
  predictions: QuestionCandidate[],
) {
  const expected = new Set(doc.questions.map((q) => q.number));
  const groups = new Map<number, QuestionCandidate[]>();
  for (const c of predictions)
    groups.set(c.originalNumber, [...(groups.get(c.originalNumber) ?? []), c]);
  const fields = {
    stem: 0,
    alternatives: 0,
    answerKey: 0,
    annulled: 0,
    pages: 0,
    provenanceValid: 0,
    provenanceBounds: 0,
    provenanceMethod: 0,
    visualHandling: 0,
    exactStructure: 0,
  };
  let truePositives = 0,
    missing = 0,
    ambiguousExpected = 0,
    ambiguousBlocked = 0,
    visualExpected = 0,
    visualFlagged = 0,
    requiresEdit = 0;
  const failures: { number: number; fields: string[] }[] = [];
  for (const q of doc.questions) {
    const matches = groups.get(q.number) ?? [],
      c = matches.length === 1 ? matches[0] : undefined;
    if (q.expectedAmbiguity) ambiguousExpected++;
    if (q.requiresVisual) visualExpected++;
    if (!c) {
      missing++;
      requiresEdit++;
      failures.push({
        number: q.number,
        fields: [
          matches.length ? "duplicate_segmentation" : "missing_segmentation",
        ],
      });
      continue;
    }
    truePositives++;
    const result = {
      stem: text(q.stem) === text(c.stem),
      alternatives:
        q.alternatives.length === c.alternatives.length &&
        q.alternatives.every(
          (a, i) =>
            a.key === c.alternatives[i]?.key &&
            text(a.text) === text(c.alternatives[i]!.text),
        ),
      answerKey: q.finalKey === c.correctKey,
      annulled: q.annulled === c.annulled,
      pages: equalPages(q, c),
      provenanceValid:
        c.provenance.length > 0 &&
        c.provenance.every(
          (p) =>
            Number.isInteger(p.page) &&
            q.provenance.some((g) => g.page === p.page) &&
            Object.values(p.bbox).every(Number.isFinite) &&
            p.bbox.x >= 0 &&
            p.bbox.y >= 0 &&
            p.bbox.width > 0 &&
            p.bbox.height > 0 &&
            p.bbox.x + p.bbox.width <= 613 &&
            p.bbox.y + p.bbox.height <= 793,
        ),
      visualHandling:
        !q.requiresVisual ||
        (c.status === "staging" &&
          (c.imageRefs.some(
            (ref) =>
              Object.values(ref.bbox).every(Number.isFinite) &&
              ref.bbox.width > 0 &&
              ref.bbox.height > 0,
          ) ||
            c.issues.some(
              (issue) =>
                issue === "visual_review_required" ||
                issue === "figure_geometry_unknown",
            ))),
      // Authored fixtures use a fixed 612x792 viewport. Gold boxes are authored
      // regions, not glyph-perfect PDF extractor boxes: measure bounded overlap.
      provenanceBounds: q.provenance.every((g) =>
        c.provenance.some(
          (p) =>
            p.page === g.page &&
            p.bbox.x >= 0 &&
            p.bbox.y >= 0 &&
            p.bbox.width > 0 &&
            p.bbox.height > 0 &&
            p.bbox.x + p.bbox.width <= 613 &&
            p.bbox.y + p.bbox.height <= 793 &&
            p.bbox.x < (g.bbox[0]! + g.bbox[2]!) * 612 &&
            p.bbox.x + p.bbox.width > g.bbox[0]! * 612 &&
            p.bbox.y < (g.bbox[1]! + g.bbox[3]!) * 792 &&
            p.bbox.y + p.bbox.height > g.bbox[1]! * 792,
        ),
      ),
      provenanceMethod: q.provenance.every((g) =>
        c.provenance.some((p) => p.page === g.page && p.method === g.method),
      ),
    };
    for (const k of Object.keys(result) as (keyof typeof result)[])
      if (result[k]) fields[k]++;
    const wrong = Object.entries(result)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (wrong.length) {
      requiresEdit++;
      failures.push({ number: q.number, fields: wrong });
    } else fields.exactStructure++;
    if (
      q.expectedAmbiguity &&
      c.correctKey === null &&
      c.issues.includes("ambiguous_answer_key")
    )
      ambiguousBlocked++;
    if (
      q.requiresVisual &&
      c.issues.some(
        (i) =>
          i === "visual_review_required" || i === "figure_geometry_unknown",
      )
    )
      visualFlagged++;
  }
  const falsePositives =
    predictions.filter((c) => !expected.has(c.originalNumber)).length +
    [...groups.entries()]
      .filter(([number]) => expected.has(number))
      .reduce((n, [, items]) => n + (items.length > 1 ? items.length : 0), 0);
  return {
    id: doc.id,
    feature: doc.feature,
    expected: doc.questions.length,
    predicted: predictions.length,
    segmentation: {
      truePositives,
      falsePositives,
      falseNegatives: missing,
      precision: truePositives / (truePositives + falsePositives || 1),
      recall: truePositives / doc.questions.length,
    },
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, count]) => [
        k,
        {
          correct: count,
          denominator: doc.questions.length,
          recall: count / doc.questions.length,
          precision: count / (predictions.length || 1),
        },
      ]),
    ),
    safety: {
      ambiguousExpected,
      ambiguousBlocked,
      visualExpected,
      visualFlagged,
    },
    requiresEdit,
    mandatoryVisualReview: predictions.filter((c) =>
      c.issues.some(
        (i) =>
          i === "figure_geometry_unknown" || i === "visual_review_required",
      ),
    ).length,
    structurallyRejected: predictions.filter(
      (c) =>
        c.alternatives.length < 2 ||
        c.issues.some(
          (i) => i === "missing_stem" || i === "duplicate_alternative",
        ),
    ).length,
    failures,
  };
}
