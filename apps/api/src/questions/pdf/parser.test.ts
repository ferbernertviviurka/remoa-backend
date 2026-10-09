import {readFile} from 'node:fs/promises';
import {readPdfLayout} from '@remoa/ai';
import { describe, expect, it, vi } from 'vitest';
import { parseExam, parseAnswerKey, readPdfPages, readPdfQuestions, readPdfAnswerKey, PdfParserError } from './index';
import { bounds, examLines, pageLines, questionNumber } from './layout';
import type { PdfLayoutPage } from './types';
const page=(lines:string[],number=1,x=10):PdfLayoutPage=>({page:number,width:600,height:800,items:lines.map((text,i)=>({text,x,y:50+i*20,width:text.length*5,height:12}))});
const valid=page(['Questão 1','Caso sintético de estudo sem conteúdo médico real.','(A) Primeiro','(B) Segundo','(C) Terceiro','(D) Quarto','(E) Quinto']);
const signature=new TextEncoder().encode('%PDF-1.7 fake fixture');
describe('PDF layout and segmentation',()=>{
 it('recognizes explicit, bare decorated and numbered questions',()=>{expect(['QUESTÃO 1:','02}','3. Caso','QUESTION 4'].map(questionNumber)).toEqual([1,2,3,4]);expect(questionNumber('0')).toBeNull();expect(questionNumber('texto')).toBeNull();expect(bounds([])).toEqual({x:0,y:0,width:0,height:0});});
 it('merges aligned fragments and separates wide column gaps',()=>{const p=page([]);p.items=[{text:'texto',x:10,y:20,width:30,height:10},{text:'segue',x:45,y:21,width:30,height:10},{text:'outra',x:320,y:20,width:30,height:10}];expect(pageLines(p).map(l=>l.text)).toEqual(['texto segue','outra']);expect(pageLines(p,false)).toHaveLength(1);});
 it('handles five choices, wrapped options, instruction rejection and multipage question',()=>{
 const first=page(['1. Instrução','2. Outra instrução','01}','Enunciado sintético','(a) primeira','continuação']);
 const second=page(['(B) segunda','(C) terceira','(D) quarta','Questão 2','Outro enunciado','A. sim','B) não'],2);
 const r=parseExam([first,second]);expect(r.candidates).toHaveLength(2);expect(r.candidates[0]!.alternatives[0]!.text).toBe('primeira continuação');expect(r.candidates[0]!.provenance.map(p=>p.page)).toEqual([1,2]);expect(parseExam([valid]).candidates[0]!.alternatives).toHaveLength(5);
 });
 it('uses column-major reading rather than joining simultaneous question stems',()=>{
 const p=page(['1','esquerda','(A) um','(B) dois']);const right=page(['2','direita','(A) três','(B) quatro'],1,330);p.items.push(...right.items);
 expect(examLines(p).map(l=>l.text)).toEqual(['1','esquerda','(A) um','(B) dois','2','direita','(A) três','(B) quatro']);expect(parseExam([p]).candidates.map(c=>c.stem)).toEqual(['esquerda','direita']);
 });
 it('preserves crops, flags visual review, gaps, duplicates and structural omissions',()=>{
 const p=page(['1','Veja imagem na tabela','(A) a','(A) b','3','(A) a','3','novo','(B) b']);p.method='ocr';p.images=[{x:10,y:75,width:100,height:20}];const r=parseExam([p]);expect(r.warnings).toContain('missing_question:2');expect(r.warnings).toContain('duplicate_number:3');expect(r.candidates[0]!.imageRefs).toHaveLength(1);expect(r.candidates[0]!.issues).toEqual(expect.arrayContaining(['duplicate_alternative','visual_review_required','ocr_used']));expect(r.candidates[1]!.issues).toEqual(expect.arrayContaining(['missing_stem','missing_alternatives']));
 const crop=parseExam([page(['1','Veja gráfico','(A) a','(B) b'])]).candidates[0]!;expect(crop.imageRefs).toEqual(crop.provenance);
 expect(parseExam([page(['Instruções sem questões'])]).warnings).toContain('no_questions_detected');
 });
});
describe('answer keys and retifications',()=>{
 it('never interprets BA or B A as two accepted keys; * is annulled',()=>{const r=parseAnswerKey([page(['1 A 2 BA 3 * 4 B A'])]);expect(r.entries.map(e=>[e.number,e.key,e.ambiguous,e.annulled])).toEqual([[1,'A',false,false],[2,null,true,false],[3,null,false,true],[4,null,true,false]]);});
 it('selects exact caderno using positioned headers and ignores correspondence page',()=>{
 const p=page([]);p.items=[{text:'PROVA AD1',x:70,y:20,width:70,height:12},{text:'PROVA AD2',x:350,y:20,width:70,height:12},{text:'1 A 2 B',x:10,y:50,width:90,height:12},{text:'1 C 2 D',x:320,y:50,width:90,height:12}];
 const key=parseAnswerKey([p,page(['GABARITO DE CORRESPONDÊNCIA','1 D'],2)],'AD1');expect(key.entries.map(e=>e.key)).toEqual(['A','B']);expect(()=>parseAnswerKey([p],'AD3')).toThrow(PdfParserError);expect(()=>parseAnswerKey([p])).toThrow('Select an explicit');expect(()=>parseAnswerKey([page(['1 A'])],'AD1')).toThrow('not found');
 });
 it('recognizes a complete fused code before a long description without borrowing the next page group',()=>{
  const a=page(['pRoVa A – Áreas Básicas e de Acesso Direto com descrição longa','1 A 2 B']),b=page(['PROVA B — Especialidades Clínicas','1 C 2 D'],2);
  const r=parseAnswerKey([a,b],'a');expect(r.entries.map(e=>e.key)).toEqual(['A','B']);expect(r.entries.every(e=>e.provenance.page===1)).toBe(true);
 });
 it.each(['AA','A1','A2'])('exact group A does not match %s',code=>{
  expect(()=>parseAnswerKey([page(['PROVA '+code+' - Descrição','1 B'])],'A')).toThrow('not found');
 });
 it('uses actual split plain header positions in multi-column keys',()=>{
  const p=page([]);p.items=[{text:'PROVA',x:70,y:20,width:35,height:12},{text:'A1',x:110,y:20,width:15,height:12},{text:'PROVA',x:350,y:20,width:35,height:12},{text:'A2',x:390,y:20,width:15,height:12},{text:'1 A 2 B',x:10,y:50,width:90,height:12},{text:'1 C 2 D',x:320,y:50,width:90,height:12}];
  expect(parseAnswerKey([p],'A1').entries.map(e=>e.key)).toEqual(['A','B']);
 });
 it.each(['PROVA A Áreas Básicas','PROVA A1ouAA','PROVA A descrição sem separador'])('rejects unresolved header %s',label=>{
  expect(()=>parseAnswerKey([page([label,'1 A'])],'A')).toThrow('not found');
 });
 it('fails closed on described multi-column labels rather than estimating the code glyph width',()=>{
  const p=page([]);p.items=[{text:'PROVA A – Descrição longa',x:10,y:20,width:200,height:12},{text:'PROVA B – Outra descrição',x:320,y:20,width:200,height:12},{text:'1 A',x:10,y:50,width:50,height:12},{text:'1 B',x:320,y:50,width:50,height:12}];
  try{parseAnswerKey([p],'A');throw Error('must reject');}catch(e){expect(e).toMatchObject({code:'ambiguous_key_geometry'});}
 });
 it('fails closed when two described headers are fused inside one item',()=>{
  try{parseAnswerKey([page(['PROVA A – primeiro PROVA B – segundo','1 A'])],'A');throw Error('must reject');}catch(e){expect(e).toMatchObject({code:'ambiguous_key_geometry'});}
 });
 it('real2023 group A has120 keys solely from its own page and preserves ambiguous retification',async()=>{
  const path=new URL('../../../../../../docs/content/questions/pdfs/rm2023_prova_gabaritos_retificados_05-01-2023.pdf',import.meta.url);
  const layout=await readPdfLayout(new Uint8Array(await readFile(path)));
  for(const group of [undefined,'']){try{parseAnswerKey(layout.pages,group);throw Error('must reject');}catch(e){expect(e).toMatchObject({code:'group_not_found'});}}
  const result=parseAnswerKey(layout.pages,'A');expect(result.entries).toHaveLength(120);
  expect([...new Set(result.entries.map(e=>e.provenance.page))]).toEqual([1]);
  expect(result.entries.find(e=>e.number===60)).toMatchObject({ambiguous:true,key:null});
 },20_000);
 it.each([['B','A'],['B','B'],['AA','A']])('rejects distinct groups across pages even if keys coincide (%s/%s)',(code,key)=>{
  const a=page(['PROVA A','1 A']),b=page(['PROVA '+code,'1 '+key],2);
  for(const group of [undefined,''])expect(()=>parseAnswerKey([a,b],group)).toThrow('Select an explicit');
  const selected=parseAnswerKey([a,b],'A');expect(selected.entries).toHaveLength(1);expect(selected.entries[0]).toMatchObject({key:'A',provenance:{page:1}});
 });
 it('allows a repeated same-group header and ignores correspondence before counting groups',()=>{
  const result=parseAnswerKey([page(['PROVA A','1 A']),page(['PROVA A','2 B'],2),page(['GABARITO DE CORRESPONDÊNCIA','PROVA B','1 D'],3)]);
  expect(result.entries.map(e=>e.key)).toEqual(['A','B']);
 });
 it('marks conflicting duplicate entries and handles empty key',()=>{const key=parseAnswerKey([page(['1 A','1 B'])]);expect(key.entries[0]!.ambiguous).toBe(true);expect(key.warnings).toContain('conflicting_key:1');expect(parseAnswerKey([page(['1 A','1 A'])]).entries).toHaveLength(1);expect(parseAnswerKey([]).warnings).toContain('no_answer_keys_detected');});
 it('attaches valid/annulled/ambiguous keys and rejects keys outside alternatives',()=>{
 const candidates=[valid,page(['2','stem','(A) a','(B) b'],2),page(['3','stem','(A) a','(B) b'],3),page(['4','stem','(A) a','(B) b'],4)];
 const r=parseExam(candidates,parseAnswerKey([page(['1 E 2 * 3 AB 4 J'])]));expect(r.candidates[0]!.correctKey).toBe('E');expect(r.candidates[1]!.annulled).toBe(true);expect(r.candidates[2]!.issues).toContain('ambiguous_answer_key');expect(r.candidates[3]!.issues).toContain('answer_not_in_alternatives');expect(r.candidates.every(c=>c.status==='staging')).toBe(true);
 });
});
describe('read orchestrator',()=>{
 it('rejects signatures, limits, malformed and empty input',async()=>{
 await expect(readPdfPages(new Uint8Array())).rejects.toMatchObject({code:'invalid_pdf'});
 await expect(readPdfPages(signature,{maxBytes:1})).rejects.toMatchObject({code:'pdf_too_large'});
 await expect(readPdfPages(signature,{readLayout:async()=>{throw Error('encrypted');}})).rejects.toMatchObject({code:'pdf_unreadable'});
 await expect(readPdfPages(signature,{readLayout:async()=>[]})).rejects.toMatchObject({code:'empty_document'});
 await expect(readPdfPages(signature,{maxPages:1,readLayout:async()=>[valid,valid]})).rejects.toMatchObject({code:'page_limit'});
 });
 it('requires OCR for scans and executes the injected OCR adapter',async()=>{
 const scan=page([]);await expect(readPdfPages(signature,{readLayout:async()=>[scan]})).rejects.toMatchObject({code:'ocr_unavailable'});
 const ocr={readPage:vi.fn(async()=>({...valid,method:'ocr' as const}))};const result=await readPdfPages(signature,{readLayout:async()=>({pages:[scan]}),ocr});expect(ocr.readPage).toHaveBeenCalledOnce();expect(result[0]!.method).toBe('ocr');
 });
 it('reads compressed-layout adapter and binds answer key only when supplied',async()=>{
 let n=0;const readLayout=async()=>[n++===0?valid:page(['GABARITO','1 E','Texto auxiliar não numerado para o documento de chave'])];
 const r=await readPdfQuestions(signature,{readLayout,answerKeyBytes:signature});expect(r.candidates[0]!.correctKey).toBe('E');
 const plain=await readPdfQuestions(signature,{readLayout:async()=>[valid]});expect(plain.answerKey).toBeNull();expect(plain.candidates[0]!.issues).toContain('missing_answer_key');
 const key=await readPdfAnswerKey(signature,undefined,{readLayout:async()=>[page(['1 A','Texto auxiliar para chave com conteúdo suficiente'])]});expect(key.entries[0]!.key).toBe('A');
 });
});
