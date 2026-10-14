/**
 * F33/G26 audited operations (rule 9). D-1804/CCR146: content-hash preparation. D-1805/CCR144: generation outbox lists, bounded
 * recovery and local metrics. Every call = exactly one admin_audit_log row (withAdmin). Nothing here returns or logs stem,
 * alternatives, answer key, object key/URL, prompt or CRM; no provider call, quota reservation or charge; no Mixpanel.
 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import {
  err, ok, parseWith, reasonSchema, questionBankServerSchema, QUESTION_CONTENT_HASH_VERSION, QUESTION_OUTBOX_MAX_ATTEMPTS,
  questionHashPrepareInputSchema, questionHashPrepareItemResultSchema, questionOutboxRecoverInputSchema, questionOutboxRecoverItemResultSchema,
  questionAdminOutboxQuerySchema, questionGenerationMetricsQuerySchema, questionRecoveryTargets,
  questionInstitutionalApproveInputSchema, questionInstitutionalApproveItemResultSchema, QUESTION_REMOA_RIGHTS_SCOPE,
  type QuestionHashPrepareInput, type QuestionOutboxRecoverInput, type QuestionInstitutionalApproveInput, type QuestionInstitutionalApproveOutcome, type Result,
} from '@remoa/contracts';
import { env } from '@remoa/config';
import { dbm, uuids } from '../../db';
import { withAdmin, reasonOf, send, type AdminEnv, type AuditCapture } from '../core';
import { lockAssociatedQuestionGraphs } from './recovery';
import { publishQuestion } from './service';
import { contentHash } from '../../questions/imports/domain';
import { prepareUnlinkedHashes, type HashPrepareResult } from './hash-prepare-bulk';
import { catalogQueryValues } from '../../questions/editorial/catalog';
import { outboxPage } from '../../questions/generation/outbox';
import { RECEIPT_MAX_BYTES, receiptHash, type ReceiptRecord } from '../../questions/generation/receipts';
import { getBytes, headObject } from '../../storage/storage';

type Row = Record<string, unknown>;
const byId = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const readJson = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
const keyOf = (json: unknown) => {
  const k = json && typeof json === 'object' ? (json as { idempotencyKey?: unknown }).idempotencyKey : undefined;
  return typeof k === 'string' ? k.slice(0, 64) : 'invalid';
};
/** sha256 of the canonical payload (items sorted by id; reason and key excluded): a retyped reason or reordered items still replay. */
export const requestHash = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

/**
 * Idempotency without DDL (D-1804): transaction advisory lock on (action, actor, key), then the original success audit row of that
 * key. Same requestHash = its stored results; another payload = 409. Concurrent twins serialize on the lock; the loser sees the row.
 */
export async function idempotentReplay(tx: Tx, action: string, actorId: string, key: string, hash: string): Promise<Result<{ auditId: number; results: unknown[]; after: Row } | null>> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${action}:${actorId}:${key}`}, 0))`);
  const [prev] = await tx.execute<Row>(sql`SELECT id, after->>'requestHash' "requestHash", after->'results' results, after FROM admin_audit_log
    WHERE actor_id = ${actorId}::uuid AND action = ${action} AND result = 'success' AND after->>'idempotencyKey' = ${key} AND after->>'replayOf' IS NULL ORDER BY id LIMIT 1`);
  if (!prev) return ok(null);
  if (prev.requestHash !== hash) return err('conflict', 'idempotency_key_payload_changed');
  return ok({ auditId: Number(prev.id), results: prev.results as unknown[], after: prev.after as Row });
}

