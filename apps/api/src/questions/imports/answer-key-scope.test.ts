import { describe, expect, it } from 'vitest';
import { answerKeyPageSelection, scopedAnswerKeyLayout, answerKeyCacheScope, reusableAnswerKeyScope } from './answer-key-scope';
import type { PdfLayoutPage } from '../pdf';
describe('immutable original answer-key page scope', () => {
  it('canonicalizes order without renumbering or silently deduplicating pages', () => {
    expect(answerKeyPageSelection([3, 1], 'key', 3)).toEqual([1, 3]);
    expect(answerKeyPageSelection(null, null)).toBeNull();
    expect(answerKeyPageSelection(undefined, null)).toBeNull();
    for (const values of [[], [0], [501], [1.5], [3, 3]]) expect(() => answerKeyPageSelection(values, 'key', 500)).toThrow();
    expect(() => answerKeyPageSelection([3], null)).toThrow('answer_key_pages_invalid');
    expect(() => answerKeyPageSelection([3], 'key', 2)).toThrow('answer_key_page_out_of_range');
  });
  it('filters entire original pages, preserves geometry/page provenance and fails on missing selection', () => {
    const pages = [1, 2, 3].map(page => ({ page, width: 600, height: 800, items: [] } as PdfLayoutPage));
    expect(scopedAnswerKeyLayout(pages, [3])).toEqual([pages[2]]);
    expect(scopedAnswerKeyLayout(pages, null)).toBe(pages);
    expect(() => scopedAnswerKeyLayout(pages, [4])).toThrow('answer_key_selected_page_missing');
    expect(() => scopedAnswerKeyLayout([pages[2]!, pages[2]!], [3])).toThrow();
  });
  it('preserves the legacy cache fingerprint while separating every explicit selection', () => {
    const old = { excludedPages: [], ocrEnabled: true, ocrVersion: 'pinned', extractionPolicy: 'font-metrics-ocr-v1' };
    expect(JSON.stringify({ ...old, ...answerKeyCacheScope(null) })).toBe(JSON.stringify(old));
    expect(JSON.stringify(answerKeyCacheScope([3]))).not.toBe(JSON.stringify(answerKeyCacheScope([4])));
    expect(answerKeyCacheScope([3, 1])).toEqual(answerKeyCacheScope([1, 3]));
  });
  it('does not reuse a draft paper when bindings differ, conflict or have no known import plan', () => {
    expect(reusableAnswerKeyScope([{ answerKeyDocumentId: 'key', answerKeyPages: [3] }], 'key', [3])).toBe(true);
    expect(reusableAnswerKeyScope([{ answerKeyDocumentId: 'key' }], 'key', null)).toBe(true);
    for (const plans of [[], [{ answerKeyDocumentId: 'other', answerKeyPages: [3] }], [{ answerKeyDocumentId: 'key', answerKeyPages: [4] }], [{ answerKeyDocumentId: 'key', answerKeyPages: [3] }, { answerKeyDocumentId: 'key', answerKeyPages: null }]])
      expect(reusableAnswerKeyScope(plans, 'key', [3])).toBe(false);
  });
});
