/** CCR130. Caller owns the single withAdmin transaction, fresh authorization, audit and post-commit invalidation.
 * No storage/provider IO here. Every writer uses import → paper → contexts(id) → candidates(id) → questions(id).
 */
import {and,eq,inArray,or,sql} from 'drizzle-orm';
import {err,ok,questionCandidateCreateInputSchema,questionCandidateNumberInputSchema,questionImportContextResolveInputSchema,questionOriginalNumberSchema,questionCandidatePayloadSchema,questionImportContextSchema,type Result,type QuestionCandidateCreateInput,type QuestionCandidateNumberInput,type QuestionImportContextResolveInput,type QuestionProvenance} from '@remoa/contracts';
import type {Tx,questionImports,examPapers,questionImportContexts,questionImportCandidates,questionBank} from '@remoa/db';
import {dbm} from '../../db';
import {fingerprint,contentHash,sha256} from '../../questions/imports/domain';
type ImportRow=typeof questionImports.$inferSelect;
type PaperRow=typeof examPapers.$inferSelect;
type ContextRow=typeof questionImportContexts.$inferSelect;
type CandidateRow=typeof questionImportCandidates.$inferSelect;
type BankRow=typeof questionBank.$inferSelect;
export interface RecoveryGraph {m:Awaited<ReturnType<typeof dbm>>;job:ImportRow;paper:PaperRow;contexts:ContextRow[];candidates:CandidateRow[];questions:BankRow[]}
export async function recoveryState(tx:Tx,importId:string,revision?:number,extraQuestionIds:readonly string[]=[]):Promise<Result<RecoveryGraph>>{
 const m=await dbm();
 const [job]=await tx.select().from(m.questionImports).where(eq(m.questionImports.id,importId)).for('update');
 if(!job?.paperId || !['review','completed'].includes(job.status))return err('conflict','import_not_in_review');
 if(revision!==undefined && job.revision!==revision)return err('conflict','import_revision_changed');
 const [paper]=await tx.select().from(m.examPapers).where(eq(m.examPapers.id,job.paperId)).for('update');
 if(!paper)return err('conflict','import_paper_missing');
 const contexts=await tx.select().from(m.questionImportContexts).where(eq(m.questionImportContexts.importId,importId)).orderBy(m.questionImportContexts.id).for('update');
 const candidates=await tx.select().from(m.questionImportCandidates).where(eq(m.questionImportCandidates.importId,importId)).orderBy(m.questionImportCandidates.id).for('update');
 // A newly selected duplicate target must join the ordered question lock phase:
 // its occurrence FK takes KEY SHARE later, which conflicts with another writer's UPDATE.
 const ids=[...new Set([...candidates.flatMap(c=>c.questionId?[c.questionId]:[]),...extraQuestionIds])].sort();
 const questions=ids.length?await tx.select().from(m.questionBank).where(inArray(m.questionBank.id,ids)).orderBy(m.questionBank.id).for('update'):[];
 return ok({m,job,paper,contexts,candidates,questions});
}
/** A published duplicate is an external canonical item; unlink it, never rewrite its medical signature. */
export function frozenRecovery(state:Pick<RecoveryGraph,'paper'|'candidates'|'questions'>):boolean{
 return state.paper.status!=='draft' || state.questions.some(q=>(q.publishedAt || q.catalogStatus==='published') && state.candidates.some(c=>c.questionId===q.id && c.state!=='duplicate'));
}
export async function bumpImport(tx:Tx,state:RecoveryGraph):Promise<number>{
 const revision=state.job.revision+1;
 await tx.update(state.m.questionImports).set({revision,updatedAt:new Date()}).where(eq(state.m.questionImports.id,state.job.id));
 return revision;
}
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value!==null && typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
 return value;
}
export function creationRequestHash(importId:string,input:QuestionCandidateCreateInput,sourceId?:string):string{
 const {importRevision:_,...creation}=input;void _;
 return sha256(JSON.stringify(canonical({importId,sourceId,...creation})));
}
export function contextResolutionHash(context:Pick<ContextRow,'id'|'evidenceHash'>,resolution:unknown,images:Record<string,unknown>[]):string{
 const stableImages=images.map(({url:_,...image})=>{void _;return image;});
 return sha256(JSON.stringify(canonical({algorithm:'context-resolution-v1',contextId:context.id,evidenceHash:context.evidenceHash,resolution,images:stableImages})));
}
export function effectiveStem(ownStem:string,contexts:(Pick<ContextRow,'status'|'resolution'> & Partial<Pick<ContextRow,'id'|'provenance'>>)[]):Result<string>{
 const prefixes:string[]=[];
 for(const context of orderedContexts(contexts)){
  if(context.status!=='bound')continue;
  if(typeof context.resolution?.text!=='string')return err('validation','context_resolution_invalid');
  if(context.resolution.text)prefixes.push(context.resolution.text);
 }
 const stem=[...prefixes,ownStem].join('\n\n');
 return stem.length>20000?err('validation','effective_stem_too_large'):ok(stem);
}
export function normalizedNumber(value:unknown):string|null{
 const result=questionOriginalNumberSchema.safeParse(value);return result.success?result.data:null;
}
export function validMarker(ref:QuestionProvenance,documentId:string,pages:number,excluded:number[]):boolean{
 const b=ref.bbox;
 return ref.documentId===documentId && Number.isInteger(ref.page) && ref.page>=1 && ref.page<=Math.min(pages,500) && !excluded.includes(ref.page) && !!b && b.every(Number.isFinite) && b[0]>=0 && b[1]>=0 && b[2]>0 && b[3]>0 && b[0]+b[2]<=1 && b[1]+b[3]<=1;
}
async function authorizedEvidence(tx:Tx,state:RecoveryGraph,refs:QuestionProvenance[]):Promise<boolean>{
 const [doc]=await tx.select().from(state.m.questionDocuments).where(eq(state.m.questionDocuments.id,state.job.documentId));
 const [source]=await tx.select().from(state.m.questionSourcesCatalog).where(eq(state.m.questionSourcesCatalog.id,state.job.sourceId));
 return !!doc?.pages && doc.kind==='exam' && doc.sourceId===state.job.sourceId && !!source && source.rightsStatus!=='revoked' && (!source.rightsExpiresAt || source.rightsExpiresAt.getTime()>Date.now()) && refs.length>0 && refs.every(ref=>validMarker(ref,doc.id,doc.pages!,state.job.excludedPages));
}
function targets(context:Pick<ContextRow,'status'|'resolution'>):number[]{return context.status==='bound' && Array.isArray(context.resolution?.targetNumbers)?context.resolution.targetNumbers as number[]:[];}
function bindings(contexts:ContextRow[],number:number){return contexts.filter(c=>targets(c).includes(number)).map(c=>({contextId:c.id,contextRevision:c.revision,resolutionHash:c.resolutionHash}));}
function references(value:unknown):Record<string,unknown>[]{return Array.isArray(value)?value.filter(v=>v && typeof v==='object') as Record<string,unknown>[]:[];}
function ownStem(candidate:CandidateRow):Result<string>{
 if(typeof candidate.payload.ownStem==='string')return ok(candidate.payload.ownStem);
 if(references(candidate.payload.contextBindings).length)return err('validation','context_own_stem_missing');
 return typeof candidate.payload.stem==='string'?ok(candidate.payload.stem):err('validation','candidate_stem_missing');
}
export function planDraftRanks(occurrences:{id:string;originalNumber:string}[]):Result<{id:string;ordinal:number}[]>{
 const normalized=occurrences.map(o=>({...o,number:normalizedNumber(o.originalNumber)}));
 if(normalized.some(o=>o.number===null))return err('validation','original_number_not_confirmed');
 if(new Set(normalized.map(o=>o.number)).size!==normalized.length)return err('conflict','occurrence_number_collision');
 return ok(normalized.sort((a,b)=>Number(a.number)-Number(b.number)||(a.id<b.id?-1:1)).map((o,index)=>({id:o.id,ordinal:index+1})));
}
/** Rank belongs to draft paper order, never to candidate insertion order. Positive temporary ranks avoid immediate unique/check collisions. */
export async function orderDraftOccurrences(tx:Tx,state:RecoveryGraph):Promise<Result<void>>{
 if(state.paper.status!=='draft')return err('conflict','published_requires_new_version');
 const o=state.m.examQuestionOccurrences;
 const rows=await tx.select({id:o.id,originalNumber:o.originalNumber,ordinal:o.ordinal}).from(o).where(eq(o.paperId,state.paper.id)).orderBy(o.id).for('update');
 if(rows.some(r=>r.ordinal<0))return err('conflict','occurrence_rank_invalid');
 const ranks=planDraftRanks(rows);if(!ranks.ok)return ranks;
 if(!rows.length)return ok(undefined);
 const maxOrdinal=Math.max(...rows.map(row=>row.ordinal)),offset=maxOrdinal+rows.length+1;
 if(maxOrdinal+offset>2147483647)return err('validation','occurrence_rank_overflow');
 await tx.update(o).set({ordinal:sql`${o.ordinal}+${offset}`}).where(eq(o.paperId,state.paper.id));
 for(const row of ranks.data)await tx.update(o).set({ordinal:row.ordinal}).where(eq(o.id,row.id));
 return ok(undefined);
}
function orderedContexts<T extends Pick<ContextRow,'status'|'resolution'> & Partial<Pick<ContextRow,'id'|'provenance'>>>(contexts:T[]):T[]{return [...contexts].sort((a,b)=>{const x=a.provenance?.[0],y=b.provenance?.[0];return (x?.page??0)-(y?.page??0)||(x?.bbox?.[1]??0)-(y?.bbox?.[1]??0)||(x?.bbox?.[0]??0)-(y?.bbox?.[0]??0)||((a.id??'')<(b.id??'')?-1:(a.id??'')>(b.id??'')?1:0);});}
function imageDescriptor(ref:Record<string,unknown>){return Object.fromEntries(['page','bbox','method','objectKey','provenance','sha256','bytes'].flatMap(key=>ref[key]===undefined?[]:[[key,ref[key]]]));}
function distinct<T>(refs:T[]):T[]{const seen=new Set<string>();return refs.filter(ref=>{const key=JSON.stringify(canonical(ref));if(seen.has(key))return false;seen.add(key);return true;});}
export function composeCandidate(candidate:CandidateRow,contexts:ContextRow[],number:number):Result<{payload:Record<string,unknown>;provenance:QuestionProvenance[];fingerprint:string}>{
 const own=ownStem(candidate);if(!own.ok)return own;
 if(references(candidate.payload.contextBindings).length && (!Array.isArray(candidate.payload.ownProvenance)||!Array.isArray(candidate.payload.ownImageRefs)))return err('validation','context_base_evidence_missing');
 const ownProvenance=Array.isArray(candidate.payload.ownProvenance)?candidate.payload.ownProvenance as QuestionProvenance[]:candidate.provenance;
 const ownImageRefs=Array.isArray(candidate.payload.ownImageRefs)?references(candidate.payload.ownImageRefs):references(candidate.payload.imageRefs);
 const selected=orderedContexts(contexts.filter(c=>targets(c).includes(number)));
 if(selected.length>100)return err('validation','candidate_context_bindings_too_many');
 const stem=effectiveStem(own.data,selected);if(!stem.ok)return stem;
 const shared=selected.flatMap(c=>{const ids=Array.isArray(c.resolution?.imageRefIds)?c.resolution.imageRefIds:[];return c.imageRefs.filter(ref=>ids.includes(ref.id)).map(imageDescriptor);});
 const imageRefs=distinct([...ownImageRefs,...shared]);const provenance=distinct([...ownProvenance,...selected.flatMap(c=>c.provenance)]);
 if(imageRefs.length>100 || provenance.length>500)return err('validation','candidate_evidence_too_large');
 const ownKeys=new Set(ownImageRefs.map(ref=>ref.objectKey));const assets=references(candidate.payload.assets).filter(asset=>ownKeys.has(asset.objectKey));
 const payload={...candidate.payload,ownStem:own.data,stem:stem.data,ownProvenance,ownImageRefs,contextBindings:bindings(selected,number),imageRefs,assets,keyFinal:false,integrityConfirmed:false,imagesConfirmed:false};
 const parsed=questionCandidatePayloadSchema.safeParse(payload);if(!parsed.success)return err('validation','candidate_payload_invalid');
 return ok({payload:parsed.data,provenance,fingerprint:fingerprint(stem.data,candidate.payload.alternatives)});
}
async function invalidateCandidate(tx:Tx,state:RecoveryGraph,candidate:CandidateRow,payload:Record<string,unknown>){
 const o=state.m.examQuestionOccurrences;const number=normalizedNumber(candidate.originalNumber);
 if(number)await tx.delete(o).where(and(eq(o.paperId,state.paper.id),sql`case when ${o.originalNumber} ~ '^[0-9]{1,3}$' then ${o.originalNumber}::integer else null end = ${Number(number)}`));
 if(!candidate.questionId || candidate.state==='duplicate')return;
 const row=state.questions.find(q=>q.id===candidate.questionId);if(!row)return;
 const stem=String(payload.stem),assets=references(payload.assets);
 const hash=contentHash({stem,alternatives:row.alternatives,correctKey:row.correctKey,explanation:row.explanation,areaId:row.enamedAreaId,topicId:row.enamedTopicId,annulled:row.availability==='annulled',assets});
 await tx.update(state.m.questionBank).set({stem,assets,contentHash:hash,fingerprint:fingerprint(stem,row.alternatives),catalogStatus:'in_review',status:'draft',reviewedHash:null,reviewerName:null,reviewerCrm:null,referenceDate:null,integrityConfirmed:false,keyFinal:false,enamedConfirmed:false,updatedAt:new Date()}).where(eq(state.m.questionBank.id,row.id));
}
export async function createMissingCandidate(tx:Tx,importId:string,raw:QuestionCandidateCreateInput){
 const parsed=questionCandidateCreateInputSchema.safeParse(raw);if(!parsed.success)return err('validation','invalid_candidate_create');const input=parsed.data;
 const loaded=await recoveryState(tx,importId);if(!loaded.ok)return loaded;const state=loaded.data;
 const hash=creationRequestHash(importId,input,state.job.sourceId),existing=state.candidates.find(c=>c.id===input.candidateId);
 if(existing){if((existing.payload.manualRecovery as {requestHash?:unknown}|undefined)?.requestHash!==hash)return err('conflict','candidate_idempotency_conflict');return ok({candidate:existing,affectedCandidates:[],importRevision:state.job.revision});}
 if(frozenRecovery(state))return err('conflict','published_requires_new_version');
 if(state.job.revision!==input.importRevision)return err('conflict','import_revision_changed');
 if(state.candidates.length>=1000)return err('validation','manual_candidate_limit_1000');
 if(state.candidates.some(c=>c.state!=='rejected'&&normalizedNumber(c.originalNumber)===input.originalNumber))return err('conflict','candidate_number_exists');
 if(!await authorizedEvidence(tx,state,[input.markerProvenance,...input.provenance]))return err('validation','marker_provenance_not_authorized');
 if(state.candidates.some(c=>c.ordinal>=2147483647))return err('validation','candidate_ordinal_overflow');
 const candidate:CandidateRow={id:input.candidateId,importId,chunkId:null,ordinal:Math.max(0,...state.candidates.map(c=>c.ordinal))+1,originalNumber:input.originalNumber,payload:{ownStem:input.ownStem,stem:input.ownStem,originalNumber:Number(input.originalNumber),alternatives:input.alternatives,correctKey:null,annulled:false,explanation:null,areaId:null,topicId:null,contextBindings:[],manualRecovery:{requestHash:hash,markerProvenance:input.markerProvenance},imageRefs:[],assets:[],keyFinal:false,integrityConfirmed:false,imagesConfirmed:false},confidence:{},provenance:distinct([...input.provenance,input.markerProvenance]),issues:['manual_marker_review_required'],fingerprint:null,duplicateOf:null,questionId:null,state:'needs_review',revision:0,createdAt:new Date(),updatedAt:new Date()};
 const composed=composeCandidate(candidate,state.contexts,Number(input.originalNumber));if(!composed.ok)return composed;
 const [created]=await tx.insert(state.m.questionImportCandidates).values({...candidate,...composed.data}).onConflictDoNothing().returning();if(!created)return err('conflict','candidate_id_exists');
 return ok({candidate:created,affectedCandidates:[],importRevision:await bumpImport(tx,state)});
}
export const createRecoveredCandidate=createMissingCandidate;
export async function repairCandidateNumber(tx:Tx,importId:string,id:string,raw:QuestionCandidateNumberInput){
 const parsed=questionCandidateNumberInputSchema.safeParse(raw);if(!parsed.success)return err('validation','invalid_candidate_number');const input=parsed.data;
 const loaded=await recoveryState(tx,importId,input.importRevision);if(!loaded.ok)return loaded;const state=loaded.data;
 const row=state.candidates.find(c=>c.id===id);if(!row)return err('not_found','candidate not found');
 if(row.revision!==input.revision)return err('conflict','candidate_revision_changed');if(frozenRecovery(state))return err('conflict','published_requires_new_version');
 if(row.originalNumber!==null && normalizedNumber(row.originalNumber)===null)return err('validation','legacy_number_not_supported');
 if(state.candidates.some(c=>c.id!==id&&c.state!=='rejected'&&normalizedNumber(c.originalNumber)===input.originalNumber))return err('conflict','candidate_number_exists');
 if(!await authorizedEvidence(tx,state,[input.markerProvenance]))return err('validation','marker_provenance_not_authorized');
 const composed=composeCandidate(row,state.contexts,Number(input.originalNumber));if(!composed.ok)return composed;
 const payload={...composed.data.payload,numberRecovery:{originalNumber:input.originalNumber,markerProvenance:input.markerProvenance,revision:row.revision+1,reason:input.reason},ownProvenance:distinct([...(composed.data.payload.ownProvenance as QuestionProvenance[]),input.markerProvenance]),originalNumber:Number(input.originalNumber),correctKey:null,annulled:false,keyFinal:false,integrityConfirmed:false};
 const newProvenance=distinct([...composed.data.provenance,input.markerProvenance]);
 await invalidateCandidate(tx,state,row,payload);
 const [updated]=await tx.update(state.m.questionImportCandidates).set({payload,provenance:newProvenance,fingerprint:composed.data.fingerprint,originalNumber:input.originalNumber,questionId:row.state==='duplicate'?null:row.questionId,duplicateOf:null,state:'needs_review',revision:row.revision+1,issues:[...new Set([...row.issues,'manual_marker_review_required','missing_answer_key'])],updatedAt:new Date()}).where(eq(state.m.questionImportCandidates.id,id)).returning();
 const rank=await orderDraftOccurrences(tx,state);if(!rank.ok)return rank;
 return ok({candidate:updated!,affectedCandidates:[],importRevision:await bumpImport(tx,state)});
}
export const recoverCandidateNumber=repairCandidateNumber;
export async function resolveImportContext(tx:Tx,importId:string,id:string,raw:QuestionImportContextResolveInput){
 const parsed=questionImportContextResolveInputSchema.safeParse(raw);if(!parsed.success)return err('validation','invalid_context_resolution');const input=parsed.data;
 const loaded=await recoveryState(tx,importId,input.importRevision);if(!loaded.ok)return loaded;const state=loaded.data;
 const row=state.contexts.find(c=>c.id===id);if(!row)return err('not_found','context not found');
 if(row.revision!==input.revision || row.evidenceHash!==input.evidenceHash)return err('conflict','context_revision_changed');if(frozenRecovery(state))return err('conflict','published_requires_new_version');
 if(input.targetNumbers.some(n=>state.candidates.filter(c=>c.state!=='rejected'&&normalizedNumber(c.originalNumber)===String(n)).length!==1))return err('validation','context_target_missing');
 const images=row.imageRefs.filter(ref=>input.imageRefIds.includes(String(ref.id)));
 if(images.length!==input.imageRefIds.length || new Set(images.map(i=>i.id)).size!==images.length)return err('validation','context_image_ref_unknown');
 const refs=[...row.provenance,...images.flatMap(image=>image.provenance?[image.provenance as QuestionProvenance]:[])];
 if(images.some(image=>typeof image.objectKey!=='string'||!image.objectKey.startsWith(`questions/imports/${importId}/crops/`)||!image.provenance)||!await authorizedEvidence(tx,state,refs))return err('validation','context_provenance_not_authorized');
 const resolution={decision:input.decision,targetNumbers:input.targetNumbers,text:input.text,imageRefIds:input.imageRefIds,reason:input.reason};
 const next:ContextRow={...row,resolution,resolutionHash:contextResolutionHash(row,resolution,images),revision:row.revision+1,status:input.decision==='bind'?'bound':'non_question',updatedAt:new Date()};
 if(!questionImportContextSchema.safeParse(next).success)return err('validation','context_payload_invalid');
 const contexts=state.contexts.map(c=>c.id===id?next:c);
 const affected=state.candidates.filter(c=>input.targetNumbers.includes(Number(c.originalNumber))||targets(row).includes(Number(c.originalNumber))||row.declaredNumbers.includes(Number(c.originalNumber))||references(c.payload.contextBindings).some(b=>b.contextId===id));
 const plans=[];for(const candidate of affected){const composed=composeCandidate(candidate,contexts,Number(candidate.originalNumber));if(!composed.ok)return composed;plans.push({candidate,...composed.data});}
 const [context]=await tx.update(state.m.questionImportContexts).set({resolution:next.resolution,resolutionHash:next.resolutionHash,revision:next.revision,status:next.status,updatedAt:next.updatedAt}).where(eq(state.m.questionImportContexts.id,id)).returning();
 const affectedCandidates:CandidateRow[]=[];
 for(const plan of plans){await invalidateCandidate(tx,state,plan.candidate,plan.payload);const [updated]=await tx.update(state.m.questionImportCandidates).set({payload:plan.payload,provenance:plan.provenance,fingerprint:plan.fingerprint,state:'needs_review',questionId:plan.candidate.state==='duplicate'?null:plan.candidate.questionId,duplicateOf:null,revision:plan.candidate.revision+1,issues:[...new Set([...plan.candidate.issues.filter(issue=>issue!=='shared_context_unresolved'),'context_reconfirmation_required'])],updatedAt:new Date()}).where(eq(state.m.questionImportCandidates.id,plan.candidate.id)).returning();affectedCandidates.push(updated!);}
 const rank=await orderDraftOccurrences(tx,state);if(!rank.ok)return rank;
 return ok({context:context!,affectedCandidates,importRevision:await bumpImport(tx,state),acceptanceBlocked:contexts.some(c=>c.status==='unresolved')});
}
/** Publication/draft edit must prelock every associated institutional graph in phases, not loop recoveryState.
 * This only establishes locking; it does not authorize publication or relax medical/history gates.
 */