// ── D-1804: content-hash preparation ───────────────────────────────────────────────────────────────────────────────
type PrepareResult = HashPrepareResult;
export async function prepareContentHashes(tx: Tx, actorId: string, input: QuestionHashPrepareInput, audit: AuditCapture) {
  const items = [...input.items].sort(byId((i) => i.id)); // lock order
  const hash = requestHash({ items: items.map((i) => ({ id: i.id, revision: i.revision, expectedUpdatedAt: new Date(i.expectedUpdatedAt).toISOString() })), sourceId: input.sourceId });
  const replay = await idempotentReplay(tx, 'question.content_hash_prepare', actorId, input.idempotencyKey, hash);
  if (!replay.ok) return replay;
  if (replay.data) {
    audit.after({ idempotencyKey: input.idempotencyKey, requestHash: hash, replayOf: replay.data.auditId, count: replay.data.results.length });
    return ok({ hashVersion: QUESTION_CONTENT_HASH_VERSION, replayed: true, results: replay.data.results.map((r) => questionHashPrepareItemResultSchema.parse(r)) });
  }
  // Existence only: the source's rights are never read as authorization here, nor changed.
  if (input.sourceId && !(await tx.execute(sql`SELECT 1 FROM question_sources WHERE id = ${input.sourceId}::uuid`)).length) return err('not_found', 'source not found');
  const bulk = await prepareUnlinkedHashes(tx, input);
  if (bulk) {
    audit.before({ items: bulk.before });
    audit.after({ idempotencyKey: input.idempotencyKey, requestHash: hash, hashVersion: QUESTION_CONTENT_HASH_VERSION, sourceId: input.sourceId, results: bulk.results });
    return ok({ hashVersion: QUESTION_CONTENT_HASH_VERSION, replayed: false, results: bulk.results.map(r => questionHashPrepareItemResultSchema.parse(r)) });
  }
  const results: PrepareResult[] = [], before: Row[] = [];
  for (const item of items) {
    const none = (outcome: PrepareResult['outcome']) => results.push({ id: item.id, outcome, version: null, contentHash: null, sourceId: null });
    if (!(await lockAssociatedQuestionGraphs(tx, item.id)).ok) { none('conflict'); continue; }
    const [row] = await tx.execute<Row>(sql`SELECT user_id "userId", visibility, origin, catalog_status "catalogStatus", published_at IS NOT NULL "wasPublished",
      content_hash "contentHash", version, source_id "sourceId", date_trunc('milliseconds', updated_at) = ${new Date(item.expectedUpdatedAt).toISOString()}::timestamptz "fresh",
      stem, alternatives, correct_key "correctKey", explanation, enamed_area_id "areaId", enamed_topic_id "topicId", availability, assets
      FROM question_bank WHERE id = ${item.id}::uuid FOR UPDATE`);
    if (!row) { none('not_found'); continue; }
    // Private/AI rows report nothing about themselves (rule 9: the 10 private AI rows stay out).
    if (row.userId !== null || row.visibility !== 'public' || !['official_exam', 'remoa_authored'].includes(String(row.origin)) || row.catalogStatus === 'published' || row.wasPublished) { none('not_eligible'); continue; }
    const version = Number(row.version), stored = (row.contentHash as string | null), sourceId = (row.sourceId as string | null);
    const canonical = contentHash({ stem: String(row.stem), alternatives: row.alternatives, correctKey: row.correctKey as string | null, explanation: row.explanation as string | null, areaId: row.areaId as string | null, topicId: row.topicId as string | null, annulled: row.availability === 'annulled', assets: row.assets });
    const done = (outcome: PrepareResult['outcome'], h = stored, s = sourceId) => results.push({ id: item.id, outcome, version, contentHash: h, sourceId: s });
    if (stored !== null) { done(stored === canonical ? 'already_prepared' : 'conflict'); continue; }
    if (version !== item.revision || row.fresh !== true) { done('conflict'); continue; }
    if (input.sourceId && sourceId && sourceId !== input.sourceId) { done('source_mismatch'); continue; }
    const link = input.sourceId && !sourceId ? input.sourceId : null;
    await tx.execute(sql`UPDATE question_bank SET content_hash = ${canonical}${link ? sql`, source_id = ${link}::uuid` : sql``} WHERE id = ${item.id}::uuid AND content_hash IS NULL`);
    before.push({ id: item.id, version, contentHash: null, sourceId });
    done('prepared', canonical, link ?? sourceId);
  }
  audit.before({ items: before });
  audit.after({ idempotencyKey: input.idempotencyKey, requestHash: hash, hashVersion: QUESTION_CONTENT_HASH_VERSION, sourceId: input.sourceId, results });
  return ok({ hashVersion: QUESTION_CONTENT_HASH_VERSION, replayed: false, results: results.map((r) => questionHashPrepareItemResultSchema.parse(r)) });
}

