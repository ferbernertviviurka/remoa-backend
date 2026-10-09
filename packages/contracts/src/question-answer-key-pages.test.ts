import { describe, expect, it } from 'vitest';
import { questionAnswerKeyPagesSchema, questionImportInputSchema, questionImportProgressSchema } from './question-catalog';
import { mockQuestionImportProgress, mockQuestionImportSelectedPages } from './mocks/question-catalog';
const id='33000000-0000-4000-8000-000000000001';
const input={sourceId:id,documentId:id,answerKeyDocumentId:id,exam:{name:'Synthetic exam',institution:'Engineering',year:2026,edition:'Fixture',booklet:'1',durationSec:null},parserVersion:'f33-layout-v5',budgetCents:0,reason:'Synthetic explicit original answer key selection'};
describe('CCR133 original answer key pages',()=>{
 it('keeps omission/null as the legacy whole document scope',()=>{
  expect(questionAnswerKeyPagesSchema.parse(undefined)).toBeNull();
  expect(questionAnswerKeyPagesSchema.parse(null)).toBeNull();
  expect(questionImportInputSchema.parse(input).answerKeyPages).toBeNull();
  expect(mockQuestionImportProgress.answerKeyPages).toBeNull();
 });
 it('canonicalizes page order without mutating input or deduplicating ambiguity',()=>{
  const pages=[19,3,9,5];expect(questionAnswerKeyPagesSchema.parse(pages)).toEqual([3,5,9,19]);expect(pages).toEqual([19,3,9,5]);
  expect(questionImportInputSchema.parse({...input,answerKeyPages:pages}).answerKeyPages).toEqual([3,5,9,19]);
 });
 it.each([[],[0],[501],[1.5],[1,1],[1,null],['3'],[NaN],[Infinity]].map(pages=>({pages})))('rejects invalid selection $pages',({pages})=>{
  expect(questionAnswerKeyPagesSchema.safeParse(pages).success).toBe(false);
 });
 it('accepts every page up to500 and rejects overflow rather than truncating',()=>{
  const pages=Array.from({length:500},(_,i)=>500-i);expect(questionAnswerKeyPagesSchema.parse(pages)).toEqual([...pages].reverse());
  expect(questionAnswerKeyPagesSchema.safeParse([...pages,501]).success).toBe(false);
 });
 it('requires a key document only when a selection is present; no untrusted extra keys',()=>{
  expect(questionImportInputSchema.safeParse({...input,answerKeyDocumentId:null,answerKeyPages:[3]}).success).toBe(false);
  expect(questionImportInputSchema.safeParse({...input,answerKeyDocumentId:null}).success).toBe(true);
  expect(questionImportInputSchema.safeParse({...input,answerKeyPages:[3],crop:true}).success).toBe(false);
 });
 it('admin progress roundtrips both scopes and retains original selected numbers',()=>{
  expect(questionImportProgressSchema.parse(mockQuestionImportSelectedPages).answerKeyPages).toEqual([3]);
  expect(questionImportProgressSchema.parse(mockQuestionImportProgress).answerKeyPages).toBeNull();
 });
});
