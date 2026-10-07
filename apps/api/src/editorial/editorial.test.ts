// Integration: needs local Supabase (see account.test.ts); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeCrm } from './editorial';

config({ path: '../../.env' });

describe('normalizeCrm (D-496)', () => {
  it('accepts number + UF in the usual spellings and returns 123456-SP', () => {
    for (const raw of ['123456-SP', 'CRM-SP 123456', 'crm/sp 123.456', '123456 sp', 'SP 123456', 'CRM 123456/SP']) expect(normalizeCrm(raw)).toBe('123456-SP');
  });
  it('rejects missing UF, unknown UF, missing number and noise', () => {
    for (const raw of ['', '123456', 'SP', '123456-XX', '12345678-SP', '123456-SP-RJ', 'abc', null, undefined]) expect(normalizeCrm(raw)).toBeNull();
  });
});

type Body = { data?: { id?: string; version?: number; items?: { id: string; cardId: string }[] }; error?: { code: string; message: string } };

describe.skipIf(!process.env.DATABASE_URL)('F10 approve, publish, copy', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;

  const newUser = async (role: 'student' | 'reviewer' | 'admin' = 'student', crm: string | null = 'CRM-SP 123456') => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    if (role !== 'student') {
      await dbm.db.insert(dbm.profiles).values({ userId: id, name: 'Revisor', role, crm }).onConflictDoUpdate({
        target: dbm.profiles.userId,
        set: { name: 'Revisor', role, crm },
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
    expect(approved!.rubric).toMatchObject({ reviewerName: 'Revisor', reviewerCrm: '123456-SP', status: 'approved' });

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
      reviewerCrm: '123456-SP',
      source: 'Diretriz',
      points: [{ text: 'Queda da pressão com perfusão ruim.', essential: true }],
    });
  });

  it('adjusting a dispute writes a new rubric version, even when the card had none', async () => {
    const author = await newUser();
    const reviewer = await newUser('reviewer');
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: author, title: 'Ajuste', status: 'seed_approved' }).returning();
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
  const seedWithPending = async (status: 'seed_draft' | 'seed_approved' | 'private' = 'seed_draft', owner?: string) => {
    const author = owner ?? await newUser();
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: author, title: `Seed ${uuid().slice(0, 6)}`, status }).returning();
    const [card] = await dbm.db.insert(dbm.cards).values({ boardId: board!.id, title: 'Choque', back: 'Noradrenalina.', source: 'ILAS', status: 'draft' }).returning();
    const [item] = await dbm.db.insert(dbm.reviewQueue).values({ cardId: card!.id, status: 'pending' }).returning();
    return { author, board: board!, card: card!, item: item! };
  };

  it('F31 library: lists only approved maps with badge and stats; Free copies one sample; trail and prereqs travel; report reaches the queue', async () => {
    const student = await newUser();
    const other = await newUser();
    const author = await newUser();
    const path = { slug: `t-${uuid().slice(0, 8)}`, modulos: ['M1'], area: 'Clínica Médica', dominios: [], competencias: [], revisarAte: '2027-01-01', versao: '2026.1', aviso: 'x' };
    const mk = async (title: string, status: 'seed_approved' | 'seed_draft') => {
      const [b] = await dbm.db.insert(dbm.boards).values({ userId: author, title, status, area: 'CM', badges: ['top10_enamed'], path: { ...path, slug: `t-${uuid().slice(0, 8)}` } as never }).returning();
      return b!;
    };
    const approved = await mk('Biblioteca aprovada', 'seed_approved');
    const draft = await mk('Biblioteca rascunho', 'seed_draft');
    const [a, b] = await dbm.db.insert(dbm.cards).values([
      { boardId: approved.id, title: 'A', status: 'approved' as const, pathOrder: 1, didactics: { nivel: 1, modulo: 'M1', risco: 'nenhum' } as never },
      { boardId: approved.id, title: 'B', status: 'approved' as const, pathOrder: 2, didactics: { nivel: 2, modulo: 'M1', risco: 'nenhum' } as never },
    ]).returning();
    await dbm.db.insert(dbm.cardPrereqs).values({ cardId: b!.id, prereqCardId: a!.id });
    await dbm.db.insert(dbm.cards).values({ boardId: draft.id, title: 'C', status: 'draft' });

    const list = await call(student, 'GET', '/editorial/seeds');
    const items = list.json.data as unknown as { id: string; badges: string[]; cardCount: number; levels: number[] }[];
    expect(items.find((x) => x.id === draft.id)).toBeUndefined();
    expect(items.find((x) => x.id === approved.id)).toMatchObject({ badges: ['top10_enamed'], cardCount: 2, levels: [1, 2] });
    expect((await call(student, 'GET', `/editorial/seeds/${draft.id}`)).status).toBe(404);
    expect((await call(student, 'GET', `/editorial/seeds/${approved.id}`)).status).toBe(200);

    await dbm.db.execute(sql`delete from entitlement_grants where user_id = ${student}`); // a signup trial would make this user Pro
    const copied = await call(student, 'POST', '/editorial/copy', { boardId: approved.id });
    expect(copied.status).toBe(200);
    const [copy] = await dbm.db.select().from(dbm.boards).where(eq(dbm.boards.id, copied.json.data!.id!));
    expect(copy).toMatchObject({ badges: [], path: expect.objectContaining({ versao: '2026.1' }) });
    const copyCards = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.boardId, copy!.id));
    expect(copyCards.map((c) => c.pathOrder).sort()).toEqual([1, 2]);
    const prereqs = await dbm.db.select().from(dbm.cardPrereqs).where(eq(dbm.cardPrereqs.cardId, copyCards.find((c) => c.title === 'B')!.id));
    expect(prereqs[0]?.prereqCardId).toBe(copyCards.find((c) => c.title === 'A')!.id);
    const second = await call(student, 'POST', '/editorial/copy', { boardId: approved.id });
    expect(second.json.error?.message).toBe('boards'); // Free: one sample

    // report: from the seed card and from the copy (points at the original); never a stranger's private card
    const fromSeed = await call(other, 'POST', '/editorial/report', { cardId: a!.id, note: 'dose errada' });
    expect(fromSeed.status).toBe(200);
    const fromCopy = await call(student, 'POST', '/editorial/report', { cardId: copyCards.find((c) => c.title === 'B')!.id, note: 'fonte antiga' });
    const [queued] = await dbm.db.select().from(dbm.reviewQueue).where(eq(dbm.reviewQueue.id, fromCopy.json.data!.id!));
    expect(queued).toMatchObject({ cardId: b!.id, status: 'pending', flagSource: 'user_disagree', note: 'fonte antiga' });
    expect((await call(other, 'POST', '/editorial/report', { cardId: copyCards[0]!.id, note: 'x' })).status).toBe(404);
    expect((await call(other, 'POST', '/editorial/report', { cardId: a!.id, note: '  ' })).status).toBe(422);
  });

  it('publish: never a student private board; needs the reviewer CRM; the version records name and CRM (rule 6)', async () => {
    const reviewer = await newUser('reviewer');
    const student = await newUser();
    const [priv] = await dbm.db.insert(dbm.boards).values({ userId: student, title: 'Meu mapa', status: 'private' }).returning();
    await dbm.db.insert(dbm.cards).values({ boardId: priv!.id, title: 'Nota', status: 'approved' });
    const leaked = await call(reviewer, 'POST', '/editorial/publish', { boardId: priv!.id, changelog: 'x', temporalMark: 'Enamed 2026.2' });
    expect(leaked.status).toBe(404);
    const [still] = await dbm.db.select().from(dbm.boards).where(eq(dbm.boards.id, priv!.id));
    expect(still).toMatchObject({ status: 'private', version: 1 });

    const [seed] = await dbm.db.insert(dbm.boards).values({ userId: student, title: 'Seed pronta', status: 'seed_draft' }).returning();
    await dbm.db.insert(dbm.cards).values({ boardId: seed!.id, title: 'Ok', status: 'approved' });
    const noCrm = await newUser('reviewer', null);
    const blocked = await call(noCrm, 'POST', '/editorial/publish', { boardId: seed!.id, changelog: 'x', temporalMark: 'Enamed 2026.2' });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error?.message).toBe('reviewer_crm_required');
    const admin = await newUser('admin');
    expect((await call(admin, 'POST', '/editorial/publish', { boardId: seed!.id, changelog: 'x', temporalMark: 'Enamed 2026.2' })).status).toBe(403);

    const done = await call(reviewer, 'POST', '/editorial/publish', { boardId: seed!.id, changelog: 'Primeira', temporalMark: 'Enamed 2026.2' });
    expect(done.status).toBe(200);
    const [version] = await dbm.db.select().from(dbm.boardVersions).where(eq(dbm.boardVersions.boardId, seed!.id));
    expect(version!.snapshot).toMatchObject({ reviewerName: 'Revisor', reviewerCrm: '123456-SP' });
  });

  it('publish F31 (P-672): a trail board needs every card from the verified build; the edition keeps didactics, sources and trail order', async () => {
    const reviewer = await newUser('reviewer');
    const author = await newUser();
    const path = { slug: `t-${uuid().slice(0, 8)}`, modulos: ['M1'], area: 'Clínica Médica', dominios: [], competencias: [], revisarAte: '2027-01-01', versao: '2026.1', aviso: 'x' };
    const [trail] = await dbm.db.insert(dbm.boards).values({ userId: author, title: 'Trilha', status: 'seed_draft', path: path as never }).returning();
    const didactics = { nivel: 1 as const, modulo: 'M1' as const, risco: 'nenhum' as const };
    const sources = [{ doc: 'doc-a', local: 's1', versao: '2026', acesso: '2026-10-01' }];
    await dbm.db.insert(dbm.cards).values({ boardId: trail!.id, title: 'Do build', status: 'approved', pathOrder: 1, didactics, sources });
    const [loose] = await dbm.db.insert(dbm.cards).values({ boardId: trail!.id, title: 'Fora do build', status: 'approved' }).returning();
    const publish = () => call(reviewer, 'POST', '/editorial/publish', { boardId: trail!.id, changelog: 'Primeira', temporalMark: 'Enamed 2026.2' });

    const blocked = await publish();
    expect(blocked.status).toBe(422);
    expect(blocked.json.error?.message).toBe('trail card outside the verified build');
    await dbm.db.update(dbm.cards).set({ pathOrder: 2 }).where(eq(dbm.cards.id, loose!.id));
    expect((await publish()).status).toBe(200);
    const [version] = await dbm.db.select().from(dbm.boardVersions).where(eq(dbm.boardVersions.boardId, trail!.id));
    expect((version!.snapshot as { cards: unknown[] }).cards).toContainEqual(expect.objectContaining({ title: 'Do build', pathOrder: 1, didactics, sources }));
  });

  it('decide: only a reviewer with name and valid CRM approves; admin is refused; a decided item stays decided', async () => {
    const { item, card } = await seedWithPending();
    const admin = await newUser('admin');
    expect((await call(admin, 'POST', '/editorial/decide', { reviewItemId: item.id, decision: 'approved', note: null })).status).toBe(403);
    const badCrm = await newUser('reviewer', 'qualquer coisa');
    const bad = await call(badCrm, 'POST', '/editorial/decide', { reviewItemId: item.id, decision: 'approved', note: null });
    expect(bad.status).toBe(422);
    expect(bad.json.error?.message).toBe('reviewer_crm_required');
    const [untouched] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, card.id));
    expect(untouched).toMatchObject({ status: 'draft', reviewerId: null });

    const reviewer = await newUser('reviewer', 'crm/rj 98.765');
    expect((await call(reviewer, 'POST', '/editorial/decide', { reviewItemId: item.id, decision: 'approved', note: null })).status).toBe(200);
    const [stamped] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, card.id));
    expect(stamped!.rubric).toMatchObject({ reviewerName: 'Revisor', reviewerCrm: '98765-RJ', status: 'approved' });
    const again = await call(reviewer, 'POST', '/editorial/decide', { reviewItemId: item.id, decision: 'rejected', note: 'mudei de ideia' });
    expect(again.status).toBe(409);
  });

  it('decide: a queue row on a student private card never stamps that card approved', async () => {
    const { item, card } = await seedWithPending('private');
    const reviewer = await newUser('reviewer');
    expect((await call(reviewer, 'POST', '/editorial/decide', { reviewItemId: item.id, decision: 'approved', note: null })).status).toBe(409);
    const [kept] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, card.id));
    expect(kept).toMatchObject({ status: 'draft', reviewerId: null });
  });

  it('crm: invalid formats are refused, valid ones are stored normalized', async () => {
    const reviewer = await newUser('reviewer', null);
    expect((await call(reviewer, 'POST', '/editorial/crm', { crm: '12' })).status).toBe(422);
    const saved = await call(reviewer, 'POST', '/editorial/crm', { crm: 'CRM-MG 4321' });
    expect(saved.status).toBe(200);
    const [p] = await dbm.db.select().from(dbm.profiles).where(eq(dbm.profiles.userId, reviewer));
    expect(p?.crm).toBe('4321-MG');
  });

  const disputeOn = async (cardId: string, by: string) => {
    const [attempt] = await dbm.db.insert(dbm.attempts).values({
      userId: by, cardId, mode: 'hidden_card', inputKind: 'text', grade: 1, answerText: 'resposta',
      verdict: { verdict: 'incorrect', matched: [], missing: [], criticalError: false, feedback: 'f', model: 'offline-grader', disputed: true },
    }).returning();
    const [item] = await dbm.db.insert(dbm.reviewQueue).values({ cardId, status: 'pending', flagSource: 'user_disagree', attemptId: attempt!.id }).returning();
    return item!;
  };
  const adjust = (reviewer: string, id: string) =>
    call(reviewer, 'POST', '/editorial/dispute', { reviewItemId: id, outcome: 'rubric_adjusted', note: null, rubricPoints: [{ text: 'Iniciar noradrenalina', essential: true }] });
  const rubricV1 = { points: [{ text: 'Noradrenalina', essential: true }], source: 'ILAS', version: 1, status: 'approved', reviewerId: null };

  it('dispute on a seed copy adjusts the seed card, never the student copy; a resolved item cannot be resolved again', async () => {
    const author = await newUser();
    const reviewer = await newUser('reviewer');
    const student = await newUser();
    const [seed] = await dbm.db.insert(dbm.boards).values({ userId: author, title: 'Seed original', status: 'seed_approved' }).returning();
    const [orig] = await dbm.db.insert(dbm.cards).values({ boardId: seed!.id, title: 'Choque séptico', back: 'Noradrenalina.', status: 'approved', rubric: rubricV1 }).returning();
    const [copy] = await dbm.db.insert(dbm.boards).values({ userId: student, title: 'Seed original', status: 'private', sourceBoardId: seed!.id }).returning();
    const [mine] = await dbm.db.insert(dbm.cards).values({ boardId: copy!.id, title: 'Choque séptico', back: 'minha anotação', status: 'approved', rubric: rubricV1 }).returning();
    const item = await disputeOn(mine!.id, student);
    expect((await adjust(reviewer, item.id)).status).toBe(200);
    const [[o], [m]] = await Promise.all([
      dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, orig!.id)),
      dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, mine!.id)),
    ]);
    expect(o!.rubric).toMatchObject({ version: 2, status: 'draft', points: [{ text: 'Iniciar noradrenalina' }] });
    expect(m).toMatchObject({ status: 'approved', back: 'minha anotação', rubric: rubricV1 });
    expect((await adjust(reviewer, item.id)).status).toBe(409);

    const copied = await call(student, 'POST', '/editorial/copy', { boardId: seed!.id });
    const [fresh] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.boardId, copied.json.data!.id!));
    expect(fresh).toMatchObject({ status: 'draft', sourceCardId: orig!.id }); // an unreviewed adjustment never travels as approved
  });

  it('a seed copy linked by source_card_id reaches its seed card even after the student renames it (D-531)', async () => {
    const author = await newUser();
    const reviewer = await newUser('reviewer');
    const student = await newUser();
    const [seed] = await dbm.db.insert(dbm.boards).values({ userId: author, title: 'Seed vínculo', status: 'seed_approved' }).returning();
    const [orig, decoy] = await dbm.db.insert(dbm.cards).values([
      { boardId: seed!.id, title: 'Choque séptico', back: 'Noradrenalina.', status: 'approved' as const, rubric: rubricV1 },
      { boardId: seed!.id, title: 'Meu título', back: 'Outro.', status: 'approved' as const, rubric: rubricV1 },
    ]).returning();
    const [copy] = await dbm.db.insert(dbm.boards).values({ userId: student, title: 'Seed vínculo', status: 'private', sourceBoardId: seed!.id }).returning();
    const [mine] = await dbm.db.insert(dbm.cards).values({ boardId: copy!.id, title: 'Meu título', status: 'approved', rubric: rubricV1, sourceCardId: orig!.id }).returning();
    const item = await disputeOn(mine!.id, student);
    expect((await adjust(reviewer, item.id)).status).toBe(200);
    const [o] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, orig!.id));
    const [d] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, decoy!.id));
    expect(o!.rubric).toMatchObject({ version: 2 });
    expect(d!.rubric).toMatchObject({ version: 1 });
  });

  it('dispute on someone else private card refuses the adjustment; on the disputer own card it applies', async () => {
    const reviewer = await newUser('reviewer');
    const owner = await newUser();
    const other = await newUser();
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: owner, title: 'Privado', status: 'private' }).returning();
    const [card] = await dbm.db.insert(dbm.cards).values({ boardId: board!.id, title: 'Droga', back: 'Noradrenalina.', status: 'approved', rubric: rubricV1 }).returning();
    const foreign = await disputeOn(card!.id, other);
    expect((await adjust(reviewer, foreign.id)).status).toBe(409);
    const [kept] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, card!.id));
    expect(kept!.rubric).toEqual(rubricV1);
    const own = await disputeOn(card!.id, owner);
    expect((await adjust(reviewer, own.id)).status).toBe(200);
    const [changed] = await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.id, card!.id));
    expect(changed!.rubric).toMatchObject({ version: 2, status: 'draft' });
  });

  it('seeds: a student sees only approved, unarchived seeds', async () => {
    const student = await newUser();
    const { board: draft } = await seedWithPending('seed_draft');
    const { board: archived } = await seedWithPending('seed_approved');
    await dbm.db.update(dbm.boards).set({ archivedAt: new Date() }).where(eq(dbm.boards.id, archived.id));
    const ids = ((await call(student, 'GET', '/editorial/seeds')).json.data as unknown as { id: string }[]).map((b) => b.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(archived.id);
  });
});
