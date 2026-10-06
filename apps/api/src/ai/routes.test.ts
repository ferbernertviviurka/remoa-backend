// Integration: needs local Supabase (see account.test.ts); skipped otherwise. D-499: /v1/ai hardening + Free 2-map cap.
import { config } from 'dotenv';
import { dropTrial } from '../test-trial';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });
process.env.AI = 'mock'; // D-580: generation without a key needs the explicit mock

describe.skipIf(!process.env.DATABASE_URL)('/v1/ai abuse limits', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;

  const newUser = async (plan?: 'pro' | 'founder') => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    await dropTrial(id);
    if (plan) await dbm.db.insert(dbm.subscriptions).values({ userId: id, plan, status: 'active' }); // D-647: Free has no PDF maps
    return id;
  };
  const req = (user: string, path: string, body: BodyInit, type = 'application/json') =>
    app.request(`/v1/ai${path}`, { method: 'POST', headers: { authorization: `Bearer ${user}`, 'content-type': type }, body });
  const genPdf = (user: string, board: unknown, body: Uint8Array) => {
    const f = new FormData();
    f.set('file', new Blob([body as BlobPart], { type: 'application/pdf' }), 'a.pdf');
    f.set('board', JSON.stringify(board));
    return app.request('/v1/ai/generate-pdf', { method: 'POST', headers: { authorization: `Bearer ${user}` }, body: f });
  };
  const generations = async (user: string) => {
    const [r] = await dbm.db.execute<{ n: number }>(sql`select coalesce(sum(ai_generations), 0)::int as n from usage_counters where user_id = ${user}`);
    return r?.n ?? 0;
  };
  const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4 (${text}) Tj`);

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (!dbm || !users.length) return;
    const ids = users.map((u) => `'${u}'`).join(',');
    await dbm.db.execute(sql.raw(`delete from usage_counters where user_id in (${ids})`));
    await dbm.db.execute(sql.raw(`delete from boards where user_id in (${ids})`));
    await dbm.db.execute(sql.raw(`delete from auth.users where id in (${ids})`));
  });

  it('rubric: free text is refused; someone else card is 404; the 31st call in a minute is 429', async () => {
    const me = await newUser();
    const other = await newUser();
    expect((await req(me, '/rubric', JSON.stringify({ title: 'Sepse', source: 'x' }))).status).toBe(422);
    const [theirs] = await dbm.db.insert(dbm.boards).values({ userId: other, title: 'Deles' }).returning();
    const [card] = await dbm.db.insert(dbm.cards).values({ boardId: theirs!.id, title: 'Segredo', back: 'conteúdo' }).returning();
    expect((await req(me, '/rubric', JSON.stringify({ cardId: card!.id }))).status).toBe(404);
    const [mine] = await dbm.db.insert(dbm.boards).values({ userId: me, title: 'Meu' }).returning();
    const [own] = await dbm.db.insert(dbm.cards).values({ boardId: mine!.id, title: 'Lactato', back: 'Reavaliar.' }).returning();
    const codes: number[] = [];
    for (let i = 0; i < 29; i++) codes.push((await req(me, '/rubric', JSON.stringify({ cardId: own!.id }))).status);
    expect(codes.every((c) => c === 200)).toBe(true);
    expect((await req(me, '/rubric', JSON.stringify({ cardId: own!.id }))).status).toBe(429); // 30 already (one 404 counted)
  });

  it('generate-pdf: over the upload cap or not a PDF is refused before any AI', async () => {
    const me = await newUser();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode('%PDF-'));
    expect((await genPdf(me, { title: 'Grande' }, big)).status).toBe(422);
    expect((await genPdf(me, { title: 'Falso' }, new TextEncoder().encode('<html>'))).status).toBe(422);
    expect(await generations(me)).toBe(0);
  });

  it('Free with 2 maps: generate-pdf and generate-board are 402 and spend no generation', async () => {
    const me = await newUser();
    await dbm.db.insert(dbm.boards).values([{ userId: me, title: 'Um' }, { userId: me, title: 'Dois' }]);
    const p = await genPdf(me, { title: 'Terceiro' }, pdf('Sepse. '.repeat(20)));
    expect(p.status).toBe(402);
    expect(((await p.json()) as { error: { message: string } }).error.message).toBe('boards');
    const t = await req(me, '/generate-board', JSON.stringify({ kind: 'text', title: 'Terceiro', area: 'CM', text: 'Sepse. '.repeat(40) }));
    expect(t.status).toBe(402);
    expect(await generations(me)).toBe(0);
    const boards = await dbm.db.select().from(dbm.boards).where(eq(dbm.boards.userId, me));
    expect(boards).toHaveLength(2);
  });

  it('generate-pdf without a key or AI=mock is 503 ai_unavailable and spends no generation (D-580)', async () => {
    const me = await newUser();
    const key = process.env.OPENROUTER_API_KEY;
    delete process.env.AI;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const res = await genPdf(me, { title: 'Sem IA', area: 'CM', access: 'owner', matrixItemIds: [] }, pdf('Sepse grave com hipotensao refrataria a volume'));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: 'ai_unavailable', message: 'ai_not_configured' } });
      expect(await generations(me)).toBe(0);
    } finally {
      process.env.AI = 'mock';
      if (key) process.env.OPENROUTER_API_KEY = key;
    }
  });

  it('D-647: Free generate-pdf is 402 "ai_generations"; Pro 6th of the month is 402; Founder unlimited', async () => {
    const free = await newUser();
    const f = await genPdf(free, { title: 'Livre' }, pdf('Sepse. '.repeat(20)));
    expect(f.status).toBe(402);
    expect(((await f.json()) as { error: { message: string } }).error.message).toBe('ai_generations');
    expect(await generations(free)).toBe(0);
    const [pro, founder] = [await newUser('pro'), await newUser('founder')];
    const { localDay } = await import('../billing/quota');
    for (const u of [pro, founder]) {
      const day = await localDay(u, new Date());
      await dbm.db.insert(dbm.usageCounters).values({ userId: u, period: `${day.slice(0, 8)}01`, aiGenerations: 5 });
    }
    const p = await genPdf(pro, { title: 'Sexto' }, pdf('Sepse. '.repeat(20)));
    expect(p.status).toBe(402);
    expect(((await p.json()) as { error: { message: string } }).error.message).toBe('ai_generations');
    expect((await genPdf(founder, { title: 'Sexto' }, pdf('x'))).status).toBe(200); // unreadable: fails later and refunds
  });

  it('generate-pdf: an unreadable PDF gives the monthly generation back', async () => {
    const me = await newUser('pro');
    const bad = await genPdf(me, { title: 'Ilegivel' }, pdf('x'));
    expect(bad.status).toBe(200);
    const { data } = (await bad.json()) as { data: { jobId: string } };
    for (let i = 0; i < 50; i++) {
      const job = (await (await app.request(`/v1/ai/jobs/${data.jobId}`, { headers: { authorization: `Bearer ${me}` } })).json()) as { data: { status: string } };
      if (job.data.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await generations(me)).toBe(0);
  });

  it('generate-pdf multipart (D-532): board is validated like createBoard before anything is charged', async () => {
    const me = await newUser('pro');
    const form = (board: unknown, body = pdf('x')) => {
      const f = new FormData();
      f.set('file', new Blob([body as BlobPart], { type: 'application/pdf' }), 'a.pdf');
      f.set('board', JSON.stringify(board));
      return app.request('/v1/ai/generate-pdf', { method: 'POST', headers: { authorization: `Bearer ${me}` }, body: f });
    };
    expect((await form({ title: 'Senha', access: 'password' })).status).toBe(422);
    expect((await form({ title: 'Item', area: 'CM', matrixItemIds: [uuid()] })).status).toBe(422);
    expect((await form({ title: 'Falso' }, new TextEncoder().encode('<html>'))).status).toBe(422);
    expect(await generations(me)).toBe(0);
    expect((await form({ title: 'Ok', area: 'PED', access: 'public' })).status).toBe(200); // unreadable: fails later and refunds
  });

  it('generate: the 6th start in a minute is 429', async () => {
    const me = await newUser();
    await dbm.db.insert(dbm.boards).values([{ userId: me, title: 'Um' }, { userId: me, title: 'Dois' }]); // 402 path: cheap, still counted
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await req(me, '/generate-board', JSON.stringify({ kind: 'text', title: 'X', area: 'CM', text: 'Sepse. '.repeat(40) }))).status);
    expect(codes).toEqual([402, 402, 402, 402, 402, 429]);
  });
});
