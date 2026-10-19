/** One effective search classification; never writes or relabels the signed question's ENAMED columns. */
import {teamReadable} from '../catalog/access';
import {sql,type SQL} from 'drizzle-orm';
import type {ExamBuilderFilter} from '@remoa/contracts';
import bundle from '../../../../../packages/db/seed/question-classification/g29-v1.json';
import {Abort,pgArray} from '../../db';
const automaticIds=new Set(bundle.nodes.map(n=>n.id));
type Selection={areaIds?:readonly string[];topicIds?:readonly string[];classificationStatus?:'unclassified'};
export const hasAutomaticIds=(selection:Selection)=>[...(selection.areaIds??[]),...(selection.topicIds??[])].some(id=>automaticIds.has(id));
export const needsClassificationHold=(selection:Selection)=>hasAutomaticIds(selection)||selection.classificationStatus==='unclassified';
export function assertClassificationSource(selection:Selection&{source?:string}){if(selection.source&&selection.source!=='catalog'&&hasAutomaticIds(selection))throw new Abort({code:'validation',message:'automatic_classification_catalog_only'});}
export const automaticBindingWhere=sql`q.visibility='public' AND q.validation_kind='remoa_team_attested' AND q.enamed_area_id IS NULL AND q.enamed_topic_id IS NULL
 AND cb.question_id=q.id AND cb.content_hash=q.content_hash AND cb.content_hash=q.reviewed_hash AND cb.course_code=q.profession_code
 AND ${teamReadable} AND cr.status='active' AND cr.activated_at IS NOT NULL AND cr.withdrawn_at IS NULL`;
/** Independent scalar aggregate is an InitPlan:1209bindings once per expression, never a PK probe per28k candidate. */
const automaticMap=sql`(SELECT coalesce(jsonb_object_agg(cb.question_id::text,jsonb_build_object('areaId',cb.area_id,'topicId',cb.topic_id)),'{}'::jsonb)
 FROM question_classification_bindings cb JOIN question_classification_runs cr ON cr.id=cb.run_id JOIN question_bank q ON q.id=cb.question_id WHERE ${automaticBindingWhere})`;
const automaticEntry=sql`(${automaticMap}->q.id::text)`;
export const effectiveArea=sql`coalesce(q.enamed_area_id,(${automaticEntry}->>'areaId')::uuid)`;
export const effectiveTopic=sql`coalesce(q.enamed_topic_id,(${automaticEntry}->>'topicId')::uuid)`;
export const effectiveKind=sql`CASE WHEN q.enamed_area_id IS NOT NULL OR q.enamed_topic_id IS NOT NULL THEN 'enamed' WHEN ${automaticEntry} IS NOT NULL THEN 'automatic_unreviewed' END`;
export const effectiveColumns=sql`${effectiveArea} enamed_area_id,${effectiveTopic} enamed_topic_id,${effectiveKind} classification_kind`;
/** Namespaced nodes stay separate from canonical ENAMED; only the currently active run exposes automatic nodes. */
export const classificationNodes=sql`(SELECT t.id,t.parent_id,t.name label,t.kind,'medicine'::text course_code,'enamed'::text classification_kind,t.matrix_ref FROM enamed_taxonomy t
 UNION ALL SELECT n.id,n.parent_id,n.label,n.kind,n.course_code,'automatic_unreviewed'::text,NULL::uuid FROM question_classification_nodes n JOIN question_classification_runs r ON r.id=n.run_id WHERE r.status='active' AND r.activated_at IS NOT NULL AND r.withdrawn_at IS NULL)`;
export function classificationFilters(selection:Selection,{descendants=false,matrixItemIds=[]}:{descendants?:boolean;matrixItemIds?:readonly string[]}={}):SQL[]{
 const parts:SQL[]=[];
 if(selection.areaIds?.length)parts.push(sql`${effectiveArea}=ANY(${pgArray(selection.areaIds,'uuid')})`);
 if(selection.topicIds?.length||matrixItemIds.length){
  if(descendants)parts.push(sql`${effectiveTopic} IN(WITH RECURSIVE nodes AS(SELECT * FROM ${classificationNodes} n), t AS(SELECT id FROM nodes WHERE id=ANY(${pgArray(selection.topicIds??[],'uuid')}) OR matrix_ref=ANY(${pgArray(matrixItemIds,'uuid')}) UNION SELECT c.id FROM nodes c JOIN t ON c.parent_id=t.id) SELECT id FROM t)`);
  else parts.push(sql`${effectiveTopic}=ANY(${pgArray(selection.topicIds??[],'uuid')})`);
 }
 if(selection.classificationStatus==='unclassified')parts.push(sql`(${effectiveArea} IS NULL OR ${effectiveTopic} IS NULL)`);
 return parts;
}
/** Automatic public selections are held to their live hash-bound filters, including pins. Legacy/private AI pins keep D1882. */
export function classificationHold(selection:Pick<ExamBuilderFilter,'areaIds'|'topicIds'|'classificationStatus'>):SQL{
 return needsClassificationHold(selection)?sql`(q.visibility<>'public' OR (${sql.join(classificationFilters(selection,{descendants:true}),sql` AND `)}))`:sql`true`;
}

export const classificationProjection=sql`(SELECT jsonb_build_object('kind',${effectiveKind},'course',coalesce(q.profession_code,'medicine'),'area',jsonb_build_object('id',ca.id,'label',ca.label),'topic',jsonb_build_object('id',ct.id,'label',ct.label)) FROM ${classificationNodes} ca JOIN ${classificationNodes} ct ON ct.id=${effectiveTopic} WHERE ca.id=${effectiveArea})`;
