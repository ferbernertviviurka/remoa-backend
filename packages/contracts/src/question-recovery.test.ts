import {describe,it,expect} from 'vitest';
import {manualMarkerSchema,questionOriginalNumberSchema,questionCandidateCreateInputSchema,questionCandidateNumberInputSchema,questionImportContextResolveInputSchema,questionImportContextSchema,questionCandidatePayloadSchema,importCandidateReviewInputSchema,questionImportDetailSchema} from './question-catalog';
import {mockQuestionImportContextUnresolved,mockQuestionImportContextBound,mockQuestionImportContextNonQuestion} from './mocks/question-catalog';
const id='33000000-0000-4000-8000-000000000001';
const provenance={documentId:id,page:1,bbox:[0,0,1,0.4]};
const reason='Synthetic audited context recovery';
describe('CCR130 strict recovery boundaries',()=>{
 it.each([['01','1'],['1','1'],['999','999']])('canonical number %s is %s',(input,value)=>expect(questionOriginalNumberSchema.parse(input)).toBe(value));
 it.each(['0','000','1000','A1','1.',' 01','-1'])('rejects ambiguous or out of range number %s',input=>expect(questionOriginalNumberSchema.safeParse(input).success).toBe(false));
 it.each([null,[0,0,0,0.4],[0,0,0.4,0],[0.9,0,0.2,0.4]])('manual marker rejects non-positive or off-page bbox %j',bbox=>expect(manualMarkerSchema.safeParse({...provenance,bbox}).success).toBe(false));
 it.each([0,501,1.5])('manual marker rejects page %s',page=>expect(manualMarkerSchema.safeParse({...provenance,page}).success).toBe(false));
 it.each([999,1000,1001])('context detail boundary %s rejects overflow without truncating',count=>{const result=questionImportDetailSchema.shape.contexts.safeParse(Array.from({length:count},()=>mockQuestionImportContextUnresolved));expect(result.success).toBe(count<=1000);if(result.success)expect(result.data).toHaveLength(count);});
 it('manual create cannot confer key, state or approval and retains malformed alternatives for review',()=>{
 const input={candidateId:id,importRevision:2,originalNumber:'02',markerProvenance:provenance,ownStem:'Synthetic missing question',alternatives:[{key:'A',text:'First'},{key:'A',text:'Second'}],provenance:[provenance],reason};
 expect(questionCandidateCreateInputSchema.parse(input).originalNumber).toBe('2');
 for(const extra of [{correctKey:'A'},{state:'accepted'},{reviewed:true},{objectKey:'private/arbitrary'}])expect(questionCandidateCreateInputSchema.safeParse({...input,...extra}).success).toBe(false);
 expect(questionCandidateCreateInputSchema.safeParse({...input,importRevision:-1}).success).toBe(false);
 });
 it('number repair requires both revisions and marker provenance',()=>{
 const input={importRevision:2,revision:3,originalNumber:'01',markerProvenance:provenance,reason};
 expect(questionCandidateNumberInputSchema.parse(input).originalNumber).toBe('1');
 expect(questionCandidateNumberInputSchema.safeParse({...input,revision:undefined}).success).toBe(false);
 expect(questionCandidateNumberInputSchema.safeParse({...input,markerProvenance:undefined}).success).toBe(false);
 });
 it('bind may correct declared numbers only by explicit targets and reason, never upload arbitrary keys',()=>{
 const input={importRevision:2,revision:0,evidenceHash:'a'.repeat(64),decision:'bind',targetNumbers:[3,4],text:'Synthetic shared context',imageRefIds:[],reason};
 expect(questionImportContextResolveInputSchema.safeParse(input).success).toBe(true);
 for(const extra of [{targetNumbers:[]},{targetNumbers:[3,3]},{targetNumbers:[1000]},{imageRefs:[{objectKey:'foreign'}]},{evidenceHash:'bad'},{text:'x'.repeat(20001)},{text:'',imageRefIds:[]}])expect(questionImportContextResolveInputSchema.safeParse({...input,...extra}).success).toBe(false);
 });
 it('non-question resolution cannot hide a binding or edited body',()=>{
 const input={importRevision:2,revision:0,evidenceHash:'a'.repeat(64),decision:'non_question',targetNumbers:[],text:'',imageRefIds:[],reason};
 expect(questionImportContextResolveInputSchema.safeParse(input).success).toBe(true);
 expect(questionImportContextResolveInputSchema.safeParse({...input,targetNumbers:[1]}).success).toBe(false);
 expect(questionImportContextResolveInputSchema.safeParse({...input,text:'Hidden binding'}).success).toBe(false);
 });
 it('staging retains own stem and binding hashes without replacing effective stem',()=>{
 const input={ownStem:'Own synthetic question',stem:'Shared context\nOwn synthetic question',contextBindings:[{contextId:id,contextRevision:1,resolutionHash:'b'.repeat(64)}],alternatives:null,correctKey:null,annulled:false};
 expect(questionCandidatePayloadSchema.parse(input).ownStem).toBe('Own synthetic question');
 expect(questionCandidatePayloadSchema.safeParse({...input,effectiveStem:'unapproved'}).success).toBe(false);
 });
 it('mock context states retain evidence and require a complete bound resolution',()=>{
 for(const mock of [mockQuestionImportContextUnresolved,mockQuestionImportContextBound,mockQuestionImportContextNonQuestion])expect(questionImportContextSchema.safeParse(mock).success).toBe(true);
 expect(questionImportContextSchema.safeParse({...mockQuestionImportContextBound,resolution:null}).success).toBe(false);
 expect(questionImportContextSchema.safeParse({...mockQuestionImportContextUnresolved,resolutionHash:'b'.repeat(64)}).success).toBe(false);
 expect(questionImportContextSchema.safeParse({...mockQuestionImportContextUnresolved,evidenceObjectKey:'public/context'}).success).toBe(false);
 expect(questionImportContextSchema.safeParse({...mockQuestionImportContextBound,resolution:{...mockQuestionImportContextBound.resolution,imageRefIds:[id]}}).success).toBe(false);
 expect(questionImportContextSchema.safeParse({...mockQuestionImportContextNonQuestion,resolution:null}).success).toBe(false);
 expect(questionImportContextSchema.safeParse({...mockQuestionImportContextNonQuestion,resolution:{...mockQuestionImportContextNonQuestion.resolution,reason:''}}).success).toBe(false);
 });
 it('import detail exposes context blockers and legacy mutation schemas default revision zero',()=>{
 expect(questionImportDetailSchema.shape.contexts.parse(undefined)).toEqual([]);
 expect(questionImportDetailSchema.shape.acceptanceBlocked.parse(true)).toBe(true);
 expect(importCandidateReviewInputSchema.parse({stem:'Synthetic',alternatives:null,correctKey:null,explanation:null,topicId:null,areaId:null,annulled:false,keyFinal:false,integrityConfirmed:false,state:'needs_review',duplicateOf:null,revision:0,reason}).importRevision).toBe(0);
 });
});
