/** F34 G27 exam builder + builder start + drawer, synthetic fixtures on an isolated f33_test database only. */
import { randomUUID } from 'node:crypto';
import { examAvailabilitySchema, examPreviewSchema, examRevalidateResultSchema, examSwapResultSchema, questionSessionsPageResultSchema } from '@remoa/contracts';
import type { db as database } from '@remoa/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertF33TestDb } from '../test-db-guard';
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => {}) }));
const url = process.env.DATABASE_URL;
assertF33TestDb(url);
type Body = { data: Record<string, unknown> & { id?: string; items?: { question: { id: string; stem: string } }[] }; error?: { code: string; message: string } };
describe.skipIf(!url)('F34 exam builder', () => {
  let db: typeof database.$client;
  let app: ReturnType<typeof import('../../app').createApp>;
  const owner = randomUUID(), other = randomUUID(), reviewer = randomUUID(), source = randomUUID(), a1 = randomUUID(), a2 = randomUUID(), topic = randomUUID(), topicB = randomUUID(), topicC = randomUUID();
  const alternatives = ['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, text: 'Synthetic choice ' + key }));
  const pubA1 = Array.from({ length: 6 }, () => randomUUID()), pubA2 = Array.from({ length: 3 }, () => randomUUID());
  const aiA1 = randomUUID(), aiNone = randomUUID(), otherAi = randomUUID();
  const all = [...pubA1, ...pubA2, aiA1, aiNone, otherAi];
  const extra: string[] = [];
  async function request(path: string, method = 'POST', body?: unknown, user = owner, key?: string) {
    const res = await app.request('/v1' + path, { method, headers: { authorization: 'Bearer ' + user, ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Body };
  }
  const filter = (over: Record<string, unknown> = {}) => ({ source: 'catalog', areaIds: [a1, a2], ...over });
  const params = (over: Record<string, unknown> = {}) => ({ ...filter(), count: 5, distribution: 'balanced', mode: 'study', ...over });
  const preview = (body: Record<string, unknown>, user = owner) => request('/exam-builder/preview', 'POST', body, user);
  async function publish(id: string) {
    await db`UPDATE question_bank SET user_id=null,visibility='public',origin='official_exam',source_id=${source},status='approved',rights_status='authorized',integrity_confirmed=true,key_final=true,enamed_confirmed=true,content_hash=${'a'.repeat(64)},reviewed_hash=${'a'.repeat(64)},reviewer_name='Synthetic reviewer',reviewer_crm='12345-SP',reference_date='2026-10-08' WHERE id=${id}`;
    await db`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${id},${reviewer},'Synthetic reviewer','12345-SP',${'a'.repeat(64)},'approved','Synthetic test only','2026-10-08')`;
    await db`UPDATE question_bank SET catalog_status='published',published_at=now(),availability='active' WHERE id=${id}`;
  }
  const finishActive = (user = owner) => db`UPDATE question_sessions SET status='finished',finished_at=now() WHERE user_id=${user} AND status='active'`;
  const startBody = async (ids: string[], seed: string, over: Record<string, unknown> = {}) => ({ mode: 'study', questionIds: ids, count: ids.length, builder: { seed, params: params({ count: ids.length, ...over }) } });

  beforeAll(async () => {
    db = (await import('@remoa/db')).db.$client;
    process.env.SHARE_SECRET = 'synthetic-f34-secret';
    for (const id of [owner, other, reviewer]) await db`INSERT INTO auth.users(id,email) VALUES(${id},${id + '@f34.example'})`;
    await db`UPDATE profiles SET role='reviewer',name='Synthetic reviewer',crm='12345-SP' WHERE user_id=${reviewer}`;
    await db`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence) VALUES(${source},'Synthetic source','Synthetic','https://example.org','authorized','Synthetic test authorization')`;
    for (const id of [a1, a2]) await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${id},${id},'area','CM','Synthetic area')`;
    for (const [id, parent] of [[topic, a1], [topicB, a1], [topicC, a2]]) await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${id!},${id!},'topic','CM','Synthetic topic',${parent!})`;
    for (const id of all) {
      const owned = id === otherAi ? other : owner, area = pubA2.includes(id) ? a2 : id === aiNone ? null : a1;
      await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,enamed_area_id,enamed_topic_id)
        VALUES(${id},${owned},'objective',${id === pubA1[0] ? 'hard' : 'medium'},${'Synthetic   question\n' + id},${JSON.stringify(alternatives)}::text::jsonb,'E','Synthetic E','student','Synthetic explanation',
        ${[aiA1, aiNone, otherAi].includes(id) ? 'ai_generated' : 'user_authored'},${area},${id === pubA1[1] ? topic : pubA1.includes(id) ? topicB : pubA2.includes(id) ? topicC : null})`;
    }
    for (const id of [...pubA1, ...pubA2]) await publish(id);
    const { createApp } = await import('../../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (token) => ([owner, other] as string[]).includes(token) ? { userId: token, sessionId: null, account: { hasProfile: true, deletedAt: null, suspendedAt: null } } : null });
  });
  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM question_sessions WHERE user_id IN (${owner},${other})`;
    await db`DELETE FROM question_bank WHERE id=ANY(${[...extra, ...all]})`;
    await db`DELETE FROM question_sources WHERE id=${source}`;
    await db`DELETE FROM enamed_taxonomy WHERE id IN (${topic},${topicB},${topicC})`; await db`DELETE FROM enamed_taxonomy WHERE id IN (${a1},${a2})`;
    await db`DELETE FROM auth.users WHERE id IN (${owner},${other},${reviewer})`;
    await db.end({ timeout: 1 });
  });

  it('availability matches SQL counts per area and honors source, topic, difficulty and A/B ownership', async () => {
    const res = await request('/exam-builder/availability', 'POST', filter());
    expect(res.status).toBe(200);
    const sqlCounts = await db`SELECT enamed_area_id area,count(*)::int n FROM question_bank WHERE enamed_area_id IN (${a1},${a2}) AND visibility='public' AND catalog_status='published' AND availability='active' GROUP BY 1`;
    const got = examAvailabilitySchema.parse(res.body.data);
    expect(new Map(got.areas.map((a) => [a.areaId, a.available]))).toEqual(new Map(sqlCounts.map((r) => [r.area as string, r.n as number])));
    expect(got.total).toBe(9);
    const count = async (over: Record<string, unknown>, user = owner) => examAvailabilitySchema.parse((await request('/exam-builder/availability', 'POST', filter(over), user)).body.data).total;
    expect(await count({ source: 'catalog_and_ai' })).toBe(10);
    expect(await count({ source: 'catalog_and_ai' }, other)).toBe(10); // other's own AI in A1, never the owner's
    expect(await count({ source: 'ai', areaIds: [] })).toBe(2); // own AI only, including the null area
    expect(await count({ topicIds: [topic] })).toBe(1);
    expect(await count({ difficulties: ['hard'] })).toBe(1);
    expect((await request('/exam-builder/availability', 'POST', { ...filter(), extra: 1 })).status).toBe(422);
  });

  it('D-1846: boardId keeps only the AI questions of that map (catalog part untouched) in availability, preview and start', async () => {
    const board = randomUUID();
    await db`INSERT INTO boards(id,user_id,title) VALUES(${board},${owner},'Synthetic map')`;
    await db`UPDATE question_bank SET board_id=${board} WHERE id=${aiA1}`;
    try {
      const total = async (over: Record<string, unknown>) => examAvailabilitySchema.parse((await request('/exam-builder/availability', 'POST', filter(over))).body.data).total;
      expect(await total({ source: 'ai', areaIds: [], boardId: board })).toBe(1); // aiA1, not aiNone
      expect(await total({ source: 'ai', areaIds: [], boardId: randomUUID() })).toBe(0);
      expect(await total({ source: 'catalog_and_ai', boardId: board })).toBe(10); // 9 public + aiA1
      const p = examPreviewSchema.parse((await preview({ params: params({ source: 'ai', areaIds: [], boardId: board, count: 5 }), pinnedIds: [], excludedIds: [] })).body.data);
      expect(p.items.map((i) => i.questionId)).toEqual([aiA1]);
      const s = await request('/question-sessions', 'POST', await startBody([aiNone], p.seed, { source: 'ai', areaIds: [], boardId: board }), owner, randomUUID());
      expect([s.status, s.body.error?.message ?? s.body.error?.code]).toEqual([409, expect.stringMatching(/exam_changed/)]);
    } finally {
      await db`UPDATE question_bank SET board_id=null WHERE id=${aiA1}`;
      await db`DELETE FROM boards WHERE id=${board}`;
    }
  });

  it('D-1861: course applies to the catalog part only (availability, preview, start, bank list and facets)', async () => {
    const total = async (over: Record<string, unknown>) => examAvailabilitySchema.parse((await request('/exam-builder/availability', 'POST', filter(over))).body.data).total;
    for (const course of [null, 'medicine']) { expect(await total({ course })).toBe(9); expect(await total({ source: 'catalog_and_ai', course })).toBe(10); }
    expect(await total({ course: 'nursing' })).toBe(0);
    expect(await total({ source: 'ai', areaIds: [], course: 'nursing' })).toBe(2); // own AI questions (aiA1, aiNone), never filtered
    expect(await total({ source: 'catalog_and_ai', course: 'nursing' })).toBe(1);
    expect((await preview({ params: params({ course: 'nursing' }), pinnedIds: [], excludedIds: [] })).body.data).toMatchObject({ items: [] });
    const med = examPreviewSchema.parse((await preview({ params: params({ course: 'medicine' }), pinnedIds: [], excludedIds: [] })).body.data);
    expect(med.items).toHaveLength(5);
    const s = await request('/question-sessions', 'POST', await startBody(med.items.map((i) => i.questionId), med.seed, { course: 'nursing' }), owner, randomUUID());
    expect([s.status, s.body.error?.message ?? s.body.error?.code]).toEqual([409, expect.stringMatching(/exam_changed/)]);
    const rv = examRevalidateResultSchema.parse((await request('/exam-builder/revalidate', 'POST', { params: params({ course: 'nursing' }), questionIds: med.items.map((i) => i.questionId) })).body.data);
    expect(rv.ok).toBe(false);
    const list = async (qs: string) => (await request('/questions?limit=50&' + qs, 'GET')).body.data as unknown as { total: number; items: { id: string }[] };
    const facets = async (qs: string) => (await request('/questions/facets?' + qs, 'GET')).body.data as unknown as { total: number; areas: { count: number }[] };
    expect((await list('scope=catalog&course=nursing')).total).toBe(0);
    expect((await facets('scope=catalog&course=nursing')).total).toBe(0);
    expect((await facets('scope=catalog&course=nursing')).areas.every((a) => a.count === 0)).toBe(true);
    expect((await list('scope=catalog&course=medicine')).total).toBe(9);
    const mine = await list('scope=mine'), mineN = await list('scope=mine&course=nursing');
    expect(mineN.total).toBe(mine.total); expect(mine.total).toBeGreaterThanOrEqual(2);
    const allN = await list('scope=all&course=nursing'); expect(allN.total).toBe(mine.total);
    expect((await facets('course=nursing')).total).toBe(mine.total);
  });

  it('D-1846: generate (AI=mock, no provider) saves questions of the map that the builder then finds by boardId', async () => {
    const board = randomUUID(), matrix = randomUUID();
    vi.stubEnv('AI', 'mock');
    await db`INSERT INTO matrix_items(id,area,code,title) VALUES(${matrix},'CM',${'SYN-' + matrix.slice(0, 8)},'Synthetic matrix item')`;
    await db`UPDATE enamed_taxonomy SET matrix_ref=${matrix} WHERE id=${topic}`;
    await db`INSERT INTO boards(id,user_id,title,matrix_item_id) VALUES(${board},${owner},'Synthetic map',${matrix})`;
    await db`INSERT INTO cards(board_id,title) VALUES(${board},'Synthetic card alpha'),(${board},'Synthetic card beta')`;
    try {
      expect((await request('/exam-builder/generate', 'POST', { boardId: board, count: 2 }, other)).status).toBe(404); // not the owner's map
      const g = await request('/exam-builder/generate', 'POST', { boardId: board, count: 2 });
      expect(g.status).toBe(200);
      const ids = (g.body.data as unknown as { questionIds: string[] }).questionIds;
      expect(ids.length).toBeGreaterThan(0);
      extra.push(...ids);
      expect(g.text).not.toMatch(/correct|stem/i);
      const av = examAvailabilitySchema.parse((await request('/exam-builder/availability', 'POST', filter({ source: 'ai', areaIds: [], boardId: board }))).body.data);
      expect(av.total).toBe(ids.length);
    } finally {
      vi.unstubAllEnvs();
      await db`DELETE FROM question_bank WHERE board_id=${board}`;
      await db`DELETE FROM boards WHERE id=${board}`;
      await db`UPDATE enamed_taxonomy SET matrix_ref=null WHERE id=${topic}`;
      await db`DELETE FROM matrix_items WHERE id=${matrix}`;
    }
  });

  it('preview is deterministic by seed, distinct, balanced, keeps pinned, honors excluded, never completes and never leaks the key', async () => {
    const first = await preview({ params: params() });
    expect(first.status).toBe(200);
    const p1 = examPreviewSchema.parse(first.body.data);
    expect(p1.seed).toMatch(/^[a-f0-9]{32}$/);
    expect(first.text).not.toMatch(/correctKey|correct_key|explanation|distractor|alternatives|expectedAnswer/);
    expect(new Set(p1.items.map((i) => i.canonicalId)).size).toBe(5);
    expect(p1.items.filter((i) => i.areaId === a1)).toHaveLength(3);
    expect(p1.items.every((i) => !i.stemPreview.includes('\n'))).toBe(true);
    const again = examPreviewSchema.parse((await preview({ params: params(), seed: p1.seed })).body.data);
    expect(again.items.map((i) => i.questionId)).toEqual(p1.items.map((i) => i.questionId));
    const pin = p1.items.find((i) => i.areaId === a2)!.questionId, excluded = p1.items.filter((i) => i.areaId === a1).map((i) => i.questionId).slice(0, 2);
    for (let n = 0; n < 4; n++) {
      const p = examPreviewSchema.parse((await preview({ params: params(), pinnedIds: [pin], excludedIds: excluded })).body.data);
      expect(p.items.find((i) => i.questionId === pin)?.pinned).toBe(true);
      expect(p.items.some((i) => excluded.includes(i.questionId))).toBe(false);
    }
    const short = examPreviewSchema.parse((await preview({ params: params({ count: 12 }) })).body.data);
    expect(short.allocation).toMatchObject({ requested: 12, allocated: 9, shortfall: 3 });
    expect(short.items).toHaveLength(9);
    expect((await preview({ params: params({ count: 1 }), pinnedIds: [pubA1[0], pubA2[0]] })).status).toBe(422);
    const b = examPreviewSchema.parse((await preview({ params: params({ source: 'catalog_and_ai' }), pinnedIds: [otherAi] })).body.data);
    expect(b.items.some((i) => i.questionId === otherAi)).toBe(false); // RLS A/B: someone else's AI question cannot be pinned in
  });

  it('swap stays in area and filters, skips current and excluded, then 409 no_replacement; revalidate reports withdrawn and updated', async () => {
    const p = examPreviewSchema.parse((await preview({ params: params({ count: 2, areaIds: [a2] }) })).body.data);
    const ids = p.items.map((i) => i.questionId);
    const swapped = await request('/exam-builder/swap', 'POST', { params: params({ count: 2, areaIds: [a2] }), seed: p.seed, questionId: ids[0], currentIds: ids });
    expect(swapped.status).toBe(200);
    const item = examSwapResultSchema.parse(swapped.body.data).item;
    expect(item.areaId).toBe(a2); expect(ids).not.toContain(item.questionId); expect(swapped.text).not.toMatch(/correctKey|explanation|alternatives/);
    const none = await request('/exam-builder/swap', 'POST', { params: params({ count: 2, areaIds: [a2] }), seed: p.seed, questionId: ids[0], currentIds: [...ids, item.questionId] });
    expect(none.status).toBe(409); expect(none.body.error?.message).toBe('no_replacement');
    expect((await request('/exam-builder/swap', 'POST', { params: params(), seed: p.seed, questionId: otherAi, currentIds: [] })).status).toBe(404);
    const re = (questionIds: string[], user = owner) => request('/exam-builder/revalidate', 'POST', { params: params(), questionIds }, user);
    expect(examRevalidateResultSchema.parse((await re(ids)).body.data).ok).toBe(true);
    expect(examRevalidateResultSchema.parse((await re([aiA1])).body.data).unavailable).toEqual([aiA1]); // source=catalog excludes AI
    const clone = randomUUID(); extra.push(clone);
    await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,enamed_area_id,enamed_topic_id,version,canonical_id,supersedes_id)
      SELECT ${clone},${owner},type,difficulty,stem||' v2',alternatives,correct_key,expected_answer,source,explanation,'user_authored',enamed_area_id,enamed_topic_id,version+1,id,id FROM question_bank WHERE id=${pubA2[2]!}`;
    await publish(clone);
    const r = examRevalidateResultSchema.parse((await re([pubA2[2]!])).body.data);
    expect(r).toEqual({ ok: false, unavailable: [], updated: [{ id: pubA2[2], latestId: clone }] });
    await db`DELETE FROM question_bank WHERE id=${clone}`;
  });

  it('start: exam_changed, coherence, flag, one active builder session for parallel tabs, settle of expired, frozen snapshot', async () => {
    const p = examPreviewSchema.parse((await preview({ params: params() })).body.data), ids = p.items.map((i) => i.questionId);
    await db`UPDATE question_bank SET catalog_status='withdrawn' WHERE id=${ids[0]!}`;
    const changed = await request('/question-sessions', 'POST', await startBody(ids, p.seed), owner, randomUUID());
    expect(changed.status).toBe(409); expect(changed.body.error?.message).toBe('exam_changed');
    await db`UPDATE question_bank SET catalog_status='published' WHERE id=${ids[0]!}`;
    expect((await request('/question-sessions', 'POST', await startBody(ids, p.seed, { mode: 'simulation' }), owner, randomUUID())).status).toBe(422);
    expect((await request('/question-sessions', 'POST', { mode: 'study', questionIds: [ids[0]], count: 1, drawer: true }, owner, randomUUID())).status).toBe(422);
    expect((await request('/question-sessions', 'POST', await startBody(ids, p.seed, { source: 'ai', areaIds: [] }), owner, randomUUID())).status).toBe(409);
    process.env.QUESTIONS_BANK_STUDENT_ENABLED = '0';
    try { expect((await request('/question-sessions', 'POST', await startBody(ids, p.seed), owner, randomUUID())).status).toBe(404); expect((await request('/exam-builder/availability', 'POST', filter())).status).toBe(404); }
    finally { delete process.env.QUESTIONS_BANK_STUDENT_ENABLED; }

    const body = await startBody(ids, p.seed), key = randomUUID();
    const same = await Promise.all([1, 2, 3].map(() => request('/question-sessions', 'POST', body, owner, key)));
    expect(same.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(same.map((r) => r.body.data.id)).size).toBe(1);
    const sessionId = same[0]!.body.data.id!;
    const tabs = await Promise.all([1, 2, 3].map(() => request('/question-sessions', 'POST', body, owner, randomUUID())));
    for (const t of tabs) { expect(t.status).toBe(409); expect(t.body.error?.message).toBe('active_session_exists:' + sessionId); }
    const [active] = await db`SELECT count(*)::int n FROM question_sessions WHERE user_id=${owner} AND status='active' AND config ? 'builder'`;
    expect(active!.n).toBe(1);
    await expect(db`INSERT INTO question_sessions(user_id,mode,config,idempotency_key) VALUES(${owner},'study','{"builder":{}}'::jsonb,${randomUUID()})`).rejects.toThrow(/question_sessions_one_active_builder_uq/); // index backstop
    const [cfg] = await db`SELECT config FROM question_sessions WHERE id=${sessionId}`;
    expect(cfg!.config).toMatchObject({ questionIds: ids, builder: { seed: p.seed, templateId: null, params: { count: 5, source: 'catalog' } } });
    // Edit and unpublish after start: the frozen snapshot does not move.
    const before = await db`SELECT question_id,position,payload_public->>'stem' stem,payload_public->>'version' version FROM question_session_items WHERE session_id=${sessionId} ORDER BY position`;
    expect(before.map((r) => r.question_id)).toEqual(ids);
    const v2 = randomUUID(); extra.push(v2);
    await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,enamed_area_id,enamed_topic_id,version,canonical_id,supersedes_id)
      SELECT ${v2},${owner},type,difficulty,'Edited synthetic stem',alternatives,'A',expected_answer,source,explanation,'user_authored',enamed_area_id,enamed_topic_id,version+1,id,id FROM question_bank WHERE id=${ids[1]!}`;
    await publish(v2);
    await db`UPDATE question_bank SET catalog_status='withdrawn' WHERE id=${ids[2]!}`;
    const got = await request('/question-sessions/' + sessionId, 'GET');
    expect(got.body.data.items!.find((i) => i.question.id === ids[1])!.question.stem).toBe(before[1]!.stem);
    expect(await db`SELECT question_id,position,payload_public->>'stem' stem,payload_public->>'version' version FROM question_session_items WHERE session_id=${sessionId} ORDER BY position`).toEqual(before);
    await db`DELETE FROM question_bank WHERE id=${v2}`;
    await db`UPDATE question_bank SET catalog_status='published' WHERE id=${ids[2]!}`;
    // RLS A/B: the other user neither reads nor is blocked by the owner's session.
    expect((await request('/question-sessions/' + sessionId, 'GET', undefined, other)).status).toBe(404);
    // Expired old session is settled, then a new start succeeds.
    await db`UPDATE question_sessions SET deadline=now()-interval '1 second' WHERE id=${sessionId}`;
    const next = await request('/question-sessions', 'POST', body, owner, randomUUID());
    expect(next.status).toBe(200);
    const [old] = await db`SELECT status FROM question_sessions WHERE id=${sessionId}`;
    expect(old!.status).toBe('expired');
    await finishActive();
  });

  it('drawer answer is an internal finished 1-item session, idempotent, counted for progress and absent from history', async () => {
    const { answerInDrawer } = await import('../sessions/service');
    const mutationId = randomUUID();
    const attempt = await answerInDrawer(owner, pubA2[0]!, { selectedKey: 'A', mutationId, elapsedMs: 1000 });
    expect(attempt).toMatchObject({ questionId: pubA2[0], selectedKey: 'A', result: 'incorrect', reference: { correctKey: 'E' } });
    expect(await answerInDrawer(owner, pubA2[0]!, { selectedKey: 'A', mutationId, elapsedMs: 1000 })).toEqual(attempt);
    await expect(answerInDrawer(owner, pubA2[0]!, { selectedKey: 'B', mutationId, elapsedMs: 1000 })).rejects.toThrow('mutation_id_reused');
    await expect(answerInDrawer(owner, pubA2[1]!, { selectedKey: 'B', mutationId, elapsedMs: 1000 })).rejects.toThrow('idempotency_key_reused');
    expect((await answerInDrawer(owner, pubA2[1]!, { selectedKey: 'E', mutationId: randomUUID(), elapsedMs: 5 })).result).toBe('correct');
    const sessions = await db`SELECT status FROM question_sessions WHERE user_id=${owner} AND config ? 'drawer'`;
    expect(sessions.map((s) => s.status)).toEqual(['finished', 'finished']);
    const wrong = examAvailabilitySchema.parse((await request('/exam-builder/availability', 'POST', filter({ progress: 'wrong' }))).body.data);
    expect(wrong.total).toBe(1);
    expect(examAvailabilitySchema.parse((await request('/exam-builder/availability', 'POST', filter({ progress: 'unseen' }))).body.data).total).toBe(7);
    const h = await request('/question-sessions/history', 'GET'); expect(h.status).toBe(200);const history = questionSessionsPageResultSchema.parse(h.body.data);
    const drawerIds = (await db`SELECT id FROM question_sessions WHERE user_id=${owner} AND config ? 'drawer'`).map((r) => r.id);
    expect(history.items.some((s) => drawerIds.includes(s.id))).toBe(false);
    expect(history.items.length).toBeGreaterThan(0);
    const list = await request('/question-sessions', 'GET');
    expect((list.body.data as unknown as { id: string }[]).some((s) => drawerIds.includes(s.id))).toBe(false);
  });
});
