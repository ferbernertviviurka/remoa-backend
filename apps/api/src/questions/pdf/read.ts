import * as aiPdf from '@remoa/ai';
import { parseAnswerKey, parseExam } from './parser';
import { PdfParserError, type PdfLayoutPage, type ReadPdfOptions } from './types';
/** All malformed/encrypted/scan-only documents fail explicitly; no byte-regex success fallback. */
export async function readPdfPages(bytes:Uint8Array,options:ReadPdfOptions={}):Promise<PdfLayoutPage[]>{
  if(bytes.byteLength>(options.maxBytes??100*1024*1024))throw new PdfParserError('pdf_too_large','PDF exceeds configured byte limit');
  if(!new TextDecoder().decode(bytes.slice(0,1024)).includes('%PDF-'))throw new PdfParserError('invalid_pdf','File has no PDF signature');
  const reader=options.readLayout??(aiPdf as unknown as {readPdfLayout?:ReadPdfOptions['readLayout']}).readPdfLayout;
  if(!reader)throw new PdfParserError('layout_unavailable','PDF layout adapter is not installed');
  let pages:PdfLayoutPage[];
  try{const result=await reader(bytes,{allowFontMetricOcr:options.allowFontMetricOcr===true});pages=Array.isArray(result)?result:result.pages;}
  catch{throw new PdfParserError('pdf_unreadable','PDF could not be opened; encrypted or malformed PDFs require a replacement');}
  if(pages.length>(options.maxPages??500))throw new PdfParserError('page_limit','PDF exceeds configured page limit');
  if(!pages.length)throw new PdfParserError('empty_document','PDF has no pages');
  const output:PdfLayoutPage[]=[];
  for(const page of pages){
    if(options.reviewedNonQuestionPages?.includes(page.page)){output.push({...page,items:[],reviewedNonQuestion:true});continue;}
    if(page.ocrRequiredReason || page.items.map(i=>i.text).join('').replace(/\W/g,'').length<30){
      if(!options.ocr)throw new PdfParserError('ocr_unavailable',`Page ${page.page} requires an OCR worker`);
      output.push({...await options.ocr.readPage(bytes,page),...(page.ocrRequiredReason?{ocrRequiredReason:page.ocrRequiredReason}:{})});
    }else output.push({...page,method:page.method??'text'});
  }
  return output;
}
export async function readPdfQuestions(bytes:Uint8Array,options:ReadPdfOptions & {answerKeyBytes?:Uint8Array;group?:string}={}){
  const pages=await readPdfPages(bytes,options);
  const key=options.answerKeyBytes?parseAnswerKey(await readPdfPages(options.answerKeyBytes,options),options.group):undefined;
  return {...parseExam(pages,key),layout:pages,answerKey:key??null};
}
export async function readPdfAnswerKey(bytes:Uint8Array,group?:string,options:ReadPdfOptions={}){return parseAnswerKey(await readPdfPages(bytes,options),group);}
