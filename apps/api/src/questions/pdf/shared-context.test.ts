import { describe, expect, it } from 'vitest';
import { parseExam } from './parser';
import { extractSharedContexts } from './shared-context';
import { SHARED_CONTEXT_GOLD as gold } from './shared-context.gold';
import type { PdfLayoutPage } from './types';
const page=(texts:string[],number=1):PdfLayoutPage=>({page:number,width:600,height:800,items:texts.map((text,i)=>({text,x:20,y:100+i*20,width:Math.min(500,text.length*5),height:12}))});
describe('pre-column shared evidence (frozen authorial gold)',()=>{
 it('preserves numbered prose, negation and units before strict question markers',()=>{
  const p=page([...gold.listCase.context.split('\n'),'Questão 1',gold.listCase.ownStems[0],'(A) 2 kg','(B) 2 mg','Questão 2',gold.listCase.ownStems[1],'(A) Não substituir','(B) Substituir']);const r=parseExam([p]);
  expect(r.sharedContexts).toHaveLength(1);expect(r.sharedContexts![0]).toMatchObject({originalText:gold.listCase.context,declaredNumbers:gold.listCase.targets,status:'unresolved'});expect(r.candidates.map(q=>q.originalNumber)).toEqual(gold.listCase.numbers);expect(r.candidates.map(q=>q.ownStem)).toEqual(gold.listCase.ownStems);expect(r.candidates.every(q=>q.issues.includes('shared_context_unresolved'))).toBe(true);expect(r.sharedContexts![0]!.rawLayout.map(i=>i.text)).toEqual(gold.listCase.context.split('\n'));
 });
 it('retains orphan evidence with no candidate and blocks undefined page continuation',()=>{
  const r=parseExam([page(gold.orphanCase.context.split('\n'))]);expect(r.candidates.map(q=>q.originalNumber)).toEqual(gold.orphanCase.numbers);expect(r.sharedContexts![0]).toMatchObject({originalText:gold.orphanCase.context,declaredNumbers:gold.orphanCase.targets,issues:expect.arrayContaining(['context_boundary_unresolved'])});expect(r.sharedContexts![0]!.provenance[0]!.bbox.height).toBeGreaterThan(0);
 });
 it('extracts spanning context before two columns without list anchors changing columns',()=>{
  const p=page(['TEXTO PARA QUESTÕES 1 A 2','1. Não trocar 2 L.']);for(const [x,n,t] of [[20,1,'Esquerda'],[320,2,'Direita']] as const)p.items.push({text:String(n),x,y:200,width:8,height:15},{text:t,x,y:220,width:100,height:12},{text:'(A) sim',x,y:240,width:60,height:12},{text:'(B) não',x,y:260,width:60,height:12});const r=parseExam([p]);expect(r.candidates.map(q=>q.stem)).toEqual(['Esquerda','Direita']);expect(r.sharedContexts![0]!.originalText).toContain('1. Não trocar 2 L.');
 });
 it('keeps standalone internal table numbers away from marker margins inside context',()=>{
  const p=page(['TEXTO PARA QUESTÕES 3 E 4']);p.items.push({text:'2',x:200,y:140,width:10,height:12},{text:'Não apagar a unidade.',x:200,y:160,width:120,height:12});expect(extractSharedContexts([p]).contexts[0]!.originalText).toContain('2\nNão apagar a unidade.');
 });
 it('retains unknown scope and multiple blocks without inferring targets',()=>{
  const r=extractSharedContexts([page(['TEXTO PARA QUESTÕES seguintes','Não substituir 2 kg.','TEXTO PARA QUESTÕES 9 ATÉ 8','2. Não substituir.'])]);expect(r.contexts).toHaveLength(2);expect(r.contexts.every(c=>c.declaredNumbers.length===0)).toBe(true);expect(r.contexts[0]!.issues).toContain('context_targets_unknown');
 });
 it('preserves figure geometry/hash/punctuation and never replaces O with zero',()=>{
  const p=page(['TEXTO PARA QUESTÕES 1 E 2','Figura O2: não usar 2 mg.','o1','(A) texto','(B) outro']);p.images=[{x:20,y:125,width:100,height:30}];const a=extractSharedContexts([p]).contexts[0]!;expect(a.originalText).toContain('o1');expect(a.imageRefs).toHaveLength(1);expect(a.evidenceHash).toMatch(/^[a-f0-9]{64}$/);const changed=structuredClone(p);changed.items[1]!.text+='!';expect(extractSharedContexts([changed]).contexts[0]!.evidenceHash).not.toBe(a.evidenceHash);
 });
 it('retains undefined multipage evidence and later own question text',()=>{
  const r=parseExam([page(['TEXTO PARA QUESTÕES 1 E 2','Não alterar 0,2 L.']),page(['Questão 1','Próprio','(A) um','(B) dois'],2)]);expect(r.sharedContexts![0]!.issues).toContain('context_boundary_unresolved');expect(r.sharedContexts![0]!.provenance.map(o=>o.page)).toEqual([1,2]);expect(r.candidates[0]!.ownStem).toBe('Próprio');
 });
 it('preserves numbered table cells at marker margins before a real question boundary',()=>{
  const p=page(['TEXTO PARA QUESTÕES 1 E 2','2','Não substituir 2 kg por 2 mg.','Questão 1','Escolha','(A) um','(B) dois']);
  p.items[1]!.height=15;
  const r=parseExam([p]);expect(r.sharedContexts![0]!.originalText).toContain('2\nNão substituir 2 kg por 2 mg.');expect(r.candidates[0]!.stem).toBe('Escolha');
 });
 it('preserves continuation before a later question and interstitial image geometry',()=>{
  const p=page(['TEXTO PARA QUESTÕES 1 E 2','Comum']);
  const second=page(['NÃO trocar 2 kg por 2 mg.','Questão 1','Escolha','(A) um','(B) dois'],2);
  second.items[1]!.y=260;second.items[2]!.y=280;second.items[3]!.y=300;second.items[4]!.y=320;
  second.images=[{x:50,y:150,width:200,height:80}];
  const r=parseExam([p,second]);const c=r.sharedContexts![0]!;
  expect(c.originalText).toContain('NÃO trocar 2 kg por 2 mg.');expect(c.provenance.map(o=>o.page)).toEqual([1,2]);expect(c.imageRefs).toContainEqual({page:2,bbox:second.images[0],method:'text'});expect(c.rawPages).toHaveLength(2);
 });

 it.each([['1, 2 E 3',[1,2,3]],['1 E 1',[1]],['500 ATÉ 503',[500,501,502,503]],['0 E 1',[]],['1 A 999',[]],['1000 E 2',[]]])('handles exact declared scope %s without inference',(scope,expected)=>{
  const r=extractSharedContexts([page(['TEXTO PARA QUESTÕES '+scope,'Texto comum.'])]);expect(r.contexts[0]!.declaredNumbers).toEqual(expected);
 });
 it('retains unknown visual geometry with a private region ref and preserves context without declarations',()=>{
  const r=extractSharedContexts([page(['TEXTO PARA QUESTÕES 1 E 2','Veja figura sem geometria.'])]);expect(r.contexts[0]!.issues).toContain('figure_geometry_unknown');expect(r.contexts[0]!.imageRefs).toHaveLength(1);
  const p=page(['PROVA ABC1 Não substituir 2 kg.']);expect(extractSharedContexts([p])).toMatchObject({contexts:[],pages:[p]});
 });
 it('does not end context at a narrative reference to another question or adjacent standalone table number',()=>{
  const p=page(['TEXTO PARA QUESTÕES 1 E 2','Questão 9 mencionada no texto comum.','Não alterar 2 kg.','2','Questão 1','Próprio','(A) um','(B) dois']);p.items[3]!.x=320;
  const r=parseExam([p]);expect(r.sharedContexts![0]!.originalText).toContain('Questão 9 mencionada no texto comum.');expect(r.sharedContexts![0]!.originalText).toContain('Não alterar 2 kg.');
 });

 it('recognizes a decomposed declaration without normalizing the stored body',()=>{
  const label='TEXTO PARA QUESTÕES 1 E 2'.normalize('NFD'),body='Não substituir 2 kg.'.normalize('NFD');
  const context=extractSharedContexts([page([label,body])]).contexts[0]!;
  expect(context.declaredNumbers).toEqual([1,2]);expect(context.originalText).toBe(label+'\n'+body);expect(context.rawLayout[1]!.text).toBe(body);
 });

});
