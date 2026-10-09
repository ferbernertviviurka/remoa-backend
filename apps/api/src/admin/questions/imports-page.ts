/** CCR139: paginated import metadata, one audited transaction and one batch aggregate. */
import {Hono} from 'hono';
import {sql,type SQL} from 'drizzle-orm';
import type {Tx} from '@remoa/db';
import {err,ok,parseWith,questionImportPageQuerySchema,questionImportProgressSchema,type QuestionImportPageQuery} from '@remoa/contracts';
import {withAdmin,send,type AdminEnv} from '../core';
import {catalogStaff,catalogQueryValues,encodeCatalogCursor,decodeCatalogCursor,type CatalogActor} from '../../questions/editorial/catalog';
import {questionFeatureGate} from '../../questions/runtime/admission';
type Row=Record<string,unknown>;
const like=(s:string)=>'%'+s.replace(/[\\%_]/g,'\\$&')+'%';
export function importsPageSQL(query:QuestionImportPageQuery,position:{at:string;id:string}|null){
 const where:SQL[]=[];
 if(query.status)where.push(sql`i.status=${query.status}`);
 if(query.sourceId)where.push(sql`i.source_id=${query.sourceId}::uuid`);
 if(query.search)where.push(sql`(p.name ILIKE ${like(query.search)} ESCAPE ${'\\'} OR p.institution ILIKE ${like(query.search)} ESCAPE ${'\\'} OR p.booklet ILIKE ${like(query.search)} ESCAPE ${'\\'} OR s.name ILIKE ${like(query.search)} ESCAPE ${'\\'})`);
 if(position)where.push(sql`(i.created_at,i.id)<(${position.at}::timestamptz,${position.id}::uuid)`);
 return sql`WITH selected AS MATERIALIZED (SELECT i.id,i.status,i.total_pages,i.completed_pages,i.cost_cents,i.error_code,i.updated_at,i.revision,i.answer_key_pages,i.created_at
 FROM question_imports i LEFT JOIN exam_papers p ON p.id=i.paper_id LEFT JOIN question_sources s ON s.id=i.source_id
 ${where.length?sql`WHERE ${sql.join(where,sql` AND `)}`:sql``} ORDER BY i.created_at DESC,i.id DESC LIMIT ${query.limit+1}),
 stats AS (SELECT c.import_id,count(*)::int candidates,count(*) FILTER(WHERE c.state='accepted')::int accepted,count(*) FILTER(WHERE c.state='rejected')::int rejected,count(*) FILTER(WHERE c.state='duplicate')::int duplicate
 FROM question_import_candidates c JOIN selected p ON p.id=c.import_id GROUP BY c.import_id)
 SELECT i.id,i.status,i.total_pages "totalPages",i.completed_pages "completedPages",i.cost_cents "costCents",i.error_code "errorCode",i.updated_at "updatedAt",i.revision,i.answer_key_pages "answerKeyPages",
 coalesce(s.candidates,0) candidates,coalesce(s.accepted,0) accepted,coalesce(s.rejected,0) rejected,coalesce(s.duplicate,0) duplicate,
 to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "cursorAt"
 FROM selected i LEFT JOIN stats s ON s.import_id=i.id ORDER BY i.created_at DESC,i.id DESC`;
}
export async function importsPage(tx:Tx,actor:CatalogActor,query:QuestionImportPageQuery,route:string){
 const scope={actor,route,query},position=query.cursor?decodeCatalogCursor(query.cursor,scope):null;
 if(query.cursor&&!position)return err('validation','invalid_cursor');
 const rows=await tx.execute<Row>(importsPageSQL(query,position));const selected=rows.slice(0,query.limit),last=selected.at(-1);
 const keys=['id','status','totalPages','completedPages','costCents','errorCode','updatedAt','revision','answerKeyPages','candidates','accepted','rejected','duplicate'];
 return ok({items:selected.map(row=>questionImportProgressSchema.parse(Object.fromEntries(keys.map(k=>[k,row[k]])))),nextCursor:rows.length>query.limit&&last?encodeCatalogCursor(String(last.cursorAt),String(last.id),scope):null});
}
export const questionImportsPageRoutes=new Hono<AdminEnv>().get('/imports/page',questionFeatureGate('import'),async c=>send(await withAdmin(c,'question.import_view',{reason:'Consultar página administrativa de importações de questões',target:{type:'route',id:c.req.path}},async(tx,audit)=>{
 const actor=await catalogStaff(tx,c.get('admin').id,'admin');if(!actor)return err('not_found','route not found');
 const input=parseWith(questionImportPageQuerySchema,catalogQueryValues(c.req.url));if(!input.ok)return input;
 const result=await importsPage(tx,actor,input.data,c.req.path);if(result.ok)audit.after({count:result.data.items.length,hasMore:result.data.nextCursor!==null,status:input.data.status??null,sourceId:input.data.sourceId??null});return result;
})));
