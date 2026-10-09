import {describe,expect,it} from 'vitest';
import {questionCandidatePayloadSchema,importCandidateReviewInputSchema,questionCandidateCreateInputSchema,questionCandidateNumberInputSchema} from './question-catalog';
const evidence={originalNumber:20,provenance:{page:7,bbox:{x:42,y:354,width:12,height:11},method:'text'}};
const payload={stem:'Synthetic preserved stem',alternatives:null,correctKey:null,annulled:false};
describe('CCR134 immutable original parser marker DTO',()=>{
 it('retains original pixel evidence separately from repaired number and crop region',()=>{
  const parsed=questionCandidatePayloadSchema.parse({...payload,originalNumber:21,parserMarkerEvidence:evidence});
  expect(parsed.originalNumber).toBe(21);expect(parsed.parserMarkerEvidence).toEqual(evidence);
  expect(questionCandidatePayloadSchema.parse(payload).parserMarkerEvidence).toBeUndefined();
 });
 it.each([0,1000,1.5])('rejects invalid original number %s',originalNumber=>expect(questionCandidatePayloadSchema.safeParse({...payload,parserMarkerEvidence:{...evidence,originalNumber}}).success).toBe(false));
 it.each([{page:0},{method:'guessed'},{bbox:{x:0,y:0,width:-1,height:2}},{extra:'forged'}])('rejects invalid marker provenance %j',extra=>expect(questionCandidatePayloadSchema.safeParse({...payload,parserMarkerEvidence:{...evidence,provenance:{...evidence.provenance,...extra}}}).success).toBe(false));
 it('mutation inputs never accept a forged parser evidence field',()=>{
  const id='33000000-0000-4000-8000-000000000001',reason='Synthetic audited repair',markerProvenance={documentId:id,page:1,bbox:[0,0,0.1,0.1]};
  const review={...payload,explanation:null,areaId:null,topicId:null,keyFinal:false,integrityConfirmed:false,state:'needs_review',duplicateOf:null,revision:0,reason};
  const create={candidateId:id,importRevision:0,originalNumber:'1',markerProvenance,ownStem:'Synthetic',alternatives:[],provenance:[markerProvenance],reason};
  const repair={importRevision:0,revision:0,originalNumber:'1',markerProvenance,reason};
  expect(importCandidateReviewInputSchema.safeParse(review).success).toBe(true);expect(questionCandidateCreateInputSchema.safeParse(create).success).toBe(true);expect(questionCandidateNumberInputSchema.safeParse(repair).success).toBe(true);
  expect(importCandidateReviewInputSchema.safeParse({...review,parserMarkerEvidence:evidence}).success).toBe(false);expect(questionCandidateCreateInputSchema.safeParse({...create,parserMarkerEvidence:evidence}).success).toBe(false);expect(questionCandidateNumberInputSchema.safeParse({...repair,parserMarkerEvidence:evidence}).success).toBe(false);
 });
});
