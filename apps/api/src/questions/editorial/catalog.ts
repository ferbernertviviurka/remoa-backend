/** CCR139 metadata discovery; institutional only. No question references or assets are selected. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { err, ok, idSchema, questionAdminCatalogItemSchema, questionAdminCatalogPageSchema, questionVersionHistoryPageSchema, questionReviewHistoryPageSchema, questionReviewHistoryItemSchema, type QuestionAdminCatalogQuery, type QuestionHistoryQuery } from '@remoa/contracts';
type Row=Record<string,unknown>;
export type CatalogActor={id:string;role:'admin'|'reviewer'};
export type CatalogCursorScope={actor:CatalogActor;route:string;query:Record<string,unknown>};
const secret=()=>{const key=process.env.SHARE_SECRET;if(!key)throw Error('missing SHARE_SECRET for catalog discovery');return key;};
const binding=(scope:CatalogCursorScope)=>{const {cursor: _cursor,...filters}=scope.query;void _cursor;return createHash('sha256').update(JSON.stringify({user:scope.actor.id,role:scope.actor.role,route:scope.route,order:'timestamp_desc_uuid_desc',filters:Object.fromEntries(Object.entries(filters).sort(([a],[b])=>a.localeCompare(b)))})).digest('hex');};
export function encodeCatalogCursor(at:string,id:string,scope:CatalogCursorScope){const data=Buffer.from(JSON.stringify({at,id,binding:binding(scope)})).toString('base64url');return data+'.'+createHmac('sha256',secret()).update('f33-staff-discovery-v1:'+data).digest('base64url');}
export function decodeCatalogCursor(value:string,scope:CatalogCursorScope):{at:string;id:string}|null{
 const key=secret();try{if(value.length>2048)return null;const [data,mac,extra]=value.split('.');if(!data||!mac||extra||!/^[-\w]+$/.test(data)||!/^[-\w]+$/.test(mac))return null;
 const bytes=Buffer.from(mac,'base64url'),expected=createHmac('sha256',key).update('f33-staff-discovery-v1:'+data).digest();if(bytes.toString('base64url')!==mac||Buffer.from(data,'base64url').toString('base64url')!==data||bytes.length!==expected.length||!timingSafeEqual(bytes,expected))return null;
 const payload=JSON.parse(Buffer.from(data,'base64url').toString()) as Row;
 if(Object.keys(payload).sort().join(',')!=='at,binding,id'||payload.binding!==binding(scope)||typeof payload.at!=='string'||!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/.test(payload.at)||Number.isNaN(Date.parse(payload.at))||!idSchema.safeParse(payload.id).success)return null;
 return {at:payload.at,id:String(payload.id)};
 }catch{return null;}
}
/** Preserve duplicate URL values so strict schemas reject rather than silently choose a value. */
export function catalogQueryValues(url:string):Record<string,unknown>{const out:Record<string,unknown>={};for(const [key,value] of new URL(url).searchParams){if(Object.hasOwn(out,key)){const previous=out[key];out[key]=Array.isArray(previous)?[...previous,value]:[previous,value];}else out[key]=value;}return out;}
/** Lock current active role in the reading/auditing transaction, including admin recheck. */
export async function catalogStaff(tx:Tx,id:string,role?:CatalogActor['role']):Promise<CatalogActor|null>{
 const [p]=await tx.execute<Row>(sql`SELECT role FROM profiles WHERE user_id=${id}::uuid AND deleted_at IS NULL AND suspended_at IS NULL FOR SHARE`);
 if(!p||(p.role!=='admin'&&p.role!=='reviewer')||(role&&p.role!==role))return null;return {id,role:p.role};
}
const institution=sql`q.visibility='public' AND q.user_id IS NULL`;
const columns=sql`q.id,coalesce(q.canonical_id,q.id) "canonicalId",q.supersedes_id "supersedesId",q.version,q.type,q.origin,left(q.stem,300) "stemPreview",q.catalog_status "catalogStatus",q.rights_status "rightsStatus",q.availability,q.source_id "sourceId",left(s.name,300) "sourceLabel",q.content_hash "contentHash",q.reviewed_hash "reviewedHash",q.created_at "createdAt",q.updated_at "updatedAt",q.published_at "publishedAt",to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "cursorAt"`;
const item=(row:Row)=>{const fields=Object.fromEntries(['id','canonicalId','supersedesId','version','type','origin','stemPreview','catalogStatus','rightsStatus','availability','sourceId','sourceLabel','contentHash','reviewedHash','createdAt','updatedAt','publishedAt'].map(k=>[k,row[k]]));for(const key of ['stemPreview','sourceLabel'])if(typeof fields[key]==='string')fields[key]=(fields[key] as string).slice(0,300);return questionAdminCatalogItemSchema.parse(fields);};
const escapedLike=(s:string)=>'%'+s.replace(/[\\%_]/g,'\\$&')+'%';
export function catalogPageSQL(query:QuestionAdminCatalogQuery,cur:{at:string;id:string}|null){
 const clauses:SQL[]=[institution];
 if(query.status)clauses.push(sql`q.catalog_status=${query.status}`);if(query.sourceId)clauses.push(sql`q.source_id=${query.sourceId}::uuid`);if(query.type)clauses.push(sql`q.type=${query.type}`);
 if(query.search)clauses.push(sql`(q.stem ILIKE ${escapedLike(query.search)} ESCAPE ${'\\'} OR s.name ILIKE ${escapedLike(query.search)} ESCAPE ${'\\'})`);
 if(query.versions==='latest')clauses.push(sql`NOT EXISTS(SELECT 1 FROM question_bank n WHERE n.visibility='public' AND n.user_id IS NULL AND coalesce(n.canonical_id,n.id)=coalesce(q.canonical_id,q.id) AND (n.version,n.created_at,n.id)>(q.version,q.created_at,q.id))`);
 if(cur)clauses.push(sql`(q.created_at,q.id)<(${cur.at}::timestamptz,${cur.id}::uuid)`);
 return sql`SELECT ${columns} FROM question_bank q LEFT JOIN question_sources s ON s.id=q.source_id WHERE ${sql.join(clauses,sql` AND `)} ORDER BY q.created_at DESC,q.id DESC LIMIT ${query.limit+1}`;
}
function position(query:Record<string,unknown>,scope:CatalogCursorScope){return typeof query.cursor==='string'?decodeCatalogCursor(query.cursor,scope):null;}
export async function catalogPage(tx:Tx,actor:CatalogActor,query:QuestionAdminCatalogQuery,route:string){
 const scope={actor,route,query},cur=position(query,scope);if(query.cursor&&!cur)return err('validation','invalid_cursor');
 const rows=await tx.execute<Row>(catalogPageSQL(query,cur));const selected=rows.slice(0,query.limit),last=selected.at(-1);
 return ok(questionAdminCatalogPageSchema.parse({items:selected.map(item),nextCursor:rows.length>query.limit&&last?encodeCatalogCursor(String(last.cursorAt),String(last.id),scope):null}));
}
async function rootOf(tx:Tx,id:string){const [row]=await tx.execute<Row>(sql`SELECT q.id,coalesce(q.canonical_id,q.id) "canonicalId" FROM question_bank q WHERE q.id=${id}::uuid AND ${institution}`);return row;}
export async function versionHistory(tx:Tx,actor:CatalogActor,id:string,query:QuestionHistoryQuery,route:string){
 const scope={actor,route,query},cur=position(query,scope);if(query.cursor&&!cur)return err('validation','invalid_cursor');const root=await rootOf(tx,id);if(!root)return err('not_found','question not found');
 const rows=await tx.execute<Row>(sql`SELECT ${columns} FROM question_bank q LEFT JOIN question_sources s ON s.id=q.source_id WHERE ${institution} AND coalesce(q.canonical_id,q.id)=${root.canonicalId}::uuid ${cur?sql`AND (q.created_at,q.id)<(${cur.at}::timestamptz,${cur.id}::uuid)`:sql``} ORDER BY q.created_at DESC,q.id DESC LIMIT ${query.limit+1}`);
 const selected=rows.slice(0,query.limit),last=selected.at(-1);return ok(questionVersionHistoryPageSchema.parse({questionId:id,canonicalId:root.canonicalId,items:selected.map(item),nextCursor:rows.length>query.limit&&last?encodeCatalogCursor(String(last.cursorAt),String(last.id),scope):null}));
}
export async function reviewHistory(tx:Tx,actor:CatalogActor,id:string,query:QuestionHistoryQuery,route:string){
 const scope={actor,route,query},cur=position(query,scope);if(query.cursor&&!cur)return err('validation','invalid_cursor');if(!await rootOf(tx,id))return err('not_found','question not found');
 const rows=await tx.execute<Row>(sql`SELECT r.id,r.question_id "questionId",r.decision,r.content_hash "contentHash",r.reason,r.reviewer_name "reviewerName",r.reviewer_crm "reviewerCrm",r.reference_date "referenceDate",r.reviewed_at "reviewedAt",to_char(r.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "cursorAt" FROM question_editorial_reviews r JOIN question_bank q ON q.id=r.question_id WHERE r.question_id=${id}::uuid AND ${institution} ${cur?sql`AND (r.reviewed_at,r.id)<(${cur.at}::timestamptz,${cur.id}::uuid)`:sql``} ORDER BY r.reviewed_at DESC,r.id DESC LIMIT ${query.limit+1}`);
 const selected=rows.slice(0,query.limit),last=selected.at(-1);return ok(questionReviewHistoryPageSchema.parse({questionId:id,items:selected.map(r=>questionReviewHistoryItemSchema.parse(Object.fromEntries(['id','questionId','decision','contentHash','reason','reviewerName','reviewerCrm','referenceDate','reviewedAt'].map(k=>[k,r[k]])))),nextCursor:rows.length>query.limit&&last?encodeCatalogCursor(String(last.cursorAt),String(last.id),scope):null}));
}
