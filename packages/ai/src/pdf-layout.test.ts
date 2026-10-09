import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { getDocumentProxy } from 'unpdf';
import { syntheticPdf } from '../eval/model/synthetic-pdf';
import { PDF_LAYOUT_LIMITS, PdfLayoutError, readPdfLayout,readPdfPageGeometry } from './pdf-layout';
vi.mock('unpdf', async importOriginal => {
  const original = await importOriginal<typeof import('unpdf')>();
  return { ...original, getDocumentProxy: vi.fn(original.getDocumentProxy) };
});
const open = vi.mocked(getDocumentProxy); const bytes = new Uint8Array([37, 80, 68, 70]);
function fake(items: unknown[] = [{ str: 'Synthetic question', transform: [12, 0, 0, 12, 50, 700], width: 80, height: 12, fontName: 'F1' }], styles: Record<string, {ascent?: number; descent?: number}> = {}) {
  const cleanup = vi.fn(); const destroy = vi.fn(async () => undefined);
  const viewport = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792], convertToViewportPoint: (x: number, y: number) => [x, 792 - y] };
  const getTextContent = vi.fn(async () => ({ items, styles }));
  const page = { cleanup, getViewport: vi.fn(() => viewport), getTextContent };
  const doc = { numPages: 1, getPage: vi.fn(async () => page), loadingTask: { destroy } };
  open.mockResolvedValueOnce(doc as unknown as Awaited<ReturnType<typeof getDocumentProxy>>);
  return { cleanup, destroy, viewport, getTextContent, page, doc };
}
afterEach(() => vi.clearAllMocks());
describe('readPdfPageGeometry',()=>{
  it('opens only the selected viewport in a500-page document and never extracts text',async()=>{
    const f=fake();f.doc.numPages=500;
    expect(await readPdfPageGeometry(bytes,450)).toEqual({page:450,width:612,height:792,totalPages:500});
    expect(f.doc.getPage).toHaveBeenCalledExactlyOnceWith(450);expect(f.getTextContent).not.toHaveBeenCalled();expect(f.cleanup).toHaveBeenCalledOnce();expect(f.destroy).toHaveBeenCalledOnce();
  });
  it.each([0,501,1.5])('rejects invalid page%s without opening',async page=>{await expect(readPdfPageGeometry(bytes,page)).rejects.toMatchObject({code:'pdf_invalid_page'});expect(open).not.toHaveBeenCalled();});
  it('rejects missing pages/oversized documents and destroys the document',async()=>{
    const f=fake();await expect(readPdfPageGeometry(bytes,2)).rejects.toMatchObject({code:'pdf_invalid_page'});expect(f.doc.getPage).not.toHaveBeenCalled();expect(f.destroy).toHaveBeenCalledOnce();
    const g=fake();g.doc.numPages=501;await expect(readPdfPageGeometry(bytes,1)).rejects.toMatchObject({code:'pdf_too_many_pages'});expect(g.destroy).toHaveBeenCalledOnce();
  });
  it('preserves rotated dimensions, validates geometry and releases resources on abort',async()=>{
    const f=fake();f.viewport.width=792;f.viewport.height=612;expect(await readPdfPageGeometry(bytes,1)).toMatchObject({width:792,height:612});
    const g=fake();g.viewport.width=0;await expect(readPdfPageGeometry(bytes,1)).rejects.toMatchObject({code:'pdf_invalid_geometry'});expect(g.cleanup).toHaveBeenCalledOnce();expect(g.destroy).toHaveBeenCalledOnce();
    const h=fake(),abort=new AbortController();const get=h.doc.getPage;h.doc.getPage=vi.fn(async()=>{abort.abort();return get();});
    await expect(readPdfPageGeometry(bytes,1,{signal:abort.signal})).rejects.toMatchObject({code:'pdf_aborted'});expect(h.getTextContent).not.toHaveBeenCalled();expect(h.cleanup).toHaveBeenCalledOnce();expect(h.destroy).toHaveBeenCalledOnce();
  });
});
describe('readPdfLayout', () => {
  it('compressed synthetic PDF preserves buffer and text geometry', async () => {
    const source = syntheticPdf(['Synthetic question 01', 'A option one', 'B option two']); const length = source.length;
    const { pages } = await readPdfLayout(source);
    expect(pages).toHaveLength(1); expect(pages[0]).toMatchObject({ page: 1, width: 612, height: 792 });
    expect(pages[0]!.items.map(x => x.text).join(' ')).toContain('Synthetic question 01');
    expect(pages[0]!.items[0]!.x).toBeCloseTo(50); expect(pages[0]!.items[1]!.y).toBeGreaterThan(pages[0]!.items[0]!.y);
    expect(source.length).toBe(length); expect(pages[0]!.images).toBeUndefined();
  });
  it('real Fuvest pilot has finite geometry, without copying its contents into fixtures', async () => {
    const path = new URL('../../../../docs/content/questions/pdfs/rm2026-prova-ECM-especialidades-clinicas.pdf', import.meta.url);
    const { pages } = await readPdfLayout(new Uint8Array(await readFile(path)));
    expect(pages.length).toBeGreaterThan(1); expect(pages[0]!.items.length).toBeGreaterThan(10);
    for (const page of pages) { expect(page.page).toBeGreaterThan(0); expect(page.width).toBeGreaterThan(0); expect(page.items.every(i => [i.x, i.y, i.width, i.height].every(Number.isFinite))).toBe(true); }
  }, 20_000);
  it('real Fuvest2024 stays strict by default and marks exactly37 pages for explicit OCR',async()=>{
    const path=new URL('../../../../docs/content/questions/pdfs/rm_2024_a1.pdf',import.meta.url);
    const input=new Uint8Array(await readFile(path));
    await expect(readPdfLayout(input)).rejects.toMatchObject({code:'pdf_invalid_geometry'});
    const {pages}=await readPdfLayout(input,{allowFontMetricOcr:true});
    expect(pages).toHaveLength(38);
    expect(pages.filter(p=>p.ocrRequiredReason).map(p=>p.page)).toEqual(Array.from({length:37},(_,i)=>i+1));
    expect(pages.filter(p=>p.ocrRequiredReason).every(p=>p.items.length===0)).toBe(true);
    expect(pages.every(p=>Number.isFinite(p.width)&&Number.isFinite(p.height))).toBe(true);
  },20_000);
  it('rejects empty, oversize, aborted bytes before opening', async () => {
    await expect(readPdfLayout(new Uint8Array())).rejects.toMatchObject({ code: 'pdf_empty' });
    await expect(readPdfLayout(new Uint8Array(PDF_LAYOUT_LIMITS.bytes + 1))).rejects.toMatchObject({ code: 'pdf_too_large' });
    const abort = new AbortController(); abort.abort(); await expect(readPdfLayout(bytes, { signal: abort.signal })).rejects.toMatchObject({ code: 'pdf_aborted' }); expect(open).not.toHaveBeenCalled();
  });
  it('broken PDF never falls back to apparent literal text', async () => {
    await expect(readPdfLayout(new TextEncoder().encode('%PDF-1.4 (Fake valid-looking question) Tj'))).rejects.toMatchObject({ code: 'pdf_unreadable' });
  });
  it('glyph box differs from baseline and releases resources', async () => {
    const f = fake(); const { pages } = await readPdfLayout(bytes);
    expect(pages[0]!.items[0]).toEqual({ text: 'Synthetic question', x: 50, y: 80, width: 80, height: 12 });
    expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.destroy).toHaveBeenCalledOnce(); expect(open.mock.calls[0]![0]).not.toBe(bytes);
  });
  it('rotated viewport applies to every corner', async () => {
    const f = fake(); f.viewport.width = 792; f.viewport.height = 612; f.viewport.transform = [0, 1, 1, 0, 0, 0]; f.viewport.convertToViewportPoint = (x, y) => [y, x];
    expect((await readPdfLayout(bytes)).pages[0]!.items[0]).toEqual({ text: 'Synthetic question', x: 700, y: 50, width: 12, height: 80 });
  });
  it('font ascent and descent position the glyph box', async () => {
    fake(undefined, { F1: { ascent: .75 } }); expect((await readPdfLayout(bytes)).pages[0]!.items[0]!.y).toBeCloseTo(83);
    fake(undefined, { F1: { descent: -.25 } }); expect((await readPdfLayout(bytes)).pages[0]!.items[0]!.y).toBeCloseTo(83);
  });
  it('font NaN routes only an explicitly opted-in page to OCR without retaining guessed text boxes', async () => {
    const f=fake(undefined,{F1:{ascent:Number.NaN,descent:Number.NaN}});
    expect((await readPdfLayout(bytes,{allowFontMetricOcr:true})).pages[0]).toEqual({page:1,width:612,height:792,items:[],ocrRequiredReason:'font_metrics_nonfinite'});
    expect(f.cleanup).toHaveBeenCalledOnce();expect(f.destroy).toHaveBeenCalledOnce();
  });
  it.each(['transform','zero','infinity','point','empty'])('opt-in never masks later invalid %s geometry after a NaN font',async kind=>{
    const first={str:'synthetic',transform:[1,0,0,1,0,1],width:1,height:1,fontName:'F1'};
    const later={...first,str:kind==='empty'?' ':first.str,fontName:'F2',transform:kind==='transform'||kind==='empty'?[1,0,0,1,0,Number.NaN]:kind==='zero'?[0,0,0,1,0,1]:[1,0,0,1,0,1]};
    const f=fake([first,later],{F1:{ascent:Number.NaN},F2:{ascent:kind==='infinity'?Infinity:1}});
    if(kind==='point')f.viewport.convertToViewportPoint=()=>[Number.NaN,0];
    await expect(readPdfLayout(bytes,{allowFontMetricOcr:true})).rejects.toMatchObject({code:'pdf_invalid_geometry'});
    expect(f.cleanup).toHaveBeenCalledOnce();expect(f.destroy).toHaveBeenCalledOnce();
  });
  it('opt-in does not reinterpret text extraction exceptions as OCR pages',async()=>{
    const f=fake();f.getTextContent.mockRejectedValueOnce(Error('encrypted'));
    await expect(readPdfLayout(bytes,{allowFontMetricOcr:true})).rejects.toMatchObject({code:'pdf_unreadable'});
  });
  it('empty text / marked content does not assert absence of figures', async () => {
    fake([{ type: 'beginMarkedContent' }, { str: ' ', transform: [1,0,0,1,0,1], width: 0, height: 1, fontName: 'F1' }]); expect((await readPdfLayout(bytes)).pages[0]).toEqual({ page: 1, width: 612, height: 792, items: [] });
  });
  it('page and item limits release resources', async () => {
    const f = fake(); f.doc.numPages = PDF_LAYOUT_LIMITS.pages + 1; await expect(readPdfLayout(bytes)).rejects.toMatchObject({ code: 'pdf_too_many_pages' }); expect(f.destroy).toHaveBeenCalledOnce();
    const g = fake(new Array(PDF_LAYOUT_LIMITS.itemsPerPage + 1).fill({ str: '' })); await expect(readPdfLayout(bytes)).rejects.toMatchObject({ code: 'pdf_too_many_items' }); expect(g.cleanup).toHaveBeenCalledOnce(); expect(g.destroy).toHaveBeenCalledOnce();
  });
  it('abort between operations releases page/document', async () => {
    const f = fake(); const signal = new AbortController(); const original = f.doc.getPage;
    f.doc.getPage = vi.fn(async () => { signal.abort(); return original(); });
    await expect(readPdfLayout(bytes, { signal: signal.signal })).rejects.toMatchObject({ code: 'pdf_aborted' }); expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.destroy).toHaveBeenCalledOnce();
  });
  it('extract failure retains cause and releases resources', async () => {
    const f = fake(); f.getTextContent.mockRejectedValueOnce(new Error('decode failed')); await expect(readPdfLayout(bytes)).rejects.toMatchObject({ code: 'pdf_unreadable', cause: new Error('decode failed') }); expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.destroy).toHaveBeenCalledOnce();
  });
  it.each(['viewport', 'text', 'zero', 'ascent', 'point'])('invalid %s geometry fails', async kind => {
    const f = fake();
    if (kind === 'viewport') f.viewport.width = 0;
    if (kind === 'text') f.getTextContent.mockResolvedValueOnce({ items: [{ str: 'broken', transform: [1, 0, 0, 1, 0, Number.NaN], width: 1, height: 1, fontName: 'F1' }], styles: {} });
    if (kind === 'zero') f.getTextContent.mockResolvedValueOnce({ items: [{ str: 'broken', transform: [0, 0, 0, 1, 0, 1], width: 1, height: 1, fontName: 'F1' }], styles: {} });
    if (kind === 'ascent') f.getTextContent.mockResolvedValueOnce({ items: [{ str: 'broken', transform: [1, 0, 0, 1, 0, 1], width: 1, height: 1, fontName: 'F1' }], styles: { F1: { ascent: Number.NaN } } });
    if (kind === 'point') f.viewport.convertToViewportPoint = () => [Number.NaN, 0];
    await expect(readPdfLayout(bytes)).rejects.toBeInstanceOf(PdfLayoutError); expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.destroy).toHaveBeenCalledOnce();
  });
});
