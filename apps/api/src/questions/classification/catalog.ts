/** Public choices and counts are derived from the exact same effective bindings used by selection. */
import {sql} from 'drizzle-orm';
import {questionClassificationCatalogSchema,type HealthCourseCode,questionListQuerySchema} from '@remoa/contracts';
import {run,asServer} from '../../db';
import {catalogWhere} from '../catalog/service';
import {classificationNodes,effectiveArea,effectiveTopic,effectiveKind} from './semantics';
export const classificationCatalogSQL=(user:string,course:HealthCourseCode)=>sql`WITH base AS MATERIALIZED(
 SELECT coalesce(q.canonical_id,q.id) canonical,${effectiveArea} area,${effectiveTopic} topic,${effectiveKind} classification_kind
 FROM question_bank q WHERE q.visibility='public' AND ${catalogWhere(user,questionListQuerySchema.parse({course}),true)}),
 areas AS(SELECT n.id,n.label name,b.classification_kind,count(DISTINCT b.canonical)::int count FROM base b JOIN ${classificationNodes} n ON n.id=b.area WHERE n.course_code=${course} GROUP BY n.id,n.label,b.classification_kind),
 topics AS(SELECT b.area,n.id,n.label name,count(DISTINCT b.canonical)::int count FROM base b JOIN ${classificationNodes} n ON n.id=b.topic WHERE n.course_code=${course} GROUP BY b.area,n.id,n.label)
 SELECT jsonb_build_object('course',${course}::text,'total',(SELECT count(DISTINCT canonical)::int FROM base),
 'unclassifiedArea',(SELECT count(DISTINCT canonical)::int FROM base WHERE area IS NULL),
 'unclassifiedTopic',(SELECT count(DISTINCT canonical)::int FROM base WHERE topic IS NULL),
 'areas',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'count',a.count,'classificationKind',a.classification_kind,'topics',coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'count',t.count) ORDER BY t.name,t.id) FROM topics t WHERE t.area=a.id),'[]'::jsonb)) ORDER BY a.name,a.id) FROM areas a),'[]'::jsonb)) catalog`;
export async function classificationCatalog(user:string,course:HealthCourseCode){return run(user,async tx=>{const[row]=await asServer<{catalog:unknown}>(tx,classificationCatalogSQL(user,course));return questionClassificationCatalogSchema.parse(row!.catalog);});}
