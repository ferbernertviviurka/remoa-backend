// G22 (D-1411–D-1418): AI quotas, errors, jobs and the correction flag. Integration: needs TEST_DATABASE_URL; skipped otherwise.
// No real AI call: "live" mode points AI_BASE_URL at a fake host and `fetch` is stubbed per test.
import { config } from 'dotenv';
import { dropTrial } from '../test-trial';
import { sql } from 'drizzle-orm';
import { createHash, randomUUID as uuid } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { planDefinition } from '@remoa/contracts';

config({ path: '../../.env' });

const AI_ENV = ['AI', 'OPENROUTER_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_MODEL_FALLBACKS', 'AI_MAX_RETRIES', 'AI_RPM_LIMIT', 'AI_RPD_LIMIT', 'AI_REQUIRE_FREE', 'INNGEST_EVENT_KEY', 'INNGEST_DEV'] as const;
const saved = Object.fromEntries(AI_ENV.map((k) => [k, process.env[k]]));
const restoreEnv = () => {
  for (const k of AI_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};
const mock = () => {
  restoreEnv();
  delete process.env.INNGEST_EVENT_KEY;
  delete process.env.INNGEST_DEV;
  process.env.AI = 'mock';
};
/** "live" against a fake host: every AI request goes to the stubbed fetch. */
const live = (rpm = 1000) => {
  mock();
  delete process.env.AI;
  Object.assign(process.env, { OPENROUTER_API_KEY: 'test-key', AI_BASE_URL: 'http://ai.invalid/v1', AI_MODEL: 'test/model:free', AI_MODEL_FALLBACKS: '', AI_MAX_RETRIES: '0', AI_RPM_LIMIT: String(rpm), AI_RPD_LIMIT: '100000' });
};
const isAi = (url: unknown) => String(url).startsWith('http://ai.invalid/');
/** Stubs only the fake AI host; anything else (none expected) goes to the real fetch. */
const stubAi = (reply: (init: RequestInit | undefined) => Promise<Response> | Response) => {
  const real = globalThis.fetch;
  const spy = vi.fn((url: Parameters<typeof fetch>[0], init?: RequestInit) => (isAi(url) ? Promise.resolve(reply(init)) : real(url, init)));
  vi.stubGlobal('fetch', spy);
  return spy;
};
const chat = (content: string) => new Response(JSON.stringify({ model: 'test/model:free', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });

const TEXT = [
  'A sepse é uma disfunção orgânica ameaçadora à vida causada por resposta desregulada do hospedeiro à infecção.',
  '',
  'O choque séptico é a sepse com hipotensão que exige vasopressor para manter a pressão arterial média de 65 mmHg.',
].join('\n');
const extractReply = (cards: { ref: string; title: string; excerpt: string }[]) =>
  chat(JSON.stringify({
    cards: cards.map((c) => ({ ref: c.ref, type: 'concept', title: c.title, question: `O que é ${c.title}?`, answer: `${c.title} explicado.`, sourceExcerpt: c.excerpt })),
    edges: cards.length > 1 ? [{ fromRef: cards[0]!.ref, toRef: cards[1]!.ref, label: 'pode evoluir para' }] : [],
  }));

describe.skipIf(!process.env.DATABASE_URL)('G22 AI quotas, errors, jobs and flags', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let q: typeof import('../billing/quota');
  let svc: typeof import('./service');
  let app: ReturnType<typeof import('../app').createApp>;

  const newUser = async (plan?: 'pro' | 'founder', tz?: string) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    await dropTrial(id);
    if (plan) await dbm.db.insert(dbm.subscriptions).values({ userId: id, plan, status: 'active' });
    if (tz) await dbm.db.execute(sql`insert into profiles (user_id, timezone) values (${id}, ${tz}) on conflict (user_id) do update set timezone = ${tz}`);
    return id;
  };
  const used = async (user: string, col: 'ai_grades' | 'ai_rubrics' | 'ai_generations') => {
    const [r] = await dbm.db.execute<{ n: number }>(sql`select coalesce(sum(${sql.identifier(col)}), 0)::int as n from usage_counters where user_id = ${user}`);
    return r!.n;
  };
  const post = (user: string, path: string, body?: unknown) =>
    app.request(`/v1/ai${path}`, { method: 'POST', headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const job = async (user: string, id: string) =>
    ((await (await app.request(`/v1/ai/jobs/${id}`, { headers: { authorization: `Bearer ${user}` } })).json()) as { data: Record<string, unknown> & { status: string; error: string | null; ai: { status: string; code: string | null } | null } }).data;
  const settle = async (user: string, id: string) => {
    for (let i = 0; i < 200; i++) {
      const j = await job(user, id);
      if (j.status === 'done' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('job did not settle');
  };
  const graderBody = {
    prompt: 'O que define sepse?', canonical: 'Disfunção orgânica por resposta desregulada à infecção.', neighbors: [],
    rubric: { points: [{ text: 'disfunção orgânica', essential: true }], source: 'Sepsis-3', version: 1, status: 'draft', reviewerId: null },
    answer: 'Disfunção orgânica causada por infecção.',
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    q = await import('../billing/quota');
    svc = await import('./service');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  beforeEach(() => mock());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });
  afterAll(async () => {
    if (!dbm || !users.length) return;
    const ids = sql.join(users.map((u) => sql`${u}`), sql`, `);
    await dbm.db.execute(sql`delete from usage_counters where user_id in (${ids})`);
    await dbm.db.execute(sql`delete from ai_jobs where user_id in (${ids})`);
    await dbm.db.execute(sql`delete from boards where user_id in (${ids})`);
    await dbm.db.execute(sql`delete from auth.users where id in (${ids})`);
  });

  describe('quota (D-1411, D-1412)', () => {
    it('limit comes from PlanDefinition; rubric has its own counter with the ai_grades number', async () => {
      const [free, pro, founder] = [await newUser(), await newUser('pro'), await newUser('founder')];
      expect(await q.limitFor(free, 'ai_grades')).toBe(planDefinition('free').ai_grades);
      expect(await q.limitFor(pro, 'ai_grades')).toBe(planDefinition('pro').ai_grades);
      expect(await q.limitFor(pro, 'ai_rubrics')).toBe(planDefinition('pro').ai_grades);
      expect(await q.limitFor(founder, 'ai_generations')).toBeNull();
      const r = await q.reserveAi(free, 'ai_rubrics');
      expect(r.ok).toBe(true);
      expect([await used(free, 'ai_rubrics'), await used(free, 'ai_grades')]).toEqual([1, 0]);
    });

    it('atomic: Promise.all of 5 on the last unit lets exactly one through', async () => {
      const u = await newUser();
      const limit = planDefinition('free').ai_grades!;
      const day = await q.localDay(u, new Date());
      await dbm.db.insert(dbm.usageCounters).values({ userId: u, period: day, aiGrades: limit - 1 });
      const r = await Promise.all(Array.from({ length: 5 }, () => q.reserveAi(u, 'ai_grades')));
      expect(r.filter((x) => x.ok)).toHaveLength(1);
      expect(r.filter((x) => !x.ok).map((x) => !x.ok && x.error)).toEqual(Array(4).fill({ code: 'quota_exceeded', message: 'ai_grades' }));
      expect(await used(u, 'ai_grades')).toBe(limit);
    });

    it('turns over at midnight of the profile timezone (injected clock); refund hits the day it was taken', async () => {
      const sp = await newUser(undefined, 'America/Sao_Paulo'); // UTC-3
      const tokyo = await newUser(undefined, 'Asia/Tokyo'); // UTC+9
      const before = new Date('2026-03-10T02:59:00Z'); // 23:59 of 9 Mar in São Paulo, 11:59 of 10 Mar in Tokyo
      const after = new Date('2026-03-10T03:01:00Z'); // 00:01 of 10 Mar in São Paulo
      expect(await q.localDay(sp, before)).toBe('2026-03-09');
      expect(await q.localDay(sp, after)).toBe('2026-03-10');
      expect(await q.localDay(tokyo, new Date('2026-03-10T14:59:00Z'))).toBe('2026-03-10');
      expect(await q.localDay(tokyo, new Date('2026-03-10T15:01:00Z'))).toBe('2026-03-11');
      const limit = planDefinition('free').ai_grades!;
      await dbm.db.insert(dbm.usageCounters).values({ userId: sp, period: '2026-03-09', aiGrades: limit });
      expect((await q.reserveAi(sp, 'ai_grades', before)).ok).toBe(false); // the full day
      const next = await q.reserveAi(sp, 'ai_grades', after); // a new day
      expect(next.ok && next.quota).toMatchObject({ period: '2026-03-10', used: 1, remaining: limit - 1 });
      const late = await q.reserveAi(sp, 'ai_grades', new Date('2026-03-11T02:59:00Z'));
      if (!late.ok) throw new Error('reserve');
      await late.refund(); // after midnight: still gives back 10 Mar, not 11 Mar
      const rows = await dbm.db.execute<{ period: string; ai_grades: number }>(sql`select period::text, ai_grades from usage_counters where user_id = ${sp} order by period`);
      expect(rows.map((r) => [r.period, r.ai_grades])).toEqual([['2026-03-09', limit], ['2026-03-10', 1]]);
    });

    it('warns at 80%: nearLimit from the unit that reaches 80% of the plan limit, with remaining', async () => {
      const u = await newUser();
      const limit = planDefinition('free').ai_grades!;
      const warnAt = Math.ceil(limit * 0.8);
      const seen: { used: number; nearLimit: boolean; remaining: number | null }[] = [];
      for (let i = 0; i < warnAt; i++) {
        const r = await q.reserveAi(u, 'ai_grades');
        if (!r.ok) throw new Error('reserve');
        seen.push({ used: r.quota.used, nearLimit: r.quota.nearLimit, remaining: r.quota.remaining });
      }
      expect(seen.at(-2)).toEqual({ used: warnAt - 1, nearLimit: false, remaining: limit - warnAt + 1 });
      expect(seen.at(-1)).toEqual({ used: warnAt, nearLimit: true, remaining: limit - warnAt });
    });
  });

  describe('a failure never spends the quota (D-1413)', () => {
    it('/grade: provider 500 -> local grader verdict marked fallback, ai_grades back to 0; ok verdict keeps it', async () => {
      const u = await newUser();
      live();
      stubAi(() => new Response('{"error":{"message":"boom","code":500}}', { status: 500 }));
      const res = await post(u, '/grade', graderBody);
      expect(res.status).toBe(200);
      const body = await res.text();
      const verdict = JSON.parse(body.split('\n\n').filter(Boolean).at(-1)!.slice(6)).verdict;
      expect(verdict.ai).toMatchObject({ status: 'fallback', code: 'provider_error', message: expect.any(String), quota: { key: 'ai_grades', used: 0 } });
      expect(verdict.ai.callId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await used(u, 'ai_grades')).toBe(0);

      mock(); // the configured grader answers: the unit stays
      const ok = await (await post(u, '/grade', graderBody)).text();
      expect(JSON.parse(ok.split('\n\n').filter(Boolean).at(-1)!.slice(6)).verdict.ai).toMatchObject({ status: 'ok', quota: { used: 1 } });
      expect(await used(u, 'ai_grades')).toBe(1);
    });

    it('/rubric: provider failure -> 503 with the friendly message, nothing saved, ai_rubrics not spent', async () => {
      const u = await newUser();
      const [b] = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'Meu' }).returning();
      const [card] = await dbm.db.insert(dbm.cards).values({ boardId: b!.id, title: 'Lactato', back: 'Reavaliar em 2 a 4 horas.' }).returning();
      live();
      stubAi(() => new Response('{"error":{"message":"down","code":503}}', { status: 503 }));
      const res = await post(u, '/rubric', { cardId: card!.id });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'ai_unavailable' }, ai: { status: 'error', code: 'provider_error' } });
      expect(await used(u, 'ai_rubrics')).toBe(0);
      const [after] = await dbm.db.execute<{ rubric: unknown }>(sql`select rubric from cards where id = ${card!.id}`);
      expect(after!.rubric).toBeNull();
    });

    it('P-610/P-623: /rubric after a model failure asks the model again, saves the model rubric as ok and spends one unit', async () => {
      const u = await newUser();
      const [b] = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'Meu' }).returning();
      const [card] = await dbm.db.insert(dbm.cards).values({ boardId: b!.id, title: 'Lactato', back: 'Reavaliar em 2 a 4 horas.' }).returning();
      live();
      stubAi(() => new Response('{"error":{"message":"down","code":503}}', { status: 503 }));
      expect((await post(u, '/rubric', { cardId: card!.id })).status).toBe(503);
      vi.unstubAllGlobals();
      const spy = stubAi(() => chat(JSON.stringify({ points: [{ text: 'Lactato seriado guia a reposição', essential: true }] })));
      const res = await post(u, '/rubric', { cardId: card!.id });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { points: { text: string }[] }; ai: { status: string; quota: { used: number } } };
      expect(spy).toHaveBeenCalled(); // no local rubric from a cache
      expect(body.data.points[0]!.text).toBe('Lactato seriado guia a reposição');
      expect(body.ai).toMatchObject({ status: 'ok', quota: { used: 1 } });
      expect(await used(u, 'ai_rubrics')).toBe(1);
      const [after] = await dbm.db.execute<{ rubric: { points: { text: string }[] } }>(sql`select rubric from cards where id = ${card!.id}`);
      expect(after!.rubric.points[0]!.text).toBe('Lactato seriado guia a reposição');
    });

    it('generation: provider failure fails the job (no paragraph map saved as AI) and gives the unit back', async () => {
      const u = await newUser('pro');
      live();
      stubAi(() => new Response('{"error":{"message":"boom","code":500}}', { status: 500 }));
      const res = await post(u, '/generate-board', { kind: 'text', title: 'Sepse', area: 'CM', text: TEXT });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { jobId: string } };
      const j = await settle(u, data.jobId);
      expect(j).toMatchObject({ status: 'failed', error: 'provider_error', boardId: null, ai: { status: 'error', code: 'provider_error' } });
      expect(await used(u, 'ai_generations')).toBe(0);
      const [boards] = await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from boards where user_id = ${u}`);
      expect(boards!.n).toBe(0);
    });
  });

  it('local AI limit: 429 with Retry-After before any quota is taken', async () => {
    const u = await newUser();
    live(1);
    stubAi(() => new Response('{"error":{"message":"boom","code":500}}', { status: 500 }));
    await (await post(u, '/grade', graderBody)).text(); // takes the only slot of the minute
    const before = await used(u, 'ai_grades');
    const res = await post(u, '/grade', graderBody);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' }, ai: { status: 'error', code: 'rate_limited' } });
    expect(await used(u, 'ai_grades')).toBe(before);
    const gen = await post(await newUser('pro'), '/generate-board', { kind: 'text', title: 'X', area: 'CM', text: TEXT });
    expect([gen.status, gen.headers.get('retry-after')]).toEqual([429, '60']);
  });

  describe('generation (D-1414)', () => {
    it('keeps only cards whose excerpt is in the text, caps at the card limit, records ai status ok', async () => {
      const u = await newUser('founder');
      live();
      stubAi(() => extractReply([
        { ref: 'c1', title: 'Sepse', excerpt: 'disfunção orgânica ameaçadora à vida' },
        { ref: 'c2', title: 'Choque séptico', excerpt: 'hipotensão que exige vasopressor' },
        { ref: 'c3', title: 'Inventado', excerpt: 'lactato acima de 4 indica hipoperfusão grave' }, // not in the text
      ]));
      const res = await post(u, '/generate-board', { kind: 'text', title: 'Sepse', area: 'CM', text: TEXT });
      const { data, ai } = (await res.json()) as { data: { jobId: string }; ai: { quota: { key: string; used: number } } };
      expect(ai.quota).toMatchObject({ key: 'ai_generations', used: 1 });
      const j = await settle(u, data.jobId);
      expect(j).toMatchObject({ status: 'done', cards: 2, edges: 1, dropped: 1, ai: { status: 'ok' } });
      const cards = await dbm.db.execute<{ title: string }>(sql`select title from cards where board_id = ${j.boardId as string} order by "order"`);
      expect(cards.map((c) => c.title)).toEqual(['Sepse', 'Choque séptico']);
      const [row] = await dbm.db.execute<{ text: string | null }>(sql`select text from ai_jobs where id = ${data.jobId}`);
      expect(row!.text).toBeNull(); // input erased once done
    });

    it('a model reply where no card has a source in the text fails the job and refunds', async () => {
      const u = await newUser('pro');
      live();
      stubAi(() => extractReply([{ ref: 'c1', title: 'Inventado', excerpt: 'texto que não está na entrada de jeito nenhum' }]));
      const { data } = (await (await post(u, '/generate-board', { kind: 'text', title: 'X', area: 'CM', text: TEXT })).json()) as { data: { jobId: string } };
      expect(await settle(u, data.jobId)).toMatchObject({ status: 'failed', error: 'invalid_output' });
      expect(await used(u, 'ai_generations')).toBe(0);
    });

    it('card limit of the plan: Free at its cards cap is 402 "cards" before anything is charged; text over the size cap is 422', async () => {
      const free = await newUser();
      const [b] = await dbm.db.insert(dbm.boards).values({ userId: free, title: 'Cheio' }).returning();
      await dbm.db.insert(dbm.cards).values(Array.from({ length: planDefinition('free').cards! }, (_, i) => ({ boardId: b!.id, title: `c${i}` })));
      const r = await post(free, '/generate-board', { kind: 'text', title: 'X', area: 'CM', text: TEXT });
      expect([r.status, ((await r.json()) as { error: { message: string } }).error.message]).toEqual([402, 'cards']);
      const pro = await newUser('pro');
      process.env.AI_MAX_INPUT_CHARS = '50';
      try {
        const big = await post(pro, '/generate-board', { kind: 'text', title: 'X', area: 'CM', text: TEXT });
        expect([big.status, ((await big.json()) as { error: { message: string } }).error.message]).toEqual([422, 'text_too_long']);
      } finally {
        delete process.env.AI_MAX_INPUT_CHARS;
      }
      expect(await used(pro, 'ai_generations')).toBe(0);
    });

    it('AI=mock: the paragraph split is labelled as not AI (source + ai.status fallback)', async () => {
      const u = await newUser('pro');
      const { data } = (await (await post(u, '/generate-board', { kind: 'text', title: 'Sepse', area: 'CM', text: TEXT })).json()) as { data: { jobId: string } };
      const j = await settle(u, data.jobId);
      expect(j).toMatchObject({ status: 'done', ai: { status: 'fallback', code: 'offline' } });
      const sources = await dbm.db.execute<{ source: string }>(sql`select distinct source from cards where board_id = ${j.boardId as string}`);
      expect(sources.map((s) => s.source)).toEqual(['Dividido do texto sem IA, não revisado']);
    });
  });

  describe('jobs in Postgres (D-1415)', () => {
    it('another process can run a job: state lives in ai_jobs, not in memory', async () => {
      const u = await newUser('pro');
      const [row] = await dbm.db.insert(dbm.aiJobs).values({ userId: u, kind: 'text', input: { kind: 'text', title: 'Fora', area: 'CM' }, text: TEXT, inputHash: 'h1' }).returning();
      await svc.runGeneration(row!.id); // what the Inngest function does, from any process
      expect(await job(u, row!.id)).toMatchObject({ status: 'done', progress: 100 });
      await svc.runGeneration(row!.id); // a duplicate delivery does nothing (claim queued -> running)
      const [n] = await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from boards where user_id = ${u}`);
      expect(n!.n).toBe(1);
      const other = await newUser();
      expect((await app.request(`/v1/ai/jobs/${row!.id}`, { headers: { authorization: `Bearer ${other}` } })).status).toBe(404); // RLS
    });

    it('retry: a failed job runs again with a new unit and finishes', async () => {
      const u = await newUser('pro');
      live();
      stubAi(() => new Response('{"error":{"message":"boom","code":500}}', { status: 500 }));
      const { data } = (await (await post(u, '/generate-board', { kind: 'text', title: 'Sepse', area: 'CM', text: TEXT })).json()) as { data: { jobId: string } };
      expect(await settle(u, data.jobId)).toMatchObject({ status: 'failed' });
      expect(await used(u, 'ai_generations')).toBe(0);
      vi.unstubAllGlobals();
      stubAi(() => extractReply([{ ref: 'c1', title: 'Sepse', excerpt: 'disfunção orgânica ameaçadora à vida' }]));
      const again = await post(u, `/jobs/${data.jobId}/retry`);
      expect(again.status).toBe(200);
      expect(await settle(u, data.jobId)).toMatchObject({ status: 'done', cards: 1, error: null, ai: { status: 'ok' } });
      expect(await used(u, 'ai_generations')).toBe(1);
      expect((await post(u, `/jobs/${data.jobId}/retry`)).status).toBe(409); // done: nothing to retry
    });

    it('cancel: aborts the running model call, gives the unit back, erases the text, saves no map', async () => {
      const u = await newUser('pro');
      live();
      let aborted = false;
      stubAi((init) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      }));
      const { data } = (await (await post(u, '/generate-board', { kind: 'text', title: 'Sepse', area: 'CM', text: TEXT })).json()) as { data: { jobId: string } };
      for (let i = 0; i < 100 && (await job(u, data.jobId)).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 10));
      const res = await post(u, `/jobs/${data.jobId}/cancel`);
      expect(res.status).toBe(200);
      expect(await job(u, data.jobId)).toMatchObject({ status: 'failed', error: 'canceled' });
      await new Promise((r) => setTimeout(r, 50));
      expect(aborted).toBe(true);
      expect(await used(u, 'ai_generations')).toBe(0);
      const [row] = await dbm.db.execute<{ text: string | null; board_id: string | null }>(sql`select text, board_id from ai_jobs where id = ${data.jobId}`);
      expect(row).toEqual({ text: null, board_id: null });
      expect((await post(u, `/jobs/${data.jobId}/cancel`)).status).toBe(409);
      expect((await post(u, `/jobs/${data.jobId}/retry`)).status).toBe(409); // canceled is final
    });

    it('dedup: two identical starts at once share one job and one unit', async () => {
      const u = await newUser('pro');
      const body = { kind: 'text', title: 'Dup', area: 'CM', text: TEXT };
      const [a, b] = await Promise.all([post(u, '/generate-board', body), post(u, '/generate-board', body)]);
      const ids = await Promise.all([a, b].map(async (r) => ((await r.json()) as { data: { jobId: string } }).data.jobId));
      expect(ids[0]).toBe(ids[1]);
      await settle(u, ids[0]!);
      expect(await used(u, 'ai_generations')).toBe(1);
    });

    /** A charged job in `status`, last touched `minutes` ago (a dead process stops the heartbeat). */
    const stuckJob = async (u: string, o: { status: 'queued' | 'running'; minutes: number; hash?: string; boardId?: string }) => {
      const held = await q.reserveAi(u, 'ai_generations');
      if (!held.ok) throw new Error('no unit');
      const [row] = await dbm.db.insert(dbm.aiJobs).values({
        userId: u, kind: 'text', input: { kind: 'text', title: 'Morto', area: 'CM' }, text: TEXT, inputHash: o.hash ?? uuid(), status: o.status, stage: 'extract',
        progress: 30, charged: true, quotaPeriod: held.quota.period, boardId: o.boardId ?? null,
      }).returning();
      await dbm.db.execute(sql`update ai_jobs set updated_at = now() - make_interval(mins => ${o.minutes}) where id = ${row!.id}`);
      return row!.id;
    };
    const statusOf = async (id: string) =>
      (await dbm.db.execute<{ status: string; error: string | null; charged: boolean }>(sql`select status, error, charged from ai_jobs where id = ${id}`))[0]!;

    it('P-617: the sweep fails a job silent for 15 min with its unit back; a live one is kept; one with its board is done', async () => {
      const u = await newUser('pro');
      const dead = await stuckJob(u, { status: 'running', minutes: 20 });
      const deadQueued = await stuckJob(u, { status: 'queued', minutes: 16 });
      const alive = await stuckJob(u, { status: 'running', minutes: 5 });
      const [b] = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'Salvo' }).returning();
      const saved = await stuckJob(u, { status: 'running', minutes: 20, boardId: b!.id });
      expect(await used(u, 'ai_generations')).toBe(4);
      expect(await svc.failStaleJobs(u)).toBe(2);
      expect(await statusOf(dead)).toEqual({ status: 'failed', error: 'generate_timeout', charged: false });
      expect(await statusOf(deadQueued)).toMatchObject({ status: 'failed', charged: false });
      expect(await statusOf(alive)).toMatchObject({ status: 'running', charged: true });
      expect(await statusOf(saved)).toMatchObject({ status: 'done', charged: true }); // the map exists: the unit was rightly spent
      expect(await used(u, 'ai_generations')).toBe(2);
      expect(await svc.failStaleJobs(u)).toBe(0); // idempotent: the unit goes back once
      expect(await used(u, 'ai_generations')).toBe(2);
      expect((await post(u, `/jobs/${dead}/retry`)).status).toBe(200); // the text is kept: the student can run it again
      expect(await settle(u, dead)).toMatchObject({ status: 'done' });
    });

    it('P-617: dedup ignores a dead job of the same input, ends it (unit back) and starts a new one charged once', async () => {
      const u = await newUser('pro');
      const body = { kind: 'text' as const, title: 'Sepse', area: 'CM' as const, text: TEXT };
      const hash = createHash('sha256').update(JSON.stringify([body.kind, body.title, body.area, body.text])).digest('hex');
      const dead = await stuckJob(u, { status: 'running', minutes: 30, hash });
      const res = await post(u, '/generate-board', body);
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { jobId: string } };
      expect(data.jobId).not.toBe(dead);
      expect(await statusOf(dead)).toMatchObject({ status: 'failed', error: 'generate_timeout', charged: false });
      expect(await settle(u, data.jobId)).toMatchObject({ status: 'done' });
      expect(await used(u, 'ai_generations')).toBe(1);
    });

    it('P-623: cancel racing the end of a job: either the map and the unit stay, or neither does', async () => {
      for (const delay of [0, 5, 20, 40]) {
        const u = await newUser('pro');
        live();
        stubAi(() => new Promise<Response>((r) => setTimeout(() => r(extractReply([{ ref: 'c1', title: 'Sepse', excerpt: 'disfunção orgânica ameaçadora à vida' }])), delay)));
        const { data } = (await (await post(u, '/generate-board', { kind: 'text', title: `Corrida ${delay}`, area: 'CM', text: TEXT })).json()) as { data: { jobId: string } };
        for (let i = 0; i < 100 && (await job(u, data.jobId)).status === 'queued'; i++) await new Promise((r) => setTimeout(r, 2));
        const cancel = await post(u, `/jobs/${data.jobId}/cancel`);
        expect([200, 409]).toContain(cancel.status);
        const end = await settle(u, data.jobId);
        await new Promise((r) => setTimeout(r, 100)); // let the in-process run finish its last writes
        const [boards] = await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from boards where user_id = ${u}`);
        if (end.status === 'done') {
          expect(cancel.status).toBe(409);
          expect({ boards: boards!.n, units: await used(u, 'ai_generations') }).toEqual({ boards: 1, units: 1 });
        } else {
          expect(end).toMatchObject({ status: 'failed', error: 'canceled' });
          expect({ boards: boards!.n, units: await used(u, 'ai_generations') }).toEqual({ boards: 0, units: 0 });
        }
        vi.unstubAllGlobals();
      }
    });
  });

  it('flag "Essa correção está errada" (D-1416): stores no text, idempotent, only own graded calls', async () => {
    const [u, other] = [await newUser(), await newUser()];
    const [call] = await dbm.db.insert(dbm.aiCalls).values({ userId: u, kind: 'grade', model: 'test/model:free' }).returning();
    const [rubric] = await dbm.db.insert(dbm.aiCalls).values({ userId: u, kind: 'rubric', model: 'test/model:free' }).returning();
    const first = await post(u, `/grades/${call!.id}/flag`, { answer: 'meu texto não deve ser guardado' });
    expect(first.status).toBe(200);
    const one = ((await first.json()) as { data: { callId: string; flaggedAt: string } }).data;
    const second = ((await (await post(u, `/grades/${call!.id}/flag`)).json()) as { data: { flaggedAt: string } }).data;
    expect(second.flaggedAt).toBe(one.flaggedAt);
    expect((await post(other, `/grades/${call!.id}/flag`)).status).toBe(404);
    expect((await post(u, `/grades/${rubric!.id}/flag`)).status).toBe(404);
    expect((await post(u, '/grades/not-a-uuid/flag')).status).toBe(422);
    const cols = await dbm.db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'ai_grade_flags' order by column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(['call_id', 'created_at', 'user_id']);
    const [n] = await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from ai_grade_flags where call_id = ${call!.id}`);
    expect(n!.n).toBe(1);
  });

  it('telemetry: ai_call and ai_error log lines carry no content (CCR-071)', async () => {
    const u = await newUser();
    live();
    stubAi(() => new Response('{"error":{"message":"boom","code":500}}', { status: 500 }));
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (out.push(String(s)), true));
    await (await post(u, '/grade', graderBody)).text();
    const events = out.flatMap((l) => l.split('\n')).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'ai_call' || l.event === 'ai_error');
    expect(events.find((e) => e.event === 'ai_call')).toMatchObject({ fn: 'grade', status: 'fallback', latencyMs: expect.any(Number), model: expect.any(String) });
    expect(events.find((e) => e.event === 'ai_error')).toMatchObject({ fn: 'grade', type: 'provider_error' });
    expect(out.join('')).not.toContain(graderBody.answer);
  });
});
