import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readPdfLayout } from '@remoa/ai';
import { describe, expect, it } from 'vitest';
import { parseAnswerKey } from './parser';
import type { PdfLayoutPage } from './types';
import gold from './numeric-key.gold.json';
import realGold from './numeric-key-real.gold.json';
const fixture = (): PdfLayoutPage => structuredClone(gold.page);
const single = (): PdfLayoutPage => { const p = fixture(); p.items = p.items.filter(i => i.y < 240); return p; };
const keys = (page: PdfLayoutPage, group = '1') => parseAnswerKey([page], group);
describe('numeric caderno paired-grid gold frozen before implementation', () => {
  it.each(['1', '01', '001'])('normalizes only complete numeric code %s and preserves observed cells', group => {
    const r = keys(fixture(), group);
    expect(r.group).toBe('1');
    expect(r.entries.map(({ number, raw }) => ({ number, raw }))).toEqual(gold.expected);
    expect(r.entries.find(e => e.number === 7)).toMatchObject({ raw: 'X', key: null, ambiguous: true, annulled: false });
    expect(r.entries.every(e => e.provenance.page === 3 && e.provenance.bbox.width > 0)).toBe(true);
  });
  it('isolates stacked cadernos and never guesses a group', () => {
    expect(keys(fixture(), '2').entries.slice(0, 5).map(e => e.key)).toEqual(['E', 'D', 'C', 'B', 'A']);
    for (const group of [undefined, '', '10', 'A1']) expect(() => parseAnswerKey([fixture()], group)).toThrow();
    expect(parseAnswerKey([single()]).entries).toHaveLength(100);
  });
  it('does not match1 as prefix10 and accepts split metadata with actual bounds', () => {
    const p = single(); p.items[0]!.text = 'PROVA 10'; expect(() => keys(p)).toThrow('explicit numeric');
    p.items[0]!.text = 'PRM - AUTORAL -'; p.items[0]!.width = 90;
    p.items.push({ text: 'PROVA', x: 250, y: 20, width: 40, height: 12 }, { text: '01', x: 295, y: 20, width: 16, height: 12 });
    expect(keys(p).entries).toHaveLength(100);
  });
  it.each(['shift', 'missing', 'fused', 'nonfinite', 'overlap'])('fails closed on %s cells', mode => {
    const p = single(), firstKey = p.items[2]!;
    if (mode === 'shift') firstKey.x += 12;
    if (mode === 'missing') p.items.splice(2, 1);
    if (mode === 'fused') { p.items[1]!.text = '1 2'; p.items.splice(3, 1); }
    if (mode === 'nonfinite') firstKey.width = Infinity;
    if (mode === 'overlap') p.items[3]!.x = p.items[1]!.x;
    expect(() => keys(p)).toThrow();
  });
  it('does not infer unexplained star or double letter as annulled or valid', () => {
    const p = single(); p.items[2]!.text = '*'; p.items[4]!.text = 'BA';
    expect(keys(p).entries.slice(0, 2).map(e => [e.key, e.ambiguous, e.annulled])).toEqual([[null, true, false], [null, true, false]]);
  });
  it('rejects repeated numbers across same-code pages even if keys coincide', () => {
    const a = single(), b = single(); b.page = 4;
    expect(() => parseAnswerKey([a, b], '01')).toThrow('explicit answer-key page selection');
  });
  it('allows continuation without overlapping numbers; correspondence is skipped first', () => {
    const a = single(), b = single(); b.page = 4;
    for (const item of b.items) if (/^\d+$/.test(item.text)) { item.text = String(Number(item.text) + 100); item.x -= (24 - item.width) / 2; item.width = 24; }
    const skipped: PdfLayoutPage = { page: 5, width: 600, height: 800, items: [{ text: 'GABARITO DE CORRESPONDÊNCIA', x: 10, y: 10, width: 200, height: 12 }, { text: 'PROVA 2', x: 10, y: 40, width: 80, height: 12 }] };
    expect(parseAnswerKey([a, b, skipped]).entries).toHaveLength(200);
  });
  it('requires group for mixed documents and preserves exact A1', () => {
    const alpha: PdfLayoutPage = { page: 4, width: 600, height: 800, items: [{ text: 'PROVA A1', x: 10, y: 20, width: 80, height: 12 }, { text: '1 B', x: 10, y: 50, width: 30, height: 12 }] };
    expect(() => parseAnswerKey([single(), alpha])).toThrow('mixed-caderno');
    expect(parseAnswerKey([single(), alpha], 'A1').entries.map(e => e.key)).toEqual(['B']);
  });
  it.each(['PROVA 0', 'PROVA 1000', 'PROVA 1ou2', 'PROVA 1 descrição sem separador'])('rejects incomplete numeric header %s instead of succeeding empty', label => {
    const p = single(); p.items[0]!.text = label;
    expect(() => parseAnswerKey([p])).toThrow('complete code');
  });
  it('rejects a valid numeric label with invalid actual header bounds', () => {
    const p = single(); p.items[0]!.width = 900;
    expect(() => keys(p)).toThrow('header geometry');
  });
  it('does not turn an unanchored body mention into a caderno', () => {
    const p = single(); p.items[0]!.text = 'Texto autoral menciona PROVA 1 sem cabeçalho delimitado';
    expect(() => keys(p)).toThrow('not found');
  });
  it('does not estimate separate header positions from fused two-group item', () => {
    const p = single(); p.items[0]!.text = 'PROVA 1 - primeiro PROVA 2 - segundo';
    expect(() => keys(p)).toThrow('verified table boundaries');
  });
  it('real original page3 matches100 frozen rawcells; full88pages cannot merge repeatedgroup', async () => {
    const bytes = await readFile(new URL('../../../../../../docs/content/questions/acquisition-batches/official-20261009/enare_2021-2022_key_definitivo.pdf', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(realGold.sourceSha256);
    const layout = await readPdfLayout(new Uint8Array(bytes)), page = layout.pages.find(p => p.page === realGold.page)!;
    const r = keys(page, '01');
    expect(r.entries.map(({ number, raw }) => ({ number, raw }))).toEqual(realGold.expected);
    expect(r.entries.filter(e => e.raw === 'X')).toHaveLength(6);
    expect(r.entries.filter(e => e.raw === 'X').every(e => e.ambiguous && e.key === null && !e.annulled)).toBe(true);
    expect(r.entries.every(e => e.provenance.page === 3)).toBe(true);
    expect(() => parseAnswerKey([page])).toThrow('explicit numeric');
    expect(() => parseAnswerKey(layout.pages, '1')).toThrow();
  }, 30_000);
});
