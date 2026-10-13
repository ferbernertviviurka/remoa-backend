import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readPdfLayout} from '@remoa/ai';
import {describe,expect,it} from 'vitest';
import {parseExam} from './parser';
import {splitAlternativeRow,pageLines} from './layout';
import type {PdfLayoutItem,PdfLayoutPage} from './types';
// D-1803 adversarial fixtures: every box is an explicit synthetic item box, never a glyph-width estimate.
const it_=(text:string,x:number,y:number,width:number,height=10):PdfLayoutItem=>({text,x,y,width,height});
const page=(items:PdfLayoutItem[]):PdfLayoutPage=>({page:1,width:600,height:800,items,images:[]});
const q=(...rows:PdfLayoutItem[]):PdfLayoutPage=>page([it_('1. Enunciado sintético da questão.',40,40,300),...rows]);
const parse=(p:PdfLayoutPage)=>parseExam([p]).candidates[0]!;
const keys=(p:PdfLayoutPage)=>parse(p).alternatives.map(a=>a.key).join('');
/** One row; gaps of 20pt stay below the 7% (42pt) line-merge gap, so v7 fused these rows. */
const row=(y:number,cells:[string,number][],x0=40,gap=20)=>{let x=x0;return cells.map(([t,w])=>{const i=it_(t,x,y,w);x+=w+gap;return i;});};
describe('D-1803 horizontal alternatives split only at real label items',()=>{
 it.each([
  [2,['A) Sim.','B) Não.']],
  [5,['A) 0,5 mg/kg','B) 1 mg/kg','C) Não usar','D) 2 g','E) 10 UI']],
 ] as const)('splits a %i-option row merged by line grouping',(_n,labels)=>{
  const items=row(60,labels.map(t=>[t,60] as [string,number]));
  expect(pageLines(page(items))).toHaveLength(1);
  const c=parse(q(...items));
  expect(c.alternatives).toEqual(labels.map(t=>({key:t[0],text:t.slice(3)})));
  expect(c.issues).not.toContain('segmentation_incomplete');
  expect(c.provenance[0]!.bbox.width).toBeGreaterThan(0);
 });
 it('10 options in two rows of five keep reading order A..J',()=>{
  const r1=row(60,['A) a1','B) b1','C) c1','D) d1','E) e1'].map(t=>[t,50] as [string,number]));
  const r2=row(72,['F) f1','G) g1','H) h1','I) i1','J) j1'].map(t=>[t,50] as [string,number]));
  expect(keys(q(...r1,...r2))).toBe('ABCDEFGHIJ');
 });
 it('internal letters and labels inside one item are never split by regex',()=>{
  const c=parse(q(it_('A) vitamina B12 e C',40,60,90),it_('B) hepatite B. Conduta: não usar C) ainda',150,60,180),it_('C) Outra',350,60,50)));
  expect(c.alternatives).toEqual([{key:'A',text:'vitamina B12 e C'},{key:'B',text:'hepatite B. Conduta: não usar C) ainda'},{key:'C',text:'Outra'}]);
  expect(c.issues).not.toContain('segmentation_incomplete');
 });
 it('fused labels without individual boxes keep text intact and flag review',()=>{
  const text='A) peitoral menor. B) peitoral maior. C) grande dorsal. D) deltoide. E) subescapular.';
  const r=parseExam([q(it_(text,40,60,400))]);const c=r.candidates[0]!;
  expect(c.alternatives).toEqual([{key:'A',text:text.slice(3)}]);
  expect(c.issues).toEqual(expect.arrayContaining(['missing_alternatives','segmentation_incomplete']));
  expect(r.warnings).toContain('segmentation_incomplete:1');
 });
 it('trailing fused label after contiguous A-D flags review without inventing E',()=>{
  const c=parse(q(...row(60,[['A) um',40],['B) dois',40],['C) três',40],['D) quatro E) cinco',90]])));
  expect(c.alternatives.at(-1)).toEqual({key:'D',text:'quatro E) cinco'});expect(c.issues).toContain('segmentation_incomplete');
 });
 it.each([
  ['word-space gap',[it_('A) usar dose de',40,60,70),it_('B) 1 g',112,60,30)]],
  ['different baseline',[it_('A) texto',40,60,40),it_('B) outro',100,63,40)]],
  ['different height',[it_('A) texto',40,60,40),it_('B) outro',100,60,40,6)]],
  ['out-of-order label',[it_('B) texto',40,60,40),it_('A) outro',100,60,40)]],
  ['duplicate label',[it_('A) texto',40,60,40),it_('A) outro',100,60,40)]],
 ])('%s: no split, full text preserved, flagged',(_name,items)=>{
  const res=splitAlternativeRow(pageLines(page(items))[0]!);
  expect(res.lines).toHaveLength(1);expect(res.ambiguous).toBe(true);
  const c=parse(q(...items));
  expect(c.alternatives).toHaveLength(1);expect(c.alternatives[0]!.text).toContain(items[1]!.text);
  expect(c.issues).toContain('segmentation_incomplete');
 });
 it('never splits the question-marker line or a stem line that does not start with a label item',()=>{
  const c=parse(page([it_('1. Paciente com hepatite',40,40,120),it_('B) não é alternativa',180,40,100),it_('A) um',40,60,40),it_('B) dois',40,72,40)]));
  expect(c.stem).toBe('Paciente com hepatite B) não é alternativa');expect(c.alternatives.map(a=>a.key)).toEqual(['A','B']);
 });
});
describe('D-1803 local grid order',()=>{
 const grid=(dx=300,dyD=0)=>[it_('A) Cleland',40,60,60),it_('B) Triangular',40,72,60),it_('D) Banda sagital',40+dx,72+dyD,80),it_('C) Colateral',40,84,60),it_('E) Tendão',40+dx,84,60)];
 it('reorders a proven 3+2 column-major grid and keeps every text',()=>{
  const c=parse(q(...grid()));
  expect(c.alternatives).toEqual([{key:'A',text:'Cleland'},{key:'B',text:'Triangular'},{key:'C',text:'Colateral'},{key:'D',text:'Banda sagital'},{key:'E',text:'Tendão'}]);
  expect(c.issues).not.toContain('segmentation_incomplete');
 });
 it('grid row merged by line grouping is split at the D label and reordered',()=>{
  expect(pageLines(page(grid(80))).some(l=>l.text==='B) Triangular D) Banda sagital')).toBe(true);expect(keys(q(...grid(80)))).toBe('ABCDE');
 });
 it('10 options in a 5+5 grid',()=>{
  const items=['ABCDE','FGHIJ'].flatMap((col,c)=>[...col].map((k,r)=>it_(`${k}) opção ${k}`,40+c*300,60+r*12,60)));
  expect(keys(q(...items))).toBe('ABCDEFGHIJ');
 });
 it('long text continuations attach to their own column, not to the reading-order neighbour',()=>{
  const items=[it_('A) primeira',40,60,60),it_('B) segunda longa',40,72,120),it_('D) quarta longa',340,72,120),
   it_('continua B',52,84,60),it_('continua D',352,84,60),it_('C) terceira',40,96,60),it_('E) quinta',340,96,60)];
  const c=parse(q(...items));
  expect(c.alternatives).toEqual([{key:'A',text:'primeira'},{key:'B',text:'segunda longa continua B'},{key:'C',text:'terceira'},{key:'D',text:'quarta longa continua D'},{key:'E',text:'quinta'}]);
 });
 it.each([
  ['later-column label off any first-column baseline',grid(300,5)],
  ['duplicate label',[it_('A) a',40,60,40),it_('B) b',40,72,40),it_('B) x',340,72,40),it_('C) c',40,84,40),it_('E) e',340,84,40)]],
  ['missing letter',[it_('A) a',40,60,40),it_('B) b',40,72,40),it_('E) x',340,72,40),it_('C) c',40,84,40)]],
  ['segment crossing into next column',[it_('A) a',40,60,40),it_('B) b',40,72,40),it_('D) d',340,72,40),it_('C) texto que invade a coluna ao lado',40,84,320),it_('E) e',400,96,40)]],
  ['continuation crossing columns',[it_('A) a',40,60,40),it_('B) b',40,72,40),it_('D) d',340,72,40),it_('linha que cruza as duas colunas sem lacuna',52,84,330),it_('C) c',40,96,40),it_('E) e',340,96,40)]],
 ])('unproven grid (%s): keeps reading order and flags review',(_n,items)=>{
  const c=parse(q(...items));
  const before=keys(q(...items));
  expect(before).not.toBe('ABCDE');expect(c.issues).toContain('segmentation_incomplete');
  const words=(s:string)=>s.split(/\s+/).filter(Boolean).sort();
  expect(words(c.alternatives.map(a=>`${a.key}) ${a.text}`).join(' '))).toEqual(words(items.map(i=>i.text).join(' ')));
 });
});
describe('D-1807 roman statement blocks are not alternative I',()=>{
 const lines=(texts:string[])=>page([it_('1. Analise as assertivas abaixo:',40,40,200),...texts.map((t,i)=>it_(t,40,60+i*12,Math.min(400,t.length*4)))]);
 it('I., II., III. before A–E stay in the stem intact',()=>{
  const c=parse(lines(['I. Dose de 0,5 mg/kg.','II. Não usar em gestantes.','III. Vitamina B12 e C.','A) Apenas I.','B) Apenas II.','C) I e II.','D) Todas.','E) Nenhuma.']));
  expect(c.stem).toBe('Analise as assertivas abaixo: I. Dose de 0,5 mg/kg. II. Não usar em gestantes. III. Vitamina B12 e C.');
  expect(c.alternatives.map(a=>a.key).join('')).toBe('ABCDE');expect(c.issues).not.toContain('segmentation_incomplete');
 });
 it('I. to IV. fused in one item stay in the stem',()=>{
  const c=parse(lines(['I. Um. II. Dois. III. Três. IV. Quatro.','A) I','B) II','C) III','D) IV','E) Todas']));
  expect(c.stem).toBe('Analise as assertivas abaixo: I. Um. II. Dois. III. Três. IV. Quatro.');expect(c.alternatives).toHaveLength(5);
 });
 it('"I." alone before alternatives is stem text',()=>{
  const c=parse(lines(['I.','A) sim','B) não']));expect(c.stem).toBe('Analise as assertivas abaixo: I.');expect(c.alternatives.map(a=>a.key)).toEqual(['A','B']);
 });
 it.each([9,10])('genuine alternative I in a %i-option question',n=>{
  const ks='ABCDEFGHIJ'.slice(0,n).split('');
  const c=parse(lines(ks.map(k=>`${k}) opção ${k}`)));
  expect(c.alternatives.map(a=>a.key)).toEqual(ks);expect(c.alternatives[8]).toEqual({key:'I',text:'opção I'});
 });
 it('mixed: roman statements in the stem and a genuine I after H',()=>{
  const c=parse(lines(['I. Primeira.','II. Segunda.',...'ABCDEFGHI'.split('').map(k=>`${k}) ${k==='I'?'I e II.':'opção '+k}`)]));
  expect(c.stem).toBe('Analise as assertivas abaixo: I. Primeira. II. Segunda.');
  expect(c.alternatives.map(a=>a.key).join('')).toBe('ABCDEFGHI');expect(c.alternatives[8]!.text).toBe('I e II.');
 });
 it('"I." after an incomplete A..G sequence is continuation text, never a new key',()=>{
  const c=parse(lines(['A) a','B) b','C) c','I. continua C']));
  expect(c.alternatives).toEqual([{key:'A',text:'a'},{key:'B',text:'b'},{key:'C',text:'c I. continua C'}]);
 });
});
describe('D-1807 running page margins need repeated evidence and a proven page-number footer',()=>{
 const sheet=(n:number,body:PdfLayoutItem[],header='GRUPO 05 / CIRURGIA DE MÃO',footer=true):PdfLayoutPage=>({page:n,width:595,height:842,images:[],items:[
  it_(header,440,35,112,8),...body,...(footer?[it_(String(n),295,796,5,9)]:[])]});
 it('removes repeated header and page number, so the last alternative and grid proof stay clean',()=>{
  const p1=sheet(1,[it_('15. Enunciado.',42,56,300),it_('A) um',42,80,40),it_('B) dois',42,92,40),it_('D) quatro',340,92,50),it_('C) três',42,104,40),it_('E) cinco',340,104,50)]);
  const p2=sheet(2,[it_('16. Outro.',42,56,300),it_('A) x',42,80,40),it_('B) y',42,92,40)]);
  const r=parseExam([p1,p2]);const c=r.candidates[0]!;
  expect(c.alternatives.map(a=>`${a.key}) ${a.text}`)).toEqual(['A) um','B) dois','C) três','D) quatro','E) cinco']);
  expect(c.issues).not.toContain('segmentation_incomplete');
  expect(r.removedMargins?.map(m=>[m.page,m.text,m.reason])).toEqual([[1,'GRUPO 05 / CIRURGIA DE MÃO','repeated_margin'],[1,'1','repeated_margin'],[2,'GRUPO 05 / CIRURGIA DE MÃO','repeated_margin'],[2,'2','repeated_margin']]);
 });
 it.each([
  ['header only on one page',(n:number)=>n===1?'GRUPO 05 / CIRURGIA DE MÃO':'Outro cabeçalho'],
  ['no page-number footer',null],
 ] as const)('keeps top text when evidence is missing: %s',(_n,header)=>{
  const mk=(n:number)=>sheet(n,[it_('Não substituir 2 kg.',42,56,120),it_('A) a',42,80,40),it_('B) b',42,92,40)],header?header(n):'Não usar dose dupla.',header!==null);
  const pages=[mk(1),mk(2)];pages[0]!.items.unshift(it_('1. Enunciado.',42,50,100));
  const r=parseExam(pages);
  expect(r.removedMargins?.some(m=>/[A-Za-z]/.test(m.text))).toBe(false);
 });
 it('a page number that does not track the page index is kept',()=>{
  const pages=[1,2].map(n=>({page:n,width:595,height:842,images:[],items:[it_(`${n}. Questão.`,42,56,100),it_('A) a',42,80,40),it_('B) b 7',42,92,40),it_('7',295,796,5,9)]}) as PdfLayoutPage);
  expect(parseExam(pages).removedMargins).toEqual([]);
 });
});
describe('D-1810 trailing text after the final question',()=>{
 const p1=page([it_('1. Enunciado.',40,40,100),it_('A) a',40,60,40),it_('B) b',40,72,40),it_('2. Outro.',40,100,100),it_('A) x',40,120,40),it_('B) dose de 2',40,132,60)]);
 it.each([
  ['closing-page title',['GRUPO 05','- CIRURGIA DA MÃO -'],'dose de 2 GRUPO 05 - CIRURGIA DA MÃO -'],
  ['genuine continuation of the last alternative',['mg/kg ao dia.'],'dose de 2 mg/kg ao dia.'],
 ] as const)('%s is kept, never removed, and flagged',(_n,texts,expected)=>{
  const r=parseExam([p1,{...page(texts.map((t,i)=>it_(t,200,400+i*20,120))),page:2}]);
  expect(r.candidates[0]!.issues).not.toContain('segmentation_incomplete');
  const last=r.candidates[1]!;expect(last.alternatives[1]!.text).toBe(expected);
  expect(last.issues).toContain('segmentation_incomplete');
  expect(r.warnings).toEqual(expect.arrayContaining(['trailing_unattached_text:2','segmentation_incomplete:2']));
  expect(r.removedMargins).toEqual([]);
 });
 it('a non-final question continuing across pages up to the next marker is not flagged by this rule',()=>{
  const r=parseExam([page([it_('1. Enunciado.',40,40,100),it_('A) a',40,60,40),it_('B) dose de 2',40,72,60)]),{...page([it_('mg/kg.',40,40,40),it_('2. Outro.',40,60,100),it_('A) x',40,80,40),it_('B) y',40,92,40)]),page:2}]);
  expect(r.candidates[0]!.alternatives[1]!.text).toBe('dose de 2 mg/kg.');
  expect(r.warnings.some(w=>w.startsWith('trailing_unattached_text'))).toBe(false);
 });
});
describe('D-1803 real SES-PE 2024 grupo 05 page 7',()=>{
 it('Q41–Q50 have all five alternatives A–E in order with original texts',async()=>{
  const bytes=await readFile(new URL('../../../../../../docs/content/questions/acquisition-batches/official-final-20261009/sespe_rm2024_gr05.pdf',import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('c9058dcb6254d81c5aee58fa73b174afc727d51642d0f5b42ae34ab09b43d4ea');
  const layout=await readPdfLayout(new Uint8Array(bytes));
  const result=parseExam(layout.pages.map(p=>({...p,method:'text' as const})));
  const page7=result.candidates.filter(c=>c.originalNumber>=41&&c.originalNumber<=50);
  expect(page7.map(c=>c.originalNumber)).toEqual([41,42,43,44,45,46,47,48,49,50]);
  for(const c of page7){expect(c.alternatives.map(a=>a.key).join('')).toBe('ABCDE');expect(c.issues.includes('segmentation_incomplete')).toBe(c.originalNumber===50);}
  expect(result.warnings).toContain('trailing_unattached_text:50');
  const alt=(n:number)=>page7.find(c=>c.originalNumber===n)!.alternatives.map(a=>a.text);
  expect(alt(41)).toEqual(['Cleland','Triangular','Colateral acessório','Banda sagital','Tendão extensor terminal']);
  expect(alt(42)).toEqual(['peitoral menor.','peitoral maior.','grande dorsal.','deltoide.','subescapular.']);
  expect(alt(43)).toEqual(['Cominuição dorsal.','Idade acima de 60 anos.','Fratura da ulna associada.','Traço de fratura intrarticular.','Angulação dorsal maior que 15 graus.']);
  expect(alt(44)).toEqual(['Infraespinhal.','Supraespinhal.','Tríceps.','Subescapular.','Redondo maior.']);
  expect(alt(45)).toEqual(['C6 e C8.','C5 e C7.','C5 e C8.','C6 e C7.','C8 e T1.']);
  expect(alt(46)).toEqual(['Subescapular','Peitoral lateral','Axilar','Supraescapular','Frênico.']);
  expect(alt(47)).toEqual(['neurilenoma','schwanoma','ganglioneuroma','tumor de células gigantes','neurofibroma']);
  expect(alt(48)).toEqual(['4-5.','6R.','6U.','3-4.','1-2.']);
  expect(alt(49)).toEqual(['Dor','Palidez','Parestesia','Aumento da pressão intracompartimental','Ausência de pulso']);
  // Running header/page number are removed (D-1807); the unrepeated closing-page title is body text and stays.
  expect(alt(50)).toEqual(['Grau I.','Grau II.','Grau IIIA','Grau IIIB.','Grau IV. GRUPO 05 - CIRURGIA DA MÃO -']);
 },30000);
});
