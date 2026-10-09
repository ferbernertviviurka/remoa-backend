import { describe, expect, it, vi } from 'vitest';
import { questionImportInputSchema, QUESTION_PDF_PARSER_VERSION } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
const f = vi.hoisted(() => ({ i: { id: 'import', paperId: 'importPaper' }, p: { id: 'paper' }, d: { id: 'document' }, o: {}, c: {} }));
vi.mock('../../db', () => ({ dbm: async () => ({ questionImports: f.i, examPapers: f.p, questionDocuments: f.d, questionOutbox: f.o, questionImportCandidates: f.c }) }));
import { createImport } from './service';
const id = '00000000-0000-4000-8000-000000000001';
const input = (pages: number[] | null = [3]) => questionImportInputSchema.parse({ sourceId: id, documentId: id, answerKeyDocumentId: id, answerKeyPages: pages, parserVersion: QUESTION_PDF_PARSER_VERSION, exam: { name: 'Authorial exam', institution: 'Synthetic', year: 2026, edition: '1', booklet: '1', durationSec: null }, ocr: true, budgetCents: 100, reason: 'Authorial page selection verification' });
function txFor(rows: unknown[][]) {
  const writes: { table: unknown; value: Record<string, unknown> }[] = [];
  const tx = { execute: vi.fn(async () => {}), select: () => {
    const result = rows.shift() ?? [];
    const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain, then: (resolve: (value: unknown[]) => unknown) => resolve(result) };
    return chain;
  }, insert: (table: unknown) => ({ values: async (value: Record<string, unknown>) => { writes.push({ table, value }); } }) } as unknown as Tx;
  return { tx, writes };
}
const existing = (pages: number[] | null) => ({ id, paperId: 'paper', documentId: id, answerKeyDocumentId: id, sourceId: id, parserVersion: QUESTION_PDF_PARSER_VERSION, ocrEnabled: true, budgetCents: 100, excludedPages: [], answerKeyPages: pages, revision: 0, status: 'review', updatedAt: new Date() });
describe('answer-key scope creation and durable replay', () => {
  it('rejects changed scope on the same idempotency key without inserting anything', async () => {
    const data = input(), h = txFor([[existing([4])], [{ ...data.exam }]]);
    expect(await createImport(h.tx, id, data, 'same-key')).toMatchObject({ ok: false, error: { message: 'idempotency_key_payload_changed' } });
    expect(h.writes).toEqual([]);
  });
  it('replays the unchanged scope and returns the stored immutable selection', async () => {
    const data = input(), h = txFor([[existing([3])], [{ ...data.exam }], [existing([3])], [{}]]);
    expect(await createImport(h.tx, id, data, 'same-key')).toMatchObject({ ok: true, data: { import: { answerKeyPages: [3] } } });
    expect(h.writes).toEqual([]);
  });
  it('rejects a selected page beyond the actual key document bounds before any insertion', async () => {
    const h = txFor([[], [{ all: 0, mine: 0 }], [{ id, pages: 2 }], [{ id, pages: 2 }]]);
    expect(await createImport(h.tx, id, input([3]), 'new-key')).toMatchObject({ ok: false, error: { message: 'answer_key_page_out_of_range' } });
    expect(h.writes).toEqual([]);
  });
  it('creates a new draft paper version when the same PDF had a different or indeterminate answer-key scope', async () => {
    for (const plans of [[{ answerKeyDocumentId: id, answerKeyPages: [4] }], []]) {
      const data = input(), h = txFor([[], [{ all: 0, mine: 0 }], [{ id, pages: 2 }], [{ id, pages: 4 }], [{ ...data.exam, id: 'old-paper', sourceId: id, documentId: id, answerKeyDocumentId: id, status: 'draft', version: 7 }], plans, [existing([3])], [{}]]);
      expect((await createImport(h.tx, id, data, 'new-key')).ok).toBe(true);
      expect(h.writes.find(write => write.table === f.p)?.value).toMatchObject({ version: 8 });
      expect(h.writes.find(write => write.table === f.i)?.value).toMatchObject({ answerKeyPages: [3] });
      expect(h.writes.find(write => write.table === f.i)?.value.paperId).not.toBe('old-paper');
    }
  });
});
