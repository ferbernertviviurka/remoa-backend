import {describe,it,expect,vi} from 'vitest';
import {readPdfPages} from './read';
import type {PdfLayoutPage} from './types';
const bytes=new TextEncoder().encode('%PDF-1.7 synthetic');
const page:PdfLayoutPage={page:1,width:600,height:800,items:[],ocrRequiredReason:'font_metrics_nonfinite'};
describe('explicit font-metric OCR policy',()=>{
 it('passes explicit opt-in and preserves the reason even when OCR adapter returns a fresh page',async()=>{
  const reader=vi.fn(async()=>({pages:[page]}));
  const ocr={readPage:vi.fn(async()=>({page:1,width:600,height:800,items:[],method:'ocr' as const}))};
  const result=await readPdfPages(bytes,{allowFontMetricOcr:true,readLayout:reader,ocr});
  expect(reader).toHaveBeenCalledWith(bytes,{allowFontMetricOcr:true});
  expect(result[0]).toMatchObject({method:'ocr',ocrRequiredReason:'font_metrics_nonfinite'});
 });
 it('keeps default strict opt-out and requires a real OCR adapter for a flagged page',async()=>{
  const reader=vi.fn(async()=>[page]);
  await expect(readPdfPages(bytes,{readLayout:reader})).rejects.toMatchObject({code:'ocr_unavailable'});
  expect(reader).toHaveBeenCalledWith(bytes,{allowFontMetricOcr:false});
 });
 it('never treats an unreadable layout as OCR success',async()=>{
  const ocr={readPage:vi.fn()};
  await expect(readPdfPages(bytes,{allowFontMetricOcr:true,readLayout:async()=>{throw Error('pdf_invalid_geometry');},ocr})).rejects.toMatchObject({code:'pdf_unreadable'});
  expect(ocr.readPage).not.toHaveBeenCalled();
 });
});
