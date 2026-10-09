import type { PdfLayoutPage } from '../pdf';
/** Original page numbers only. Null means the legacy whole answer-key document. */
export function answerKeyPageSelection(pages: number[] | null | undefined, documentId: string | null, totalPages?: number | null): number[] | null {
  if (pages == null) return null;
  if (!documentId || !Array.isArray(pages) || !pages.length || pages.length > 500 || pages.some(page => !Number.isInteger(page) || page < 1 || page > 500) || new Set(pages).size !== pages.length)
    throw Error('answer_key_pages_invalid');
  if (totalPages != null && pages.some(page => page > totalPages)) throw Error('answer_key_page_out_of_range');
  return [...pages].sort((a, b) => a - b);
}
export function scopedAnswerKeyLayout(pages: PdfLayoutPage[], selection: number[] | null): PdfLayoutPage[] {
  if (selection === null) return pages;
  if (selection.some(number => pages.filter(page => page.page === number).length !== 1)) throw Error('answer_key_selected_page_missing');
  const selected = new Set(selection);
  return pages.filter(page => selected.has(page.page));
}
export function answerKeyCacheScope(selection: number[] | null | undefined): { answerKeyPages?: number[] } {
  return selection == null ? {} : { answerKeyPages: [...selection].sort((a, b) => a - b) };
}
export function reusableAnswerKeyScope(plans: { answerKeyDocumentId: string | null; answerKeyPages?: number[] | null }[], documentId: string | null, selection: number[] | null): boolean {
  if (!plans.length || plans.length > 1000) return false;
  return plans.every(plan => plan.answerKeyDocumentId === documentId && JSON.stringify(plan.answerKeyPages ?? null) === JSON.stringify(selection));
}
