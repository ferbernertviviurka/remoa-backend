import {describe,it,expect} from 'vitest';
import {accountExportSchema} from './billing';
import {questionSessionSummaryPublicSchema,questionEditorialReviewInputSchema} from './question-catalog';
import {mockQuestionSessionSummary} from './mocks/question-catalog';
const uid='11111111-1111-4111-8111-111111111111';const at='2026-10-08T00:00:00Z';
const base={version:1,exportedAt:at,userId:uid,profile:null,boards:[],cards:[],edges:[],attempts:[],tickets:[]};
const sections={ownedQuestions:[],generationReceipts:[],sessions:[],answers:[],userStates:[],reports:[]};
describe('F33 personal export boundary',()=>{
 it('accepts historical v1 export with empty new personal sections',()=>{expect(accountExportSchema.parse(base).questions).toEqual(sections);});
 it('never accepts correctness, references, private object keys or shuffle secrets in exported attempts',()=>{
  const answer={id:uid,userId:uid,sessionId:uid,itemId:uid,questionId:uid,selectedKey:'A',revision:1,elapsedMs:100,submittedAt:at};
  expect(accountExportSchema.safeParse({...base,questions:{...sections,answers:[answer]}}).success).toBe(true);
  for(const extra of[{correct:true},{referenceSnapshot:{}},{reference_snapshot:{}},{shuffleMap:{A:'B'}},{objectKey:'secret'}])expect(accountExportSchema.safeParse({...base,questions:{...sections,answers:[{...answer,...extra}]}}).success).toBe(false);
  expect(accountExportSchema.safeParse({...base,questions:{...sections,answers:[{...answer,userId:'22222222-2222-4222-8222-222222222222'}]}}).success).toBe(false);
 });
 it('active sessions cannot export scores or institutional references',()=>{const session={id:uid,userId:uid,mode:'simulation',status:'active',startedAt:at,deadline:null,finishedAt:null,count:1,answeredCount:1};expect(accountExportSchema.safeParse({...base,questions:{...sections,sessions:[session]}}).success).toBe(true);expect(accountExportSchema.safeParse({...base,questions:{...sections,sessions:[{...session,result:{correct:1,incorrect:0,unanswered:0,annulled:0,denominator:1,score:1}}]}}).success).toBe(false);expect(accountExportSchema.safeParse({...base,questions:{...sections,sessions:[{...session,references:[]}]}}).success).toBe(false);});
 it('recent summaries exclude item payloads and references',()=>{expect(questionSessionSummaryPublicSchema.safeParse(mockQuestionSessionSummary).success).toBe(true);expect(questionSessionSummaryPublicSchema.safeParse({...mockQuestionSessionSummary,items:[]}).success).toBe(false);});
 it('medical review dates are calendar dates',()=>{const review={decision:'approved',contentHash:'a'.repeat(64),reason:'Synthetic only',referenceDate:'2026-02-30'};expect(questionEditorialReviewInputSchema.safeParse(review).success).toBe(false);expect(questionEditorialReviewInputSchema.safeParse({...review,referenceDate:'2024-02-29'}).success).toBe(true);});
});
