import {describe,expect,it} from 'vitest';
import {examPaperCoverageSchema,examPaperListQuerySchema,examPaperListResultSchema,examPaperPublicSchema} from './question-catalog';
const paper={id:'34000000-0000-4000-8000-000000000001',name:'Seleção disponível',institution:'Instituição original',year:2024,edition:'2024',booklet:'único',sourceId:'34000000-0000-4000-8000-000000000002',version:1,durationSec:null,questionCount:20,status:'published'};
describe('G29 original paper excerpts and truthful coverage',()=>{
 it('keeps legacy rows compatible and distinguishes a partial selection from a complete original paper',()=>{
  expect(examPaperPublicSchema.safeParse(paper).success).toBe(true);
  const r=examPaperPublicSchema.parse({...paper,professionCode:'nursing',coverage:{kind:'source_excerpt',expectedQuestionCount:null,availableQuestionCount:20,scorableQuestionCount:18}});
  expect(r.coverage?.expectedQuestionCount).toBeNull();expect(r.coverage?.kind).toBe('source_excerpt');
 });
 it('does not assume that contiguous numbering proves completeness',()=>{
  expect(examPaperCoverageSchema.safeParse({kind:'complete',expectedQuestionCount:null,availableQuestionCount:20,scorableQuestionCount:20}).success).toBe(false);
 });
 it.each([
  {kind:'complete',expectedQuestionCount:30,availableQuestionCount:20,scorableQuestionCount:20},
  {kind:'source_excerpt',expectedQuestionCount:null,availableQuestionCount:20,scorableQuestionCount:21},
  {kind:'source_excerpt',expectedQuestionCount:0,availableQuestionCount:20,scorableQuestionCount:20},
 ])('rejects invented completeness or score capacity %#',value=>expect(examPaperCoverageSchema.safeParse(value).success).toBe(false));
 it('requires bounded pagination and known courses, without carrying any answer key',()=>{
  expect(examPaperListQuerySchema.parse({})).toEqual({limit:25});
  expect(examPaperListQuerySchema.safeParse({limit:101}).success).toBe(false);
  expect(examPaperListQuerySchema.safeParse({course:'invented_course'}).success).toBe(false);
  expect(examPaperListResultSchema.safeParse({items:[paper],total:841,nextCursor:null,correctKey:'A'}).success).toBe(false);
 });
});
