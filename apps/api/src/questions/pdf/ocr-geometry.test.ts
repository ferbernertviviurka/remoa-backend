import {describe,expect,it} from 'vitest';
import {ocrTsvItems} from './ocr';
import {parseExam} from './parser';
import type {AnswerKeyResult,PdfLayoutPage} from './types';
import fixture from './sespe-ocr-tsv.fixture.json';
// D-1813: real tesseract word boxes from the official scanned SES-PE booklets (see fixture header for model/dpi/SHA).
const HEADER='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const tsv=(words:(string|number)[][])=>[HEADER,...words.map(([b,p,l,x,y,w,h,c,t])=>['5','1',b,p,l,'1',x,y,w,h,c,t].join('\t'))].join('\n');
const ocrPage=(source:string,page:number):PdfLayoutPage=>{
 const p=fixture.pages.find(f=>f.source===source&&f.page===page)!;
 return {page,width:p.width,height:p.height,items:ocrTsvItems(tsv(p.words),72/fixture.dpi),method:'ocr'};
};
const key=(entries:[number,string][]):AnswerKeyResult=>({group:null,warnings:[],entries:entries.map(([number,k])=>({number,key:k,raw:k,annulled:false,ambiguous:false,provenance:{page:1,bbox:{x:1,y:1,width:1,height:1},method:'text'}}))});
const q=(r:ReturnType<typeof parseExam>,n:number)=>r.candidates.find(c=>c.originalNumber===n)!;
const keys=(r:ReturnType<typeof parseExam>,n:number)=>q(r,n).alternatives.map(a=>a.key).join('');
describe('D-1813 OCR items split at real word-box gutters',()=>{
 it('fixture provenance is pinned to the official PDFs',()=>{
  expect(new Set(fixture.pages.map(p=>p.sourceSha256))).toEqual(new Set(['68ae70a711237e00d27eaab4bb8def90a9838099468378ebbcb1cdbebdbe4ea4','5b429425e0b6cd45a6bf1e1e02505740ccff424119c2689268cb51e715ee984c']));
 });
 it('synthetic: a TSV line is split only at a gutter, never at word spaces or by text',()=>{
  const words=[[1,1,1,100,10,40,20,90,'B)'],[1,1,1,145,10,60,20,90,'Polimiosite'],[1,1,1,700,10,40,20,90,'D)'],[1,1,1,745,10,90,20,90,'Hipertensão'],[1,1,1,840,10,60,20,90,'intracraniana']];
  expect(ocrTsvItems(tsv(words),1).map(i=>i.text)).toEqual(['B) Polimiosite','D) Hipertensão intracraniana']);
  const prose=[[1,1,1,100,10,40,20,90,'Dose'],[1,1,1,145,10,30,20,90,'de'],[1,1,1,180,10,60,20,90,'0,5'],[1,1,1,245,10,60,20,90,'mg/kg.'],[1,1,1,310,10,40,20,90,'C)'],[1,1,1,355,10,40,20,90,'não']];
  expect(ocrTsvItems(tsv(prose),1).map(i=>i.text)).toEqual(['Dose de 0,5 mg/kg. C) não']);
 });
 it('gr01 p3: 2-column grids Q1/Q3 are split and reordered; misread "OC)" is not rewritten and stays flagged',()=>{
  const r=parseExam([ocrPage('sespe_rm2024_gr01.pdf',3)],key([[1,'E'],[3,'C'],[4,'D']]));
  expect(keys(r,1)).toBe('ABCDE');expect(keys(r,3)).toBe('ABCDE');
  expect(q(r,3).alternatives.map(a=>a.text)).toEqual(['Proteinúria de 10 g/24 horas','C3 normal','Hemácias dismórficas na urina','Cilindros céreos na sedimentoscopia urinária','Títulos elevados de antiestreptolisina O']);
  expect(q(r,3).correctKey).toBe('C');
  expect(keys(r,4)).toBe('ABDE');expect(q(r,4).alternatives[1]!.text).toContain('OC)');
  expect(q(r,4).issues).toEqual(expect.arrayContaining(['segmentation_incomplete','ambiguous_answer_key']));expect(q(r,4).correctKey).toBeNull();
 });
 it('gr01 p13: Q45 printed as one row of five',()=>{
  const r=parseExam([ocrPage('sespe_rm2024_gr01.pdf',13)],key([[45,'C']]));
  expect(q(r,45).alternatives).toEqual(['5','6','8','12','14'].map((w,i)=>({key:'ABCDE'[i],text:`${w} semanas`})));
  expect(q(r,45).correctKey).toBe('C');
 });
 it('gr01 p17: marker "63 “Com…" without period is the next expected question at the marker column',()=>{
  const r=parseExam([ocrPage('sespe_rm2024_gr01.pdf',17)],key([[62,'B'],[63,'A']]));
  expect(r.candidates.map(c=>c.originalNumber)).toContain(63);expect(keys(r,63)).toBe('ABCDE');
  expect(q(r,63).stem.startsWith('“Com base')).toBe(true);expect(q(r,62).stem).not.toContain('Com base na sua riqueza');
 });
 it('gr01 p26: marker "99, O código" is recovered; its misread C stays flagged and the key is not confirmed',()=>{
  const r=parseExam([ocrPage('sespe_rm2024_gr01.pdf',26)],key([[98,'C'],[99,'B']]));
  expect(keys(r,99)).toBe('ABDE');expect(q(r,99).alternatives[1]!.text).toContain('OC) Autonomia');
  expect(q(r,99).issues).toEqual(expect.arrayContaining(['segmentation_incomplete','ambiguous_answer_key']));expect(q(r,99).correctKey).toBeNull();
 });
 it('gr03 p10: Q45 with unreadable labels is flagged and its official key is not confirmed',()=>{
  const r=parseExam([ocrPage('sespe_rm2024_gr03.pdf',10)],key([[45,'B']]));
  expect(q(r,45).issues).toEqual(expect.arrayContaining(['segmentation_incomplete','ambiguous_answer_key']));expect(q(r,45).correctKey).toBeNull();
 });
});
describe('D-1813 contextual loose markers',()=>{
 const it_=(text:string,x:number,y:number)=>({text,x,y,width:Math.min(300,text.length*4),height:9});
 const pg=(items:ReturnType<typeof it_>[]):PdfLayoutPage=>({page:1,width:600,height:800,images:[],items});
 it('rejects a numeric stem line when the number is not the next one, is detected elsewhere, sits off the marker column, or before options',()=>{
  const base=[it_('1. Enunciado.',42,40),it_('A) a',42,60),it_('B) b',42,72)];
  for(const items of [
   [...base,it_('3 pacientes foram vistos.',42,90),it_('A) x',42,110),it_('B) y',42,122)],
   [...base,it_('2 pacientes foram vistos.',42,90),it_('2. Real.',42,140),it_('A) x',42,160),it_('B) y',42,172)],
   [...base,it_('2 pacientes foram vistos.',60,90),it_('A) x',42,110),it_('B) y',42,122)],
   [it_('1. Enunciado.',42,40),it_('2 pacientes foram vistos.',42,60),it_('A) a',42,80),it_('B) b',42,92)],
  ]) expect(parseExam([pg(items)]).candidates.filter(c=>c.stem.startsWith('pacientes'))).toEqual([]);
  const ok=parseExam([pg([...base,it_('2, Paciente.',42,90),it_('A) x',42,110),it_('B) y',42,122)])]);
  expect(ok.candidates.map(c=>[c.originalNumber,c.stem])).toEqual([[1,'Enunciado.'],[2,'Paciente.']]);
 });
});
