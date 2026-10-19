/** G29: server-derived, audited source excerpts. Original coverage is unknown; never asserts full papers or final keys. */
import { sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { err, ok } from '@remoa/contracts';
import type { AuditCapture } from '../../core';
import { idempotentReplay } from '../operations';
import { teamReadable } from '../../../questions/catalog/service';
import { NAMESPACE,MEMBERSHIP_HASH,hash,fixedId,files,objectKey,record } from './domain';
type Row=Record<string,unknown>;
export async function indexTeamPapers(tx:Tx,actor:string,input:{idempotencyKey:string;reason:string},audit:AuditCapture){
 await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${NAMESPACE+':papers'},29))`);
 const [batch]=await tx.execute<Row>(sql`SELECT * FROM question_team_batches WHERE id=${fixedId('batch')} FOR UPDATE`);
 if(!batch?.activated_at||batch.revoked_at||batch.actor_id!==actor)return err('conflict','team_batch_not_active');
 const members=await tx.execute<Row>(sql`SELECT i.offline_id,i.payload_hash,i.question_id,i.source_id,i.profession_code,i.original_payload->>'numero' number,i.original_payload->>'exame' exam,i.original_payload->>'ano' "year",i.original_payload->>'edicao' edition,coalesce(nullif(i.original_payload#>>'{fonte,tipo_caderno}',''),i.original_payload#>>'{fonte,caderno}','') booklet,i.original_payload->'fonte' source,q.availability,s.name source_name FROM question_team_items i JOIN question_bank q ON q.id=i.question_id JOIN question_sources s ON s.id=i.source_id WHERE i.batch_id=${batch.id} AND s.rights_status='authorized' AND s.rights_scope=${NAMESPACE} AND s.rights_evidence='Aprovado por Remoa' AND s.rights_expires_at>now() AND ${teamReadable} ORDER BY i.offline_id COLLATE "C"`);
 if(members.length!==28188||hash(members.map(r=>`${String(r.offline_id)}\t${String(r.payload_hash)}\n`).join(''))!==MEMBERSHIP_HASH)return err('conflict','team_membership_incomplete');
 const groups=new Map<string,Row[]>();for(const r of members){const key=String(r.source_id);groups.set(key,[...(groups.get(key)??[]),r]);}
 if(groups.size!==841)return err('conflict','team_source_count_changed');
 const papers=[],documents=[],occurrences=[];
 for(const[sourceId,rows]of groups){
  rows.sort((a,b)=>Number(a.number)-Number(b.number));const first=rows[0]!,source=record(first.source),path=String(source.prova_arquivo??''),pin=path?files.get(path):undefined;
  if(path&&(!pin||!path.endsWith('.pdf')))return err('conflict','team_paper_document_not_pinned');
  if(new Set(rows.map(r=>r.number)).size!==rows.length||rows.some(r=>!/^\d{1,3}$/.test(String(r.number))||Number(r.number)<1||r.profession_code!==first.profession_code||r.exam!==first.exam||r.year!==first.year||r.edition!==first.edition||r.booklet!==first.booklet||String(record(r.source).prova_arquivo??'')!==path))return err('conflict','team_paper_metadata_changed');
  const paperId=fixedId('paper:'+sourceId),documentId=pin?fixedId('document:'+sourceId+':'+pin.sha256):null;
  const year=Number(first.year);if(!Number.isInteger(year)||year<1900||year>2200)return err('conflict','team_paper_year_invalid');
  papers.push({id:paperId,sourceId,documentId,name:[String(first.exam||first.source_name),String(source.cargo||source.trilha||'')].filter(Boolean).join(' — ').slice(0,300),institution:String(source.orgao||first.source_name).slice(0,300),year,edition:String(first.edition??'').slice(0,200),booklet:String(first.booklet??'').slice(0,100)});
  if(pin)documents.push({id:documentId,sourceId,key:objectKey(pin.sha256),sha256:pin.sha256,bytes:pin.bytes});
  for(const[rIndex,row]of rows.entries())occurrences.push({id:fixedId('occurrence:'+String(row.question_id)),paperId,questionId:row.question_id,number:String(row.number),ordinal:rIndex+1,annulled:row.availability==='annulled'});
 }
 if(documents.length!==822)return err('conflict','team_paper_document_count_changed');
 const requestHash=hash(JSON.stringify({namespace:NAMESPACE,membership:MEMBERSHIP_HASH,papers,documents,occurrences}));
 const replay=await idempotentReplay(tx,'question.import',actor,input.idempotencyKey,requestHash);if(!replay.ok)return replay;
 const json=JSON.stringify({papers,documents,occurrences});
 const existingPapers=await tx.execute<Row>(sql`SELECT p.id FROM exam_papers p WHERE p.id IN(SELECT (x->>'id')::uuid FROM jsonb_array_elements(${JSON.stringify(papers)}::jsonb)x)`);
 if(existingPapers.length!==0&&existingPapers.length!==841)return err('conflict','team_paper_partial_state');
 audit.before({namespace:NAMESPACE,papers:existingPapers.map(r=>r.id)});
 // Replays verify every row without reentering expensive publish triggers.
 if(!replay.data&&existingPapers.length===0){
 // Conflicts are verified below, so retries can never replace edited or withdrawn records.
 await tx.execute(sql`INSERT INTO question_documents(id,user_id,source_id,kind,object_key,sha256,bytes,mime) SELECT (x->>'id')::uuid,${actor}::uuid,(x->>'sourceId')::uuid,'exam',x->>'key',x->>'sha256',(x->>'bytes')::int,'application/pdf' FROM jsonb_array_elements(${json}::jsonb->'documents')x ON CONFLICT(id) DO NOTHING`);
 await tx.execute(sql`INSERT INTO exam_papers(id,source_id,document_id,name,institution,year,edition,booklet,status,key_final,coverage_kind,expected_question_count) SELECT (x->>'id')::uuid,(x->>'sourceId')::uuid,(x->>'documentId')::uuid,x->>'name',x->>'institution',(x->>'year')::int,x->>'edition',x->>'booklet','draft',false,'source_excerpt',NULL FROM jsonb_array_elements(${json}::jsonb->'papers')x ON CONFLICT(id) DO NOTHING`);
 await tx.execute(sql`INSERT INTO exam_question_occurrences(id,paper_id,question_id,ordinal,original_number,annulled,original_keys) SELECT (x->>'id')::uuid,(x->>'paperId')::uuid,(x->>'questionId')::uuid,(x->>'ordinal')::int,x->>'number',(x->>'annulled')::boolean,NULL FROM jsonb_array_elements(${json}::jsonb->'occurrences')x ON CONFLICT(id) DO NOTHING`);
 await tx.execute(sql`UPDATE exam_papers SET status='published' WHERE coverage_kind='source_excerpt' AND status='draft' AND id IN(SELECT (x->>'id')::uuid FROM jsonb_array_elements(${JSON.stringify(papers)}::jsonb)x)`);
 }
 // Bulk load changes row counts from0 to28k; refresh only these three touched relations once.
 if(!replay.data&&existingPapers.length===0)await tx.execute(sql`ANALYZE exam_papers,exam_question_occurrences,question_documents`);
 const [check]=await tx.execute<{papers:number;documents:number;occurrences:number}>(sql`SELECT (SELECT count(*)::int FROM jsonb_array_elements(${json}::jsonb->'papers')x JOIN exam_papers p ON p.id=(x->>'id')::uuid WHERE p.source_id=(x->>'sourceId')::uuid AND p.document_id IS NOT DISTINCT FROM (x->>'documentId')::uuid AND p.name=x->>'name' AND p.institution=x->>'institution' AND p.year=(x->>'year')::int AND p.edition=x->>'edition' AND p.booklet=x->>'booklet' AND p.status='published' AND p.coverage_kind='source_excerpt' AND p.expected_question_count IS NULL AND NOT p.key_final) papers,(SELECT count(*)::int FROM jsonb_array_elements(${json}::jsonb->'documents')x JOIN question_documents d ON d.id=(x->>'id')::uuid WHERE d.source_id=(x->>'sourceId')::uuid AND d.object_key=x->>'key' AND d.sha256=x->>'sha256' AND d.bytes=(x->>'bytes')::int) documents,(SELECT count(*)::int FROM jsonb_array_elements(${json}::jsonb->'occurrences')x JOIN exam_question_occurrences o ON o.id=(x->>'id')::uuid WHERE o.paper_id=(x->>'paperId')::uuid AND o.question_id=(x->>'questionId')::uuid AND o.ordinal=(x->>'ordinal')::int AND o.original_number=x->>'number' AND o.annulled=(x->>'annulled')::boolean AND o.original_keys IS NULL) occurrences`);
 if(check?.papers!==841||check.documents!==822||check.occurrences!==28188)throw Error('team_paper_readback_failed');
 audit.after({idempotencyKey:input.idempotencyKey,requestHash,namespace:NAMESPACE,coverageKind:'source_excerpt',expectedQuestionCount:null,...check,...(replay.data?{replayOf:replay.data.auditId}:{}),results:papers.map(p=>({id:p.id,outcome:'indexed'}))});
 return ok({replayed:!!replay.data,...check,coverageKind:'source_excerpt' as const});
}
