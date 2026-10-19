import {sql} from 'drizzle-orm';
/** Server-only equivalent of 0059's signed-team visibility guard. Keep every signature/source/batch check.
 * Expose the membership join to the planner: a non-inlined SQL function per candidate rescans the same graph for the full count.
 * OFFSET0 fences the small eligible-source set: authorized-source statistics otherwise choose28k PK probes.
 * This predicate is only executed by asServer; authenticated RLS keeps its private UUID-only boolean helper unchanged.
 */
export const teamReadable=sql`q.visibility='public' AND q.catalog_status='published' AND q.status='approved'
 AND q.origin='official_exam' AND q.user_id IS NULL AND q.validation_kind='remoa_team_attested' AND q.rights_status='pending'
 AND EXISTS(SELECT 1 FROM question_team_items ti JOIN question_team_batches tb ON tb.id=ti.batch_id
 JOIN(SELECT ts.id FROM question_sources ts WHERE
 (ts.rights_status='pending' OR (ts.rights_status='authorized' AND ts.rights_scope='g29-cp21-20261019' AND ts.rights_evidence='Aprovado por Remoa' AND ts.rights_expires_at IS NOT NULL))
 AND (ts.rights_expires_at IS NULL OR ts.rights_expires_at>now()) OFFSET 0) ts ON ts.id=ti.source_id
 WHERE ti.question_id=q.id AND ti.content_hash=q.content_hash AND ti.content_hash=q.reviewed_hash AND ti.source_id=q.source_id AND ti.profession_code=q.profession_code
 AND tb.sealed_at IS NOT NULL AND tb.activated_at IS NOT NULL AND tb.revoked_at IS NULL)`;