// ── D-1819: institutional approval ("Validado pela Remoa", rule 6 exception) ─────────────────────────────────────
/** Topic lineage reaches the area without cycles: the same rule f33_validate_question enforces at publication. */
const taxonomyConsistent = (areaId: string, topicId: string) => sql`SELECT EXISTS (WITH RECURSIVE lineage AS (
    SELECT t.id,t.parent_id,t.area,0 depth,ARRAY[t.id] path,false cycle FROM enamed_taxonomy t WHERE t.id=${topicId}::uuid AND t.kind='topic'
    UNION ALL SELECT p.id,p.parent_id,p.area,l.depth+1,l.path||p.id,p.id=ANY(l.path) FROM enamed_taxonomy p JOIN lineage l ON p.id=l.parent_id WHERE l.depth<10 AND NOT l.cycle
  ) SELECT 1 FROM lineage l JOIN enamed_taxonomy a ON a.id=${areaId}::uuid AND a.kind='area' WHERE l.id=a.id
    AND NOT EXISTS(SELECT 1 FROM lineage bad WHERE bad.area<>a.area OR bad.cycle OR (bad.depth=10 AND bad.parent_id IS NOT NULL))) ok`;
class ItemRollback extends Error { constructor(readonly outcome: QuestionInstitutionalApproveOutcome) { super(outcome); } }

/** Find-or-create the single Remoa-owned source (unique partial index), then hold it FOR SHARE like publishQuestion. Never re-authorized. */
async function remoaSource(tx: Tx, input: QuestionInstitutionalApproveInput, today: string): Promise<Result<string>> {
  const siteUrl = env().siteUrl.replace(/\/+$/, ''); // SITE_URL (required in production by @remoa/config)
  const evidence = `Conteúdo próprio da Remoa; atestado por ${input.attestation.approverName} (founder médica) em ${today}, D-1819`;
  await tx.execute(sql`INSERT INTO question_sources(name,publisher,url,rights_status,rights_evidence,rights_scope)
    VALUES('Remoa','Remoa',${siteUrl},'authorized',${evidence},${QUESTION_REMOA_RIGHTS_SCOPE})
    ON CONFLICT (rights_scope) WHERE rights_scope = 'remoa_owned' DO NOTHING`);
  const [src] = await tx.execute<Row>(sql`SELECT id, rights_status = 'authorized' AND (rights_expires_at IS NULL OR rights_expires_at > now()) usable
    FROM question_sources WHERE rights_scope = ${QUESTION_REMOA_RIGHTS_SCOPE} FOR SHARE`);
  if (!src) return err('conflict', 'remoa_source_rights_revoked');
  return src.usable === true ? ok(String(src.id)) : err('conflict', 'remoa_source_rights_revoked');
}