export async function lockAssociatedQuestionGraphs(tx:Tx,questionId:string):Promise<Result<void>>{
 const m=await dbm(),c=m.questionImportCandidates,q=m.questionBank;
 const discoverQuestions=async()=>{
  const [question]=await tx.select({id:q.id,visibility:q.visibility,userId:q.userId,supersedesId:q.supersedesId}).from(q).where(eq(q.id,questionId));
  if(!question || question.visibility!=='public' || question.userId!==null)return null;
  return {question,ids:[...new Set([questionId,...(question.supersedesId?[question.supersedesId]:[])])].sort()};
 };
 const discovery=await discoverQuestions();if(!discovery)return ok(undefined);
 const discover=async()=>{
  const linked=await tx.select({importId:c.importId}).from(c).where(inArray(c.questionId,discovery.ids));
  const occurrencePapers=await tx.select({paperId:m.examQuestionOccurrences.paperId}).from(m.examQuestionOccurrences).where(inArray(m.examQuestionOccurrences.questionId,discovery.ids));
  const papers=[...new Set(occurrencePapers.map(row=>row.paperId))].sort(),candidateImports=[...new Set(linked.map(row=>row.importId))];
  const conditions=[...(candidateImports.length?[inArray(m.questionImports.id,candidateImports)]:[]),...(papers.length?[inArray(m.questionImports.paperId,papers)]:[])];
  const associated=conditions.length?await tx.select({id:m.questionImports.id,paperId:m.questionImports.paperId}).from(m.questionImports).where(or(...conditions)):[];
  return {imports:[...new Set(associated.map(row=>row.id))].sort(),papers:[...new Set([...papers,...associated.flatMap(row=>row.paperId?[row.paperId]:[])])].sort()};
 };
 const original=await discover(),imports=original.imports;
 const jobs=imports.length?await tx.select().from(m.questionImports).where(inArray(m.questionImports.id,imports)).orderBy(m.questionImports.id).for('update'):[];
 if(jobs.length!==imports.length)return err('conflict','question_graph_changed_retry');
 const paperIds=[...new Set([...original.papers,...jobs.flatMap(job=>job.paperId?[job.paperId]:[])])].sort();
 if(paperIds.length)await tx.select({id:m.examPapers.id}).from(m.examPapers).where(inArray(m.examPapers.id,paperIds)).orderBy(m.examPapers.id).for('update');
 if(imports.length)await tx.select({id:m.questionImportContexts.id}).from(m.questionImportContexts).where(inArray(m.questionImportContexts.importId,imports)).orderBy(m.questionImportContexts.id).for('update');
 const candidates=imports.length?await tx.select({id:c.id,questionId:c.questionId}).from(c).where(inArray(c.importId,imports)).orderBy(c.id).for('update'):[];
 const ids=[...new Set([...discovery.ids,...candidates.flatMap(row=>row.questionId?[row.questionId]:[])])].sort();
 await tx.select({id:q.id}).from(q).where(inArray(q.id,ids)).orderBy(q.id).for('update');
 const current=await discoverQuestions(),currentGraph=await discover();
 if(!current || JSON.stringify(current.ids)!==JSON.stringify(discovery.ids) || JSON.stringify(currentGraph)!==JSON.stringify(original))return err('conflict','question_graph_changed_retry');
 return ok(undefined);
}
/** Publication alone needs a stable authorization source. Lock it before any graph
 * row; recovery evidence reads do not publish and must not take a late source SHARE.
 * Source updates use NO KEY UPDATE, so their implicit FK KEY SHARE stays compatible.
 */
export async function lockPublicationQuestionGraph(tx:Tx,questionId:string):Promise<Result<void>>{
 const m=await dbm(),q=m.questionBank,s=m.questionSourcesCatalog;
 const [initial]=await tx.select({sourceId:q.sourceId,visibility:q.visibility,userId:q.userId}).from(q).where(eq(q.id,questionId));
 if(!initial?.sourceId || initial.visibility!=='public' || initial.userId!==null)return err('not_found','question not found');
 const [source]=await tx.select({id:s.id}).from(s).where(eq(s.id,initial.sourceId)).for('share');
 if(!source)return err('not_found','source not found');
 const locked=await lockAssociatedQuestionGraphs(tx,questionId);if(!locked.ok)return locked;
 const [current]=await tx.select({sourceId:q.sourceId,visibility:q.visibility,userId:q.userId}).from(q).where(eq(q.id,questionId));
 if(!current || current.sourceId!==initial.sourceId || current.visibility!=='public' || current.userId!==null)return err('conflict','question_source_changed_retry');
 return ok(undefined);
}
