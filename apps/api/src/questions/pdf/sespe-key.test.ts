import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readPdfLayout} from '@remoa/ai';
import {describe,it,expect} from 'vitest';
import {parseAnswerKey} from './parser';
import type {PdfLayoutPage} from './types';
const root=new URL('../../../../../../docs/content/questions/',import.meta.url);
const fixture=():PdfLayoutPage=>({page:1,width:400,height:500,items:[
{text:'GABARITO DEFINITIVO',x:100,y:10,width:160,height:10},
{text:'GRUPO 01 – Exame autoral',x:100,y:30,width:180,height:10},
{text:'QUESTÕES',x:50,y:60,width:60,height:10},
{text:'ALTERNATIVAS',x:180,y:60,width:100,height:10},
{text:'01',x:70,y:90,width:12,height:10},{text:'NULA',x:210,y:90,width:30,height:10},
{text:'02',x:70,y:110,width:12,height:10},{text:'B',x:220,y:110,width:7,height:10}]});
describe('SESPE frozen structural gold and GRUPO cell boundaries',()=>{
 it('maps only literal whole NULA cell and preserves exact observed bounds',()=>{
  const r=parseAnswerKey([fixture()],'1');expect(r.entries.map(e=>[e.number,e.key,e.annulled,e.ambiguous])).toEqual([[1,null,true,false],[2,'B',false,false]]);
  expect(r.entries[0]!.provenance.bbox).toEqual({x:70,y:90,width:170,height:10});
 });
 it.each(['NULL','X','NULA texto','NU LA'])('does not infer annulment from %s',raw=>{
  const p=fixture();p.items[5]!.text=raw;expect(parseAnswerKey([p],'01').entries[0]).toMatchObject({key:null,annulled:false,ambiguous:true});
 });
 it('rejects split NULA, wrong group, repeated pages and conflicting headers',()=>{
  const p=fixture();p.items[5]!.text='NU';p.items.push({text:'LA',x:245,y:90,width:12,height:10});expect(()=>parseAnswerKey([p],'1')).toThrow();
  expect(()=>parseAnswerKey([fixture()],'2')).toThrow('group');
  expect(()=>parseAnswerKey([fixture(),fixture()],'1')).toThrow('Repeated');
  const q=fixture();q.items.push({text:'GRUPO 02',x:100,y:45,width:80,height:10});expect(()=>parseAnswerKey([q],'1')).toThrow();
 });
 it('requires explicit selection for multiple GRUPOs and ignores unanchored body mentions',()=>{
  const q=fixture();q.page=2;q.items[1]!.text='GRUPO 02';expect(()=>parseAnswerKey([fixture(),q])).toThrow('explicit');
  const p=fixture();p.items[1]!.text='Texto menciona GRUPO 01';expect(()=>parseAnswerKey([p],'1')).toThrow('not found');
 });
 it('rejects displaced internal cells and keeps NULA outside the labelled grid out of the key',()=>{
  const p=fixture();p.items[6]!.x+=25;expect(()=>parseAnswerKey([p],'1')).toThrow('anchor');
  const q=fixture();q.items.push({text:'NULA',x:10,y:200,width:30,height:10});expect(parseAnswerKey([q],'1').entries).toHaveLength(2);
 });
 it.each(['GRUPO 01ou02','GRUPO 01 descrição sem separador'])('rejects incomplete header %s',label=>{
  const p=fixture();p.items[1]!.text=label;expect(()=>parseAnswerKey([p],'1')).toThrow('complete numeric');
 });
 it('matches all350 frozen original numbers/tokens/pages without changing gold',async()=>{
  const goldBytes=await readFile(new URL('golds/sespe-2024-structural/gold.json',root));
  expect(createHash('sha256').update(goldBytes).digest('hex')).toBe('fe384bbfb34f04d78584b747b6df97a4e90dd38cc89f9015b798afa4b7e23b50');
  const gold=JSON.parse(goldBytes.toString());let total=0,annulled=0;
  for(const g of gold.groups){
   const bytes=await readFile(new URL(g.pdfPath.replace('docs/content/questions/',''),root));
   expect(createHash('sha256').update(bytes).digest('hex')).toBe(g.pdfSha256);
   const layout=await readPdfLayout(new Uint8Array(bytes));const page=layout.pages.find(p=>p.page===g.originalPage)!;
   const result=parseAnswerKey([page],g.group);
   expect(result.entries.map(e=>({number:e.number,raw:e.raw}))).toEqual(g.cells.map((c:{number:number;tokenLiteral:string})=>({number:c.number,raw:c.tokenLiteral})));
   for(const [i,e] of result.entries.entries()){expect(e.provenance.page).toBe(g.originalPage);expect(e.provenance.bbox.x).toBeCloseTo(g.cells[i].bbox[0],1);expect(e.provenance.bbox.width).toBeCloseTo(g.cells[i].bbox[2],1);}
   total+=result.entries.length;annulled+=result.entries.filter(e=>e.annulled).length;
  }
  expect([total,annulled]).toEqual([350,8]);
 },30000);
});
