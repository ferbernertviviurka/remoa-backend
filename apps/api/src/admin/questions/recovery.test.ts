import {describe,it,expect,vi,beforeEach} from 'vitest';
import {SQL,getTableName,type Table} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {Tx} from '@remoa/db';
import * as schema from '../../../../../packages/db/src/schema';
const dependency=vi.hoisted(()=>({module:null as unknown}));
vi.mock('../../db',()=>({dbm:async()=>dependency.module}));
import {recoveryState,createMissingCandidate,repairCandidateNumber,resolveImportContext,creationRequestHash,contextResolutionHash,composeCandidate,effectiveStem,validMarker,planDraftRanks,frozenRecovery,lockAssociatedQuestionGraphs,lockPublicationQuestionGraph} from './recovery';
const id='33000000-0000-4000-8000-000000000001',doc='33000000-0000-4000-8000-000000000002',candidateId='33000000-0000-4000-8000-000000000003',contextId='33000000-0000-4000-8000-000000000004',questionId='33000000-0000-4000-8000-000000000005';
const region={documentId:doc,page:1,bbox:[0,0,0.3,0.3] as [number,number,number,number]},reason='Synthetic audited manual recovery';
const creation={candidateId,importRevision:0,originalNumber:'2',markerProvenance:region,ownStem:'Synthetic own stem',alternatives:[{key:'A',text:'First'},{key:'B',text:'Second'}],provenance:[region],reason};
type Row=Record<string,unknown>;
const dialect=new PgDialect(),camel=(field:string)=>field.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
function fake(){
 const rows=new Map<string,Row[]>(),events:string[]=[],writes:string[]=[],lockedQuestions:string[][]=[],hooks={onLock:undefined as undefined|((table:string)=>void)};
 const data=(table:Table)=>{const name=getTableName(table);if(!rows.has(name))rows.set(name,[]);return rows.get(name)!;};
 class Query implements PromiseLike<Row[]>{
  table!:Table;condition?:SQL;mode:'select'|'update'|'insert'|'delete'='select';value:Row|Row[]={};locked=false;
  from(table:Table){this.table=table;return this;}where(condition:SQL){this.condition=condition;return this;}orderBy(..._:unknown[]){void _;return this;}for(_:string){void _;this.locked=true;return this;}
  set(value:Row){this.value=value;return this;}values(value:Row|Row[]){this.value=value;return this;}onConflictDoNothing(){return this;}returning(){return this;}
  matches(row:Row){if(!this.condition)return true;const query=dialect.sqlToQuery(this.condition),matches=[...query.sql.matchAll(/"[^"]+"\."([^"]+)"\s*=\s*\$(\d+)/g)];if(query.sql.includes('case when'))return Number(row.originalNumber)===Number(query.params.at(-1));if(query.sql.includes(' in (')){const column=query.sql.match(/\."([^"]+)" in/);return query.params.includes(row[camel(column?.[1]??'id')]);}return matches.every(m=>row[camel(m[1]!)]===query.params[Number(m[2])-1]);}
  async run(){const name=getTableName(this.table);if(this.locked){events.push(name);hooks.onLock?.(name);}let selected=data(this.table).filter(row=>this.matches(row));if(this.locked&&name==='question_bank')lockedQuestions.push(this.condition?dialect.sqlToQuery(this.condition).params as string[]:[]);if(this.mode==='insert'){selected=[];for(const value of Array.isArray(this.value)?this.value:[this.value]){if(data(this.table).some(row=>row.id===value.id))continue;const created={...value};data(this.table).push(created);selected.push(created);}writes.push(name);}if(this.mode==='update'){for(const row of selected)for(const[key,value]of Object.entries(this.value)){row[key]=value instanceof SQL?Number(row[key])+Number(dialect.sqlToQuery(value).params[0]):value;}writes.push(name);}if(this.mode==='delete'){rows.set(name,data(this.table).filter(row=>!this.matches(row)));writes.push(name);}return selected.map(row=>({...row}));}
  then<T=Row[],U=never>(success?:((v:Row[])=>T|PromiseLike<T>)|null,failure?:((e:unknown)=>U|PromiseLike<U>)|null){return this.run().then(success,failure);}
 }
 const tx={select:()=>new Query(),insert:(table:Table)=>{const q=new Query();q.table=table;q.mode='insert';return q;},update:(table:Table)=>{const q=new Query();q.table=table;q.mode='update';return q;},delete:(table:Table)=>{const q=new Query();q.table=table;q.mode='delete';return q;}}as unknown as Tx;
 const put=(table:Table,values:Row[])=>rows.set(getTableName(table),values);
 put(schema.questionImports,[{id,paperId:id,documentId:doc,sourceId:id,status:'review',revision:0,excludedPages:[]}]);put(schema.examPapers,[{id,status:'draft'}]);put(schema.questionDocuments,[{id:doc,pages:5,kind:'exam',sourceId:id}]);put(schema.questionSourcesCatalog,[{id,rightsStatus:'pending',rightsExpiresAt:null}]);dependency.module=schema;return {tx,put,data,events,writes,lockedQuestions,hooks};
}
const candidate=(extra:Row={})=>({id:candidateId,importId:id,ordinal:5,originalNumber:'2',revision:0,state:'needs_review',questionId:null,duplicateOf:null,issues:[],provenance:[region],payload:{stem:'Own',ownStem:'Own',alternatives:creation.alternatives,correctKey:'A',annulled:false,imageRefs:[],assets:[]},...extra});
const context=(extra:Row={})=>({id:contextId,importId:id,documentId:doc,revision:0,status:'unresolved',resolution:null,resolutionHash:null,evidenceHash:'a'.repeat(64),declaredNumbers:[2],provenance:[region],imageRefs:[],originalText:'Synthetic context',evidenceObjectKey:`questions/imports/${id}/contexts/synthetic.json`,createdAt:new Date(),updatedAt:new Date(),...extra});
describe('CCR130 transaction graph',()=>{
 let f:ReturnType<typeof fake>;beforeEach(()=>{f=fake();});
 it('locks old and newly selected duplicate targets together in sorted question phase before FK writes',async()=>{
  f.put(schema.questionImportCandidates,[candidate({questionId})]);f.put(schema.questionBank,[{id:questionId},{id:doc}]);
  const result=await recoveryState(f.tx,id,0,[doc,questionId,doc]);expect(result.ok).toBe(true);
  expect(f.events).toEqual(['question_imports','exam_papers','question_import_contexts','question_import_candidates','question_bank']);
  expect(f.lockedQuestions).toEqual([[doc,questionId]]);expect(f.writes).toEqual([]);
 });
 it('publication holds source authorization before any import/paper/question lock',async()=>{
  f.put(schema.questionImportCandidates,[candidate({questionId})]);f.put(schema.questionBank,[{id:questionId,sourceId:id,visibility:'public',userId:null}]);
  expect((await lockPublicationQuestionGraph(f.tx,questionId)).ok).toBe(true);
  expect(f.events).toEqual(['question_sources','question_imports','exam_papers','question_import_contexts','question_import_candidates','question_bank']);expect(f.writes).toEqual([]);
 });
 it('publication rejects a changed source association before its caller may publish',async()=>{
  f.put(schema.questionBank,[{id:questionId,sourceId:id,visibility:'public',userId:null}]);
  f.hooks.onLock=table=>{if(table==='question_sources')f.data(schema.questionBank)[0]!.sourceId=doc;};
  expect(await lockPublicationQuestionGraph(f.tx,questionId)).toMatchObject({ok:false,error:{message:'question_source_changed_retry'}});expect(f.writes).toEqual([]);
 });
 it('publication cannot lock a private question or missing source as an institutional graph',async()=>{
  f.put(schema.questionBank,[{id:questionId,sourceId:id,visibility:'private',userId:id}]);expect((await lockPublicationQuestionGraph(f.tx,questionId)).ok).toBe(false);expect(f.events).toEqual([]);
  f.put(schema.questionBank,[{id:questionId,sourceId:id,visibility:'public',userId:null}]);f.put(schema.questionSourcesCatalog,[]);expect((await lockPublicationQuestionGraph(f.tx,questionId)).ok).toBe(false);expect(f.events).toEqual(['question_sources']);expect(f.writes).toEqual([]);
 });
 it('locks import/paper/contexts/candidates/questions and batch publication uses the same phases',async()=>{f.put(schema.questionImportCandidates,[candidate({questionId})]);f.put(schema.questionBank,[{id:questionId,visibility:'public',userId:null}]);await recoveryState(f.tx,id,0);expect(f.events).toEqual(['question_imports','exam_papers','question_import_contexts','question_import_candidates','question_bank']);f.events.length=0;expect((await lockAssociatedQuestionGraphs(f.tx,questionId)).ok).toBe(true);expect(f.events).toEqual(['question_imports','exam_papers','question_import_contexts','question_import_candidates','question_bank']);expect(f.writes).toEqual([]);});
 it('locks predecessor occurrence papers even when no candidate retains the old association',async()=>{
  const old=doc,secondPaper=contextId,secondImport=questionId;
  f.put(schema.questionBank,[{id:questionId,visibility:'public',userId:null,supersedesId:old},{id:old,visibility:'public',userId:null}]);
  f.put(schema.examQuestionOccurrences,[{id:candidateId,paperId:secondPaper,questionId:old,originalNumber:'1',ordinal:1}]);
  f.put(schema.questionImports,[...f.data(schema.questionImports),{id:secondImport,paperId:secondPaper,status:'completed'}]);f.put(schema.examPapers,[...f.data(schema.examPapers),{id:secondPaper,status:'draft'}]);
  expect((await lockAssociatedQuestionGraphs(f.tx,questionId)).ok).toBe(true);expect(f.events).toEqual(['question_imports','exam_papers','question_import_contexts','question_import_candidates','question_bank']);expect(f.writes).toEqual([]);
 });
 it('private questions have no institutional graph lock side effect',async()=>{
  f.put(schema.questionBank,[{id:questionId,visibility:'private',userId:id}]);expect((await lockAssociatedQuestionGraphs(f.tx,questionId)).ok).toBe(true);expect(f.events).toEqual([]);expect(f.writes).toEqual([]);
 });
 it('creates needs_review and replays unchanged request after edits/publication without writes',async()=>{expect((await createMissingCandidate(f.tx,id,creation)).ok).toBe(true);const row=f.data(schema.questionImportCandidates)[0]!;expect(row.state).toBe('needs_review');row.payload={...row.payload as Row,stem:'Later edited'};f.data(schema.examPapers)[0]!.status='published';const writes=f.writes.length;expect((await createMissingCandidate(f.tx,id,creation)).ok).toBe(true);expect(f.writes).toHaveLength(writes);expect((await createMissingCandidate(f.tx,id,{...creation,ownStem:'Changed'})).ok).toBe(false);});
 it('rejects normalized collision and excluded markers before writes',async()=>{f.put(schema.questionImportCandidates,[candidate({id:questionId,originalNumber:'02'})]);expect((await createMissingCandidate(f.tx,id,creation)).ok).toBe(false);f.put(schema.questionImportCandidates,[]);f.data(schema.questionImports)[0]!.excludedPages=[1];expect((await createMissingCandidate(f.tx,id,creation)).ok).toBe(false);expect(f.writes).toEqual([]);});
 it('repairs linked draft number and invalidates key, signature and occurrence',async()=>{f.put(schema.questionImportCandidates,[candidate({questionId,state:'accepted'})]);f.put(schema.questionBank,[{id:questionId,alternatives:creation.alternatives,correctKey:'A',availability:'active',explanation:null,enamedAreaId:null,enamedTopicId:null,catalogStatus:'in_review'}]);f.put(schema.examQuestionOccurrences,[{id:contextId,paperId:id,questionId,originalNumber:'2',ordinal:1}]);expect((await repairCandidateNumber(f.tx,id,candidateId,{importRevision:0,revision:0,originalNumber:'01',markerProvenance:region,reason})).ok).toBe(true);const row=f.data(schema.questionImportCandidates)[0]!;expect(row).toMatchObject({originalNumber:'1',state:'needs_review',revision:1});expect((row.payload as Row).correctKey).toBeNull();expect((row.payload as Row).numberRecovery).toMatchObject({originalNumber:'1',markerProvenance:region,revision:1,reason});expect(f.data(schema.examQuestionOccurrences)).toEqual([]);expect(f.data(schema.questionBank)[0]!).toMatchObject({keyFinal:false,reviewedHash:null,status:'draft'});});
 it('resolving context unlinks published duplicate without modifying medical signature',async()=>{f.put(schema.questionImportContexts,[context()]);f.put(schema.questionImportCandidates,[candidate({questionId,state:'duplicate',duplicateOf:questionId})]);f.put(schema.questionBank,[{id:questionId,publishedAt:new Date(),catalogStatus:'published',reviewedHash:'frozen'}]);const result=await resolveImportContext(f.tx,id,contextId,{importRevision:0,revision:0,evidenceHash:'a'.repeat(64),decision:'bind',targetNumbers:[2],text:'Do not replace 2 kg.',imageRefIds:[],reason});expect(result.ok).toBe(true);expect(f.writes).not.toContain('question_bank');expect(f.data(schema.questionBank)[0]!.reviewedHash).toBe('frozen');expect(f.data(schema.questionImportCandidates)[0]!).toMatchObject({questionId:null,duplicateOf:null,state:'needs_review'});expect((f.data(schema.questionImportCandidates)[0]!.payload as Row).stem).toBe('Do not replace 2 kg.\n\nOwn');});
 it('stale context and unknown image IDs fail before writes',async()=>{f.put(schema.questionImportContexts,[context()]);f.put(schema.questionImportCandidates,[candidate()]);const base={importRevision:0,revision:0,evidenceHash:'a'.repeat(64),decision:'bind' as const,targetNumbers:[2],text:'Shared',imageRefIds:[],reason};expect((await resolveImportContext(f.tx,id,contextId,{...base,revision:1})).ok).toBe(false);expect((await resolveImportContext(f.tx,id,contextId,{...base,imageRefIds:[id]})).ok).toBe(false);expect(f.writes).toEqual([]);});
 it('retargets context transitively, removes former prefix and clears every affected acceptance',async()=>{
  const bound=context({status:'bound',revision:1,resolution:{decision:'bind',targetNumbers:[2],text:'Old shared',imageRefIds:[],reason},resolutionHash:'b'.repeat(64)});
  const old=candidate({payload:{ownStem:'Own',stem:'Old shared\n\nOwn',ownProvenance:[region],ownImageRefs:[],contextBindings:[{contextId,contextRevision:1,resolutionHash:'b'.repeat(64)}],imageRefs:[],assets:[],alternatives:creation.alternatives,correctKey:'A',annulled:false,keyFinal:true,integrityConfirmed:true}});
  f.put(schema.questionImportContexts,[bound]);f.put(schema.questionImportCandidates,[old,candidate({id:questionId,originalNumber:'3'})]);
  const result=await resolveImportContext(f.tx,id,contextId,{importRevision:0,revision:1,evidenceHash:'a'.repeat(64),decision:'bind',targetNumbers:[3],text:'New shared',imageRefIds:[],reason});expect(result.ok).toBe(true);
  const rows=f.data(schema.questionImportCandidates);expect(rows.map(r=>(r.payload as Row).stem)).toEqual(['Own','New shared\n\nOwn']);expect(rows.every(r=>r.revision===1 && r.state==='needs_review')).toBe(true);expect(rows.every(r=>(r.payload as Row).keyFinal===false)).toBe(true);
 });
 it('non-question decision preserves reason and unresolved unknown context still blocks the import',async()=>{
  f.put(schema.questionImportContexts,[context(),context({id:questionId,declaredNumbers:[]})]);
  const result=await resolveImportContext(f.tx,id,contextId,{importRevision:0,revision:0,evidenceHash:'a'.repeat(64),decision:'non_question',targetNumbers:[],text:'',imageRefIds:[],reason});expect(result.ok).toBe(true);if(result.ok){expect(result.data.acceptanceBlocked).toBe(true);expect(result.data.context?.resolution).toMatchObject({decision:'non_question',reason});}
 });
 it('rejects overlong composed content before the first write, preserving the old graph',async()=>{
  f.put(schema.questionImportContexts,[context()]);f.put(schema.questionImportCandidates,[candidate()]);
  const result=await resolveImportContext(f.tx,id,contextId,{importRevision:0,revision:0,evidenceHash:'a'.repeat(64),decision:'bind',targetNumbers:[2],text:'x'.repeat(20000),imageRefIds:[],reason});expect(result).toMatchObject({ok:false,error:{message:'effective_stem_too_large'}});expect(f.writes).toEqual([]);expect(f.data(schema.questionImportContexts)[0]!.status).toBe('unresolved');
 });
 it('image-only binding preserves authorized pixels, strips descriptor IDs from candidate refs and rejects foreign storage',async()=>{
  const image={id:doc,page:1,bbox:{x:0,y:0,width:100,height:100},method:'text',objectKey:`questions/imports/${id}/crops/context.png`,provenance:region};f.put(schema.questionImportContexts,[context({imageRefs:[image]})]);f.put(schema.questionImportCandidates,[candidate()]);
  const input={importRevision:0,revision:0,evidenceHash:'a'.repeat(64),decision:'bind' as const,targetNumbers:[2],text:'',imageRefIds:[doc],reason};const result=await resolveImportContext(f.tx,id,contextId,input);expect(result.ok).toBe(true);const ref=((f.data(schema.questionImportCandidates)[0]!.payload as Row).imageRefs as Row[])[0]!;expect(ref.objectKey).toBe(image.objectKey);expect(ref.id).toBeUndefined();expect(ref.provenance).toEqual(region);
  f=fake();f.put(schema.questionImportContexts,[context({imageRefs:[{...image,objectKey:'questions/imports/foreign/crops/context.png'}]})]);f.put(schema.questionImportCandidates,[candidate()]);expect((await resolveImportContext(f.tx,id,contextId,input)).ok).toBe(false);expect(f.writes).toEqual([]);
 });
 it('temporary rank offsets are positive and inserting Q2 does not retain the final ordinal3',async()=>{
  f.put(schema.examQuestionOccurrences,[{id:'q1',paperId:id,originalNumber:'1',ordinal:1},{id:'q3',paperId:id,originalNumber:'3',ordinal:2},{id:'q2',paperId:id,originalNumber:'2',ordinal:3}]);const graph=await recoveryState(f.tx,id,0);expect(graph.ok).toBe(true);if(graph.ok){const {orderDraftOccurrences}=await import('./recovery');expect((await orderDraftOccurrences(f.tx,graph.data)).ok).toBe(true);expect(f.data(schema.examQuestionOccurrences).map(r=>[r.originalNumber,r.ordinal])).toEqual([['1',1],['3',3],['2',2]]);}
 });
 it.each(['revoked','expired','wrong_doc_kind','wrong_doc_source','missing_document','missing_source','no_pages','outside_page','foreign_document','missing_import','missing_paper','cancelled_import','published_paper','stale_import','ordinal_overflow'])('manual recovery fails closed for %s before writes',async scenario=>{
  let input={...creation};
  if(scenario==='revoked')f.data(schema.questionSourcesCatalog)[0]!.rightsStatus='revoked';
  if(scenario==='expired')f.data(schema.questionSourcesCatalog)[0]!.rightsExpiresAt=new Date(0);
  if(scenario==='wrong_doc_kind')f.data(schema.questionDocuments)[0]!.kind='answer_key';
  if(scenario==='wrong_doc_source')f.data(schema.questionDocuments)[0]!.sourceId=doc;
  if(scenario==='missing_document')f.put(schema.questionDocuments,[]);
  if(scenario==='missing_source')f.put(schema.questionSourcesCatalog,[]);
  if(scenario==='no_pages')f.data(schema.questionDocuments)[0]!.pages=null;
  if(scenario==='outside_page')input={...input,markerProvenance:{...region,page:6}};
  if(scenario==='foreign_document')input={...input,markerProvenance:{...region,documentId:id}};
  if(scenario==='missing_import')f.put(schema.questionImports,[]);
  if(scenario==='missing_paper')f.put(schema.examPapers,[]);
  if(scenario==='cancelled_import')f.data(schema.questionImports)[0]!.status='cancelled';
  if(scenario==='published_paper')f.data(schema.examPapers)[0]!.status='published';
  if(scenario==='stale_import')input={...input,importRevision:9};
  if(scenario==='ordinal_overflow')f.put(schema.questionImportCandidates,[candidate({id:questionId,originalNumber:'9',ordinal:2147483647})]);
  expect((await createMissingCandidate(f.tx,id,input)).ok).toBe(false);expect(f.writes).toEqual([]);
 });
 it.each(['missing_candidate','stale_candidate','published_question','legacy_number','normalized_collision'])('number repair preserves the graph for %s',async scenario=>{
  f.put(schema.questionImportCandidates,[candidate()]);
  if(scenario==='missing_candidate')f.put(schema.questionImportCandidates,[]);
  if(scenario==='stale_candidate')f.data(schema.questionImportCandidates)[0]!.revision=1;
  if(scenario==='published_question'){f.data(schema.questionImportCandidates)[0]!.questionId=questionId;f.data(schema.questionImportCandidates)[0]!.state='accepted';f.put(schema.questionBank,[{id:questionId,publishedAt:new Date()}]);}
  if(scenario==='legacy_number')f.data(schema.questionImportCandidates)[0]!.originalNumber='A1';
  if(scenario==='normalized_collision')f.data(schema.questionImportCandidates).push(candidate({id:questionId,originalNumber:'01'}));
  expect((await repairCandidateNumber(f.tx,id,candidateId,{importRevision:0,revision:0,originalNumber:'1',markerProvenance:region,reason})).ok).toBe(false);expect(f.writes).toEqual([]);
 });
 it('cannot resolve a target with duplicate original numbers or a mismatched evidence hash',async()=>{
  f.put(schema.questionImportContexts,[context()]);f.put(schema.questionImportCandidates,[candidate(),candidate({id:questionId,originalNumber:'02'})]);
  const input={importRevision:0,revision:0,evidenceHash:'a'.repeat(64),decision:'bind' as const,targetNumbers:[2],text:'Shared',imageRefIds:[],reason};expect((await resolveImportContext(f.tx,id,contextId,input)).ok).toBe(false);f.put(schema.questionImportCandidates,[candidate()]);expect((await resolveImportContext(f.tx,id,contextId,{...input,evidenceHash:'b'.repeat(64)})).ok).toBe(false);expect(f.writes).toEqual([]);
 });
 it('caps manual creation at the explicit 1000 staging bound instead of silently hiding new rows',async()=>{f.put(schema.questionImportCandidates,Array.from({length:1000},(_,n)=>candidate({id:String(n),originalNumber:String(n+10)})));const result=await createMissingCandidate(f.tx,id,creation);expect(result).toMatchObject({ok:false,error:{message:'manual_candidate_limit_1000'}});expect(f.writes).toEqual([]);});
});
describe('CCR130 pure planning',()=>{
 it('prefix source order preserves own units/negation and refuses overflow',()=>{const contexts=[{id:'b',status:'bound' as const,resolution:{text:'Later'},provenance:[{...region,page:2}]},{id:'a',status:'bound' as const,resolution:{text:'Earlier'},provenance:[region]}];expect(effectiveStem('DO NOT replace 2 kg.',contexts)).toEqual({ok:true,data:'Earlier\n\nLater\n\nDO NOT replace 2 kg.'});expect(effectiveStem('x'.repeat(20001),[]).ok).toBe(false);});
 it('ranks numeric original numbers and refuses normalized collisions/arbitrary legacy',()=>{expect(planDraftRanks([{id:'q3',originalNumber:'3'},{id:'q2',originalNumber:'02'},{id:'q1',originalNumber:'1'}])).toEqual({ok:true,data:[{id:'q1',ordinal:1},{id:'q2',ordinal:2},{id:'q3',ordinal:3}]});expect(planDraftRanks([{id:'a',originalNumber:'01'},{id:'b',originalNumber:'1'}]).ok).toBe(false);expect(planDraftRanks([{id:'a',originalNumber:'A1'}]).ok).toBe(false);});
 it('requires finite positive in-document regions and no excluded page',()=>{expect(validMarker(region,doc,5,[])).toBe(true);for(const ref of [{...region,bbox:null},{...region,bbox:[0,0,0,1] as typeof region.bbox},{...region,page:6},{...region,documentId:id}])expect(validMarker(ref,doc,5,[])).toBe(false);expect(validMarker(region,doc,5,[1])).toBe(false);});
 it('hashes creation independent of revisions but sensitive to reason; resolution ignores presign TTL',()=>{const hash=creationRequestHash(id,creation);expect(creationRequestHash(id,{...creation,importRevision:99})).toBe(hash);expect(creationRequestHash(id,{...creation,reason:reason+' changed'})).not.toBe(hash);expect(contextResolutionHash({id,evidenceHash:'a'},{text:'Exact'},[{id,url:'https://temporary/1'}])).toBe(contextResolutionHash({id,evidenceHash:'a'},{text:'Exact'},[{id,url:'https://temporary/2'}]));});
 it('rebind removes shared evidence while retaining overlapping own provenance/assets',()=>{const row=candidate({payload:{ownStem:'Own',stem:'Old\n\nOwn',ownProvenance:[region],ownImageRefs:[{objectKey:'own',page:1,bbox:{x:0,y:0,width:10,height:10},method:'text',provenance:region}],contextBindings:[{contextId,contextRevision:1,resolutionHash:'a'}],imageRefs:[{objectKey:'own',page:1,bbox:{x:0,y:0,width:10,height:10},method:'text',provenance:region},{objectKey:'shared',page:1,bbox:{x:0,y:0,width:10,height:10},method:'text',provenance:region}],assets:[{id,objectKey:'own',alt:'Own',provenance:region},{id:doc,objectKey:'shared',alt:'Shared',provenance:region}],alternatives:creation.alternatives,correctKey:'A',annulled:false}});const result=composeCandidate(row as unknown as Parameters<typeof composeCandidate>[0],[],2);expect(result.ok).toBe(true);if(result.ok){expect(result.data.payload.stem).toBe('Own');expect(result.data.provenance).toEqual([region]);expect(result.data.payload.imageRefs).toMatchObject([{objectKey:'own'}]);expect(result.data.payload.assets).toMatchObject([{objectKey:'own',alt:'Own'}]);}});
 it('missing base evidence and too many context bindings are quarantined instead of guessing/truncating',()=>{
  const lost=candidate({payload:{stem:'Shared and own',contextBindings:[{contextId,contextRevision:0,resolutionHash:'a'.repeat(64)}],alternatives:null,correctKey:null,annulled:false}});
  expect(composeCandidate(lost as unknown as Parameters<typeof composeCandidate>[0],[],2)).toMatchObject({ok:false,error:{message:'context_own_stem_missing'}});
  const noBase=candidate({payload:{stem:'Shared and own',ownStem:'Own',contextBindings:[{contextId,contextRevision:0,resolutionHash:'a'.repeat(64)}],alternatives:null,correctKey:null,annulled:false}});
  expect(composeCandidate(noBase as unknown as Parameters<typeof composeCandidate>[0],[],2)).toMatchObject({ok:false,error:{message:'context_base_evidence_missing'}});
  const contexts=Array.from({length:101},()=>context({status:'bound',resolution:{targetNumbers:[2],text:'Shared'}}));
  expect(composeCandidate(candidate() as unknown as Parameters<typeof composeCandidate>[0],contexts as unknown as Parameters<typeof composeCandidate>[1],2)).toMatchObject({ok:false,error:{message:'candidate_context_bindings_too_many'}});
 });
 it('history remains frozen even withdrawn while an unpublished approved draft can change',()=>{const state={paper:{status:'draft'},candidates:[candidate({questionId,state:'accepted'})],questions:[{id:questionId,publishedAt:new Date(),catalogStatus:'withdrawn'}]};expect(frozenRecovery(state as unknown as Parameters<typeof frozenRecovery>[0])).toBe(true);state.questions[0]!.publishedAt=null as unknown as Date;state.questions[0]!.catalogStatus='in_review';expect(frozenRecovery(state as unknown as Parameters<typeof frozenRecovery>[0])).toBe(false);});
});

describe('CCR130 guards, original evidence and transaction drift',()=>{
 let f:ReturnType<typeof fake>;beforeEach(()=>{f=fake();});
 const binding={importRevision:0,revision:0,evidenceHash:'a'.repeat(64),decision:'bind' as const,targetNumbers:[2],text:'Do not replace 2 kg with 2 mg.',imageRefIds:[],reason};
 const numbering={importRevision:0,revision:0,originalNumber:'1',markerProvenance:region,reason};
 it('rejects malformed transport data before taking graph locks or writing',async()=>{
  const create=await createMissingCandidate(f.tx,id,{...creation,markerProvenance:{...region,bbox:[0.9,0,0.3,0.3]}});
  const repair=await repairCandidateNumber(f.tx,id,candidateId,{...numbering,reason:'short'});
  const resolve=await resolveImportContext(f.tx,id,contextId,{...binding,targetNumbers:[]});
  expect(create).toMatchObject({ok:false,error:{message:'invalid_candidate_create'}});expect(repair).toMatchObject({ok:false,error:{message:'invalid_candidate_number'}});expect(resolve).toMatchObject({ok:false,error:{message:'invalid_context_resolution'}});expect(f.events).toEqual([]);expect(f.writes).toEqual([]);
 });
 it.each(['number','context'])('stale import revision blocks %s recovery before dependent locks and writes',async kind=>{
  f.data(schema.questionImports)[0]!.revision=8;f.put(schema.questionImportCandidates,[candidate()]);f.put(schema.questionImportContexts,[context()]);
  const result=kind==='number'?await repairCandidateNumber(f.tx,id,candidateId,numbering):await resolveImportContext(f.tx,id,contextId,binding);
  expect(result).toMatchObject({ok:false,error:{message:'import_revision_changed'}});expect(f.events).toEqual(['question_imports']);expect(f.writes).toEqual([]);
 });
 it('cannot resolve a missing context or mutate a context whose dependent question has published history',async()=>{
  expect(await resolveImportContext(f.tx,id,contextId,binding)).toMatchObject({ok:false,error:{message:'context not found'}});expect(f.writes).toEqual([]);
  f.put(schema.questionImportContexts,[context()]);f.put(schema.questionImportCandidates,[candidate({questionId,state:'accepted'})]);f.put(schema.questionBank,[{id:questionId,publishedAt:new Date(),catalogStatus:'withdrawn',reviewedHash:'frozen-original'}]);
  const before=JSON.stringify(f.data(schema.questionBank));expect(await resolveImportContext(f.tx,id,contextId,binding)).toMatchObject({ok:false,error:{message:'published_requires_new_version'}});expect(JSON.stringify(f.data(schema.questionBank))).toBe(before);expect(f.writes).toEqual([]);
 });
 it('repairing a published duplicate unlinks staging without changing its original signature or marker evidence',async()=>{
  const marker={originalNumber:2,provenance:{page:1,bbox:{x:20,y:30,width:12,height:10},method:'text'}};
  const row:Row=candidate({questionId,duplicateOf:questionId,state:'duplicate'});row.payload={...row.payload as Row,parserMarkerEvidence:marker};
  f.put(schema.questionImportCandidates,[row]);f.put(schema.questionBank,[{id:questionId,publishedAt:new Date(),catalogStatus:'published',reviewedHash:'medical-original'}]);f.put(schema.examQuestionOccurrences,[{id:contextId,paperId:id,questionId,originalNumber:'2',ordinal:1}]);
  const before=JSON.stringify(f.data(schema.questionBank)),result=await repairCandidateNumber(f.tx,id,candidateId,numbering);
  expect(result.ok).toBe(true);expect(f.writes).not.toContain('question_bank');expect(JSON.stringify(f.data(schema.questionBank))).toBe(before);const updated=f.data(schema.questionImportCandidates)[0]!;expect(updated).toMatchObject({questionId:null,duplicateOf:null,originalNumber:'1',state:'needs_review'});expect((updated.payload as Row).parserMarkerEvidence).toEqual(marker);expect((updated.payload as Row).numberRecovery).toMatchObject({originalNumber:'1'});expect(f.data(schema.examQuestionOccurrences)).toEqual([]);
 });
 it('an out-of-document repair is rejected without discarding the existing answer or occurrence',async()=>{
  f.put(schema.questionImportCandidates,[candidate({questionId,state:'accepted'})]);f.put(schema.questionBank,[{id:questionId,catalogStatus:'in_review',reviewedHash:'existing-review'}]);f.put(schema.examQuestionOccurrences,[{id:contextId,paperId:id,questionId,originalNumber:'2',ordinal:1}]);
  const before=JSON.stringify([...f.data(schema.questionImportCandidates),...f.data(schema.questionBank),...f.data(schema.examQuestionOccurrences)]);
  expect(await repairCandidateNumber(f.tx,id,candidateId,{...numbering,markerProvenance:{...region,page:6}})).toMatchObject({ok:false,error:{message:'marker_provenance_not_authorized'}});expect(f.writes).toEqual([]);expect(JSON.stringify([...f.data(schema.questionImportCandidates),...f.data(schema.questionBank),...f.data(schema.examQuestionOccurrences)])).toBe(before);
 });
 it('quarantines invalid stored context evidence instead of writing a seemingly valid resolution',async()=>{
  f.put(schema.questionImportContexts,[context({evidenceObjectKey:`questions/imports/${questionId}/contexts/foreign.json`})]);f.put(schema.questionImportCandidates,[candidate()]);
  expect(await resolveImportContext(f.tx,id,contextId,binding)).toMatchObject({ok:false,error:{message:'context_payload_invalid'}});expect(f.writes).toEqual([]);
 });
 it('a context image without authorized provenance cannot be attached to any target',async()=>{
  f.put(schema.questionImportContexts,[context({imageRefs:[{id:doc,page:1,bbox:{x:0,y:0,width:100,height:100},method:'text',objectKey:`questions/imports/${id}/crops/p.png`}]})]);f.put(schema.questionImportCandidates,[candidate()]);
  expect(await resolveImportContext(f.tx,id,contextId,{...binding,imageRefIds:[doc]})).toMatchObject({ok:false,error:{message:'context_provenance_not_authorized'}});expect(f.writes).toEqual([]);
 });
 it('plans every affected candidate before writing context resolution, including a legacy target without base evidence',async()=>{
  const legacy=candidate({id:questionId,originalNumber:'3',payload:{stem:'Legacy effective stem',alternatives:creation.alternatives,contextBindings:[{contextId,contextRevision:0,resolutionHash:'b'.repeat(64)}]}});
  f.put(schema.questionImportCandidates,[candidate(),legacy]);f.put(schema.questionImportContexts,[context()]);
  expect(await resolveImportContext(f.tx,id,contextId,binding)).toMatchObject({ok:false,error:{message:'context_own_stem_missing'}});expect(f.writes).toEqual([]);expect(f.data(schema.questionImportContexts)[0]!.status).toBe('unresolved');
 });
 it('missing linked draft row is not substituted by another question during number repair',async()=>{
  f.put(schema.questionImportCandidates,[candidate({questionId,state:'accepted'})]);f.put(schema.questionBank,[{id:doc,reviewedHash:'unrelated'}]);const before=JSON.stringify(f.data(schema.questionBank));
  expect((await repairCandidateNumber(f.tx,id,candidateId,numbering)).ok).toBe(true);expect(f.writes).not.toContain('question_bank');expect(JSON.stringify(f.data(schema.questionBank))).toBe(before);
 });
 it.each(['question_deleted','association_changed','predecessor_changed'])('batch lock detects %s after discovery without authorizing a write',async change=>{
  f.put(schema.questionBank,[{id:questionId,visibility:'public',userId:null}]);f.put(schema.questionImportCandidates,[candidate({questionId})]);
  f.hooks.onLock=table=>{if(table!=='question_bank')return;if(change==='question_deleted')f.put(schema.questionBank,[]);else if(change==='predecessor_changed')f.data(schema.questionBank)[0]!.supersedesId=doc;else f.data(schema.questionImportCandidates)[0]!.questionId=doc;};
  expect(await lockAssociatedQuestionGraphs(f.tx,questionId)).toMatchObject({ok:false,error:{message:'question_graph_changed_retry'}});expect(f.writes).toEqual([]);
 });
 it('publication propagates graph drift after holding source authorization and never silently publishes',async()=>{
  f.put(schema.questionBank,[{id:questionId,sourceId:id,visibility:'public',userId:null}]);f.put(schema.questionImportCandidates,[candidate({questionId})]);
  f.hooks.onLock=table=>{if(table==='question_bank')f.put(schema.questionImportCandidates,[]);};
  expect(await lockPublicationQuestionGraph(f.tx,questionId)).toMatchObject({ok:false,error:{message:'question_graph_changed_retry'}});expect(f.events[0]).toBe('question_sources');expect(f.writes).toEqual([]);
 });
});

describe('CCR130 conservative composition and draft rank planning',()=>{
 it('rejects missing own text, invalid bound text and evidence overflow rather than truncating',()=>{
  const typed=(value:Row)=>value as unknown as Parameters<typeof composeCandidate>[0];
  expect(composeCandidate(typed(candidate({payload:{alternatives:null}})),[],2)).toMatchObject({ok:false,error:{message:'candidate_stem_missing'}});
  const invalid=context({status:'bound',resolution:{targetNumbers:[2],text:null}}) as unknown as Parameters<typeof composeCandidate>[1][number];
  expect(composeCandidate(typed(candidate()),[invalid],2)).toMatchObject({ok:false,error:{message:'context_resolution_invalid'}});
  const images=Array.from({length:101},(_,n)=>({objectKey:`own-${n}`,page:1,bbox:{x:n,y:0,width:1,height:1},method:'text',provenance:region}));
  expect(composeCandidate(typed(candidate({payload:{...candidate().payload as Row,imageRefs:images}})),[],2)).toMatchObject({ok:false,error:{message:'candidate_evidence_too_large'}});
  const provenance=Array.from({length:501},(_,n)=>({...region,bbox:[0,n/1000,0.1,0.001]}));
  expect(composeCandidate(typed(candidate({provenance})),[],2)).toMatchObject({ok:false,error:{message:'candidate_evidence_too_large'}});
  expect(composeCandidate(typed(candidate({payload:{...candidate().payload as Row,alternatives:[{key:'A',text:10}]}})),[],2)).toMatchObject({ok:false,error:{message:'candidate_payload_invalid'}});
 });
 it('orders same-page contexts by vertical/horizontal provenance and never treats non-question text as a prefix',()=>{
  const bound=(name:string,x:number,y:number)=>({id:name,status:'bound' as const,resolution:{text:name},provenance:[{...region,bbox:[x,y,0.1,0.1] as typeof region.bbox}]});
  const result=effectiveStem('Do not replace 2 kg.',[bound('bottom',0,0.8),bound('right',0.6,0.2),{status:'non_question',resolution:{text:'Excluded metadata'}},bound('left',0.1,0.2)]);
  expect(result).toEqual({ok:true,data:'left\n\nright\n\nbottom\n\nDo not replace 2 kg.'});
 });
 it('treats image identifiers and provenance changes as real resolution changes while object-key ordering is irrelevant',()=>{
  const a={id:doc,objectKey:'private/first',alt:'Exact description',provenance:region},resolution={text:'Do not replace 2 kg.',targetNumbers:[2],imageRefIds:[doc]};
  const h=contextResolutionHash({id:contextId,evidenceHash:'a'.repeat(64)},resolution,[a]);expect(contextResolutionHash({id:contextId,evidenceHash:'a'.repeat(64)},{imageRefIds:[doc],targetNumbers:[2],text:'Do not replace 2 kg.'},[{provenance:region,alt:'Exact description',objectKey:'private/first',id:doc}])).toBe(h);
  for(const image of [{...a,objectKey:'private/second'},{...a,alt:'Different description'},{...a,provenance:{...region,page:2}}])expect(contextResolutionHash({id:contextId,evidenceHash:'a'.repeat(64)},resolution,[image])).not.toBe(h);
 });
 it.each(['published','negative_rank','collision','overflow'])('rank planning refuses %s without updating any occurrence',async scenario=>{
  const f=fake();f.put(schema.examQuestionOccurrences,[{id:doc,paperId:id,originalNumber:'1',ordinal:scenario==='negative_rank'?-1:scenario==='overflow'?2147483647:1}]);if(scenario==='collision')f.data(schema.examQuestionOccurrences).push({id:contextId,paperId:id,originalNumber:'01',ordinal:2});
  const graph=await recoveryState(f.tx,id,0);expect(graph.ok).toBe(true);if(!graph.ok)return;
  if(scenario==='published')graph.data.paper.status='published';const before=JSON.stringify(f.data(schema.examQuestionOccurrences));const {orderDraftOccurrences}=await import('./recovery');expect((await orderDraftOccurrences(f.tx,graph.data)).ok).toBe(false);expect(f.writes).toEqual([]);expect(JSON.stringify(f.data(schema.examQuestionOccurrences))).toBe(before);
 });
});