type InstitutionalResult = { id: string; outcome: QuestionInstitutionalApproveOutcome; version: number | null; contentHash: string | null };
export async function approveInstitutional(tx: Tx, actorId: string, input: QuestionInstitutionalApproveInput, audit: AuditCapture) {
  const items = [...input.items].sort(byId((i) => i.id)); // lock order
  const { approverRole, approverName, rightsBasis } = input.attestation;
  const hash = requestHash({ items, attestation: input.attestation });
  const replay = await idempotentReplay(tx, 'question.institutional_approve', actorId, input.idempotencyKey, hash);
  if (!replay.ok) return replay;
  if (replay.data) {
    audit.after({ idempotencyKey: input.idempotencyKey, requestHash: hash, replayOf: replay.data.auditId, count: replay.data.results.length });
    return ok({ replayed: true, sourceId: String(replay.data.after.sourceId), results: replay.data.results.map((r) => questionInstitutionalApproveItemResultSchema.parse(r)) });
  }
  const [{ today } = {}] = await tx.execute<Row>(sql`SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') today`);
  const source = await remoaSource(tx, input, String(today));
  if (!source.ok) return source;
  const sourceId = source.data;
  const results: InstitutionalResult[] = [], before: Row[] = [];
  for (const item of items) {
    let version: number | null = null, stored: string | null = null;
    try {
      await tx.transaction(async (sp) => { // one savepoint per item: a failed item leaves nothing behind
        const skip = (outcome: QuestionInstitutionalApproveOutcome): never => { throw new ItemRollback(outcome); };
        if (!(await lockAssociatedQuestionGraphs(sp, item.id)).ok) skip('conflict');
        const [row] = await sp.execute<Row>(sql`SELECT user_id "userId", visibility, origin, type, catalog_status "catalogStatus", status, availability,
          published_at IS NOT NULL "wasPublished", content_hash "contentHash", version, source_id "sourceId", stem, alternatives, correct_key "correctKey",
          explanation, enamed_area_id "areaId", enamed_topic_id "topicId", assets FROM question_bank WHERE id = ${item.id}::uuid FOR UPDATE`);
        if (!row) skip('not_found');
        const q = row!;
        if (q.userId !== null || q.visibility !== 'public' || q.origin !== 'remoa_authored') skip('not_eligible');
        version = Number(q.version); stored = q.contentHash as string | null;
        if (q.catalogStatus === 'published') skip('already_published');
        if (['withdrawn', 'rejected'].includes(String(q.catalogStatus)) || q.availability === 'superseded' || q.wasPublished) skip('not_eligible');
        if (stored === null) skip('hash_missing');
        const canonical = contentHash({ stem: String(q.stem), alternatives: q.alternatives, correctKey: q.correctKey as string | null, explanation: q.explanation as string | null, areaId: q.areaId as string | null, topicId: q.topicId as string | null, annulled: q.availability === 'annulled', assets: q.assets });
        if (version !== item.revision || stored !== item.expectedContentHash || stored !== canonical) skip('conflict');
        const keys = Array.isArray(q.alternatives) ? (q.alternatives as { key?: unknown }[]).map((a) => a.key) : [];
        if (q.type !== 'objective' || q.availability !== 'active' || !q.correctKey || !keys.includes(q.correctKey)) skip('answer_key_missing');
        if (!q.areaId || !q.topicId || !(await sp.execute<Row>(taxonomyConsistent(String(q.areaId), String(q.topicId))))[0]?.ok) skip('taxonomy_missing');
        if (!String(q.explanation ?? '').trim()) skip('explanation_missing');
        if (q.sourceId !== null && q.sourceId !== sourceId) skip('source_mismatch');
        // Source first: the signature trigger checks the Remoa-owned authorized source of this exact hash.
        await sp.execute(sql`UPDATE question_bank SET source_id = ${sourceId}::uuid WHERE id = ${item.id}::uuid`);
        await sp.execute(sql`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,kind,content_hash,decision,reason,reference_date)
          VALUES(${item.id}::uuid,${actorId}::uuid,${approverName},NULL,'remoa_institutional',${stored},'approved',${input.reason},${today})`);
        // integrity_confirmed / key_final / enamed_confirmed untouched: the seal is an attestation, not a confirmation (D-1819).
        await sp.execute(sql`UPDATE question_bank SET status='approved', catalog_status='approved', rights_status='authorized', reviewed_hash=content_hash,
          reviewer_name=${approverName}, reviewer_crm=NULL, reference_date=${today}, validation_kind='remoa_institutional' WHERE id = ${item.id}::uuid`);
        const published = await publishQuestion(sp, item.id, { revision: version!, expectedContentHash: stored!, reason: input.reason });
        if (!published.ok) skip('conflict'); // ponytail: a gate disagreeing after our checks is reported as conflict, not raised
        before.push({ id: item.id, version, contentHash: stored, catalogStatus: q.catalogStatus, status: q.status, sourceId: q.sourceId });
      });
      results.push({ id: item.id, outcome: 'published', version, contentHash: stored });
    } catch (e) {
      if (!(e instanceof ItemRollback)) throw e;
      results.push({ id: item.id, outcome: e.outcome, version, contentHash: stored });
    }
  }
  audit.before({ items: before });
  audit.after({ idempotencyKey: input.idempotencyKey, requestHash: hash, approverRole, approverName, rightsBasis, sourceId, referenceDate: today, results });
  return ok({ replayed: false, sourceId, results: results.map((r) => questionInstitutionalApproveItemResultSchema.parse(r)) });
}

// ── D-1805: durable object check (HEAD/GET of the existing object only) ────────────────────────────────────────────
export type DurableCheck = 'ok' | 'durable_content_missing' | 'replay_metadata_invalid';
export type DurableRow = { target: string; payloadReference: string; runId: string; ownerId: string; payloadHash: string | null };
export type DurableStorage = { head(key: string): Promise<{ size: number } | null>; get(key: string): Promise<Buffer> };
const r2: DurableStorage = { head: (k) => headObject(k), get: (k) => getBytes(k, { maxBytes: RECEIPT_MAX_BYTES }) };

