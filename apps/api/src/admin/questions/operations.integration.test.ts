/** D-1804/D-1805 against the isolated local f33_test database (0052 applied). Synthetic text only; storage mocked; fetch spied. */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeToken, fakeVerifier } from '../core/test-helpers';
import type { AdminEnv } from '../core';
import type { Env } from '../../app';
import { assertF33TestDb } from '../../questions/test-db-guard';

const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../../storage/storage', () => ({
  getBytes: vi.fn(async (k: string) => { const b = objects.get(k); if (!b) throw Error('missing_object'); return b; }),
  headObject: vi.fn(async (k: string) => (objects.has(k) ? { size: objects.get(k)!.length, mime: 'application/json' } : null)),
  putBytes: vi.fn(), deleteObject: vi.fn(), presignGet: vi.fn(),
}));
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => {}) }));

const url = process.env.DATABASE_URL;
assertF33TestDb(url);
describe.skipIf(!url)('F33 operations: content-hash prepare + outbox recovery (D-1804/D-1805)', () => {
  const admin = randomUUID(), student = randomUUID(), other = randomUUID(), source = randomUUID(), source2 = randomUUID();
  const reason = 'Preparação sintética de integração';
  const STEM = 'Enunciado sintético exclusivo D1804';
  let pg: typeof import('@remoa/db').db.$client;
  let app: Hono<AdminEnv>, userApp: Hono<Env>;
  let contentHash: typeof import('../../questions/imports/domain').contentHash;
  const fetchSpy = vi.fn(async () => { throw Error('network forbidden in this test'); });

  const req = (path: string, method = 'GET', body?: unknown, who = admin, agoMs = 60_000) =>
    app.request(path, { method, headers: { authorization: 'Bearer ' + fakeToken(who, agoMs), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const auditCount = async (action: string) => Number((await pg`SELECT count(*)::int n FROM admin_audit_log WHERE actor_id=${admin} AND action=${action}`)[0]!.n);
  const question = async (opts: { userId?: string | null; visibility?: string; origin?: string; publishedAt?: boolean; sourceId?: string | null; hash?: string | null } = {}) => {
    const id = randomUUID();
    const alts = JSON.stringify([{ key: 'A', text: 'Alternativa sintética A' }, { key: 'B', text: 'Alternativa sintética B' }]);
    await pg`INSERT INTO question_bank(id,user_id,visibility,origin,source,source_id,type,difficulty,stem,expected_answer,alternatives,correct_key,status,catalog_status,content_hash,published_at)
      VALUES(${id},${opts.userId ?? null},${opts.visibility ?? 'public'},${opts.origin ?? 'official_exam'},'ai',${opts.sourceId ?? null},'objective','easy',${STEM},'Resposta sintética',${alts}::jsonb,'A','draft','in_review',${opts.hash ?? null},${opts.publishedAt ? new Date().toISOString() : null})`;
    const [row] = await pg`SELECT version, to_char(date_trunc('milliseconds',updated_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at FROM question_bank WHERE id=${id}`;
    return { id, revision: Number(row!.version), expectedUpdatedAt: String(row!.at) };
  };
  const canonical = () => contentHash({ stem: STEM, alternatives: [{ key: 'A', text: 'Alternativa sintética A' }, { key: 'B', text: 'Alternativa sintética B' }], correctKey: 'A', explanation: null, areaId: null, topicId: null, annulled: false, assets: [] });

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    process.env.SHARE_SECRET ||= 'synthetic-operations-secret';
    const db = await import('@remoa/db');
    pg = db.db.$client;
    ({ contentHash } = await import('../../questions/imports/domain'));
    for (const id of [admin, student, other]) await pg`INSERT INTO auth.users(id,email) VALUES(${id},${id + '@f33.example'})`;
    await pg`UPDATE profiles SET role='admin',name='Synthetic Ops Admin' WHERE user_id=${admin}`;
    for (const id of [source, source2]) await pg`INSERT INTO question_sources(id,name,publisher,url,rights_status) VALUES(${id},'Fonte sintética D1804','Testes','https://example.invalid/source','pending')`;
    const { questionAdminRoutes } = await import('./routes');
    const { requireAdmin } = await import('../core');
    const { questionsRoutes } = await import('../../routes/questions');
    const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as AdminEnv['Variables']['log'];
    app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => { c.set('log', log); c.set('requestId', randomUUID()); await next(); });
    app.use('*', requireAdmin(fakeVerifier([admin, student])));
    app.route('/', questionAdminRoutes);
    userApp = new Hono<Env>();
    userApp.use('*', async (c, next) => { c.set('log', log); c.set('requestId', randomUUID()); c.set('userId', c.req.header('x-user')!); c.set('sessionId', null); await next(); });
    userApp.route('/', questionsRoutes());
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pg) return;
    await pg`DELETE FROM question_generation_runs WHERE user_id IN (${student},${other})`;
    await pg`DELETE FROM question_bank WHERE stem=${STEM}`;
    await pg`DELETE FROM question_sources WHERE id IN (${source},${source2})`;
    await pg`DELETE FROM auth.users WHERE id IN (${admin},${student},${other})`;
    await pg.end({ timeout: 1 });
  });

  // ── D-1804 ──
  it('prepares institutional drafts, links a NULL source, one audit row without text; replays; 409 on changed payload', async () => {
    const a = await question(), b = await question({ sourceId: source });
    const body = { items: [b, a], sourceId: source, idempotencyKey: randomUUID(), reason };
    const before = await auditCount('question.content_hash_prepare');
    const res = await req('/content-hash/prepare', 'POST', body);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { replayed: boolean; hashVersion: string; results: { id: string; outcome: string; contentHash: string; sourceId: string }[]; audit: { id: number; after: unknown } } };
    expect(data.replayed).toBe(false);
    expect(data.hashVersion).toBe('f33-content-v2-jsonb-assets');
    expect(data.results.map((r) => r.outcome)).toEqual(['prepared', 'prepared']);
    expect(data.results.every((r) => r.contentHash === canonical() && r.sourceId === source)).toBe(true);
    const rows = await pg`SELECT content_hash, source_id, catalog_status, status, reviewed_hash, integrity_confirmed, key_final FROM question_bank WHERE id IN (${a.id},${b.id})`;
    expect(rows.every((r) => r.content_hash === canonical() && r.source_id === source && r.catalog_status === 'in_review' && r.reviewed_hash === null && !r.integrity_confirmed && !r.key_final)).toBe(true);
    expect(await auditCount('question.content_hash_prepare')).toBe(before + 1);
    const [audit] = await pg`SELECT before, after, target_type FROM admin_audit_log WHERE id=${data.audit.id}`;
    expect(audit!.target_type).toBe('question_batch');
    expect(JSON.stringify([audit!.before, audit!.after])).not.toMatch(/sintética|Alternativa|correct/i);

    const replay = await req('/content-hash/prepare', 'POST', { ...body, items: [a, b], reason: 'Outro motivo, mesmo pedido' });
    const r2 = (await replay.json() as { data: { replayed: boolean; results: unknown[]; audit: { id: number } } }).data;
    expect(r2.replayed).toBe(true);
    expect(r2.results).toEqual(data.results);
    const [replayAudit] = await pg`SELECT after FROM admin_audit_log WHERE id=${r2.audit.id}`;
    expect((replayAudit!.after as { replayOf: number }).replayOf).toBe(data.audit.id);
    expect(await auditCount('question.content_hash_prepare')).toBe(before + 2);

    const changed = await req('/content-hash/prepare', 'POST', { ...body, sourceId: null });
    expect(changed.status).toBe(409);
    expect((await changed.json() as { error: { message: string } }).error.message).toBe('idempotency_key_payload_changed');
    expect(await auditCount('question.content_hash_prepare')).toBe(before + 3);
  });

  it('per-item outcomes: not_eligible for private AI and published rows, not_found, conflict, source_mismatch, already_prepared', async () => {
    const priv = await question({ userId: student, visibility: 'private', origin: 'ai_generated' });
    const published = await question({ publishedAt: true });
    const stale = await question(), mismatch = await question({ sourceId: source2 }), done = await question({ hash: canonical() }), wrong = await question({ hash: 'f'.repeat(64) });
    const missing = { id: randomUUID(), revision: 1, expectedUpdatedAt: new Date().toISOString() };
    const res = await req('/content-hash/prepare', 'POST', { items: [priv, published, { ...stale, revision: 2 }, mismatch, done, wrong, missing], sourceId: source, idempotencyKey: randomUUID(), reason });
    const out = Object.fromEntries((await res.json() as { data: { results: { id: string; outcome: string; version: number | null; contentHash: string | null }[] } }).data.results.map((r) => [r.id, r]));
    expect(out[priv.id]).toEqual({ id: priv.id, outcome: 'not_eligible', version: null, contentHash: null, sourceId: null });
    expect(out[published.id]!.outcome).toBe('not_eligible');
    expect(out[stale.id]!.outcome).toBe('conflict');
    expect(out[mismatch.id]!.outcome).toBe('source_mismatch');
    expect(out[done.id]!.outcome).toBe('already_prepared');
    expect(out[wrong.id]!.outcome).toBe('conflict');
    expect(out[missing.id]!.outcome).toBe('not_found');
    const [p] = await pg`SELECT content_hash FROM question_bank WHERE id=${priv.id}`;
    expect(p!.content_hash).toBeNull();
    const old = await question();
    const late = await req('/content-hash/prepare', 'POST', { items: [{ ...old, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }], sourceId: null, idempotencyKey: randomUUID(), reason });
    expect((await late.json() as { data: { results: { outcome: string }[] } }).data.results[0]!.outcome).toBe('conflict');
  });

  it('two parallel prepares on the same ids: each id prepared exactly once', async () => {
    const items = [await question(), await question(), await question()];
    const [x, y] = await Promise.all([0, 1].map(() => req('/content-hash/prepare', 'POST', { items, sourceId: null, idempotencyKey: randomUUID(), reason })));
    const outcomes = await Promise.all([x!, y!].map(async (r) => (await r.json() as { data: { results: { id: string; outcome: string }[] } }).data.results));
    for (const item of items) {
      const pair = outcomes.map((rs) => rs.find((r) => r.id === item.id)!.outcome).sort();
      expect(pair).toEqual(['already_prepared', 'prepared']);
    }
  });

  it('same idempotency key in parallel: one applies, the twin replays', async () => {
    const items = [await question()];
    const body = { items, sourceId: null, idempotencyKey: randomUUID(), reason };
    const rs = await Promise.all([0, 1].map(async () => (await (await req('/content-hash/prepare', 'POST', body)).json() as { data: { replayed: boolean } }).data.replayed));
    expect(rs.sort()).toEqual([false, true]);
  });

  it('non-admin gets 404; invalid body denied; a sign-in older than 30 min still passes with one audit row (D-1841)', async () => {
    const item = await question();
    const body = { items: [item], sourceId: null, idempotencyKey: randomUUID(), reason };
    expect((await req('/content-hash/prepare', 'POST', body, student)).status).toBe(404);
    expect((await req('/content-hash/prepare', 'POST', { ...body, extra: true })).status).toBe(422);
    const [row] = await pg`SELECT content_hash FROM question_bank WHERE id=${item.id}`;
    expect(row!.content_hash).toBeNull();
    const before = await auditCount('question.content_hash_prepare');
    const stale = await req('/content-hash/prepare', 'POST', body, admin, 60 * 60_000);
    expect(stale.status).toBe(200);
    expect(await auditCount('question.content_hash_prepare')).toBe(before + 1);
  });

  it('catalog hashState filter lists only missing hashes and binds the cursor to it', async () => {
    await question(); await question();
    const page = await req('/catalog?hashState=missing&limit=1');
    expect(page.status).toBe(200);
    const data = (await page.json() as { data: { items: { contentHash: string | null }[]; nextCursor: string } }).data;
    expect(data.items.every((i) => i.contentHash === null)).toBe(true);
    expect(data.nextCursor).toBeTruthy();
    const swapped = await req(`/catalog?hashState=present&limit=1&cursor=${encodeURIComponent(data.nextCursor)}`);
    expect(swapped.status).toBe(422);
    const present = (await (await req('/catalog?hashState=present&limit=10')).json() as { data: { items: { contentHash: string | null }[] } }).data;
    expect(present.items.every((i) => i.contentHash !== null)).toBe(true);
  });

  // ── D-1805 ──
  const run = async (owner: string, cost = 0) => {
    const id = randomUUID();
    await pg`INSERT INTO question_generation_runs(id,user_id,producer,request_key,prompt_id,prompt_version,model,provider,status,cost_cents) VALUES(${id},${owner},'challenge_objective',${randomUUID()},'synthetic','test','test/model','test','reserved',${cost})`;
    return id;
  };
  const receipt = (owner: string, runId: string) => Buffer.from(JSON.stringify({ version: 1, runId, meta: { ownerId: owner }, completion: { text: '{}' } }));
  const outbox = async (owner: string, o: { attempts?: number; limit?: number; leased?: boolean; delivered?: boolean; store?: boolean } = {}) => {
    const runId = await run(owner), key = `questions/generation/${owner}/${runId}/receipt.json`, id = randomUUID();
    if (o.store !== false) objects.set(key, receipt(owner, runId));
    await pg`INSERT INTO question_outbox(id,run_id,event_key,target,payload_reference,attempts,attempt_limit,lease_until,delivered_at,error_code)
      VALUES(${id},${runId},${'question-receipt:' + runId},'question-receipt',${key},${o.attempts ?? 20},${o.limit ?? 20},${o.leased ? new Date(Date.now() + 600_000).toISOString() : null},${o.delivered ? new Date().toISOString() : null},'provider_receipt_missing')`;
    return id;
  };

  it('0052: attempts/attempt_limit never decrease; limit capped at 25', async () => {
    const id = await outbox(other, { attempts: 5 });
    await expect(pg`UPDATE question_outbox SET attempts=4 WHERE id=${id}`).rejects.toThrow(/question_outbox_history_monotonic/);
    await expect(pg`UPDATE question_outbox SET attempt_limit=26 WHERE id=${id}`).rejects.toThrow(/attempt_limit_chk/);
    await pg`UPDATE question_outbox SET attempt_limit=21 WHERE id=${id}`;
    await expect(pg`UPDATE question_outbox SET attempt_limit=20 WHERE id=${id}`).rejects.toThrow(/question_outbox_history_monotonic/);
  });

  it('recovery grants a bounded budget after revalidating the stored object, never calling a provider', async () => {
    const ok = await outbox(student), missing = await outbox(student, { store: false }), leased = await outbox(student, { leased: true }), delivered = await outbox(student, { delivered: true }), fresh = await outbox(student, { attempts: 3 });
    const items = [ok, missing, leased, delivered, fresh].map((outboxId) => ({ outboxId, expectedAttempts: outboxId === fresh ? 3 : 20, expectedAttemptLimit: 20 }));
    const before = await auditCount('question.generation_recover');
    const res = await req('/generation/recover', 'POST', { items: [...items, { outboxId: randomUUID(), expectedAttempts: 20, expectedAttemptLimit: 20 }], extraAttempts: 3, idempotencyKey: randomUUID(), reason });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/questions\/generation|receipt\.json/);
    const out = Object.fromEntries((JSON.parse(text) as { data: { results: { outboxId: string; outcome: string; granted: number; attemptLimit: number | null }[] } }).data.results.map((r) => [r.outboxId, r]));
    expect(out[ok]).toMatchObject({ outcome: 'granted', granted: 3, attempts: 20, attemptLimit: 23 });
    expect(out[missing]!.outcome).toBe('durable_content_missing');
    expect(out[leased]!.outcome).toBe('leased');
    expect(out[delivered]!.outcome).toBe('delivered');
    expect(out[fresh]!.outcome).toBe('not_exhausted');
    expect(Object.values(out).filter((r) => r.outcome === 'not_found')).toHaveLength(1);
    const [row] = await pg`SELECT attempts, attempt_limit FROM question_outbox WHERE id=${ok}`;
    expect([row!.attempts, row!.attempt_limit]).toEqual([20, 23]);
    expect(await auditCount('question.generation_recover')).toBe(before + 1);
    // Stale expectations conflict; cap: 23 + min(5, 2) = 25 once the worker exhausts the new budget.
    const stale = await req('/generation/recover', 'POST', { items: [{ outboxId: ok, expectedAttempts: 20, expectedAttemptLimit: 20 }], extraAttempts: 5, idempotencyKey: randomUUID(), reason });
    expect((await stale.json() as { data: { results: { outcome: string }[] } }).data.results[0]!.outcome).toBe('conflict');
    await pg`UPDATE question_outbox SET attempts=23 WHERE id=${ok}`;
    const capped = await req('/generation/recover', 'POST', { items: [{ outboxId: ok, expectedAttempts: 23, expectedAttemptLimit: 23 }], extraAttempts: 5, idempotencyKey: randomUUID(), reason });
    expect((await capped.json() as { data: { results: { granted: number; attemptLimit: number }[] } }).data.results[0]).toMatchObject({ granted: 2, attemptLimit: 25 });
    await pg`UPDATE question_outbox SET attempts=25 WHERE id=${ok}`;
    const full = await req('/generation/recover', 'POST', { items: [{ outboxId: ok, expectedAttempts: 25, expectedAttemptLimit: 25 }], extraAttempts: 1, idempotencyKey: randomUUID(), reason });
    expect((await full.json() as { data: { results: { outcome: string }[] } }).data.results[0]!.outcome).toBe('limit_reached');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recovery: replay, 409 on changed payload, stale sign-in accepted (D-1841), tampered object rejected', async () => {
    const id = await outbox(student);
    const body = { items: [{ outboxId: id, expectedAttempts: 20, expectedAttemptLimit: 20 }], extraAttempts: 2, idempotencyKey: randomUUID(), reason };
    const before = await auditCount('question.generation_recover');
    const first = (await (await req('/generation/recover', 'POST', body, admin, 60 * 60_000)).json() as { data: { replayed: boolean } }).data;
    const again = (await (await req('/generation/recover', 'POST', body)).json() as { data: { replayed: boolean } }).data;
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    const [row] = await pg`SELECT attempt_limit FROM question_outbox WHERE id=${id}`;
    expect(row!.attempt_limit).toBe(22);
    expect((await req('/generation/recover', 'POST', { ...body, extraAttempts: 3 })).status).toBe(409);
    expect(await auditCount('question.generation_recover')).toBe(before + 3);
    const tampered = await outbox(student);
    const [t] = await pg`SELECT payload_reference FROM question_outbox WHERE id=${tampered}`;
    objects.set(String(t!.payload_reference), receipt(other, randomUUID()));
    const bad = await req('/generation/recover', 'POST', { items: [{ outboxId: tampered, expectedAttempts: 20, expectedAttemptLimit: 20 }], extraAttempts: 1, idempotencyKey: randomUUID(), reason });
    expect((await bad.json() as { data: { results: { outcome: string }[] } }).data.results[0]!.outcome).toBe('replay_metadata_invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('owner sees only own outbox metadata; admin list filters by owner/state; metrics count cost 0 as unknown', async () => {
    const mine = await outbox(other), theirs = await outbox(student);
    const own = await userApp.request('/generation/outbox?state=exhausted', { headers: { 'x-user': other } });
    expect(own.status).toBe(200);
    const ownText = await own.text();
    expect(ownText).not.toMatch(/questions\/generation|payload|ownerId/);
    const ids = (JSON.parse(ownText) as { data: { items: { outboxId: string }[] } }).data.items.map((i) => i.outboxId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect((await userApp.request('/generation/outbox?cursor=forged', { headers: { 'x-user': other } })).status).toBe(422);

    const list = await req(`/generation/outbox?ownerId=${student}&limit=1`);
    expect(list.status).toBe(200);
    const page = (await list.json() as { data: { items: { ownerId: string; state: string }[]; nextCursor: string | null; audit: unknown } }).data;
    expect(page.items[0]).toMatchObject({ ownerId: student, state: 'exhausted' });
    expect(page.nextCursor).toBeTruthy();
    expect((await req(`/generation/outbox?ownerId=${other}&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`)).status).toBe(422);
    expect((await req('/generation/outbox', 'GET', undefined, student)).status).toBe(404);

    await run(other, 0); await run(other, 7);
    const m = await req('/generation/metrics?windowHours=1');
    expect(m.status).toBe(200);
    const metrics = (await m.json() as { data: { cost: { runs: number; runsWithKnownCost: number; runsWithUnknownCost: number; knownCostCents: number }; backlog: { target: string; exhausted: number }[] } }).data;
    expect(metrics.cost.runs).toBe(metrics.cost.runsWithKnownCost + metrics.cost.runsWithUnknownCost);
    expect(metrics.cost.runsWithUnknownCost).toBeGreaterThanOrEqual(1);
    expect(metrics.cost.knownCostCents).toBeGreaterThanOrEqual(7);
    expect(metrics.backlog.find((b) => b.target === 'question-receipt')!.exhausted).toBeGreaterThanOrEqual(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
