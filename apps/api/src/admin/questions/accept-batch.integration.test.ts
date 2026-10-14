/** D-1841 batch accept over HTTP + isolated f33_test database. Synthetic text only; storage mocked; fetch forbidden. */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeToken, fakeVerifier } from '../core/test-helpers';
import type { AdminEnv } from '../core';
import { assertF33TestDb } from '../../questions/test-db-guard';

vi.mock('../../storage/storage', () => ({ getBytes: vi.fn(), headObject: vi.fn(), putBytes: vi.fn(), deleteObject: vi.fn(), presignGet: vi.fn(async () => 'https://example.invalid/x') }));
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => {}) }));

const url = process.env.DATABASE_URL;
assertF33TestDb(url);
type Body = { data?: { results: { id: string; outcome: string; questionId: string | null }[]; importRevision: number; audit: { id: number } }; error?: { code: string; message: string } };

describe.skipIf(!url)('F33 batch accept candidates (D-1841)', () => {
  const admin = randomUUID(), student = randomUUID(), source = randomUUID(), doc = randomUUID(), paper = randomUUID(), job = randomUUID(), area = randomUUID(), topic = randomUUID();
  const reason = 'Conferi as candidatas sintéticas';
  let pg: typeof import('@remoa/db').db.$client;
  let app: Hono<AdminEnv>;
  let ordinal = 0;

  const rev = async () => Number((await pg`SELECT revision FROM question_imports WHERE id=${job}`)[0]!.revision);
  const candidate = async (over: { correctKey?: string | null; state?: string } = {}) => {
    const id = randomUUID(), n = ++ordinal;
    const payload = { originalNumber: n, stem: 'Enunciado sintético D1841 ' + n, alternatives: [{ key: 'A', text: 'Alternativa A' }, { key: 'B', text: 'Alternativa B' }], correctKey: over.correctKey === undefined ? 'A' : over.correctKey, annulled: false, areaId: area, topicId: topic, imageRefs: [] };
    await pg`INSERT INTO question_import_candidates(id,import_id,ordinal,original_number,payload,provenance,issues,state) VALUES(${id},${job},${n},${String(n)},${JSON.stringify(payload)}::jsonb,${JSON.stringify([{ documentId: doc, page: 1, bbox: [0, 0, 1, 1] }])}::jsonb,${[]},${over.state ?? 'needs_review'})`;
    return { id, revision: 0 };
  };
  const post = async (body: unknown, who = admin, agoMs = 2 * 3_600_000, id = job) => {
    const res = await app.request(`/imports/${id}/candidates/accept`, { method: 'POST', headers: { authorization: 'Bearer ' + fakeToken(who, agoMs), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Body };
  };
  const input = async (items: { id: string; revision: number }[], extra: Record<string, unknown> = {}) => ({ importRevision: await rev(), items, confirmsChecks: true, reason, ...extra });
  const count = async (result?: string) => Number((await pg`SELECT count(*)::int n FROM admin_audit_log WHERE actor_id=${admin} AND action='question.candidate_update' AND target_id=${job} AND (${result ?? null}::text IS NULL OR result=${result ?? null})`)[0]!.n);

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('network forbidden in this test'); }));
    pg = (await import('@remoa/db')).db.$client;
    for (const id of [admin, student]) await pg`INSERT INTO auth.users(id,email) VALUES(${id},${id + '@f33.example'})`;
    await pg`UPDATE profiles SET role='admin',name='Synthetic Accept Admin' WHERE user_id=${admin}`;
    await pg`INSERT INTO question_sources(id,name,publisher,url,rights_status) VALUES(${source},'Fonte sintética D1841','Testes','https://example.org','pending')`;
    await pg`INSERT INTO question_documents(id,user_id,source_id,kind,object_key,sha256,bytes,pages) VALUES(${doc},${admin},${source},'exam',${'questions/documents/' + doc + '.pdf'},${'a'.repeat(64)},100,1)`;
    await pg`INSERT INTO exam_papers(id,source_id,document_id,name,institution,year,edition,booklet) VALUES(${paper},${source},${doc},'Synthetic exam D1841','Synthetic',2026,${paper},'A')`;
    await pg`INSERT INTO question_imports(id,user_id,source_id,paper_id,document_id,idempotency_key,parser_version,status,total_pages,completed_pages) VALUES(${job},${admin},${source},${paper},${doc},${job},'f33-layout-v4','review',1,1)`;
    await pg`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','Synthetic')`;
    await pg`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','Synthetic topic',${area})`;
    const { questionAdminRoutes } = await import('./routes');
    const { requireAdmin } = await import('../core');
    const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as AdminEnv['Variables']['log'];
    app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => { c.set('log', log); c.set('requestId', randomUUID()); await next(); });
    app.use('*', requireAdmin(fakeVerifier([admin, student])));
    app.route('/', questionAdminRoutes);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pg) return;
    await pg`DELETE FROM question_imports WHERE id=${job}`;
    await pg`DELETE FROM exam_papers WHERE id=${paper}`;
    await pg`DELETE FROM question_bank WHERE source_id=${source}`;
    await pg`DELETE FROM question_documents WHERE id=${doc}`;
    await pg`DELETE FROM question_sources WHERE id=${source}`;
    await pg.end({ timeout: 1 });
  });

  it('accepts 3 pending candidates with a 2 h old login: drafts in_review, nothing published, one audit row', async () => {
    const items = [await candidate(), await candidate(), await candidate({ state: 'pending' })];
    const before = await count('success');
    const { status, body } = await post(await input(items));
    expect(status).toBe(200);
    expect(body.data!.results.map((r) => r.outcome)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(body.data!.importRevision).toBe(await rev());
    const cands = await pg`SELECT state, question_id FROM question_import_candidates WHERE id IN ${pg(items.map((i) => i.id))}`;
    expect(cands.every((r) => r.state === 'accepted' && r.question_id)).toBe(true);
    const qs = await pg`SELECT catalog_status, status, published_at FROM question_bank WHERE id IN ${pg(body.data!.results.map((r) => r.questionId!))}`;
    expect(qs).toHaveLength(3);
    for (const q of qs) expect(q).toMatchObject({ catalog_status: 'in_review', published_at: null });
    expect(await count('success')).toBe(before + 1);
    const [audit] = await pg`SELECT after FROM admin_audit_log WHERE id=${body.data!.audit.id}`;
    expect((audit!.after as { results: { id: string; outcome: string }[] }).results.map((r) => [r.id, r.outcome])).toEqual(items.map((i) => [i.id, 'accepted']));
  });

  it('a bad item in the middle reports its outcome and does not block the others', async () => {
    const a = await candidate(), noKey = await candidate({ correctKey: null }), done = await candidate({ state: 'accepted' }), b = await candidate();
    const { status, body } = await post(await input([a, noKey, done, b]));
    expect(status).toBe(200);
    expect(body.data!.results.map((r) => r.outcome)).toEqual(['accepted', 'answer_key_missing', 'already_accepted', 'accepted']);
    expect(body.data!.results.map((r) => r.questionId !== null)).toEqual([true, false, false, true]);
    const rows = await pg`SELECT id, state FROM question_import_candidates WHERE id IN ${pg([a.id, noKey.id, b.id])}`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.state]))).toEqual({ [a.id]: 'accepted', [noKey.id]: 'needs_review', [b.id]: 'accepted' });
  });

  it('non admin gets 404; short reason and missing confirmsChecks get 422; denied rows only for admin', async () => {
    const item = await candidate();
    expect((await post(await input([item]), student)).status).toBe(404);
    const denied = await count('denied');
    const short = await post(await input([item], { reason: 'curto' }));
    expect(short.status).toBe(422);
    expect(await count('denied')).toBe(denied + 1);
    const noCheck = await post(await input([item], { confirmsChecks: false }));
    expect(noCheck.status).toBe(422);
    expect((await post({ ...(await input([item])), confirmsChecks: undefined })).status).toBe(422);
    expect((await pg`SELECT state FROM question_import_candidates WHERE id=${item.id}`)[0]!.state).toBe('needs_review');
  });

  it('stale import revision returns 409 and changes nothing', async () => {
    const item = await candidate();
    const stale = (await input([item])) as { importRevision: number };
    stale.importRevision -= 1;
    const { status, body } = await post(stale);
    expect(status).toBe(409);
    expect(body.error!.code).toBe('conflict');
    expect((await pg`SELECT state FROM question_import_candidates WHERE id=${item.id}`)[0]!.state).toBe('needs_review');
  });
});
