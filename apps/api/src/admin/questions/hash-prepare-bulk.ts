/** G28: fast path only for isolated Remoa institutional rows. Caller owns auth,
 * transaction, idempotency and the ONE audit. Never switch to graph locking
 * after taking question locks: a concurrent association instead yields conflict.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import type { QuestionHashPrepareInput, questionHashPrepareOutcomes } from '@remoa/contracts';
import { uuids } from '../../db';
import { contentHash } from '../../questions/imports/domain';

type Row = Record<string, unknown>;
export type HashPrepareResult = {
  id: string; outcome: (typeof questionHashPrepareOutcomes)[number];
  version: number | null; contentHash: string | null; sourceId: string | null;
};
type GraphRow = Row & {
  id: string; canonicalId: string | null; supersedesId: string | null;
  userId: string | null; visibility: string; origin: string;
  hasChildren: boolean; hasCandidates: boolean; hasOccurrences: boolean;
};
const isolated = (q: GraphRow) => q.userId === null && q.visibility === 'public'
  && q.origin === 'remoa_authored' && q.supersedesId === null
  && (q.canonicalId === null || q.canonicalId === q.id)
  && q.hasChildren === false && q.hasCandidates === false && q.hasOccurrences === false;

// Read-only discovery, repeated AFTER the ordered FOR UPDATE phase. FK checks on
// new aliases/children/candidates/occurrences need KEY SHARE on the parent row;
// that conflicts with FOR UPDATE and cannot finish while these locks are held.
const graph = (ids: readonly string[]) => sql`SELECT q.id, q.canonical_id "canonicalId", q.supersedes_id "supersedesId",
  q.user_id "userId", q.visibility, q.origin,
  EXISTS(SELECT 1 FROM question_bank child WHERE child.id <> q.id AND (child.supersedes_id = q.id OR child.canonical_id = q.id)) "hasChildren",
  EXISTS(SELECT 1 FROM question_import_candidates c WHERE c.question_id = q.id OR c.duplicate_of = q.id) "hasCandidates",
  EXISTS(SELECT 1 FROM exam_question_occurrences o WHERE o.question_id = q.id) "hasOccurrences"
  FROM question_bank q WHERE q.id = ANY(${uuids(ids)}) ORDER BY q.id`;

/** null means run the original path, BEFORE acquiring any question/graph lock.
 * An opted-in batch uses at most four statements regardless of its size (<=500).
 * Hash comparison precedes revision/time CAS, exactly as in the original path.
 */
export async function prepareUnlinkedHashes(tx: Tx, input: QuestionHashPrepareInput): Promise<{
  results: HashPrepareResult[]; before: Row[];
} | null> {
  if (input.sourceId !== null) return null; // preserve optional source-linking logic unchanged
  const items = [...input.items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ids = items.map(i => i.id);
  const initial = await tx.execute<GraphRow>(graph(ids));
  if (initial.some(q => !isolated(q))) return null;
  const requested = sql.join(items.map(i => sql`(${i.id}::uuid, ${new Date(i.expectedUpdatedAt).toISOString()}::timestamptz)`), sql`, `);
  const locked = await tx.execute<Row>(sql`SELECT q.id, q.user_id "userId", q.visibility, q.origin,
    q.catalog_status "catalogStatus", q.published_at IS NOT NULL "wasPublished", q.content_hash "contentHash", q.version,
    q.source_id "sourceId", date_trunc('milliseconds', q.updated_at) = requested.at "fresh",
    q.stem, q.alternatives, q.correct_key "correctKey", q.explanation, q.enamed_area_id "areaId", q.enamed_topic_id "topicId", q.availability, q.assets
    FROM question_bank q JOIN (VALUES ${requested}) requested(id, at) ON requested.id = q.id ORDER BY q.id FOR UPDATE OF q`);
  const current = await tx.execute<GraphRow>(graph(ids));
  const oldById = new Map(initial.map(q => [q.id, q]));
  const changed = current.some(q => {
    const old = oldById.get(q.id);
    return !old || !isolated(q) || old.canonicalId !== q.canonicalId || old.supersedesId !== q.supersedesId;
  });
  const none = (id: string, outcome: HashPrepareResult['outcome']): HashPrepareResult =>
    ({ id, outcome, version: null, contentHash: null, sourceId: null });
  if (changed) return { results: items.map(i => none(i.id, 'conflict')), before: [] };
  const rows = new Map(locked.map(q => [String(q.id), q]));
  const results: HashPrepareResult[] = [], before: Row[] = [];
  const updates: { id: string; version: number; at: string; hash: string }[] = [];
  for (const item of items) {
    const q = rows.get(item.id);
    if (!q) { results.push(none(item.id, 'not_found')); continue; }
    if (q.userId !== null || q.visibility !== 'public' || q.origin !== 'remoa_authored' || q.catalogStatus === 'published' || q.wasPublished) {
      results.push(none(item.id, 'not_eligible')); continue;
    }
    const version = Number(q.version), stored = q.contentHash as string | null, sourceId = q.sourceId as string | null;
    const canonical = contentHash({ stem: String(q.stem), alternatives: q.alternatives,
      correctKey: q.correctKey as string | null, explanation: q.explanation as string | null,
      areaId: q.areaId as string | null, topicId: q.topicId as string | null,
      annulled: q.availability === 'annulled', assets: q.assets });
    const done = (outcome: HashPrepareResult['outcome'], hash = stored) => results.push({ id: item.id, outcome, version, contentHash: hash, sourceId });
    if (stored !== null) { done(stored === canonical ? 'already_prepared' : 'conflict'); continue; }
    if (version !== item.revision || q.fresh !== true) { done('conflict'); continue; }
    updates.push({ id: item.id, version, at: new Date(item.expectedUpdatedAt).toISOString(), hash: canonical });
    done('prepared', canonical);
  }
  if (updates.length) {
    const values = sql.join(updates.map(u => sql`(${u.id}::uuid, ${u.version}::integer, ${u.at}::timestamptz, ${u.hash}::text)`), sql`, `);
    const updated = await tx.execute<Row>(sql`UPDATE question_bank q SET content_hash = prepared.hash
      FROM (VALUES ${values}) prepared(id, version, at, hash)
      WHERE q.id = prepared.id AND q.content_hash IS NULL AND q.version = prepared.version
        AND date_trunc('milliseconds', q.updated_at) = prepared.at RETURNING q.id`);
    const applied = new Set(updated.map(q => String(q.id)));
    for (const r of results) if (r.outcome === 'prepared') {
      if (!applied.has(r.id)) { r.outcome = 'conflict'; r.contentHash = null; }
      else before.push({ id: r.id, version: r.version, contentHash: null, sourceId: r.sourceId });
    }
  }
  return { results, before };
}
