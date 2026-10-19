/** G29/F34 automatic suggestions are a separate, hash-bound search index. They never confer editorial or medical approval. */
import { z } from 'zod';
import { idSchema } from './common';
import { healthCourseCodeSchema } from './health-course-codes';
import { reasonSchema } from './admin';

export const QUESTION_CLASSIFICATION_NAMESPACE = 'g29-auto-classification-v1' as const;
export const QUESTION_CLASSIFICATION_RUN_ID = '6ca13d43-da39-5ff0-a03f-075ea7eb2501' as const;
export const QUESTION_CLASSIFICATION_QUEUE_HASH = 'fddc09e994200c8809363ccb9fb74fdcc17b7ca11cd7715f05ba9e7e2ad40f3c' as const;
export const QUESTION_CLASSIFICATION_RULE_HASH = '2a547fc806d7c23259a8231e29f58b6011aca4e7ef9494a5cd99b5092f44b778' as const;
export const QUESTION_CLASSIFICATION_BUNDLE_HASH = '6e3b517ea4b2b21fcc70cca5876d0e57c1492f9609946661c771b233d8a4272f' as const;
export const QUESTION_CLASSIFICATION_EXPECTED_COUNT = 1209 as const;
export const QUESTION_CLASSIFICATION_NODE_COUNT = 119 as const;
export const questionClassificationKindSchema = z.enum(['enamed', 'automatic_unreviewed']);
const classificationLabel = z.object({ id: idSchema, label: z.string().min(1).max(300) }).strict();
export const questionEffectiveClassificationSchema = z.object({ kind: questionClassificationKindSchema, course: healthCourseCodeSchema, area: classificationLabel, topic: classificationLabel }).strict();
export type QuestionEffectiveClassification = z.infer<typeof questionEffectiveClassificationSchema>;
export type QuestionClassificationKind = z.infer<typeof questionClassificationKindSchema>;
export const questionClassificationStatusSchema = z.literal('unclassified');
/** Unclassified means either effective area OR effective topic is missing. */
export const questionClassificationQuerySchema = z.object({ course: healthCourseCodeSchema }).strict();
const n = z.number().int().nonnegative();
const topic = z.object({ id: idSchema, name: z.string().min(1).max(300), count: n }).strict();
export const questionClassificationCatalogSchema = z.object({
  course: healthCourseCodeSchema, total: n, unclassifiedArea: n, unclassifiedTopic: n,
  areas: z.array(z.object({ id: idSchema, name: z.string().min(1).max(300), count: n, classificationKind: questionClassificationKindSchema, topics: z.array(topic).max(500) }).strict()).max(100),
}).strict().superRefine((value, ctx) => {
  const topicIds = value.areas.flatMap(area => area.topics.map(row => row.id));
  if (new Set(value.areas.map(row => row.id)).size !== value.areas.length || new Set(topicIds).size !== topicIds.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate_classification_node' });
  if (value.unclassifiedArea > value.total || value.unclassifiedTopic > value.total || value.areas.some(area => area.count > value.total || area.topics.some(row => row.count > area.count)))
    ctx.addIssue({ code: 'custom', message: 'classification_count_exceeds_capacity' });
});
export type QuestionClassificationCatalog = z.infer<typeof questionClassificationCatalogSchema>;
/** Audited administrative operation derives every row from the server-pinned bundle, never client-supplied labels or question data. */
export const questionClassificationIndexInputSchema = z.object({ idempotencyKey: idSchema, reason: reasonSchema }).strict();
