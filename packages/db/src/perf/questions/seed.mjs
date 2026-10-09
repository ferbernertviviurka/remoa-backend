/** Synthetic neutral placeholders only. No real examination/medical content or user data. */
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {targetUrl,save} from './target.mjs';
const db=postgres(targetUrl(),{max:1,onnotice:()=>{}}),t0=performance.now();
const owner=randomUUID(),reviewer=randomUUID(),source=randomUUID(),area=randomUUID(),topic=randomUUID(),paper=randomUUID();
const users=Array.from({length:20},()=>({id:randomUUID(),authSessionId:randomUUID(),activeSessionId:randomUUID()}));
const alternatives=JSON.stringify(['A','B','C','D','E'].map(key=>({key,text:'Synthetic '+key+' '+('neutral option placeholder '.repeat(5))})));
const hash='f'.repeat(64);
try{
 const [existing]=await db`SELECT count(*)::int n FROM question_bank`;if(existing.n)throw Error('perf seed refuses any populated target');
 await db.begin(async tx=>{
  for(const id of[owner,reviewer,...users.map(u=>u.id)])await tx`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@synthetic-fr32.invalid'})`;
  for(const u of users)await tx`INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES(${u.authSessionId},${u.id},now(),now())`;
  await tx`UPDATE profiles SET role='reviewer',name='Synthetic FR32 reviewer',crm='12345-SP' WHERE user_id=${reviewer}`;
  await tx`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence) VALUES(${source},'FR32 synthetic source','Synthetic benchmark','https://example.invalid/fr32','authorized','Synthetic fixture only: never publish or count as real content')`;
  await tx`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','FR32 synthetic area')`;
  await tx`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','FR32 synthetic topic',${area})`;
  await tx`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,visibility,source_id,status,rights_status,integrity_confirmed,key_final,enamed_confirmed,enamed_area_id,enamed_topic_id,content_hash,reviewed_hash,reviewer_name,reviewer_crm,reference_date,created_at)
   SELECT md5('f33-perf-q-'||g)::uuid,NULL,'objective',CASE WHEN g%3=0 THEN 'easy' WHEN g%3=1 THEN 'medium' ELSE 'hard' END,
   'Synthetic FR32 question '||lpad(g::text,5,'0')||CASE WHEN g%97=0 THEN ' distinctive' ELSE '' END||' '||repeat('Neutral synthetic benchmark placeholder. ',20),${alternatives}::text::jsonb,'A','Synthetic A','student','Synthetic explanation','official_exam','public',${source},'approved','authorized',true,true,true,${area},${topic},${hash},${hash},'Synthetic FR32 reviewer','12345-SP','2026-10-08',now()-(g||' seconds')::interval FROM generate_series(1,50000)g`;
  await tx`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) SELECT id,${reviewer},'Synthetic FR32 reviewer','12345-SP',${hash},'approved','Synthetic benchmark fixture','2026-10-08' FROM question_bank`;
  await tx`UPDATE question_bank SET catalog_status='published'`;
  // 5000 unpublished successor versions must neither inflate the canonical count nor hide the published original.
  await tx`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,visibility,source_id,version,canonical_id,supersedes_id,status,enamed_area_id,enamed_topic_id)
   SELECT md5('f33-perf-version-'||g)::uuid,NULL,'objective','medium','Synthetic pending successor '||g,${alternatives}::text::jsonb,'A','Synthetic A','student','Synthetic explanation','official_exam','public',${source},2,md5('f33-perf-q-'||g)::uuid,md5('f33-perf-q-'||g)::uuid,'draft',${area},${topic} FROM generate_series(1,5000)g`;
  await tx`INSERT INTO exam_papers(id,source_id,name,institution,year,edition,booklet,status,key_final) VALUES(${paper},${source},'FR32 synthetic paper','FR32 synthetic institution',2026,'Synthetic','A','published',true)`;
  await tx`INSERT INTO exam_question_occurrences(paper_id,question_id,ordinal,original_number) SELECT ${paper},md5('f33-perf-q-'||g)::uuid,g,g::text FROM generate_series(1,200)g`;
  for(const [index,u]of users.entries()){
   await tx`INSERT INTO question_sessions(id,user_id,mode,config,status,idempotency_key,started_at,finished_at,created_at)
    SELECT md5(${u.id}||'-session-'||g)::uuid,${u.id},'simulation','{}'::jsonb,'finished','synthetic-history-'||g,now()-(g||' days')::interval,now()-(g||' days')::interval,now()-(g||' days')::interval FROM generate_series(1,50)g`;
   await tx`INSERT INTO question_session_items(id,user_id,session_id,question_id,position,payload_public,reference_snapshot,selected_key,answered,revision)
    SELECT md5(${u.id}||'-item-'||s||'-'||p)::uuid,${u.id},md5(${u.id}||'-session-'||s)::uuid,q.id,p-1,
    jsonb_build_object('id',q.id,'canonicalId',q.canonical_id,'version',1,'type',q.type,'stem',q.stem,'alternatives',q.alternatives,'origin',q.origin,'visibility',q.visibility,'availability',q.availability,'difficulty',q.difficulty,'topicId',q.enamed_topic_id,'areaId',q.enamed_area_id,'sourceId',q.source_id,'sourceLabel','FR32 synthetic source','reviewed',true,'assets','[]'::jsonb,'cardIds','[]'::jsonb,'boardId',NULL,'createdAt',q.created_at),
    jsonb_build_object('questionId',q.id,'version',1,'correctKey','A','explanation','Synthetic explanation','distractorNotes',NULL,'annulled',false,'reviewed',true,'reviewerName','Synthetic FR32 reviewer','reviewerCrm','12345-SP','referenceDate','2026-10-08','sourceUrl','https://example.invalid/fr32','obsolete',false),CASE WHEN p%2=0 THEN 'A' ELSE 'B' END,true,1
    FROM generate_series(1,50)s CROSS JOIN generate_series(1,100)p JOIN question_bank q ON q.id=md5('f33-perf-q-'||(((${index}*2500+(s-1)*100+p-1)%50000)+1))::uuid`;
   await tx`INSERT INTO question_answers(user_id,session_id,item_id,mutation_id,selected_key,correct,elapsed_ms,revision,submitted_at) SELECT user_id,session_id,id,gen_random_uuid(),selected_key,selected_key='A',1000,1,now()-(position||' seconds')::interval FROM question_session_items WHERE user_id=${u.id}`;
   await tx`INSERT INTO question_sessions(id,user_id,mode,config,status,idempotency_key) VALUES(${u.activeSessionId},${u.id},'simulation','{}'::jsonb,'active','synthetic-active')`;
   await tx`INSERT INTO question_session_items(user_id,session_id,question_id,position,payload_public,reference_snapshot)
    SELECT ${u.id},${u.activeSessionId},q.id,p-1,
    jsonb_build_object('id',q.id,'canonicalId',q.canonical_id,'version',1,'type',q.type,'stem',q.stem,'alternatives',q.alternatives,'origin',q.origin,'visibility',q.visibility,'availability',q.availability,'difficulty',q.difficulty,'topicId',q.enamed_topic_id,'areaId',q.enamed_area_id,'sourceId',q.source_id,'sourceLabel','FR32 synthetic source','reviewed',true,'assets','[]'::jsonb,'cardIds','[]'::jsonb,'boardId',NULL,'createdAt',q.created_at),
    jsonb_build_object('questionId',q.id,'version',1,'correctKey','A','explanation','Synthetic explanation','distractorNotes',NULL,'annulled',false,'reviewed',true,'reviewerName','Synthetic FR32 reviewer','reviewerCrm','12345-SP','referenceDate','2026-10-08','sourceUrl','https://example.invalid/fr32','obsolete',false)
    FROM generate_series(1,200)p JOIN question_bank q ON q.id=md5('f33-perf-q-'||p)::uuid`;
  }
 });
 await db`ANALYZE`;
 const [counts]=await db`SELECT (SELECT count(*)::int FROM question_bank WHERE catalog_status='published') canonical,(SELECT count(*)::int FROM question_bank WHERE version=2) versions,(SELECT count(*)::int FROM question_answers) attempts,(SELECT pg_size_pretty(pg_database_size(current_database()))) db_size`;
 if(counts.canonical!==50000||counts.versions!==5000||counts.attempts!==100000)throw Error('synthetic seed counts mismatch');
 for(const u of users){const [item]=await db`SELECT id FROM question_session_items WHERE session_id=${u.activeSessionId} ORDER BY position LIMIT 1`;u.itemId=item.id;}
 save('seed-state.json',{synthetic:true,createdAt:new Date().toISOString(),users,source,area,topic,paper,counts,seedMs:Math.round(performance.now()-t0)});
 process.stdout.write(JSON.stringify({synthetic:true,...counts,seedMs:Math.round(performance.now()-t0)})+'\n');
}finally{await db.end();}
