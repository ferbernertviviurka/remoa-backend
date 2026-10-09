import {beforeEach,describe,expect,it,vi} from 'vitest';
import {questionReviewDetailSchema} from '@remoa/contracts';
const fixture=vi.hoisted(()=>({rows:[] as {payload:Record<string,unknown>}[],queries:vi.fn()}));
vi.mock('../../db',()=>({dbm:async()=>({questionImportCandidates:{questionId:'questionId',payload:'payload'},db:{select:()=>{fixture.queries();return {from:()=>({where:async()=>fixture.rows})}}}})}));
vi.mock('../../storage/storage',()=>({presignGet:vi.fn(async()=> 'https://example.org/private')}));
import {reviewDto} from '../../questions/editorial/service';
const id='00000000-0000-4000-8000-000000000001',contextId='00000000-0000-4000-8000-000000000002';
const row=()=>({id,canonicalId:id,version:1,type:'objective',difficulty:'medium',stem:'Contexto\n\nPróprio',alternatives:[{key:'A',text:'Um'},{key:'B',text:'Dois'}],correctKey:'A',explanation:'Comentário',enamedAreaId:null,enamedTopicId:null,origin:'official_exam',sourceId:null,catalogStatus:'in_review',rightsStatus:'pending',availability:'active',integrityConfirmed:false,keyFinal:false,enamedConfirmed:false,contentHash:'a'.repeat(64),reviewedHash:null,reviewerName:null,reviewerCrm:null,referenceDate:null,assets:[],visibility:'public',userId:null} as Parameters<typeof reviewDto>[0]);
beforeEach(()=>{fixture.rows=[];fixture.queries.mockClear()});
describe('editorial bounded shared-context metadata',()=>{
 it('emits only own stem and validated bindings for an institutional question',async()=>{
  fixture.rows=[{payload:{ownStem:'Próprio',contextBindings:[{contextId,contextRevision:2,resolutionHash:'b'.repeat(64)}],originalText:'RAW_PRIVATE_CONTEXT',evidenceObjectKey:'private/raw',unrelated:'secret'}}];
  const dto=await reviewDto(row());expect(questionReviewDetailSchema.safeParse(dto).success).toBe(true);expect(dto).toMatchObject({contextManaged:true,ownStem:'Próprio',contextBindings:[{contextId,contextRevision:2,resolutionHash:'b'.repeat(64)}]});expect(JSON.stringify(dto)).not.toContain('RAW_PRIVATE_CONTEXT');expect(JSON.stringify(dto)).not.toContain('private/raw');
 });
 it('does not query staging evidence for a private owner question',async()=>{
  const dto=await reviewDto({...row(),visibility:'private',userId:id});expect(fixture.queries).not.toHaveBeenCalled();expect(dto).toMatchObject({contextManaged:false,ownStem:null,contextBindings:[]});
 });
 it('ignores malformed bindings without leaking arbitrary payload keys',async()=>{
  fixture.rows=[{payload:{ownStem:'Próprio',contextBindings:[{contextId:'not_uuid',contextRevision:2,resolutionHash:'b'.repeat(64)}]}}];const dto=await reviewDto(row());expect(dto.contextManaged).toBe(true);expect(dto.ownStem).toBe('Próprio');
 });
});