/** The worker's own acceptance rules (reconcile.ts), read-only. A receipt run without payload_hash yet is the crash-after-PUT case. */
export async function checkDurableObject(row: DurableRow, storage: DurableStorage = r2): Promise<DurableCheck> {
  const [key = '', refHash] = row.payloadReference.split('#');
  if (!key.startsWith(`questions/generation/${row.ownerId}/`) || key.includes('..')) return 'replay_metadata_invalid';
  const head = await storage.head(key).catch(() => null);
  if (!head) return 'durable_content_missing';
  if (head.size > RECEIPT_MAX_BYTES) return 'replay_metadata_invalid';
  let bytes: Buffer;
  try { bytes = await storage.get(key); } catch { return 'durable_content_missing'; }
  if (bytes.length > RECEIPT_MAX_BYTES) return 'replay_metadata_invalid';
  const hash = receiptHash(bytes);
  try {
    if (row.target === 'question-receipt') {
      if ((row.payloadHash && row.payloadHash !== hash) || (refHash && refHash !== hash) || key !== `questions/generation/${row.ownerId}/${row.runId}/receipt.json`) return 'replay_metadata_invalid';
      const rec = JSON.parse(bytes.toString()) as ReceiptRecord;
      if (![1, 2].includes(rec.version) || rec.meta?.ownerId !== row.ownerId || rec.runId !== row.runId || (rec.version === 1 ? typeof rec.completion?.text !== 'string' : !rec.envelope)) return 'replay_metadata_invalid';
    } else if (row.target === 'question-promotion') {
      if (refHash !== hash) return 'replay_metadata_invalid';
      const plan = JSON.parse(bytes.toString()) as { ownerId?: unknown; runIds?: unknown; rows?: unknown };
      if (plan.ownerId !== row.ownerId || !Array.isArray(plan.runIds) || plan.runIds[0] !== row.runId || !Array.isArray(plan.rows) || plan.rows.length > 1000) return 'replay_metadata_invalid';
      if (plan.rows.some((r) => questionBankServerSchema.parse(r).userId !== row.ownerId)) return 'replay_metadata_invalid';
    } else return 'replay_metadata_invalid';
  } catch { return 'replay_metadata_invalid'; }
  return 'ok';
}

const outboxRow = sql`SELECT o.id, o.target, o.payload_reference "payloadReference", o.run_id "runId", r.user_id "ownerId", r.payload_hash "payloadHash",
  o.attempts, o.attempt_limit "attemptLimit", o.delivered_at IS NOT NULL delivered, coalesce(o.lease_until > now(), false) leased
  FROM question_outbox o JOIN question_generation_runs r ON r.id = o.run_id WHERE o.target IN ('question-receipt','question-promotion')`;
type OutboxRow = DurableRow & { id: string; attempts: number; attemptLimit: number; delivered: boolean; leased: boolean };
const recoverable = (r: OutboxRow) => !r.delivered && !r.leased && r.attempts >= r.attemptLimit && r.attemptLimit < QUESTION_OUTBOX_MAX_ATTEMPTS;
const checkKey = (r: DurableRow) => `${r.payloadReference}|${r.payloadHash ?? ''}`;

/** Before the transaction (no R2 IO while row locks are held): check only rows that currently look recoverable. */
export async function precheckRecovery(input: QuestionOutboxRecoverInput, storage: DurableStorage = r2) {
  const { db } = await dbm();
  const ids = input.items.map((i) => i.outboxId);
  const rows = await db.execute<OutboxRow>(sql`${outboxRow} AND o.id = ANY(${uuids(ids)})`);
  const checks = new Map<string, { key: string; check: DurableCheck }>();
  for (const r of rows) if (recoverable(r)) checks.set(r.id, { key: checkKey(r), check: await checkDurableObject(r, storage) });
  return checks;
}

