/**
 * D-1819 scale run (opt-in: F33_INST_SCALE=1, isolated f33_test DB only). 10,000 synthetic remoa_authored drafts → D-1804 prepare
 * + institutional approval in 20 batches of 500 through the real handlers; prints total and p95 per batch.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeToken, fakeVerifier } from '../core/test-helpers';
import type { AdminEnv } from '../core';
import { assertF33TestDb } from '../../questions/test-db-guard';

vi.mock('../../storage/storage', () => ({ getBytes: vi.fn(), headObject: vi.fn(), putBytes: vi.fn(), deleteObject: vi.fn(), presignGet: vi.fn() }));
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => {}) }));

const url = process.env.DATABASE_URL;
assertF33TestDb(url);
const N = 10_000, BATCH = 500;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

describe.skipIf(!url || process.env.F33_INST_SCALE !== '1')('D-1819 scale: 10k institutional approvals', () => {
  const admin = randomUUID(), student = randomUUID(), area = randomUUID(), topic = randomUUID(), tag = 'D1819-scale-' + admin.slice(0, 8);
  let pg: typeof import('@remoa/db').db.$client;
  let app: Hono<AdminEnv>, userApp: ReturnType<typeof import('../../app').createApp>;
  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, { method: 'POST', headers: { authorization: 'Bearer ' + fakeToken(admin), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return (await res.json() as { data: { results: { id: string; outcome: string; version: number; contentHash: string }[]; sourceId?: string } }).data;
  };

  beforeAll(async () => {
    process.env.SHARE_SECRET ||= 'synthetic-scale-secret';
    pg = (await import('@remoa/db')).db.$client;
    for (const id of [admin, student]) await pg`INSERT INTO auth.users(id,email) VALUES(${id},${id + '@f33.example'})`;
    await pg`UPDATE profiles SET role='admin',name='Synthetic Admin' WHERE user_id=${admin}`;
    await pg`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','Scale CM')`;
    await pg`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','Scale topic',${area})`;
    const alts = JSON.stringify(['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, text: 'Alternativa sintética ' + key })));
    await pg`INSERT INTO question_bank(user_id,visibility,origin,source,type,difficulty,stem,expected_answer,alternatives,correct_key,explanation,enamed_area_id,enamed_topic_id,status,catalog_status)
      SELECT NULL,'public','remoa_authored','ai','objective','medium',${tag} || ' enunciado sintético ' || g,'Resposta sintética',${alts}::jsonb,'C','Explicação sintética ' || g,${area},${topic},'draft','in_review'
      FROM generate_series(1,${N}) g`;
    const { questionAdminRoutes } = await import('./routes');
    const { requireAdmin } = await import('../core');
    const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as AdminEnv['Variables']['log'];
    app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => { c.set('log', log); c.set('requestId', randomUUID()); await next(); });
    app.use('*', requireAdmin(fakeVerifier([admin])));
    app.route('/', questionAdminRoutes);
    const { createApp } = await import('../../app');
    userApp = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (t === student ? { userId: t, sessionId: null, account: { hasProfile: true, deletedAt: null, suspendedAt: null } } : null) });
  }, 120_000);
  afterAll(async () => { await pg?.end({ timeout: 1 }); });

  it('prepares and publishes 10,000 in 20 batches of 500', async () => {
    const rows = await pg`SELECT id, version, to_char(date_trunc('milliseconds',updated_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at
      FROM question_bank WHERE stem LIKE ${tag + '%'} ORDER BY id`;
    expect(rows).toHaveLength(N);
    const prep: number[] = [], appr: number[] = [];
    let sourceId = '';
    const t0 = performance.now();
    for (let i = 0; i < N; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      let t = performance.now();
      const prepared = await post('/content-hash/prepare', { items: batch.map((r) => ({ id: r.id, revision: Number(r.version), expectedUpdatedAt: r.at })), sourceId: null, idempotencyKey: randomUUID(), reason: 'Preparação sintética em escala' });
      prep.push(performance.now() - t);
      expect(prepared.results.every((r) => r.outcome === 'prepared')).toBe(true);
      t = performance.now();
      const approved = await post('/institutional-approval', {
        items: prepared.results.map((r) => ({ id: r.id, revision: r.version, expectedContentHash: r.contentHash })),
        attestation: { approverRole: 'medical_founder', approverName: 'Fundadora Sintética', rightsBasis: 'remoa_owned', acceptsUnconfirmedChecks: true },
        idempotencyKey: randomUUID(), reason: 'Aprovação institucional sintética em escala',
      });
      appr.push(performance.now() - t);
      expect(approved.results.filter((r) => r.outcome !== 'published')).toEqual([]);
      sourceId = approved.sourceId!;
    }
    const total = performance.now() - t0;
    const [count] = await pg`SELECT count(*) FILTER (WHERE catalog_status='published' AND validation_kind='remoa_institutional' AND reviewer_crm IS NULL AND NOT integrity_confirmed)::int n FROM question_bank WHERE stem LIKE ${tag + '%'}`;
    expect(count!.n).toBe(N);
    const [sqlTotal] = await pg`SELECT count(*)::int n FROM question_bank WHERE source_id=${sourceId} AND catalog_status='published' AND availability IN ('active','annulled')`;
    const res = await userApp.request('/v1/questions?scope=catalog&sourceId=' + sourceId + '&limit=1', { headers: { authorization: 'Bearer ' + student } });
    const list = (await res.json() as { data: { total: number; items: { validation: unknown }[] } }).data;
    expect(list.total).toBe(sqlTotal!.n);
    expect(list.total).toBeGreaterThanOrEqual(N);
    expect(list.items[0]!.validation).toEqual({ kind: 'remoa_institutional', label: 'Remoa' });
    const fmt = (x: number) => Math.round(x);
    process.stdout.write(`D1819_SCALE total_ms=${fmt(total)} prepare_p95_ms=${fmt(p95(prep))} approve_p95_ms=${fmt(p95(appr))} approve_mean_ms=${fmt(appr.reduce((a, b) => a + b) / appr.length)} prepare_mean_ms=${fmt(prep.reduce((a, b) => a + b) / prep.length)} catalog_total=${list.total}\n`);
  }, 1_800_000);
});
