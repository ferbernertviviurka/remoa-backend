/** D-1819 against the isolated local f33_test database (0053 applied). Synthetic text only; storage mocked; fetch forbidden. */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { questionInstitutionalApproveResultSchema, questionPublicSchema, questionReferenceAfterAnswerSchema } from '@remoa/contracts';
import { fakeToken, fakeVerifier } from '../core/test-helpers';
import type { AdminEnv } from '../core';
import { assertF33TestDb } from '../../questions/test-db-guard';

vi.mock('../../storage/storage', () => ({ getBytes: vi.fn(), headObject: vi.fn(), putBytes: vi.fn(), deleteObject: vi.fn(), presignGet: vi.fn(async () => 'https://example.invalid/x') }));
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => {}) }));

const url = process.env.DATABASE_URL;
assertF33TestDb(url);
type Out = { id: string; outcome: string; version: number | null; contentHash: string | null };
type Body = { data: { replayed: boolean; sourceId: string; results: Out[]; audit: { id: number } }; error?: { message: string } };

describe.skipIf(!url)('F33 institutional approval (D-1819)', () => {
  const admin = randomUUID(), student = randomUUID(), reviewer = randomUUID(), other = randomUUID();
  const area = randomUUID(), topic = randomUUID(), area2 = randomUUID(), topic2 = randomUUID(), foreign = randomUUID();
  const STEM = 'Enunciado sintético D1819 ' + admin.slice(0, 8), EXPL = 'Explicação sintética D1819';
  const ALTS = ['A', 'B', 'C', 'D'].map((key) => ({ key, text: 'Alternativa sintética ' + key }));
  const attestation = { approverRole: 'medical_founder', approverName: 'Fundadora Sintética', rightsBasis: 'remoa_owned', acceptsUnconfirmedChecks: true };
  const reason = 'Aprovação institucional sintética';
  let pg: typeof import('@remoa/db').db.$client;
  let app: Hono<AdminEnv>, userApp: ReturnType<typeof import('../../app').createApp>;
  let contentHash: typeof import('../../questions/imports/domain').contentHash;

  const req = (body: unknown, who = admin, agoMs = 60_000) =>
    app.request('/institutional-approval', { method: 'POST', headers: { authorization: 'Bearer ' + fakeToken(who, agoMs), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const approve = async (items: unknown[], extra: Record<string, unknown> = {}) => {
    const res = await req({ items, attestation, idempotencyKey: randomUUID(), reason, ...extra });
    return { status: res.status, body: await res.json() as Body };
  };
  const user = async (path: string, method = 'GET', body?: unknown) => {
    const res = await userApp.request('/v1' + path, { method, headers: { authorization: 'Bearer ' + student, 'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as { data: Record<string, unknown> & { items: { id: string }[] } } };
  };
  const auditCount = async () => Number((await pg`SELECT count(*)::int n FROM admin_audit_log WHERE actor_id=${admin} AND action='question.institutional_approve'`)[0]!.n);
  type Q = { origin?: string; key?: string | null; explanation?: string | null; areaId?: string | null; topicId?: string | null; sourceId?: string | null; hash?: 'canonical' | null; userId?: string | null; availability?: string; type?: string };
  const question = async (o: Q = {}) => {
    const id = randomUUID();
    const disc = o.type === 'discursive', alts = disc ? null : ALTS;
    const c = { key: disc ? null : o.key === undefined ? 'B' : o.key, explanation: o.explanation === undefined ? EXPL : o.explanation, areaId: o.areaId === undefined ? area : o.areaId, topicId: o.topicId === undefined ? topic : o.topicId };
    const hash = o.hash === null ? null : contentHash({ stem: STEM, alternatives: alts, correctKey: c.key, explanation: c.explanation, areaId: c.areaId, topicId: c.topicId, annulled: o.availability === 'annulled', assets: [] });
    await pg`INSERT INTO question_bank(id,user_id,visibility,origin,source,source_id,type,difficulty,stem,expected_answer,alternatives,correct_key,explanation,enamed_area_id,enamed_topic_id,status,catalog_status,availability,content_hash)
      VALUES(${id},${o.userId ?? null},${o.userId ? 'private' : 'public'},${o.origin ?? 'remoa_authored'},'ai',${o.sourceId ?? null},${o.type ?? 'objective'},'medium',${STEM},'Resposta sintética',${alts ? JSON.stringify(alts) : null}::jsonb,${c.key},${c.explanation},${c.areaId},${c.topicId},'draft','in_review',${o.availability ?? 'active'},${hash})`;
    return { id, revision: 1, expectedContentHash: hash ?? 'f'.repeat(64) };
  };

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('network forbidden in this test'); }));
    process.env.SHARE_SECRET ||= 'synthetic-institutional-secret';
    const db = await import('@remoa/db');
    pg = db.db.$client;
    ({ contentHash } = await import('../../questions/imports/domain'));
    for (const id of [admin, student, reviewer, other]) await pg`INSERT INTO auth.users(id,email) VALUES(${id},${id + '@f33.example'})`;
    await pg`UPDATE profiles SET role='admin',name='Synthetic Admin' WHERE user_id=${admin}`;
    await pg`UPDATE profiles SET role='reviewer',name='Synthetic reviewer',crm='12345-SP' WHERE user_id=${reviewer}`;
    await pg`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','Synthetic CM'),(${area2},${area2},'area','GO','Synthetic GO')`;
    await pg`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','Synthetic topic',${area}),(${topic2},${topic2},'topic','GO','Synthetic GO topic',${area2})`;
    await pg`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence) VALUES(${foreign},'Fonte externa sintética','Testes','https://example.org','authorized','Synthetic authorization')`;
    const { questionAdminRoutes } = await import('./routes');
    const { requireAdmin } = await import('../core');
    const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as AdminEnv['Variables']['log'];
    app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => { c.set('log', log); c.set('requestId', randomUUID()); await next(); });
    app.use('*', requireAdmin(fakeVerifier([admin, student])));
    app.route('/', questionAdminRoutes);
    const { createApp } = await import('../../app');
    userApp = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (t === student ? { userId: t, sessionId: null, account: { hasProfile: true, deletedAt: null, suspendedAt: null } } : null) });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await pg?.end({ timeout: 1 });
  });

  it('happy path: 3 items published with the Remoa seal; one audit row without text; flags untouched', async () => {
    const items = [await question(), await question(), await question()];
    const before = await auditCount();
    const { status, body } = await approve(items);
    expect(status).toBe(200);
    const data = questionInstitutionalApproveResultSchema.parse({ ...body.data, audit: body.data.audit });
    expect(data.replayed).toBe(false);
    expect(data.results.map((r) => r.outcome)).toEqual(['published', 'published', 'published']);
    const rows = await pg`SELECT q.catalog_status, q.status, q.validation_kind, q.reviewer_crm, q.reviewer_name, q.rights_status, q.reviewed_hash=q.content_hash same,
      q.integrity_confirmed, q.key_final, q.enamed_confirmed, q.source_id, s.rights_scope, s.rights_evidence, r.kind, r.reviewer_crm r_crm, r.user_id r_user
      FROM question_bank q JOIN question_sources s ON s.id=q.source_id JOIN question_editorial_reviews r ON r.question_id=q.id WHERE q.id IN ${pg(items.map((i) => i.id))}`;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ catalog_status: 'published', status: 'approved', validation_kind: 'remoa_institutional', reviewer_crm: null, reviewer_name: 'Fundadora Sintética',
      rights_status: 'authorized', same: true, integrity_confirmed: false, key_final: false, enamed_confirmed: false, source_id: data.sourceId, rights_scope: 'remoa_owned', kind: 'remoa_institutional', r_crm: null, r_user: admin });
    expect(String(rows[0]!.rights_evidence)).toMatch(/^Conteúdo próprio da Remoa; atestado por .+ \(founder médica\) em \d{4}-\d{2}-\d{2}, D-1819$/);
    expect(await auditCount()).toBe(before + 1);
    const [audit] = await pg`SELECT target_type, before, after FROM admin_audit_log WHERE id=${body.data.audit.id}`;
    expect(audit!.target_type).toBe('question_batch');
    expect(audit!.after).toMatchObject({ approverRole: 'medical_founder', approverName: 'Fundadora Sintética', rightsBasis: 'remoa_owned', sourceId: data.sourceId });
    expect(JSON.stringify([audit!.before, audit!.after])).not.toMatch(/Enunciado|Alternativa|Explicação|correct/i);

    // public DTO + reference after answer: seal "Remoa", never a CRM or a reviewer name
    const pub = await user('/questions/' + items[0]!.id);
    expect(pub.status).toBe(200);
    const q = questionPublicSchema.parse(pub.body.data);
    expect(q.validation).toEqual({ kind: 'remoa_institutional', label: 'Remoa' });
    expect(JSON.stringify(pub.body)).not.toMatch(/crm|Fundadora/i);
    const created = await user('/question-sessions', 'POST', { mode: 'study', questionIds: [items[0]!.id], count: 1 });
    expect(created.status).toBe(200);
    const session = created.body.data as { id: string; items: { id: string }[] };
    const path = '/question-sessions/' + session.id + '/items/' + session.items[0]!.id;
    expect((await user(path + '/answer', 'PUT', { selectedKey: 'A', mutationId: randomUUID(), revision: 0, elapsedMs: 100 })).status).toBe(200);
    const ref = questionReferenceAfterAnswerSchema.parse((await user(path + '/reference')).body.data);
    expect(ref).toMatchObject({ reviewed: true, reviewerName: null, reviewerCrm: null, validation: { kind: 'remoa_institutional', label: 'Remoa' } });

    // replay: same payload (reordered) = stored results; 409 on changed payload; each call one audit row
    const key = randomUUID(), fresh = await question();
    const first = await approve([fresh], { idempotencyKey: key });
    const again = await req({ items: [fresh], attestation, idempotencyKey: key, reason: 'Outro motivo, mesmo pedido' });
    const r2 = (await again.json() as Body).data;
    expect(r2.replayed).toBe(true);
    expect(r2.results).toEqual(first.body.data.results);
    expect(r2.sourceId).toBe(data.sourceId);
    const changed = await req({ items: [fresh], attestation: { ...attestation, approverName: 'Outra Fundadora' }, idempotencyKey: key, reason });
    expect(changed.status).toBe(409);
    expect((await changed.json() as Body).error!.message).toBe('idempotency_key_payload_changed');
    expect(await auditCount()).toBe(before + 4);
    // second call on an already published item
    expect((await approve([items[1]!])).body.data.results[0]!.outcome).toBe('already_published');
  });

  it('every negative outcome, nothing written for skipped items', async () => {
    const cases: [string, Promise<{ id: string; revision: number; expectedContentHash: string }>][] = [
      ['not_eligible', question({ origin: 'official_exam' })],
      ['not_eligible', question({ userId: student })],
      ['hash_missing', question({ hash: null })],
      ['answer_key_missing', question({ type: 'discursive' })],
      ['answer_key_missing', question({ availability: 'annulled' })],
      ['taxonomy_missing', question({ areaId: null })],
      ['taxonomy_missing', question({ topicId: topic2 })],
      ['explanation_missing', question({ explanation: null })],
      ['explanation_missing', question({ explanation: '   ' })],
      ['source_mismatch', question({ sourceId: foreign })],
    ];
    const items = await Promise.all(cases.map(([, p]) => p));
    const stale = await question(), wrongHash = await question();
    const missing = { id: randomUUID(), revision: 1, expectedContentHash: 'a'.repeat(64) };
    const all = [...items, { ...stale, revision: 2 }, { ...wrongHash, expectedContentHash: 'e'.repeat(64) }, missing];
    const { status, body } = await approve(all);
    expect(status).toBe(200);
    const out = Object.fromEntries(body.data.results.map((r) => [r.id, r.outcome]));
    cases.forEach(([want], i) => expect([i, out[items[i]!.id]]).toEqual([i, want]));
    expect(out[stale.id]).toBe('conflict');
    expect(out[wrongHash.id]).toBe('conflict');
    expect(out[missing.id]).toBe('not_found');
    const touched = await pg`SELECT count(*)::int n FROM question_bank WHERE id IN ${pg(all.map((i) => i.id))} AND (catalog_status<>'in_review' OR validation_kind<>'medical_review' OR status<>'draft')`;
    expect(touched[0]!.n).toBe(0);
    expect((await pg`SELECT count(*)::int n FROM question_editorial_reviews WHERE question_id IN ${pg(all.map((i) => i.id))}`)[0]!.n).toBe(0);
  });

  it('race: two parallel calls (different keys) on the same items publish each item exactly once', async () => {
    const items = [await question(), await question(), await question()];
    const [x, y] = await Promise.all([0, 1].map(() => approve(items)));
    for (const item of items) {
      const pair = [x!, y!].map((r) => r.body.data.results.find((o) => o.id === item.id)!.outcome).sort();
      expect(pair).toEqual(['already_published', 'published']);
    }
    expect((await pg`SELECT count(*)::int n FROM question_editorial_reviews WHERE question_id IN ${pg(items.map((i) => i.id))}`)[0]!.n).toBe(3);
  });

  it('auth gates: non-admin 404, stale sign-in 403 with a denied audit row, short reason 422', async () => {
    const item = await question();
    const body = { items: [item], attestation, idempotencyKey: randomUUID(), reason };
    expect((await req(body, student)).status).toBe(404);
    const before = Number((await pg`SELECT count(*)::int n FROM admin_audit_log WHERE actor_id=${admin} AND action='question.institutional_approve' AND result='denied'`)[0]!.n);
    expect((await req(body, admin, 2 * 60 * 60_000)).status).toBe(403);
    expect((await req({ ...body, reason: 'curto' })).status).toBe(422);
    expect(Number((await pg`SELECT count(*)::int n FROM admin_audit_log WHERE actor_id=${admin} AND action='question.institutional_approve' AND result='denied'`)[0]!.n)).toBe(before + 2);
    expect((await pg`SELECT catalog_status FROM question_bank WHERE id=${item.id}`)[0]!.catalog_status).toBe('in_review');
  });

  it('triggers and publish_chk refuse an institutional seal outside its scope', async () => {
    const { body } = await approve([await question()]);
    const remoa = body.data.sourceId;
    const fails = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };
    const official = await question({ origin: 'official_exam', sourceId: remoa });
    const ins = (id: string, who: string, crm: string | null, hash: string) =>
      pg`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,kind,content_hash,decision,reason,reference_date) VALUES(${id},${who},'Fundadora Sintética',${crm},'remoa_institutional',${hash},'approved',${reason},'2026-10-12')`;
    await fails(ins(official.id, admin, null, official.expectedContentHash), /institutional_scope_required/);
    const own = await question({ sourceId: remoa });
    await fails(ins(own.id, admin, '12345-SP', own.expectedContentHash), /invalid_institutional_attestation|question_editorial_identity_chk/);
    await fails(ins(own.id, student, null, own.expectedContentHash), /active_admin_required/);
    await fails(ins(own.id, reviewer, null, own.expectedContentHash), /active_admin_required/);
    // medical seal cannot be skipped: publishing an approved remoa_authored row as medical without CRM/flags fails
    await fails(pg`UPDATE question_bank SET status='approved',catalog_status='published',rights_status='authorized',reviewed_hash=content_hash,reviewer_name='X',reference_date='2026-10-12' WHERE id=${own.id}`, /medical|publish_chk|signature/);
    // institutional seal with a CRM or on a non-remoa_authored row violates publish_chk/trigger
    await fails(pg`UPDATE question_bank SET validation_kind='remoa_institutional',status='approved',catalog_status='published',rights_status='authorized',reviewed_hash=content_hash,reviewer_name='X',reviewer_crm='1-SP',reference_date='2026-10-12' WHERE id=${own.id}`, /institutional_scope_required|publish_chk/);
    await fails(pg`UPDATE question_bank SET validation_kind='remoa_institutional',status='approved',catalog_status='published',rights_status='authorized',reviewed_hash=content_hash,reviewer_name='X',reference_date='2026-10-12' WHERE id=${official.id}`, /institutional_scope_required|publish_chk/);
    // a published institutional seal is immutable
    const [pubId] = body.data.results.map((r) => r.id);
    await fails(pg`UPDATE question_bank SET validation_kind='medical_review' WHERE id=${pubId!}`, /published_content_immutable/);
  });

  it('revoked Remoa source: whole call 409 remoa_source_rights_revoked, never re-authorized', async () => {
    const item = await question();
    const [src] = await pg`SELECT id FROM question_sources WHERE rights_scope='remoa_owned'`;
    await pg`UPDATE question_sources SET rights_status='revoked' WHERE id=${src!.id}`;
    try {
      const { status, body } = await approve([item]);
      expect(status).toBe(409);
      expect(body.error!.message).toBe('remoa_source_rights_revoked');
      expect((await pg`SELECT rights_status FROM question_sources WHERE id=${src!.id}`)[0]!.rights_status).toBe('revoked');
      expect((await pg`SELECT catalog_status FROM question_bank WHERE id=${item.id}`)[0]!.catalog_status).toBe('in_review');
    } finally {
      await pg`UPDATE question_sources SET rights_status='authorized' WHERE id=${src!.id}`;
    }
  });
});
