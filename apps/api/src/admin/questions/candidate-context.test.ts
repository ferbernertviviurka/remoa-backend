import {describe,expect,it,vi} from 'vitest';
import {importCandidateReviewInputSchema,ok,err} from '@remoa/contracts';
import type {Tx} from '@remoa/db';
const f=vi.hoisted(()=>({graph:{} as Record<string,unknown>,tables:{c:{id:'candidate',importId:'candidateImport'},q:{id:'question'},o:{paperId:'occurrencePaper',originalNumber:'occurrenceNumber',questionId:'occurrenceQuestion'},p:{id:'paper'},t:{id:'taxonomy'},s:{id:'source'}}}));
vi.mock('../../db',()=>({dbm:async()=>({questionImportCandidates:f.tables.c,questionBank:f.tables.q,examQuestionOccurrences:f.tables.o,examPapers:f.tables.p,enamedTaxonomy:f.tables.t,questionSourcesCatalog:f.tables.s})}));
vi.mock('./recovery',()=>({recoveryState:vi.fn(async()=>ok(f.graph)),frozenRecovery:vi.fn(()=>false),bumpImport:vi.fn(async()=>1),effectiveStem:vi.fn((own:string)=>ok(own)),orderDraftOccurrences:vi.fn(async()=>ok(undefined)),lockAssociatedQuestionGraphs:vi.fn(async()=>ok(undefined))}));
import {updateCandidate} from './service';
import {recoveryState} from './recovery';
describe('candidate shared-pipeline persistence',()=>{
 it('locks the requested duplicate target in the sorted graph phase before any FK mutation',async()=>{
  const target='00000000-0000-4000-8000-000000000099';
  const input=importCandidateReviewInputSchema.parse({stem:'Authorial',alternatives:[{key:'A',text:'One'},{key:'B',text:'Two'}],correctKey:'A',explanation:null,topicId:null,areaId:null,annulled:false,integrityConfirmed:false,state:'duplicate',duplicateOf:target,revision:0,importRevision:2,keyFinal:true,reason:'Authorial duplicate lock verification'});
  vi.mocked(recoveryState).mockResolvedValueOnce(err('conflict','question_graph_changed_retry'));
  const tx={} as Tx;
  expect(await updateCandidate(tx,'import','candidate',input)).toMatchObject({ok:false,error:{message:'question_graph_changed_retry'}});
  expect(recoveryState).toHaveBeenLastCalledWith(tx,'import',2,[target]);
 });
 it('rejecting a published duplicate unlinks draft occurrence and preserves immutable target plus readonly provenance',async()=>{
  const input=importCandidateReviewInputSchema.parse({stem:'Authorial question',alternatives:[{key:'A',text:'One'},{key:'B',text:'Two'}],correctKey:null,explanation:null,areaId:null,topicId:null,annulled:false,state:'rejected',duplicateOf:null,revision:0,importRevision:0,keyFinal:false,integrityConfirmed:false,imagesConfirmed:false,reason:'Synthetic explicit rejection'});
  const candidate={id:'candidate',questionId:'public-target',state:'duplicate',duplicateOf:'public-target',revision:0,ordinal:1,originalNumber:'1',issues:[],payload:{ownStem:'Authorial question',imageRefs:[],ownImageRefs:[],contextBindings:[],manualRecovery:{requestHash:'frozen',markerProvenance:{page:1}}}};
  f.graph={job:{id:'import',paperId:'paper',revision:0},paper:{status:'draft'},contexts:[],candidates:[candidate],questions:[{id:'public-target',catalogStatus:'published',publishedAt:new Date(),reviewedHash:'frozen_signature'}]};
  const writes:{table:unknown;payload:Record<string,unknown>}[]=[];const remove=vi.fn(()=>({where:async()=>{}}));
  const tx={delete:remove,update:(table:unknown)=>({set:(payload:Record<string,unknown>)=>{writes.push({table,payload});const chain={where:()=>chain,returning:async()=>[{...candidate,...payload}],then:(resolve:(rows:unknown[])=>unknown)=>resolve([])};return chain;}})} as unknown as Tx;
  const result=await updateCandidate(tx,'import','candidate',input);expect(result).toMatchObject({ok:true,data:{candidate:{questionId:null,duplicateOf:null,state:'rejected'},importRevision:1}});expect(remove).toHaveBeenCalledOnce();expect(writes.some(w=>w.table===f.tables.q)).toBe(false);
  const payload=writes.find(w=>w.table===f.tables.c)!.payload.payload as Record<string,unknown>;expect(payload).not.toHaveProperty('importRevision');expect(payload.manualRecovery).toEqual(candidate.payload.manualRecovery);expect(payload.ownImageRefs).toEqual([]);
 });
});
