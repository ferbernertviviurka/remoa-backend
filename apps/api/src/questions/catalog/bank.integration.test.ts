/** F34 BE-1 (CCR-147): list filters/sort/progress, facets, drawer answer, templates. Synthetic data, isolated f33_test database only. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { db as database } from '@remoa/db';
import { assertF33TestDb } from '../test-db-guard';
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => {}) }));
const url = process.env.DATABASE_URL;
assertF33TestDb(url);
const FORBIDDEN = /correctKey|explanation|distractorNotes|expectedAnswer|verdict|reviewerCrm/;
type Q = { id: string; areaId: string | null; topicId: string | null; difficulty: string; createdAt: string; progress?: string };
type Counted = { count: number };
type D = { total: number; nextCursor: string | null; items: Q[]; id: string; limit: number | null; result: string; last: unknown; areas: (Counted & { id: string })[]; topics: unknown; years: unknown; institutions: { name: string }[]; difficulties: (Counted & { value: string })[] };
type Body = { data: D; error?: { code: string; message: string } };
describe.skipIf(!url)('F34 BE-1 student bank', () => {
  let db: typeof database.$client, app: ReturnType<typeof import('../../app').createApp>;
  const owner = randomUUID(), other = randomUUID(), racer = randomUUID(), reviewer = randomUUID(), source = randomUUID(), paper = randomUUID(), areaA = randomUUID(), areaB = randomUUID();
  const topics: string[] = [randomUUID(), randomUUID(), randomUUID()], names = ['Alpha topic', 'Beta topic', 'Gamma topic'], topicArea = [areaA, areaA, areaB];
  const ids: string[] = [], draft = randomUUID(), foreignPrivate = randomUUID(), discursive = randomUUID();
  const diffs = ['easy', 'medium', 'hard'] as const;
  const alternatives = JSON.stringify(['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, text: 'Synthetic choice ' + key })));
  const seen: string[] = [];
  async function request(path: string, method = 'GET', body?: unknown, user = owner) {
    const res = await app.request('/v1' + path, { method, headers: { authorization: 'Bearer ' + user, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); seen.push(text);
    return { status: res.status, body: JSON.parse(text) as Body };
  }
  const publish = async (id: string, i: number, type = 'objective') => {
    await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin) VALUES(${id},${owner},${type},${diffs[i % 3]!},${'Synthetic question ' + i},${type === 'objective' ? alternatives : null}::text::jsonb,${type === 'objective' ? 'E' : null},'Synthetic E','student','Synthetic explanation','user_authored')`;
    await db`UPDATE question_bank SET user_id=null,visibility='public',origin='official_exam',source_id=${source},status='approved',rights_status='authorized',integrity_confirmed=true,key_final=true,enamed_confirmed=true,enamed_area_id=${topicArea[i % 3]!},enamed_topic_id=${topics[i % 3]!},content_hash=${'a'.repeat(64)},reviewed_hash=${'a'.repeat(64)},reviewer_name='Synthetic reviewer',reviewer_crm='12345-SP',reference_date='2026-10-08' WHERE id=${id}`;
    await db`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${id},${reviewer},'Synthetic reviewer','12345-SP',${'a'.repeat(64)},'approved','Synthetic test only','2026-10-08')`;
    await db`UPDATE question_bank SET catalog_status='published',created_at=${'2026-01-01T00:' + String(10 + (i % 20)) + ':00Z'}::timestamptz WHERE id=${id}`;
  };
  beforeAll(async () => {
    db = (await import('@remoa/db')).db.$client;
    process.env.SHARE_SECRET = 'synthetic-f34-cursor-secret'; delete process.env.QUESTIONS_BANK_STUDENT_ENABLED;
    for (const id of [owner, other, racer, reviewer]) await db`INSERT INTO auth.users(id,email) VALUES(${id},${id + '@f34.example'})`;
    await db`UPDATE profiles SET role='reviewer',name='Synthetic reviewer',crm='12345-SP' WHERE user_id=${reviewer}`;
    await db`DELETE FROM entitlement_grants WHERE user_id IN (${owner},${other},${racer})`; // sign-up trial off: Free plan
    await db`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence) VALUES(${source},'Synthetic source','Synthetic','https://example.org','authorized','Synthetic test authorization')`;
    for (const [id, name] of [[areaA, 'Area A'], [areaB, 'Area B']] as const) await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${id},${id},'area','CM',${name})`;
    for (const [i, id] of topics.entries()) await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${id},${id},'topic','CM',${names[i]!},${topicArea[i]!})`;
    for (let i = 0; i < 60; i++) { const id = randomUUID(); ids.push(id); await publish(id, i); }
    await publish(discursive, 0, 'discursive');
    await db`INSERT INTO exam_papers(id,source_id,name,institution,year,edition,booklet,status,key_final) VALUES(${paper},${source},'Synthetic paper','Synthetic Inst','2025','t','A','published',true)`;
    for (const [i, q] of ids.slice(0, 30).entries()) await db`INSERT INTO exam_question_occurrences(paper_id,question_id,ordinal,original_number) VALUES(${paper},${q},${i + 1},${String(i + 1)})`;
    // a public draft and another owner's private question never reach the student
    await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin) VALUES(${draft},${other},'objective','easy','Synthetic draft',${alternatives}::text::jsonb,'E','x','student','x','user_authored')`;
    await db`UPDATE question_bank SET user_id=null,visibility='public',origin='official_exam',source_id=${source},catalog_status='draft',enamed_area_id=${areaA} WHERE id=${draft}`;
    await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin) VALUES(${foreignPrivate},${other},'objective','easy','Synthetic private of other',${alternatives}::text::jsonb,'E','x','student','x','user_authored')`;
    const { createApp } = await import('../../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => ([owner, other, racer] as string[]).includes(t) ? { userId: t, sessionId: null, account: { hasProfile: true, deletedAt: null, suspendedAt: null } } : null });
  });
  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM question_sessions WHERE user_id IN (${owner},${other},${racer})`;
    await db`DELETE FROM exam_templates WHERE user_id IN (${owner},${other},${racer})`;
    await db`DELETE FROM exam_papers WHERE id=${paper}`;
    await db`DELETE FROM question_bank WHERE id=ANY(${[...ids, draft, foreignPrivate, discursive]}::uuid[])`;
    await db`DELETE FROM question_sources WHERE id=${source}`;
    await db`DELETE FROM enamed_taxonomy WHERE id=ANY(${topics}::uuid[])`; await db`DELETE FROM enamed_taxonomy WHERE id IN (${areaA},${areaB})`;
    await db`DELETE FROM auth.users WHERE id IN (${owner},${other},${racer},${reviewer})`;
    await db.end({ timeout: 1 });
  });
  const q = (extra = '') => `/questions?scope=catalog&sourceId=${source}${extra}`;
  async function pages(extra: string) {
    const out: Q[][] = []; let cursor: string | null = null;
    do { const r = await request(q(`&limit=25${extra}` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))); expect(r.status).toBe(200); out.push(r.body.data.items); cursor = r.body.data.nextCursor; } while (cursor);
    return out;
  }

  it('RLS A/B: drafts, other private questions, other templates and attempts stay invisible', async () => {
    const list = await request(q('&limit=50')); expect(list.body.data.total).toBe(61); // 60 + the discursive; no draft
    expect(list.body.data.items.map((i: Q) => i.id)).not.toContain(draft);
    expect((await request('/questions/' + draft)).status).toBe(404);
    expect((await request('/questions/' + foreignPrivate)).status).toBe(404);
    expect((await request(`/questions/${foreignPrivate}/answer`, 'POST', { selectedKey: 'E', mutationId: randomUUID(), elapsedMs: 5 })).status).toBe(404);
    expect((await request(`/questions/${foreignPrivate}/attempt`)).status).toBe(404);
    const f = await request(`/questions/facets?scope=catalog&sourceId=${source}`); expect(f.body.data.total).toBe(61);
  });

  it('answer key never appears before an answer (list, facets, detail, templates)', async () => {
    await request(q('&sort=topic&limit=50')); await request(`/questions/facets?sourceId=${source}`); await request('/questions/' + ids[0]); await request('/exam-templates');
    expect(seen.filter((t) => FORBIDDEN.test(t))).toEqual([]);
  });

  it('multivalue filters: OR inside a group, AND across groups', async () => {
    const sqlCount = async (area: string[], diff: string[]) => Number((await db`SELECT count(*)::int n FROM question_bank WHERE source_id=${source} AND type='objective' AND enamed_area_id=ANY(${area}::uuid[]) AND difficulty::text=ANY(${diff})`)[0]!.n);
    const either = await request(q(`&areaIds=${areaA}&areaIds=${areaB}&limit=50`)); expect(either.body.data.total).toBe(await sqlCount([areaA, areaB], diffs as unknown as string[]) );
    const and = await request(q(`&areaIds=${areaA}&difficulties=easy&difficulties=hard&limit=50`)); expect(and.body.data.total).toBe(await sqlCount([areaA], ['easy', 'hard']));
    expect(and.body.data.items.every((i: Q) => i.areaId === areaA && ['easy', 'hard'].includes(i.difficulty))).toBe(true);
    const one = await request(q(`&topicIds=${topics[0]}&limit=50`)); expect(one.body.data.total).toBe(21);
    const years = await request(q(`&years=2025&years=2030&limit=50`)); expect(years.body.data.total).toBe(30);
    expect((await request(q(`&areaIds=${areaA}&areaIds=${areaA}`))).status).toBe(422);
  });

  it.each(['recent', 'difficulty', 'topic'])('sort=%s paginates 25/25/11 stable with no duplicates', async (sort) => {
    const all = await pages(`&sort=${sort}`); expect(all.map((p) => p.length)).toEqual([25, 25, 11]);
    const flat = all.flat(), idsSeen = flat.map((i) => i.id); expect(new Set(idsSeen).size).toBe(61);
    const single = (await request(q(`&sort=${sort}&limit=50`))).body.data.items.map((i: Q) => i.id); expect(idsSeen.slice(0, 50)).toEqual(single); // same order as one big page
    if (sort === 'difficulty') { const rank = flat.map((i) => (diffs as readonly string[]).indexOf(i.difficulty)); expect(rank).toEqual([...rank].sort((a, b) => a - b)); }
    if (sort === 'topic') { const n = flat.map((i) => (i.topicId ? names[topics.indexOf(i.topicId)]! : '\u{10FFFF}')); expect(n).toEqual([...n].sort()); }
    if (sort === 'recent') { const at = flat.map((i) => Date.parse(i.createdAt)); expect(at).toEqual([...at].sort((a, b) => b - a)); }
  });

  it('cursor is bound to sort, filters and owner', async () => {
    const first = await request(q('&sort=difficulty&limit=5')); const cur = encodeURIComponent(String(first.body.data.nextCursor));
    expect((await request(q(`&sort=topic&limit=5&cursor=${cur}`))).status).toBe(422);
    expect((await request(q(`&sort=difficulty&limit=5&difficulties=easy&cursor=${cur}`))).status).toBe(422);
    expect((await request(q(`&sort=difficulty&limit=5&cursor=${cur}`), 'GET', undefined, other)).status).toBe(422);
    expect((await request(q(`&sort=difficulty&limit=5&cursor=${cur}`))).status).toBe(200);
  });

  it('facets: disjunctive counts equal SQL, eligible only', async () => {
    const f = await request(`/questions/facets?scope=catalog&sourceId=${source}&difficulties=easy&areaIds=${areaA}`); expect(f.status).toBe(200);
    const d = f.body.data;
    const sqlTotal = Number((await db`SELECT count(*)::int n FROM question_bank WHERE source_id=${source} AND difficulty='easy' AND enamed_area_id=${areaA} AND visibility='public' AND catalog_status='published'`)[0]!.n);
    expect(d.total).toBe(sqlTotal);
    // area group ignores its own filter (difficulty easy only), difficulty group ignores its own (area A only)
    const byArea = await db`SELECT enamed_area_id id,count(*)::int n FROM question_bank WHERE source_id=${source} AND difficulty='easy' AND catalog_status='published' GROUP BY 1`;
    expect(Object.fromEntries(d.areas.map((a) => [a.id, a.count]))).toEqual(Object.fromEntries(byArea.map((r) => [r.id, r.n])));
    const byDiff = await db`SELECT difficulty::text d,count(*)::int n FROM question_bank WHERE source_id=${source} AND enamed_area_id=${areaA} AND catalog_status='published' GROUP BY 1`;
    expect(Object.fromEntries(d.difficulties.map((a) => [a.value, a.count]))).toEqual(Object.fromEntries(byDiff.map((r) => [r.d, r.n])));
    expect(d.years).toEqual([{ year: 2025, count: Number((await db`SELECT count(DISTINCT o.question_id)::int n FROM exam_question_occurrences o JOIN question_bank q ON q.id=o.question_id WHERE o.paper_id=${paper} AND q.difficulty='easy' AND q.enamed_area_id=${areaA}`)[0]!.n) }]);
    expect(d.institutions[0]!.name).toBe('Synthetic Inst');
    const t = await request(`/questions/facets?sourceId=${source}&groups=topic&topicQuery=beta`); expect(t.body.data.topics).toEqual([{ id: topics[1], name: 'Beta topic', count: 20 }]); expect(t.body.data.areas).toBeUndefined();
    expect((await request('/questions/facets?bogus=1')).status).toBe(422);
  });

  it('drawer answer: server corrects, idempotent by mutationId, concurrent calls record one attempt', async () => {
    const target = ids[3]!, mutationId = randomUUID(), body = { selectedKey: 'A', mutationId, elapsedMs: 1200 };
    expect((await request(`/questions/${target}/attempt`)).body.data).toEqual({ last: null });
    const [a, b] = await Promise.all([request(`/questions/${target}/answer`, 'POST', body), request(`/questions/${target}/answer`, 'POST', body)]);
    expect([a.status, b.status]).toEqual([200, 200]); expect(a.body.data).toEqual(b.body.data);
    expect(a.body.data).toMatchObject({ questionId: target, selectedKey: 'A', result: 'incorrect', reference: { correctKey: 'E', questionId: target } });
    expect(Number((await db`SELECT count(*)::int n FROM question_answers WHERE user_id=${owner} AND mutation_id=${mutationId}`)[0]!.n)).toBe(1);
    expect(Number((await db`SELECT count(*)::int n FROM question_sessions WHERE user_id=${owner} AND config ? 'drawer'`)[0]!.n)).toBe(1);
    expect((await request(`/questions/${target}/answer`, 'POST', body)).body.data).toEqual(a.body.data); // sequential retry
    expect((await request(`/questions/${target}/answer`, 'POST', { ...body, selectedKey: 'B' })).status).toBe(409); // mutationId reused
    const last = await request(`/questions/${target}/attempt`); expect(last.body.data.last).toMatchObject({ selectedKey: 'A', result: 'incorrect' });
    expect((await request(`/questions/${target}/attempt`, 'GET', undefined, other)).body.data).toEqual({ last: null }); // other's attempts
    // later correct attempt wins; progress follows
    const ok = await request(`/questions/${target}/answer`, 'POST', { selectedKey: 'E', mutationId: randomUUID(), elapsedMs: 900 }); expect(ok.body.data.result).toBe('correct');
    const wrong = await request(`/questions/${ids[4]}/answer`, 'POST', { selectedKey: 'B', mutationId: randomUUID(), elapsedMs: 900 }); expect(wrong.body.data.result).toBe('incorrect');
    const all = (await pages('')).flat(); const prog = (id: string) => all.find((i: Q) => i.id === id)!.progress;
    expect([prog(target), prog(ids[4]!), prog(ids[5]!)]).toEqual(['correct', 'wrong', 'unseen']);
    expect((await request(q('&limit=50'), 'GET', undefined, other)).body.data.items.every((i: Q) => i.progress === 'unseen')).toBe(true);
    expect((await request(q('&state=wrong&limit=50'))).body.data.total).toBe(1);
  });

  it('drawer answer rejects discursive (409) and bad input', async () => {
    const r = await request(`/questions/${discursive}/answer`, 'POST', { selectedKey: 'A', mutationId: randomUUID(), elapsedMs: 1 });
    expect(r.status).toBe(409); expect(r.body.error?.message).toBe('discursive_use_challenge');
    expect((await request(`/questions/${ids[0]}/answer`, 'POST', { selectedKey: 'Z', mutationId: randomUUID(), elapsedMs: 1 })).status).toBe(422);
    expect((await request(`/questions/${ids[0]}/answer`, 'POST', { selectedKey: 'A', mutationId: randomUUID(), elapsedMs: 1, extra: 1 })).status).toBe(422);
  });

  it('templates: owner only, Free limit 3 (409 limit_reached), name unique, race-safe, delete', async () => {
    const params = (count: number) => ({ count, mode: 'study', source: 'catalog' });
    const created: D[] = [];
    for (let i = 0; i < 3; i++) { const r = await request('/exam-templates', 'POST', { name: 'T' + i, params: params(10 + i) }); expect(r.status).toBe(200); created.push(r.body.data); }
    const full = await request('/exam-templates', 'POST', { name: 'T9', params: params(10) }); expect(full.status).toBe(409); expect(full.body.error?.message).toBe('limit_reached');
    expect((await request('/exam-templates', 'POST', { name: 'T0', params: params(10) })).status).toBe(409);
    const list = await request('/exam-templates'); expect(list.body.data.limit).toBe(3); expect(list.body.data.items).toHaveLength(3);
    expect((await request('/exam-templates', 'GET', undefined, other)).body.data.items).toEqual([]);
    expect((await request('/exam-templates/' + created[0]!.id, 'DELETE', undefined, other)).status).toBe(404);
    expect((await request('/exam-templates/' + created[0]!.id, 'DELETE')).status).toBe(200);
    expect((await request('/exam-templates', 'POST', { name: 'T9', params: params(10) })).status).toBe(200);
    expect((await request('/exam-templates', 'POST', { name: '', params: params(10) })).status).toBe(422);
    const race = await Promise.all(Array.from({ length: 6 }, (_, i) => request('/exam-templates', 'POST', { name: 'R' + i, params: params(10) }, racer)));
    expect(race.filter((r) => r.status === 200)).toHaveLength(3); expect(race.filter((r) => r.status === 409)).toHaveLength(3);
    expect(Number((await db`SELECT count(*)::int n FROM exam_templates WHERE user_id=${racer}`)[0]!.n)).toBe(3);
  });

  it('flag off: new routes 404 without touching data; the legacy list is unchanged', async () => {
    process.env.QUESTIONS_BANK_STUDENT_ENABLED = '0';
    try {
      const before = Number((await db`SELECT count(*)::int n FROM question_answers WHERE user_id=${owner}`)[0]!.n);
      expect((await request(`/questions/facets?sourceId=${source}`)).status).toBe(404);
      expect((await request(`/questions/${ids[0]}/answer`, 'POST', { selectedKey: 'A', mutationId: randomUUID(), elapsedMs: 1 })).status).toBe(404);
      expect((await request(`/questions/${ids[0]}/attempt`)).status).toBe(404);
      expect((await request('/exam-templates')).status).toBe(404);
      expect((await request('/exam-templates', 'POST', { name: 'X', params: { count: 5, mode: 'study' } })).status).toBe(404);
      expect((await request(q(`&sort=topic`))).status).toBe(404);
      expect((await request(q(`&areaIds=${areaA}`))).status).toBe(404);
      const legacy = await request(q('&limit=3')); expect(legacy.status).toBe(200);
      expect(legacy.body.data.items.every((i: Q) => !('progress' in i))).toBe(true);
      expect(Number((await db`SELECT count(*)::int n FROM question_answers WHERE user_id=${owner}`)[0]!.n)).toBe(before);
    } finally { delete process.env.QUESTIONS_BANK_STUDENT_ENABLED; }
  });
});
