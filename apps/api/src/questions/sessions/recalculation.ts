import { sql } from 'drizzle-orm';
import { questionReferenceAfterAnswerSchema,questionSessionRecalculationSchema,type QuestionSessionRecalculation } from '@remoa/contracts';
import { asServer,run } from '../../db';
import { latest,readable,conflict,missing,type Row } from '../catalog/service';
export type Outcome='correct'|'incorrect'|'unanswered'|'annulled';
export function answerOutcome(answered:boolean,selected:string|null,correct:string|null,annulled:boolean):Outcome{
 return annulled?'annulled':!answered?'unanswered':selected!==null&&selected===correct?'correct':'incorrect';
}
const object=(value:unknown):Row=>typeof value==='object'&&value!==null?value as Row:{};
const text=(value:string)=>value.normalize('NFC').replace(/\s+/g,' ').trim();
function stable(value:unknown):unknown{
 if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)]));return value;
}
function assetSignature(value:unknown):string|null{
 if(value===undefined||value===null)return '[]';if(!Array.isArray(value))return null;
 const normalized=[];
 for(const raw of value){const a=object(raw);if(typeof a.id!=='string'||typeof a.alt!=='string')return null;
  const pointer=a.objectKey;if(typeof pointer!=='string'||!pointer)return null;
  normalized.push({id:a.id,alt:text(a.alt),pointer,provenance:stable(a.provenance??null)});
 }
 return JSON.stringify(normalized.sort((a,b)=>a.id.localeCompare(b.id)));
}
function alternatives(value:unknown):Map<string,string>|null{
 if(!Array.isArray(value)||value.length<2)return null;const keys=new Map<string,string>(),texts=new Set<string>();
 for(const raw of value){const a=object(raw);if(typeof a.key!=='string'||typeof a.text!=='string'||!text(a.text)||keys.has(a.key)||texts.has(text(a.text)))return null;keys.set(a.key,text(a.text));texts.add(text(a.text));}return keys;
}
export function compareSessionItem(item:Row,current?:Row):QuestionSessionRecalculation['items'][number]{
 const frozen=object(item.payload_public),saved=object(item.reference_snapshot);
 const base={itemId:String(item.id),originalQuestionId:String(item.question_id),originalQuestionVersion:Number(saved.version??frozen.version),comparedQuestionId:current?String(current.id):null,comparedQuestionVersion:current?Number(current.version):null};
 if(!current)return {...base,outcome:'unavailable',reasonCode:'rights_unavailable',reference:null};
 const oldOptions=alternatives(frozen.alternatives),newOptions=alternatives(current.alternatives),oldAssets=assetSignature(frozen.assets),newAssets=assetSignature(current.assets);
 // A review of materially changed content cannot be inferred from the previous answer.
 if(oldAssets===null||newAssets===null||oldAssets!==newAssets||frozen.type!=='objective'||current.type!=='objective'||typeof frozen.stem!=='string'||typeof current.stem!=='string'||text(frozen.stem)!==text(current.stem)||!oldOptions||!newOptions||oldOptions.size!==newOptions.size||[...oldOptions.values()].some(t=>![...newOptions.values()].includes(t)))return {...base,outcome:'not_comparable',reasonCode:'content_not_comparable',reference:null};
 const selected=item.selected_key===null||item.selected_key===undefined?null:oldOptions.get(String(item.selected_key));
 if(item.answered===true&&item.selected_key!=null&&selected===undefined)return {...base,outcome:'not_comparable',reasonCode:'content_not_comparable',reference:null};
 const annulled=current.availability==='annulled'||current.id===item.question_id&&saved.annulled===true;
 const correct=current.correct_key==null?null:newOptions.get(String(current.correct_key));
 if(!annulled&&(correct===undefined||correct===null))return {...base,outcome:'not_comparable',reasonCode:'content_not_comparable',reference:null};
 const originalCorrect=saved.correctKey==null?null:oldOptions.get(String(saved.correctKey));
 const reference=questionReferenceAfterAnswerSchema.parse({questionId:current.id,version:current.version,correctKey:annulled?null:current.correct_key??null,explanation:current.explanation??null,distractorNotes:current.distractor_notes??null,annulled,reviewed:current.visibility==='public',reviewerName:current.reviewer_name??null,reviewerCrm:current.reviewer_crm??null,referenceDate:current.reference_date??null,sourceUrl:current.source_url??null,obsolete:false});
 const outcome=answerOutcome(item.answered===true,selected??null,correct??null,annulled);
 const reasonCode=annulled?'annulled':correct!==originalCorrect?'key_changed':Number(current.version)!==base.originalQuestionVersion||current.id!==item.question_id?'version_changed':'unchanged';
 return {...base,outcome,reasonCode,reference};
}
export async function recalculateSession(userId:string,id:string){
 return run(userId,async(tx)=>{
  const [session]=await asServer<Row>(tx,sql`SELECT id,status,report FROM question_sessions WHERE id=${id} AND user_id=${userId} FOR SHARE`);if(!session)throw missing();if(session.status==='active')throw conflict('session_not_finished');
  const rows=await asServer<Row>(tx,sql`SELECT i.id,i.question_id,i.payload_public,i.reference_snapshot,i.selected_key,i.answered,coalesce(original.canonical_id,original.id) canonical_id FROM question_session_items i JOIN question_bank original ON original.id=i.question_id WHERE i.session_id=${id} AND i.user_id=${userId} ORDER BY i.position`);
  const candidates=await asServer<Row>(tx,sql`SELECT q.id,coalesce(q.canonical_id,q.id) canonical_id,q.version,q.type,q.stem,q.alternatives,q.assets,q.correct_key,q.explanation,q.distractor_notes,q.availability,q.visibility,q.reviewer_name,q.reviewer_crm,q.reference_date,src.url source_url FROM question_bank q LEFT JOIN question_sources src ON src.id=q.source_id WHERE coalesce(q.canonical_id,q.id) IN(SELECT coalesce(original.canonical_id,original.id) FROM question_session_items i JOIN question_bank original ON original.id=i.question_id WHERE i.session_id=${id} AND i.user_id=${userId}) AND ${readable(userId)} AND ${latest} AND (q.visibility='private' OR NOT EXISTS(SELECT 1 FROM question_bank n WHERE coalesce(n.canonical_id,n.id)=coalesce(q.canonical_id,q.id) AND n.version>q.version AND n.visibility='public' AND (n.published_at IS NOT NULL OR n.catalog_status='published')))`);
  const byCanonical=new Map(candidates.map(q=>[String(q.canonical_id),q]));const items=rows.map(item=>compareSessionItem(item,byCanonical.get(String(item.canonical_id))));
  const complete=!items.some(i=>i.outcome==='unavailable'||i.outcome==='not_comparable');const counts={correct:0,incorrect:0,unanswered:0,annulled:0};for(const i of items)if(i.outcome in counts)counts[i.outcome as Outcome]++;
  const denominator=counts.correct+counts.incorrect+counts.unanswered;
  return questionSessionRecalculationSchema.parse({sessionId:id,originalVersion:object(session.report).version??1,calculatedAt:new Date(),complete,aggregates:complete?{...counts,denominator,score:denominator?counts.correct/denominator:null}:null,items});
 });
}