type RecoverResult = { outboxId: string; outcome: (typeof import('@remoa/contracts').questionOutboxRecoverOutcomes)[number]; granted: number; attempts: number | null; attemptLimit: number | null };
export async function recoverOutbox(tx: Tx, actorId: string, input: QuestionOutboxRecoverInput, checks: Map<string, { key: string; check: DurableCheck }>, audit: AuditCapture) {
  const items = [...input.items].sort(byId((i) => i.outboxId));
  const hash = requestHash({ items, extraAttempts: input.extraAttempts });
  const replay = await idempotentReplay(tx, 'question.generation_recover', actorId, input.idempotencyKey, hash);
  if (!replay.ok) return replay;
  if (replay.data) {
    audit.after({ idempotencyKey: input.idempotencyKey, requestHash: hash, replayOf: replay.data.auditId, count: replay.data.results.length });
    return ok({ replayed: true, results: replay.data.results.map((r) => questionOutboxRecoverItemResultSchema.parse(r)) });
  }
  const results: RecoverResult[] = [], before: Row[] = [];
  for (const item of items) {
    const [row] = await tx.execute<OutboxRow>(sql`${outboxRow} AND o.id = ${item.outboxId}::uuid FOR UPDATE OF o`);
    if (!row) { results.push({ outboxId: item.outboxId, outcome: 'not_found', granted: 0, attempts: null, attemptLimit: null }); continue; }
    const done = (outcome: RecoverResult['outcome'], granted = 0) => results.push({ outboxId: item.outboxId, outcome, granted, attempts: row.attempts, attemptLimit: row.attemptLimit + granted });
    if (row.delivered) { done('delivered'); continue; }
    if (row.leased) { done('leased'); continue; }
    if (row.attempts !== item.expectedAttempts || row.attemptLimit !== item.expectedAttemptLimit) { done('conflict'); continue; }
    if (row.attempts < row.attemptLimit) { done('not_exhausted'); continue; }
    if (row.attemptLimit >= QUESTION_OUTBOX_MAX_ATTEMPTS) { done('limit_reached'); continue; }
    const pre = checks.get(row.id);
    if (!pre || pre.key !== checkKey(row)) { done('conflict'); continue; } // changed between precheck and lock: retry
    if (pre.check !== 'ok') { done(pre.check); continue; }
    const granted = Math.min(input.extraAttempts, QUESTION_OUTBOX_MAX_ATTEMPTS - row.attemptLimit);
    // CAS again in the statement itself; attempts is never touched (0052 trigger also forbids lowering either column).
    const updated = await tx.execute(sql`UPDATE question_outbox SET attempt_limit = attempt_limit + ${granted}, updated_at = now()
      WHERE id = ${row.id}::uuid AND attempts = ${row.attempts} AND attempt_limit = ${row.attemptLimit} AND delivered_at IS NULL RETURNING id`);
    if (!updated.length) { done('conflict'); continue; }
    before.push({ outboxId: row.id, attempts: row.attempts, attemptLimit: row.attemptLimit });
    done('granted', granted);
  }
  audit.before({ items: before });
  audit.after({ idempotencyKey: input.idempotencyKey, requestHash: hash, extraAttempts: input.extraAttempts, results });
  return ok({ replayed: false, results: results.map((r) => questionOutboxRecoverItemResultSchema.parse(r)) });
}

