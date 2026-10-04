// Integration: needs local Supabase (see account.test.ts); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });

type Body = { data?: { id?: string; version?: number; items?: { id: string; cardId: string }[] }; error?: { code: string; message: string } };

describe.skipIf(!process.env.DATABASE_URL)('F10 approve, publish, copy', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;

  const newUser = async (role: 'student' | 'reviewer' = 'student') => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    if (role === 'reviewer') {
      await dbm.db.insert(dbm.profiles).values({ userId: id, name: 'Revisor', role: 'reviewer', crm: 'CRM-SP 123456' }).onConflictDoUpdate({
        target: dbm.profiles.userId,
        set: { name: 'Revisor', role: 'reviewer', crm: 'CRM-SP 123456' },
      });
    }
    return id;
  };

  const call = async (user: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${user}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Body };
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });

  afterAll(async () => {
    if (!dbm || !users.length) return;
    const ids = users.map((u) => `'${u}'`).join(',');
    await dbm.db.execute(sql.raw(`delete from boards where user_id in (${ids})`));
    await dbm.db.execute(sql.raw(`delete from auth.users where id in (${ids})`));
  });

  it('a student gets 404; approving three cards publishes, and a later edition leaves the copy note', async () => {
    const author = await newUser();
    const reviewer = await newUser('reviewer');
    const student = await newUser();
    const [open, own] = await dbm.db.insert(dbm.assets).values([
      { userId: author, key: `assets/${author}/open`, mime: 'image/webp', license: 'cc_by' },
      { userId: author, key: `assets/${author}/own`, mime: 'image/webp', license: 'own' },
    ]).returning();
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: author, title: 'Sepse de teste', status: 'seed_draft', temporalMark: 'Enamed 2026.2' }).returning();
    const titles = ['Hemocultura', 'Lactato', 'Foco'];
    const concepts = await dbm.db.insert(dbm.cards).values(titles.map((title, order) => ({
      boardId: board!.id, title, back: `${title}. Diretriz.`, source: 'ILAS', status: 'draft' as const, order,
      frontAssetId: title === 'Hemocultura' ? own!.id : null,
      rubric: { points: [{ text: title, essential: true }], source: 'ILAS', version: 1, status: 'draft', reviewerId: null },
    }))).returning();
    const [shared, personal] = await dbm.db.insert(dbm.cards).values([
      {
        boardId: board!.id, type: 'image' as const, title: 'Figura aberta', status: 'approved' as const, order: 3,
        payload: { assetId: open!.id, masks: [{ polygon: [[0, 0], [1, 0], [0, 1]], label: 'foco' }] },
      },
      {
        boardId: board!.id, type: 'image' as const, title: 'Figura própria', status: 'approved' as const, order: 4,
        payload: { assetId: own!.id, masks: [{ polygon: [[0, 0], [1, 0], [0, 1]], label: 'privada' }] },
      },
    ]).returning();
    await dbm.db.insert(dbm.edges).values({ boardId: board!.id, fromCardId: concepts[0]!.id, toCardId: concepts[1]!.id, label: 'leva a' });
    const queued = await dbm.db.insert(dbm.reviewQueue).values(concepts.map((card) => ({ cardId: card.id, status: 'pending' as const }))).returning();

    expect((await call(student, 'GET', '/editorial/queue')).status).toBe(404);
    const blocked = await call(reviewer, 'POST', '/editorial/publish', { boardId: board!.id, changelog: 'Cedo demais', temporalMark: 'Enamed 2026.2' });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error?.message).toBe('cards still draft');

    for (const item of queued) {
      const decided = await call(reviewer, 'POST', '/editorial/decide', { reviewItemId: item.id, decision: 'approved', note: null });
      expect(decided.status).toBe(200);
    }
    const [approved] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, concepts[0]!.id));
    expect(approved).toMatchObject({ status: 'approved', reviewerId: reviewer });
    expect(approved!.rubric).toMatchObject({ reviewerName: 'Revisor', reviewerCrm: 'CRM-SP 123456', status: 'approved' });

    const published = await call(reviewer, 'POST', '/editorial/publish', { boardId: board!.id, changelog: 'Primeira edição', temporalMark: 'Enamed 2026.2' });
    expect(published.status).toBe(200);
    expect(published.json.data?.version).toBe(2);
    const seeds = await call(student, 'GET', '/editorial/seeds');
    expect(seeds.json.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: board!.id, title: 'Sepse de teste' })]));

    const before = await call(student, 'POST', '/editorial/copy', { boardId: uuid() });
    expect(before.status).toBe(404);
    const copied = await call(student, 'POST', '/editorial/copy', { boardId: board!.id });
    expect(copied.status).toBe(200);
    const copyId = copied.json.data!.id!;
    const copyCards = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.boardId, copyId));
    const noteCard = copyCards.find((c) => c.title === 'Hemocultura')!;
    await dbm.db.update(dbm.cards).set({ back: 'anotação privada' }).where(eq(dbm.cards.id, noteCard.id));
    expect(noteCard.frontAssetId).toBeNull();
    const openCopy = copyCards.find((c) => c.title === 'Figura aberta')!;
    const ownCopy = copyCards.find((c) => c.title === 'Figura própria')!;
    expect((openCopy.payload as { assetId?: string }).assetId).toBe(open!.id);
    expect((ownCopy.payload as { assetId?: string; masks?: unknown[] }).assetId ?? null).toBeNull();
    expect((ownCopy.payload as { masks?: unknown[] }).masks).toEqual([]);
    const maskRows = await dbm.db.select().from(dbm.masks).where(eq(dbm.masks.cardId, openCopy.id));
    expect(maskRows).toHaveLength(1);
    expect(maskRows[0]?.assetId).toBe(open!.id);
    expect(await dbm.db.select().from(dbm.masks).where(eq(dbm.masks.cardId, ownCopy.id))).toHaveLength(0);
    const copyEdges = await dbm.db.select().from(dbm.edges).where(eq(dbm.edges.boardId, copyId));
    expect(copyEdges).toHaveLength(1);

    await dbm.db.update(dbm.cards).set({ back: 'texto da edição nova' }).where(eq(dbm.cards.id, concepts[0]!.id));
    const second = await call(reviewer, 'POST', '/editorial/publish', { boardId: board!.id, changelog: 'Segunda edição', temporalMark: 'Enamed 2026.2' });
    expect(second.json.data?.version).toBe(3);
    const [kept] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, noteCard.id));
    expect(kept?.back).toBe('anotação privada');
    const [source] = await dbm.db.select().from(dbm.boards).where(eq(dbm.boards.id, copyId));
    expect(source).toMatchObject({ status: 'private', sourceBoardId: board!.id });
    expect(shared!.id).not.toBe(personal!.id);
  });

  it('approving a card without a rubric still stamps the reviewer name and CRM', async () => {
    const author = await newUser();
    const reviewer = await newUser('reviewer');
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: author, title: 'Sem rubrica', status: 'seed_draft' }).returning();
    const [card] = await dbm.db.insert(dbm.cards).values({
      boardId: board!.id, title: 'Hipotensão', back: 'Queda da pressão com perfusão ruim.', source: 'Diretriz', status: 'draft', rubric: null,
    }).returning();
    const [item] = await dbm.db.insert(dbm.reviewQueue).values({ cardId: card!.id, status: 'pending' }).returning();
    const decided = await call(reviewer, 'POST', '/editorial/decide', { reviewItemId: item!.id, decision: 'approved', note: null });
    expect(decided.status).toBe(200);
    const [saved] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, card!.id));
    expect(saved).toMatchObject({ status: 'approved', reviewerId: reviewer });
    expect(saved!.rubric).toMatchObject({
      status: 'approved',
      reviewerName: 'Revisor',
      reviewerCrm: 'CRM-SP 123456',
      source: 'Diretriz',
      points: [{ text: 'Queda da pressão com perfusão ruim.', essential: true }],
    });
  });

  it('adjusting a dispute writes a new rubric version, even when the card had none', async () => {
    const author = await newUser();
    const reviewer = await newUser('reviewer');
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: author, title: 'Ajuste', status: 'private' }).returning();
    const [withRubric, without] = await dbm.db.insert(dbm.cards).values([
      {
        boardId: board!.id, title: 'Com rubrica', back: 'Noradrenalina.', source: 'Diretriz', status: 'approved',
        rubric: { points: [{ text: 'Noradrenalina', essential: true }], source: 'Diretriz', version: 1, status: 'approved', reviewerId: null },
      },
      { boardId: board!.id, title: 'Sem rubrica', back: 'Reavaliar o lactato.', source: 'Diretriz', status: 'approved', rubric: null },
    ]).returning();
    const [first, second] = await dbm.db.insert(dbm.reviewQueue).values([
      { cardId: withRubric!.id, status: 'pending', flagSource: 'user_disagree' },
      { cardId: without!.id, status: 'pending', flagSource: 'user_disagree' },
    ]).returning();
    expect((await call(reviewer, 'POST', '/editorial/dispute', {
      reviewItemId: first!.id, outcome: 'rubric_adjusted', note: null, rubricPoints: [{ text: 'Iniciar noradrenalina', essential: true }],
    })).status).toBe(200);
    expect((await call(reviewer, 'POST', '/editorial/dispute', {
      reviewItemId: second!.id, outcome: 'rubric_adjusted', note: null, rubricPoints: [{ text: 'Reavaliar o lactato', essential: true }],
    })).status).toBe(200);
    const [kept, created] = await Promise.all([
      dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, withRubric!.id)),
      dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, without!.id)),
    ]);
    expect(kept[0]?.rubric).toMatchObject({
      version: 2,
      status: 'draft',
      source: 'Diretriz',
      points: [{ text: 'Iniciar noradrenalina', essential: true }],
      previousPoints: [{ text: 'Noradrenalina', essential: true }],
    });
    expect(created[0]).toMatchObject({ status: 'draft' });
    expect(created[0]?.rubric).toMatchObject({
      version: 1,
      status: 'draft',
      source: 'Diretriz',
      points: [{ text: 'Reavaliar o lactato', essential: true }],
      previousPoints: [],
    });
    const pending = await dbm.db.select().from(dbm.reviewQueue).where(eq(dbm.reviewQueue.cardId, without!.id));
    expect(pending.filter((row) => row.status === 'pending')).toHaveLength(1);
  });

  it('a dispute in the queue shows the student answer and the verdict', async () => {
    const student = await newUser();
    const reviewer = await newUser('reviewer');
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: student, title: 'Discordância', status: 'private' }).returning();
    const [card] = await dbm.db.insert(dbm.cards).values({
      boardId: board!.id, title: 'Droga', back: 'Noradrenalina.', source: 'Diretriz', status: 'approved',
      rubric: { points: [{ text: 'Noradrenalina', essential: true }], source: 'Diretriz', version: 1, status: 'approved', reviewerId: null },
    }).returning();
    const [attempt] = await dbm.db.insert(dbm.attempts).values({
      userId: student, cardId: card!.id, mode: 'hidden_card', inputKind: 'text', grade: 1,
      answerText: 'Usar dopamina em bolus.',
      verdict: { verdict: 'incorrect', matched: [], missing: ['Noradrenalina'], criticalError: true, feedback: 'A conduta contraria a rubrica.', model: 'offline-grader', disputed: true },
    }).returning();
    await dbm.db.insert(dbm.reviewQueue).values({ cardId: card!.id, status: 'pending', flagSource: 'user_disagree', attemptId: attempt!.id });

    const queue = await call(reviewer, 'GET', '/editorial/queue?flag=user_disagree');
    expect(queue.status).toBe(200);
    const item = (queue.json.data as { items?: { answerText?: string; verdict?: string; feedback?: string; criticalError?: boolean; points?: { text: string }[] }[] } | undefined)?.items?.find((row) => row.answerText === 'Usar dopamina em bolus.');
    expect(item).toMatchObject({
      verdict: 'incorrect',
      feedback: 'A conduta contraria a rubrica.',
      criticalError: true,
      points: [{ text: 'Noradrenalina' }],
    });
  });
});
