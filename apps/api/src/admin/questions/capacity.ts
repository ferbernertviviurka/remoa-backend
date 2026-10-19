import {effectiveArea,effectiveTopic,effectiveKind,classificationNodes} from '../../questions/classification/semantics';
/** Public capacity and taxonomy coverage share visibility/canonical guards. Source tags never become editorial bindings. */
import {sql} from 'drizzle-orm';
import type {QuestionAcervoCoverage} from '@remoa/contracts';
import {latest,readable} from '../../questions/catalog/service';
export type CatalogCapacity={
 public_canonical:number;origins:{origin:string;count:number}[];
 areas:{areaId:string;name:string;count:number}[];topics:{topicId:string;name:string;count:number}[];
 acervo_coverage:QuestionAcervoCoverage;
};
export const catalogCapacitySQL=()=>sql`WITH eligible AS MATERIALIZED
 (SELECT q.id,coalesce(q.canonical_id,q.id) canonical,q.origin,q.type,coalesce(q.profession_code,'medicine') course,${effectiveArea} area_id,${effectiveTopic} topic_id,${effectiveKind} classification_kind
 FROM question_bank q WHERE q.visibility='public' AND q.availability='active' AND ${readable('00000000-0000-0000-0000-000000000000')} AND ${latest}),
 scoring AS MATERIALIZED(SELECT * FROM eligible WHERE type='objective'),
 source_tags AS MATERIALIZED(SELECT s.canonical,a.code FROM scoring s JOIN question_team_items i ON i.question_id=s.id
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.original_payload->'areas')='array' THEN i.original_payload->'areas' ELSE '[]'::jsonb END) a(code))
 SELECT (SELECT count(DISTINCT canonical)::int FROM eligible) public_canonical,
 (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT origin,count(DISTINCT canonical)::int count FROM eligible GROUP BY origin ORDER BY origin) row) origins,
 (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT e.area_id "areaId",t.label name,count(DISTINCT e.canonical)::int count FROM eligible e JOIN ${classificationNodes} t ON t.id=e.area_id GROUP BY e.area_id,t.label ORDER BY t.label,e.area_id LIMIT 501) row) areas,
 (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT e.topic_id "topicId",t.label name,count(DISTINCT e.canonical)::int count FROM eligible e JOIN ${classificationNodes} t ON t.id=e.topic_id GROUP BY e.topic_id,t.label ORDER BY t.label,e.topic_id LIMIT 501) row) topics,
 jsonb_build_object('automaticClassifiedTotal',(SELECT count(DISTINCT canonical)::int FROM scoring WHERE classification_kind='automatic_unreviewed'),'eligibleTotal',(SELECT count(DISTINCT canonical)::int FROM scoring),
 'byCourse',(SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM(SELECT course,count(DISTINCT canonical)::int count FROM scoring GROUP BY course ORDER BY course) row),
 'unclassifiedArea',(SELECT count(DISTINCT canonical)::int FROM scoring WHERE area_id IS NULL),
 'unclassifiedTopic',(SELECT count(DISTINCT canonical)::int FROM scoring WHERE topic_id IS NULL),
 'sourceAreaTags',(SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM(SELECT code,count(DISTINCT canonical)::int count FROM source_tags GROUP BY code ORDER BY code) row),
 'sourceAreaTagsUnreviewed',true) acervo_coverage`;