// ── D-1805: local metrics (aggregates only) ───────────────────────────────────────────────────────────────────────
const iso = (col: SQL) => sql`to_char(${col} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const metricsSQL = (windowHours: number) => ({
  backlog: sql`SELECT o.target, count(*) FILTER (WHERE (o.lease_until IS NULL OR o.lease_until <= now()) AND o.attempts < o.attempt_limit)::int pending,
    count(*) FILTER (WHERE o.lease_until > now())::int leased, count(*) FILTER (WHERE (o.lease_until IS NULL OR o.lease_until <= now()) AND o.attempts >= o.attempt_limit)::int exhausted,
    ${iso(sql`min(o.created_at) FILTER (WHERE (o.lease_until IS NULL OR o.lease_until <= now()) AND o.attempts < o.attempt_limit)`)} "oldestPendingAt"
    FROM question_outbox o WHERE o.delivered_at IS NULL AND o.target IN ('question-receipt','question-promotion') GROUP BY o.target`,
  throughput: sql`SELECT o.target, count(*)::int delivered, count(*) FILTER (WHERE o.attempt_limit > 20)::int recovered FROM question_outbox o
    WHERE o.delivered_at >= now() - make_interval(hours => ${windowHours}) AND o.target IN ('question-receipt','question-promotion') GROUP BY o.target`,
  // cost_cents = 0 is unknown, never free (D-1805).
  cost: sql`SELECT count(*)::int runs, count(*) FILTER (WHERE cost_cents > 0)::int "runsWithKnownCost", count(*) FILTER (WHERE cost_cents <= 0)::int "runsWithUnknownCost",
    coalesce(sum(cost_cents) FILTER (WHERE cost_cents > 0), 0)::int "knownCostCents" FROM question_generation_runs WHERE created_at >= now() - make_interval(hours => ${windowHours})`,
});
export async function generationMetrics(tx: Tx, windowHours: number) {
  const q = metricsSQL(windowHours);
  const backlog = await tx.execute<Row>(q.backlog), throughput = await tx.execute<Row>(q.throughput), [cost] = await tx.execute<Row>(q.cost);
  const of = (rows: Row[], t: string) => rows.find((r) => r.target === t);
  return {
    generatedAt: new Date(), windowHours,
    backlog: questionRecoveryTargets.map((target) => { const r = of(backlog, target); return { target, pending: Number(r?.pending ?? 0), leased: Number(r?.leased ?? 0), exhausted: Number(r?.exhausted ?? 0), oldestPendingAt: (r?.oldestPendingAt as string | null | undefined) ?? null }; }),
    throughput: questionRecoveryTargets.map((target) => { const r = of(throughput, target); return { target, delivered: Number(r?.delivered ?? 0), recovered: Number(r?.recovered ?? 0) }; }),
    cost: { runs: Number(cost?.runs ?? 0), runsWithKnownCost: Number(cost?.runsWithKnownCost ?? 0), runsWithUnknownCost: Number(cost?.runsWithUnknownCost ?? 0), knownCostCents: Number(cost?.knownCostCents ?? 0) },
  };
}

// ── Routes (mounted under /v1/admin/questions; requireAdmin → 404 for non-admins) ─────────────────────────────────
export const questionAdminOperationsRoutes = new Hono<AdminEnv>()
  .post('/content-hash/prepare', async (c) => {
    const json = await readJson(c);
    return send(await withAdmin(c, 'question.content_hash_prepare', { reason: reasonOf(json), target: { type: 'question_batch', id: keyOf(json) } }, async (tx, audit) => {
      const input = parseWith(questionHashPrepareInputSchema, json);
      if (!input.ok) return input;
      return prepareContentHashes(tx, c.get('admin').id, input.data, audit);
    }));
  })
  .post('/institutional-approval', async (c) => {
    const json = await readJson(c);
    return send(await withAdmin(c, 'question.institutional_approve', { reason: reasonOf(json), target: { type: 'question_batch', id: keyOf(json) } }, async (tx, audit) => {
      const input = parseWith(questionInstitutionalApproveInputSchema, json);
      if (!input.ok) return input;
      return approveInstitutional(tx, c.get('admin').id, input.data, audit);
    }));
  })
  .post('/generation/recover', async (c) => {
    const json = await readJson(c);
    const opts = { reason: reasonOf(json), target: { type: 'question_outbox' as const, id: keyOf(json) } };
    const gate = <T extends object>(r: Result<T>) => withAdmin(c, 'question.generation_recover', opts, async () => r);
    // withAdmin still writes the denial; storage is only read after the same reason gate and a valid body.
    if (!reasonSchema.safeParse(opts.reason).success) return send(await gate(ok({})));
    const input = parseWith(questionOutboxRecoverInputSchema, json);
    if (!input.ok) return send(await gate(input));
    const checks = await precheckRecovery(input.data);
    return send(await withAdmin(c, 'question.generation_recover', opts, (tx, audit) => recoverOutbox(tx, c.get('admin').id, input.data, checks, audit)));
  })
  .get('/generation/outbox', async (c) =>
    send(await withAdmin(c, 'question.generation_view', { reason: 'Consultar fila de geração de questões', target: { type: 'route', id: c.req.path }, sensitive: false }, async (tx, audit) => {
      const input = parseWith(questionAdminOutboxQuerySchema, catalogQueryValues(c.req.url));
      if (!input.ok) return input;
      const page = await outboxPage((q) => tx.execute<Row>(q), input.data, { actor: { id: c.get('admin').id, role: 'admin' }, route: c.req.path, query: input.data });
      if (page.ok) audit.after({ count: page.data.items.length, state: input.data.state, target: input.data.target ?? null, hasMore: page.data.nextCursor !== null });
      return page;
    })))
  .get('/generation/metrics', async (c) =>
    send(await withAdmin(c, 'question.generation_view', { reason: 'Consultar métricas da fila de geração', target: { type: 'route', id: c.req.path }, sensitive: false }, async (tx, audit) => {
      const input = parseWith(questionGenerationMetricsQuerySchema, catalogQueryValues(c.req.url));
      if (!input.ok) return input;
      audit.after({ windowHours: input.data.windowHours });
      return ok(await generationMetrics(tx, input.data.windowHours));
    })));
