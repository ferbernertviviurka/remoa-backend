import {describe,expect,it,vi} from 'vitest';
import {importCandidateReviewInputSchema,ok} from '@remoa/contracts';
import type {Tx} from '@remoa/db';
vi.mock('./recovery',()=>({lockAssociatedQuestionGraphs:vi.fn(async()=>ok(undefined)),recoveryState:vi.fn(),frozenRecovery:vi.fn(),bumpImport:vi.fn(),effectiveStem:vi.fn(),orderDraftOccurrences:vi.fn()}));
const fixture=vi.hoisted(()=>({q:{id:'q'},t:{id:'t'},c:{questionId:'c'}}));
vi.mock('../../db',()=>({dbm:async()=>({questionBank:fixture.q,enamedTaxonomy:fixture.t,questionImportCandidates:fixture.c})}));
import {updateQuestionDraft} from './service';
const input=()=>importCandidateReviewInputSchema.parse({stem:'Contexto\n\nPróprio',alternatives:[{key:'A',text:'Um'},{key:'B',text:'Dois'}],correctKey:'A',explanation:'Comentário',areaId:'00000000-0000-4000-8000-000000000001',topicId:'00000000-0000-4000-8000-000000000002',annulled:false,duplicateOf:null,state:'accepted',revision:1,importRevision:0,integrityConfirmed:true,keyFinal:true,imagesConfirmed:true,reason:'Conferência sintética'});
describe('context draft structural mutation cannot bypass staging',()=>{
 it.each([{stem:'Próprio cortado'},{alternatives:[{key:'A' as const,text:'Novo'},{key:'B' as const,text:'Dois'}]},{correctKey:'B' as const},{annulled:true}])('returns validation with zero writes for %j',async patch=>{
  const row={...input(),id:'00000000-0000-4000-8000-000000000003',version:1,contentHash:'hash',publishedAt:null,catalogStatus:'in_review',availability:'active',assets:[]};
  const update=vi.fn();
  const tx={update,select:()=>({from:(table:unknown)=>({where:()=>({for:async()=>[row],then:(resolve:(rows:unknown[])=>unknown)=>resolve(table===fixture.c?[{payload:{contextBindings:[{contextId:'bound'}]}}]:[row])})})})} as unknown as Tx;
  const result=await updateQuestionDraft(tx,row.id,{...input(),...patch},'hash');expect(result).toMatchObject({ok:false,error:{code:'validation',message:'context_requires_staging_review'}});expect(update).not.toHaveBeenCalled();
 });
});
