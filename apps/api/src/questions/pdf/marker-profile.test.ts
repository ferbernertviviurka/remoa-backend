import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readPdfLayout} from '@remoa/ai';
import {questionCandidatePayloadSchema} from '@remoa/contracts';
import {describe,expect,it} from 'vitest';
import {parseExam,parseAnswerKey} from './parser';
import {inferExamMarkerProfiles} from './layout';
import type {PdfLayoutPage} from './types';
import authorial from './marker-profile.gold.json';
import actual from './enare-t102-structure.gold.json';
const item=(text:string,x:number,y:number,height=11)=>({text,x,y,width:Math.min(220,text.length*5),height});
const page=(items:ReturnType<typeof item>[],number=1):PdfLayoutPage=>({page:number,width:600,height:800,items});
describe('CCR134 regional marker structure',()=>{
 it('cover giant cannot suppress body markers; tables/lists remain full body and pre-A reference is preserved',()=>{
  const result=parseExam(structuredClone(authorial.pages));
  expect(result.candidates.map(c=>c.originalNumber)).toEqual(authorial.expectedNumbers);
  expect(result.candidates.map(c=>c.alternatives.map(a=>a.key))).toEqual(Array(4).fill(authorial.expectedKeys));
  for(const text of authorial.requiredPreservedText)expect(result.candidates.some(c=>c.stem.includes(text))).toBe(true);
  expect(result.candidates[2]!.stem).toContain('63 591');expect(result.candidates[2]!.stem).toContain('12');
  expect(result.candidates.every(c=>c.provenance.every(p=>p.page===2))).toBe(true);
 });
 it('preserves an unlabelled right-column prelude and flags its uncertain attachment',()=>{
  const p=page([item('1',25,80),item('Own stem',25,100),item('(A) first',25,140),item('(B) second',25,170),item('Uncertain title: não alterar 2 kg.',330,50),item('2',330,80),item('Other stem',330,100),item('(A) third',330,140),item('(B) fourth',330,170)]);
  const r=parseExam([p]);expect(r.candidates.map(c=>c.originalNumber)).toEqual([1,2]);
  expect(r.candidates[0]!.alternatives[1]!.text).toContain('Uncertain title: não alterar 2 kg.');expect(r.candidates[0]!.issues).toContain('marker_profile_ambiguous');expect(r.warnings).toContain('marker_profile_ambiguous:1');
  expect(r.candidates[0]!.parserMarkerEvidence!.provenance.bbox.y).toBe(80);
 });
 it('corroborates a first outdented marker by bounded indentation and an aligned stem, preserving original bounds',()=>{
  const p:PdfLayoutPage={page:1,width:100,height:200,items:[{text:'1',x:0,y:0,width:10,height:10},{text:'texto não mudar 2 kg',x:10,y:20,width:70,height:10},{text:'(A) a',x:10,y:40,width:30,height:10},{text:'(B) b',x:10,y:60,width:30,height:10}]};
  const r=parseExam([p]);expect(r.candidates).toHaveLength(1);expect(r.candidates[0]!.stem).toBe('texto não mudar 2 kg');expect(r.candidates[0]!.parserMarkerEvidence!.provenance.bbox.x).toBe(0);expect(r.candidates[0]!.alternatives.map(a=>a.key)).toEqual(['A','B']);
  for(const delta of [11,20]){const bad=structuredClone(p);bad.items[0]!.x=10-delta;expect(parseExam([bad]).candidates).toHaveLength(0);}
  const table=structuredClone(p);table.items[1]!.text='12 31';expect(parseExam([table]).candidates).toHaveLength(0);
  const list=structuredClone(p);list.items[1]!.text='1. Lista interna';expect(parseExam([list]).candidates.every(c=>c.parserMarkerEvidence!.provenance.bbox.y!==0)).toBe(true); // Generic legacy prefixed numbers retain their old behavior; no outdented marker is recovered.
  const noStem=structuredClone(p);noStem.items.splice(1,1);expect(parseExam([noStem]).candidates).toHaveLength(0);
  const interior=structuredClone(p);interior.items[0]!.y=50;expect(parseExam([interior]).candidates).toHaveLength(0);
 });
 it('learns alternative geometry rather than particular PDF column coordinates',()=>{
  const shifted=structuredClone(authorial.pages);for(const p of shifted)for(const i of p.items)i.x+=12;
  expect(parseExam(shifted).candidates.map(c=>c.originalNumber)).toEqual([1,2,3,4]);
  const profiles=inferExamMarkerProfiles(shifted);expect(profiles.get(2)!.map(p=>p.x)).toEqual([52,342]);
 });
 it('retains original continuation negation, units and image provenance without a next marker',()=>{
  const first=page([item('1',25,80),item('Não trocar 2 kg.',25,100),item('(A) primeira',25,140)]);
  const second=page([item('Negação continua com 0,5.',25,50),item('(B) segunda',25,80),item('(C) terceira',25,110)],2);second.images=[{x:25,y:50,width:100,height:15}];
  const result=parseExam([first,second]);expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]!.alternatives[0]!.text).toContain('Negação continua com 0,5.');
  expect(result.candidates[0]!.provenance.map(p=>p.page)).toEqual([1,2]);expect(result.candidates[0]!.imageRefs).toHaveLength(1);
 });
 it('a borrowed bare profile keeps numbered lists in a continuation body instead of creating duplicate questions',()=>{
  const a=page([item('1',25,80),item('Stem original',25,100),item('(A) first',25,140)]);
  const b=page([item('1. Lista dentro da alternativa',25,50),item('2. Lista conserva não alterar 2 kg.',25,70),item('(B) second',25,100),item('(C) third',25,130)],2);
  const r=parseExam([a,b]);expect(r.candidates).toHaveLength(1);expect(r.candidates[0]!.alternatives[0]!.text).toContain('1. Lista dentro da alternativa 2. Lista conserva não alterar 2 kg.');
 });
 it('preserves generic legacy non-A alternatives and marks unresolved bare starts for review',()=>{
  const legacy=parseExam([page([item('Questão 1',10,50),item('Original stem',10,80),item('(B) second',10,110),item('(D) fourth',10,140)])]);
  expect(legacy.candidates[0]!.alternatives.map(a=>a.key)).toEqual(['B','D']);
  const ambiguous=parseExam([page([item('1',10,50),item('Original stem',10,80),item('(B) second',10,110),item('(D) fourth',10,140)])]);
  expect(ambiguous.candidates[0]!.alternatives.map(a=>a.key)).toEqual(['B','D']);expect(ambiguous.warnings).toContain('marker_profile_ambiguous:1');
 });
 it('warns about all unmatched selected-key numbers without inventing candidates or changing reviewed exclusions',()=>{
  const p=page([item('Questão 1',10,50),item('Stem',10,80),item('(A) one',10,110),item('(B) two',10,140)]);p.reviewedNonQuestion=true;
  const key=parseAnswerKey([page([item('1 A 2 B 100 C',10,50)])]);const r=parseExam([p],key);
  expect(r.candidates.map(c=>c.originalNumber)).toEqual([1]);expect(r.warnings).toEqual(expect.arrayContaining(['expected_question_unmatched:2','expected_question_unmatched:100','reviewed_non_question_page:1']));
 });
 it('giant duplicate alternatives get a structural warning and retain existing rejection issues',()=>{
  const p=page([item('Questão 1',10,30),item('Stem',10,60),...Array.from({length:12},(_,n)=>item('('+('AB'[n%2])+') retained',10,90+n*20))]);
  const r=parseExam([p]);expect(r.candidates[0]!.alternatives).toHaveLength(12);expect(r.candidates[0]!.issues).toEqual(expect.arrayContaining(['duplicate_alternative','segmentation_incomplete']));expect(r.warnings).toContain('segmentation_incomplete:1');
 });
 it('omits only complete corroborated official labels; retains quoted labels, body phrases and one-off notes',()=>{
  const first=page([item('Exame Nacional de Residência',20,20,7),item('INSTITUTO AOCP',350,20,7),item('PRM - ACESSO DIRETO',20,760,7),item('Tipo 01 - Página 1',350,760,7),item('1',20,80),item('INSTITUTO AOCP não muda a negação nem 2 kg.',20,110),item('"Instituto AOCP"',20,130),item('(A) one',20,160),item('(B) two',20,190)]);
  const second=page([item('Exame Nacional de Residência',20,20,7),item('INSTITUTO AOCP',350,20,7),item('PRM - ACESSO DIRETO',20,760,7),item('Tipo 01 - Página 2',350,760,7),item('2',20,80),item('Stem',20,110),item('(A) one',20,160),item('(B) two',20,190)],2);
  const r=parseExam([first,second]);expect(r.removedMargins).toHaveLength(8);expect(r.candidates[0]!.stem).toContain('não muda a negação nem 2 kg.');expect(r.candidates[0]!.stem).toContain('"Instituto AOCP"');
  const lone=parseExam([first]);expect(lone.removedMargins).toEqual([]);expect(lone.candidates[0]!.alternatives[1]!.text).toContain('PRM - ACESSO DIRETO');
 });
 it('preserves complete metadata-like words on a continuation without matching margin geometry',()=>{
  const a=page([item('INSTITUTO AOCP',20,20,7),item('1',20,80),item('Stem',20,110),item('(A) one',20,160)]);
  const b=page([item('INSTITUTO AOCP',20,60,11),item('não alterar 2 kg.',20,80),item('(B) two',20,110)],2);
  const r=parseExam([a,b]);expect(r.removedMargins).toEqual([]);expect(r.candidates[0]!.alternatives[0]!.text).toContain('INSTITUTO AOCP não alterar 2 kg.');
 });
 it('actual first caderno matches100 independently frozen markers and keeps raw501 option-prefix evidence',async()=>{
  const bytes=await readFile(new URL('../../../../../../docs/content/questions/acquisition-batches/official-20261009/enare_2021-2022_t102.pdf',import.meta.url));expect(createHash('sha256').update(bytes).digest('hex')).toBe(actual.sourceSha256);
  const layout=await readPdfLayout(new Uint8Array(bytes));const pages=layout.pages.filter(p=>p.page<=31),r=parseExam(pages);
  expect(r.candidates.map(c=>c.originalNumber)).toEqual(actual.entries.map(e=>e.number));
  for(const [index,c]of r.candidates.entries()){
   // Store replaces raw crop boxes with prepared private descriptors before DTO parsing.
   expect(questionCandidatePayloadSchema.safeParse({...c,imageRefs:[]}).success).toBe(true);
   const g=actual.entries[index]!;expect(c.parserMarkerEvidence!.originalNumber).toBe(g.number);expect(c.parserMarkerEvidence!.provenance.page).toBe(g.page);expect(c.parserMarkerEvidence!.provenance.bbox.x).toBeCloseTo(g.bbox.x,5);expect(c.parserMarkerEvidence!.provenance.bbox.y).toBeCloseTo(g.bbox.y,5);
   expect(c.alternatives.map(a=>a.key)).toEqual(['A','B','C','D','E']);
  }
  expect(r.candidates.find(c=>c.originalNumber===20)!.issues).toContain("marker_profile_ambiguous");
  expect(r.warnings).toContain("marker_profile_ambiguous:20");
  expect(actual.entries.reduce((n,e)=>n+e.alternativeAnchors.length,0)).toBe(501);
  expect(r.candidates.find(c=>c.originalNumber===64)!.stem).toContain('(F)');
 },30_000);
});
