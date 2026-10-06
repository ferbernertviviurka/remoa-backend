// Integration: needs local Supabase (`pnpm db:up && pnpm db:migrate`, DATABASE_URL from the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grade as mockGrader } from '@remoa/contracts/mocks';
import { err, ok, type GradeAnswer } from '@remoa/contracts';
import { flowOrder, makeOptions } from '../challenge/build';
import type { GradeStream } from '../challenge/session';

config({ path: '../../.env' });

const HOUR = 3_600_000;
// distinctive strings so "the canonical never leaks" can be asserted on raw JSON
const STEPS = ['Coletar hemocultura antes do antibiótico', 'Iniciar antibiótico de amplo espectro', 'Ressuscitação volêmica com cristaloide', 'Reavaliar perfusão tecidual', 'Introduzir vasopressor se refratário'];
const MASKS = [{ id: uuid(), label: 'Ventrículo esquerdo' }, { id: uuid(), label: 'Átrio direito' }];
const CASE = [
  { stage: 'presentation', text: 'Homem de 60 anos com febre e hipotensão' },
  { stage: 'workup', text: 'Lactato de 5 e leucocitose com desvio' },
  { stage: 'diagnosis', text: 'Choque séptico de foco pulmonar' },
];
const RUBRIC = (status: 'draft' | 'approved') => ({ points: [{ text: 'Hemocultura', essential: true }], source: 'Diretriz', version: 1, status, reviewerId: null });

type J = { ok?: true; data?: any; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('makeOptions (pure)', () => {
  it('excludes the canonical (case-insensitive) and duplicates; needs 3 distractors', () => {
    const o = makeOptions('Sepse', ['sepse', 'SEPSE ', 'Choque', 'choque', 'Febre', 'Dor', 'Tosse'], 'seed')!;
    expect(o).toHaveLength(4);
    expect(o.filter((x) => x.toLowerCase().trim() === 'sepse')).toHaveLength(1);
    expect(new Set(o.map((x) => x.toLowerCase())).size).toBe(4);
    expect(makeOptions('Sepse', ['sepse', 'Choque', 'choque', 'Febre'], 'seed')).toBeUndefined();
    expect(makeOptions('Sepse', ['A', 'B', 'C'], 'k')).toEqual(makeOptions('Sepse', ['A', 'B', 'C'], 'k')); // deterministic
  });
});

describe('flowOrder (pure)', () => {
  const e = (from: string, to: string) => ({ from, to });
  it('follows the arrows from several roots; a card waits for all its predecessors; ties by card order', () => {
    expect(flowOrder(['a', 'b', 'c', 'd', 'e'], [e('a', 'c'), e('c', 'e'), e('b', 'd'), e('a', 'd')])).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(flowOrder(['a', 'b', 'c'], [e('b', 'c'), e('a', 'b')])).toEqual(['a', 'b', 'c']);
  });
  it('isolated cards are roots in card order; foreign ids and self-loops are ignored', () => {
    expect(flowOrder(['x', 'y', 'z'], [e('z', 'z'), e('y', 'nope')])).toEqual(['x', 'y', 'z']);
  });
  it('breaks a cycle at the first card in card order, after the real roots', () => {
    expect(flowOrder(['a', 'b', 'c', 'r'], [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('r', 'a')])).toEqual(['r', 'a', 'b', 'c']);
    expect(flowOrder(['a', 'b', 'c'], [e('a', 'b'), e('b', 'c'), e('c', 'a')])).toEqual(['a', 'b', 'c']);
  });
  it('is deterministic', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const es = [e('d', 'a'), e('b', 'c'), e('c', 'b')];
    expect(flowOrder(ids, es)).toEqual(flowOrder(ids, es));
  });
});

describe.skipIf(!process.env.DATABASE_URL)('/v1/challenge', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let mk: (grade?: GradeAnswer, stream?: GradeStream) => ReturnType<typeof import('../app').createApp>;
  let app: ReturnType<typeof import('../app').createApp>;
  let quota: typeof import('../challenge/quota');

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const post = async (user: string, path: string, body: unknown, a = app) => {
    const res = await a.request(`/v1/challenge${path}`, { method: 'POST', headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const raw = await res.text();
    return { status: res.status, raw, json: JSON.parse(raw) as J };
  };
  const card = async (boardId: string, o: { type?: 'concept' | 'flow' | 'image' | 'case' | 'note'; title?: string; front?: string; back?: string; payload?: unknown; rubric?: unknown; order?: number }) => {
    const [c] = await dbm.db.insert(dbm.cards).values({ boardId, type: o.type ?? 'concept', title: o.title ?? 'c', front: o.front, back: o.back, payload: o.payload ?? {}, rubric: o.rubric, order: o.order ?? 0 }).returning();
    return c!.id;
  };
  const edge = (boardId: string, from: string, to: string, label: string | null) => dbm.db.insert(dbm.edges).values({ boardId, fromCardId: from, toCardId: to, label });
  /** `pad`: CHALLENGE_MIN_CARDS is 10; padding = image cards without masks (challengeable, but no item, no distractor text). */
  const board = async (userId: string, status: 'private' | 'seed_approved' = 'private', pad = true) => {
    const id = (await dbm.db.insert(dbm.boards).values({ userId, title: 'Mapa', status }).returning())[0]!.id;
    if (pad) await dbm.db.insert(dbm.cards).values(Array.from({ length: 10 }, (_, i) => ({ boardId: id, type: 'image' as const, title: '', payload: {}, order: 100 + i })));
    return id;
  };
  const putState = (userId: string, cardId: string, sub: string, due: Date) => {
    const last = new Date(due.getTime() - 5 * 86_400_000);
    return dbm.db.insert(dbm.fsrsState).values({ userId, cardId, subId: sub, stability: 5, difficulty: 5, due, reps: 3, lapses: 0, lastReview: last, state: 'review', scheduledDays: 5, createdAt: last });
  };
  /** Mini "prancheta": 3 concepts (A-causa->B, C alone), a 5-step flow, a 3-stage case, an image with 2 masks = 11 items. */
  const prancheta = async (u: string, rubric?: unknown) => {
    const b = await board(u);
    const [a, bb, c] = [await card(b, { title: 'Sepse', front: 'O que define sepse?', back: 'Disfunção orgânica por resposta desregulada à infecção', rubric, order: 0 }), await card(b, { title: 'Choque séptico', order: 1, back: 'Sepse com hipotensão persistente' }), await card(b, { title: 'Lactato', order: 2, back: 'Marcador de hipoperfusão' })];
    await edge(b, a, bb, 'evolui para');
    const flow = await card(b, { type: 'flow', title: 'Bundle da hora 1', order: 3, payload: { steps: STEPS.map((text, i) => ({ id: `s${i + 1}`, text })) }, rubric });
    const kase = await card(b, { type: 'case', title: 'Caso séptico', order: 4, payload: { caseSteps: CASE }, rubric });
    const [asset] = await dbm.db.insert(dbm.assets).values({ userId: u, key: 'k', mime: 'image/webp' }).returning();
    const poly = [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.4 }];
    const image = await card(b, { type: 'image', title: 'Coração', order: 5, payload: { assetId: asset!.id, masks: MASKS.map((m) => ({ ...m, polygon: poly })) } });
    return { b, a, bb, c, flow, kase, image };
  };
  /** `ai`: the start endpoint refuses gradingMode 'ai' (CCR-019), so AI-path tests flip the stored option directly. */
  const start = async (u: string, body: object = { kind: 'daily' }, ai = false) => {
    const r = await post(u, '/start', body);
    expect(r.status).toBe(200);
    if (ai) await dbm.db.update(dbm.sessions).set({ options: { gradingMode: 'ai', order: 'random', answerMode: 'write' } }).where(eq(dbm.sessions.id, r.json.data.sessionId));
    return { sessionId: r.json.data.sessionId as string, items: r.json.data.items as any[], raw: r.raw }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const answer = (u: string, sessionId: string, itemId: string, extra: object = { inputKind: 'self' }, a = app) => post(u, '/answer', { sessionId, itemId, durationMs: 4000, ...extra }, a);
  const rate = (u: string, sessionId: string, itemId: string, grade: string, overridden = false) => post(u, '/rate', { sessionId, itemId, grade, overridden });

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    quota = await import('../challenge/quota');
    const { createApp } = await import('../app');
    mk = (grade, stream) => createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null), grade, stream });
    app = mk(mockGrader);
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('requires auth; board sessions need boardId and only they', async () => {
    expect((await app.request('/v1/challenge/start', { method: 'POST' })).status).toBe(401);
    const u = await newUser();
    expect((await post(u, '/start', { kind: 'board' })).status).toBe(422);
    expect((await post(u, '/start', { kind: 'daily', boardId: uuid() })).status).toBe(422);
    expect((await post(u, '/start', { kind: 'board', boardId: uuid() })).status).toBe(404);
  });

  it('empty queue -> a session with 0 items', async () => {
    const s = await start(await newUser());
    expect(s.items).toEqual([]);
  });

  it('prancheta: mode per item, due step first, canonical never in the response', async () => {
    const u = await newUser();
    const w = await prancheta(u);
    await putState(u, w.flow, 's3', new Date(Date.now() - HOUR)); // weak step -> due -> first
    const s = await start(u, { kind: 'board', boardId: w.b });
    expect(s.items).toHaveLength(11);
    expect(s.items[0]).toMatchObject({ cardId: w.flow, subId: 's3', mode: 'next_step' });
    const modes = (cardId: string) => s.items.filter((i) => i.cardId === cardId).map((i) => i.mode);
    expect(modes(w.a)).toEqual(['edge']);
    expect(modes(w.bb)).toEqual(['edge']);
    expect(modes(w.c)).toEqual(['hidden_card']);
    expect(modes(w.flow)).toEqual(Array(5).fill('next_step'));
    expect(modes(w.kase)).toEqual(['case']);
    expect(modes(w.image)).toEqual(['occlusion', 'occlusion']);

    // limit
    expect((await start(u, { kind: 'board', boardId: w.b, limit: 5 })).items).toHaveLength(5);

    // no canonical anywhere
    expect(s.raw).not.toContain('"canonical"');
    expect(s.raw).not.toContain('"x":{');
    for (const i of s.items) {
      expect(i).not.toHaveProperty('canonical');
      if (!i.options) for (const secret of [...STEPS, ...MASKS.map((m) => m.label), CASE[2]!.text, 'evolui para']) expect(JSON.stringify(i)).not.toContain(secret);
    }
    // contexts
    const edgeItem = s.items.find((i) => i.cardId === w.a)!;
    expect(edgeItem.prompt).toBe('O que liga Sepse a Choque séptico?');
    expect(edgeItem.context.edge).toEqual({ fromTitle: 'Sepse', toTitle: 'Choque séptico' });
    expect(edgeItem.context.neighbors).toEqual([]);
    const step3 = s.items.find((i) => i.subId === 's3')!;
    expect(step3.context.revealed).toEqual(STEPS.slice(0, 2));
    const first = s.items.find((i) => i.subId === 's1')!;
    expect(first.prompt).toContain('primeiro passo');
    const img = s.items.find((i) => i.mode === 'occlusion')!;
    expect(img.context.image.masks).toHaveLength(2);
    expect(img.context.image.masks.every((m: object) => !('label' in m))).toBe(true);
    const kase = s.items.find((i) => i.mode === 'case')!;
    expect(kase.context).toMatchObject({ stage: 'diagnosis', revealed: [CASE[0]!.text, CASE[1]!.text] }); // last filled stage on first sight
    // hidden_card without front: title is the answer -> not exposed
    const hidden = s.items.find((i) => i.cardId === w.c)!;
    expect(hidden.cardTitle).toBe('');
    expect(hidden.prompt).toBe('Qual é o conceito?');
    expect(hidden.context.neighbors).toEqual([]);
  });

  it('edge items leave the asked connection out of the neighbours', async () => {
    const u = await newUser();
    const b = await board(u);
    const x = await card(b, { title: 'X', front: 'Pergunta X', back: 'Resposta X' });
    const y = await card(b, { title: 'Y' });
    const z = await card(b, { title: 'Z' });
    await edge(b, x, y, 'causa');
    await edge(b, z, x, 'tratado com');
    // X is edge-eligible; make Y/Z reviewed so only X is new... all three appear, check X
    const s = await start(u, { kind: 'board', boardId: b });
    const ex = s.items.find((i) => i.cardId === x)!;
    expect(ex.mode).toBe('edge');
    // the asked edge goes to the neighbour with the lowest retrievability (tie -> lowest edge id); the other stays as neighbour
    expect(ex.context.neighbors).toHaveLength(1);
    expect(['causa', 'tratado com']).toContain(ex.context.neighbors[0].label);
  });

  it('edge target = other end with the lowest retrievability; edge alternates with hidden_card', async () => {
    const u = await newUser();
    const b = await board(u);
    const x = await card(b, { title: 'X', front: 'Pergunta X', back: 'Resposta X' });
    const y = await card(b, { title: 'Y' });
    const z = await card(b, { title: 'Z' });
    await edge(b, x, y, 'liga-y');
    await edge(b, x, z, 'liga-z');
    await putState(u, y, '', new Date(Date.now() + 3 * 86_400_000)); // Y well remembered
    const s1 = await start(u, { kind: 'board', boardId: b });
    const it1 = s1.items.find((i) => i.cardId === x)!;
    expect(it1.mode).toBe('edge');
    expect(it1.context.edge).toEqual({ fromTitle: 'X', toTitle: 'Z' });
    expect(it1.context.neighbors).toEqual([{ title: 'Y', label: 'liga-y' }]);
    await answer(u, s1.sessionId, it1.id);
    expect((await rate(u, s1.sessionId, it1.id, 'again')).status).toBe(200);
    const s2 = await start(u, { kind: 'board', boardId: b });
    const it2 = s2.items.find((i) => i.cardId === x)!;
    expect(it2.mode).toBe('hidden_card');
    expect(it2.prompt).toBe('Pergunta X');
    expect(it2.cardTitle).toBe('X');
    expect(it2.context.neighbors).toHaveLength(2);
    await answer(u, s2.sessionId, it2.id);
    await rate(u, s2.sessionId, it2.id, 'again');
    expect((await start(u, { kind: 'board', boardId: b })).items.find((i) => i.cardId === x)!.mode).toBe('edge');
  });

  it('case stage rotates with attempt count (n, n-1, ... then wraps)', async () => {
    const u = await newUser();
    const b = await board(u);
    const k = await card(b, { type: 'case', title: 'Caso', payload: { caseSteps: CASE } });
    const seen: string[] = [];
    for (let n = 0; n < 3; n++) {
      const s = await start(u, { kind: 'board', boardId: b });
      const it = s.items.find((i) => i.cardId === k)!;
      seen.push(it.context.stage);
      await answer(u, s.sessionId, it.id);
      await rate(u, s.sessionId, it.id, 'again');
    }
    expect(seen).toEqual(['diagnosis', 'workup', 'diagnosis']);
  });

  it('MCQ: 4 unique options with the canonical once, or none; correction is server-side', async () => {
    const u = await newUser();
    const w = await prancheta(u);
    const s = await start(u, { kind: 'board', boardId: w.b });
    for (const i of s.items) {
      if (i.options) {
        expect(i.options).toHaveLength(4);
        expect(new Set(i.options.map((o: string) => o.toLowerCase())).size).toBe(4);
      }
    }
    expect(s.items.filter((i) => i.mode === 'next_step').every((i) => i.options)).toBe(true);
    expect(s.items.filter((i) => i.mode === 'occlusion' || i.mode === 'case').every((i) => !i.options)).toBe(true);
    const step = s.items.find((i) => i.subId === 's2')!;
    const right = step.options.indexOf(STEPS[1]);
    expect(right).toBeGreaterThanOrEqual(0);
    expect(step.options.filter((o: string) => o === STEPS[1])).toHaveLength(1);
    const ok1 = await answer(u, s.sessionId, step.id, { inputKind: 'mcq', optionIndex: right });
    expect(ok1.json.data).toMatchObject({ canonical: STEPS[1], suggestedGrade: 'good', verdict: null, fallback: null });
    const step4 = s.items.find((i) => i.subId === 's4')!;
    const wrong = (step4.options.indexOf(STEPS[3]) + 1) % 4;
    expect((await answer(u, s.sessionId, step4.id, { inputKind: 'mcq', optionIndex: wrong })).json.data.suggestedGrade).toBe('again');
    const noOpt = s.items.find((i) => i.mode === 'case')!;
    expect((await answer(u, s.sessionId, noOpt.id, { inputKind: 'mcq', optionIndex: 0 })).status).toBe(422);
  });

  it('answer -> rate writes the attempt and updates fsrs_state; retries are idempotent', async () => {
    const u = await newUser();
    const w = await prancheta(u);
    const s = await start(u, { kind: 'board', boardId: w.b });
    const it = s.items.find((i) => i.subId === 's2')!;
    expect((await rate(u, s.sessionId, it.id, 'good')).status).toBe(409); // before answering
    const a = await answer(u, s.sessionId, it.id, { inputKind: 'self' });
    expect(a.json.data.canonical).toBe(STEPS[1]);
    expect(a.json.data.preview.good.intervalDays).toBeGreaterThanOrEqual(0);
    const r1 = await rate(u, s.sessionId, it.id, 'hard', true);
    const r2 = await rate(u, s.sessionId, it.id, 'hard', true);
    expect(r1.status).toBe(200);
    expect(r2.json.data.due).toBe(r1.json.data.due);
    const rows = await dbm.db.select().from(dbm.attempts).where(eq(dbm.attempts.userId, u));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cardId: w.flow, subId: 's2', sessionId: s.sessionId, mode: 'next_step', inputKind: 'self', grade: 2, gradeOverridden: true, durationMs: 4000, answerText: null, verdict: null });
    const [st] = await dbm.db.select().from(dbm.fsrsState).where(and(eq(dbm.fsrsState.userId, u), eq(dbm.fsrsState.cardId, w.flow)));
    expect(st).toMatchObject({ subId: 's2', reps: 1 });
  });

  it('answering twice returns the stored result without regrading or a second quota unit', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    let calls = 0;
    const counting = mk(async (i) => (calls++, mockGrader(i)));
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const it = s.items.find((i) => i.subId === 's1')!;
    const body = { inputKind: 'text', text: 'hemocultura primeiro' };
    const a1 = await answer(u, s.sessionId, it.id, body, counting);
    const a2 = await answer(u, s.sessionId, it.id, { inputKind: 'text', text: 'outra coisa' }, counting);
    expect(a1.json.data.verdict.verdict).toBe('correct');
    expect(a2.json.data.verdict).toEqual(a1.json.data.verdict);
    expect(calls).toBe(1);
    const [c] = await dbm.db.select().from(dbm.usageCounters).where(eq(dbm.usageCounters.userId, u));
    expect(c!.aiGrades).toBe(1);
  });

  it('text answer: no rubric -> no_rubric fallback; draft rubric on someone else\'s board too', async () => {
    const u = await newUser();
    const w = await prancheta(u); // no rubrics
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const it = s.items.find((i) => i.subId === 's1')!;
    const r = await answer(u, s.sessionId, it.id, { inputKind: 'text', text: 'qualquer coisa' });
    expect(r.json.data).toMatchObject({ canonical: STEPS[0], verdict: null, suggestedGrade: null, fallback: 'no_rubric', gradeLocked: false });
    expect(r.json.data.preview.again).toBeDefined();
    const counters = await dbm.db.select().from(dbm.usageCounters).where(eq(dbm.usageCounters.userId, u));
    expect(counters).toHaveLength(0);
  });

  it('own draft rubric on a private board grades (rubric_own); mock grader -> verdict + suggestedGrade', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('draft'));
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const it = s.items.find((i) => i.subId === 's1')!;
    expect(it.grading).toBe('rubric_own');
    const good = await answer(u, s.sessionId, it.id, { inputKind: 'text', text: 'Coletar hemocultura' });
    expect(good.json.data).toMatchObject({ suggestedGrade: 'good', gradeLocked: false, fallback: null, verdict: { verdict: 'correct' } });
    const it2 = s.items.find((i) => i.subId === 's2')!;
    const bad = await answer(u, s.sessionId, it2.id, { inputKind: 'text', text: 'xyz' });
    expect(bad.json.data).toMatchObject({ suggestedGrade: 'again', verdict: { verdict: 'incorrect' } });
    // the text is stored on the attempt, the verdict too
    await rate(u, s.sessionId, it.id, 'good');
    const [row] = await dbm.db.select().from(dbm.attempts).where(and(eq(dbm.attempts.userId, u), eq(dbm.attempts.subId, 's1')));
    expect(row).toMatchObject({ inputKind: 'text', answerText: 'Coletar hemocultura', gradeOverridden: false });
    expect(row!.verdict).toMatchObject({ verdict: 'correct', disputed: false });
  });

  it('voice and text with the same rubric and the same answer get the same verdict', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('draft'));
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const spoken = 'Coletar hemocultura';
    const a = s.items.find((i) => i.subId === 's1')!;
    const b = s.items.find((i) => i.subId === 's2')!;
    const byText = await answer(u, s.sessionId, a.id, { inputKind: 'text', text: spoken });
    const byVoice = await answer(u, s.sessionId, b.id, { inputKind: 'voice', text: spoken });
    expect(byText.json.data.verdict.verdict).toBe(byVoice.json.data.verdict.verdict);
    expect(byVoice.json.data.gradeLocked).toBe(byText.json.data.gradeLocked);
    await rate(u, s.sessionId, b.id, 'good');
    const [row] = await dbm.db.select().from(dbm.attempts).where(and(eq(dbm.attempts.userId, u), eq(dbm.attempts.subId, 's2')));
    expect(row).toMatchObject({ inputKind: 'voice', answerText: spoken });
  });

  it('approved rubric on a seed board grades for a non-owner (rubric_approved)', async () => {
    const owner = await newUser();
    const u = await newUser();
    const b = await board(owner, 'seed_approved');
    const c = await card(b, { title: 'Sepse', front: 'Definição?', back: 'Disfunção orgânica', rubric: RUBRIC('approved') });
    await dbm.db.insert(dbm.fsrsState).values({ userId: u, cardId: c, subId: '', stability: 5, difficulty: 5, due: new Date(Date.now() - HOUR), reps: 2, lastReview: new Date(Date.now() - 5 * 86_400_000), state: 'review', scheduledDays: 5 });
    const s = await start(u);
    const it = s.items.find((i) => i.cardId === c)!;
    expect(it.grading).toBe('rubric_approved');
  });

  it('criticalError locks the grade at again: rate with good -> 422, again -> 200', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    const critical = mk(async (i) => { const g = await mockGrader(i); return g.ok ? ok({ ...g.data, verdict: 'partial' as const, criticalError: true }) : g; });
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const it = s.items.find((i) => i.subId === 's1')!;
    const a = await answer(u, s.sessionId, it.id, { inputKind: 'text', text: 'hemocultura' }, critical);
    expect(a.json.data).toMatchObject({ gradeLocked: true, suggestedGrade: 'again' });
    expect((await rate(u, s.sessionId, it.id, 'good')).status).toBe(422);
    expect((await rate(u, s.sessionId, it.id, 'again')).status).toBe(200);
  });

  it('AI quota: 20 per local day; the 21st falls back to quota without calling the grader', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    let calls = 0;
    const counting = mk(async (i) => (calls++, mockGrader(i)));
    const period = await quota.localDay(u, new Date());
    await dbm.db.insert(dbm.usageCounters).values({ userId: u, period, aiGrades: 19 });
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const [i1, i2] = [s.items.find((i) => i.subId === 's1')!, s.items.find((i) => i.subId === 's2')!];
    expect((await answer(u, s.sessionId, i1.id, { inputKind: 'text', text: 'hemocultura' }, counting)).json.data.fallback).toBeNull();
    const over = await answer(u, s.sessionId, i2.id, { inputKind: 'text', text: 'hemocultura' }, counting);
    expect(over.json.data).toMatchObject({ fallback: 'quota', verdict: null, suggestedGrade: null, canonical: STEPS[1] });
    expect(calls).toBe(1);
    const [c] = await dbm.db.select().from(dbm.usageCounters).where(eq(dbm.usageCounters.userId, u));
    expect(c!.aiGrades).toBe(20);
  });

  it('grader throwing, erroring or missing -> grader_error, canonical and preview still returned', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const ids = ['s1', 's2', 's3'].map((sub) => s.items.find((i) => i.subId === sub)!.id);
    const text = { inputKind: 'text', text: 'hemocultura' };
    const throwing = mk(async () => { throw new Error('boom'); });
    const erroring = mk(async () => err('ai_unavailable', 'down'));
    for (const [id, a] of [[ids[0]!, throwing], [ids[1]!, erroring], [ids[2]!, mk()]] as const) {
      const r = await answer(u, s.sessionId, id, text, a);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ fallback: 'grader_error', verdict: null, suggestedGrade: null });
      expect(r.json.data.canonical).toBeTruthy();
      expect(r.json.data.preview.good).toBeDefined();
    }
  });

  it('dispute: needs a graded answer; inserts review_queue with attempt_id; idempotent; works before or after rate', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const [i1, i2, i3] = ['s1', 's2', 's3'].map((sub) => s.items.find((i) => i.subId === sub)!.id);
    await answer(u, s.sessionId, i3!, { inputKind: 'self' });
    expect((await post(u, '/dispute', { sessionId: s.sessionId, itemId: i3 })).status).toBe(409); // self-assessment has no verdict

    await answer(u, s.sessionId, i1!, { inputKind: 'text', text: 'xyz' });
    await rate(u, s.sessionId, i1!, 'again');
    const d1 = await post(u, '/dispute', { sessionId: s.sessionId, itemId: i1 });
    const d1b = await post(u, '/dispute', { sessionId: s.sessionId, itemId: i1 });
    expect(d1.status).toBe(200);
    expect(d1b.json.data.reviewItemId).toBe(d1.json.data.reviewItemId);
    const [att] = await dbm.db.select().from(dbm.attempts).where(and(eq(dbm.attempts.userId, u), eq(dbm.attempts.subId, 's1')));
    expect((att!.verdict as { disputed: boolean }).disputed).toBe(true);
    const q = await dbm.db.select().from(dbm.reviewQueue).where(eq(dbm.reviewQueue.cardId, w.flow));
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ id: d1.json.data.reviewItemId, flagSource: 'user_disagree', status: 'pending', attemptId: att!.id });

    // dispute before rate: carried into the attempt at rate
    await answer(u, s.sessionId, i2!, { inputKind: 'text', text: 'xyz' });
    const d2 = await post(u, '/dispute', { sessionId: s.sessionId, itemId: i2 });
    expect(d2.status).toBe(200);
    await rate(u, s.sessionId, i2!, 'again');
    const [att2] = await dbm.db.select().from(dbm.attempts).where(and(eq(dbm.attempts.userId, u), eq(dbm.attempts.subId, 's2')));
    expect((att2!.verdict as { disputed: boolean }).disputed).toBe(true);
  });

  it('skip: moves to the end, max 2 per item, then 409', async () => {
    const u = await newUser();
    const w = await prancheta(u);
    const s = await start(u, { kind: 'board', boardId: w.b });
    const id = s.items[0]!.id;
    const r1 = await post(u, '/skip', { sessionId: s.sessionId, itemId: id });
    expect(r1.json.data).toEqual({ remaining: 10 }); // F08: free plan, 10 new cards per day
    expect((await post(u, '/skip', { sessionId: s.sessionId, itemId: id })).status).toBe(200);
    expect((await post(u, '/skip', { sessionId: s.sessionId, itemId: id })).status).toBe(409);
    expect((await post(u, '/skip', { sessionId: s.sessionId, itemId: 'nope' })).status).toBe(404);
  });

  it('finish: correct/wrong/toReview/nextDue/durationMs; idempotent', async () => {
    const u = await newUser();
    const w = await prancheta(u);
    const s = await start(u, { kind: 'board', boardId: w.b, limit: 4 });
    const grades = ['good', 'again', 'hard', 'easy'];
    const dues: string[] = [];
    for (const [n, it] of s.items.slice(0, 3).entries()) {
      await answer(u, s.sessionId, it.id);
      dues.push((await rate(u, s.sessionId, it.id, grades[n]!)).json.data.due);
    }
    const f1 = await post(u, '/finish', { sessionId: s.sessionId });
    expect(f1.status).toBe(200);
    expect(f1.json.data).toMatchObject({ sessionId: s.sessionId, correct: 2, wrong: 1 });
    expect([...f1.json.data.toReview].sort()).toEqual([s.items[1]!.cardId, s.items[2]!.cardId].filter((v, i, a) => a.indexOf(v) === i).sort());
    expect(f1.json.data.nextDue).toBe([...dues].sort()[0]);
    expect(f1.json.data.durationMs).toBeGreaterThanOrEqual(0);
    const f2 = await post(u, '/finish', { sessionId: s.sessionId });
    expect(f2.json.data).toEqual(f1.json.data);
    const [row] = await dbm.db.select().from(dbm.sessions).where(eq(dbm.sessions.id, s.sessionId));
    expect(row!.endedAt).not.toBeNull();
    expect((await answer(u, s.sessionId, s.items[3]!.id)).status).toBe(409);
  });

  it('QA: nothing equal to the answer reaches the client (title with blank back, repeated edge label, rate after finish)', async () => {
    const u = await newUser();
    const b = await board(u);
    const t = await card(b, { title: 'Segredo Alfa', front: 'Qual a primeira linha?' }); // no back: canonical = title
    const y = await card(b, { title: 'Y' });
    const z = await card(b, { title: 'Z' });
    await edge(b, t, y, 'causa'); // asked edge (tie -> lowest id) or the other: both carry the same label
    await edge(b, t, z, 'causa');
    const s = await start(u, { kind: 'board', boardId: b });
    const it = s.items.find((i) => i.cardId === t)!;
    expect(it.mode).toBe('edge');
    expect(JSON.stringify(it.context.neighbors)).not.toContain('causa');
    await answer(u, s.sessionId, it.id);
    await rate(u, s.sessionId, it.id, 'good');
    const hidden = (await start(u, { kind: 'board', boardId: b })).items.find((i) => i.cardId === t);
    if (hidden?.mode === 'hidden_card') expect(hidden.cardTitle).toBe('');
    // an answered item cannot be rated once the session is finished
    const s2 = await start(u, { kind: 'board', boardId: b });
    const i2 = s2.items[0]!;
    await answer(u, s2.sessionId, i2.id);
    await post(u, '/finish', { sessionId: s2.sessionId });
    expect((await rate(u, s2.sessionId, i2.id, 'good')).status).toBe(409);
  });

  it('QA: grader failure refunds the quota unit; dispute before rate links attempt_id at rate', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const [i1, i2] = [s.items.find((i) => i.subId === 's1')!.id, s.items.find((i) => i.subId === 's2')!.id];
    await answer(u, s.sessionId, i1, { inputKind: 'text', text: 'x' }, mk(async () => { throw new Error('boom'); }));
    const [c0] = await dbm.db.select().from(dbm.usageCounters).where(eq(dbm.usageCounters.userId, u));
    expect(c0!.aiGrades).toBe(0);
    await answer(u, s.sessionId, i2, { inputKind: 'text', text: 'xyz' });
    const d = await post(u, '/dispute', { sessionId: s.sessionId, itemId: i2 });
    await rate(u, s.sessionId, i2, 'again');
    const [q] = await dbm.db.select().from(dbm.reviewQueue).where(eq(dbm.reviewQueue.id, d.json.data.reviewItemId));
    const [att] = await dbm.db.select().from(dbm.attempts).where(and(eq(dbm.attempts.userId, u), eq(dbm.attempts.subId, 's2')));
    expect(q!.attemptId).toBe(att!.id);
  });

  it('another user gets 404 on every endpoint for a session that is not theirs', async () => {
    const a = await newUser();
    const b = await newUser();
    const w = await prancheta(a);
    const s = await start(a, { kind: 'board', boardId: w.b });
    const ref = { sessionId: s.sessionId, itemId: s.items[0]!.id };
    expect((await answer(b, ref.sessionId, ref.itemId)).status).toBe(404);
    expect((await rate(b, ref.sessionId, ref.itemId, 'good')).status).toBe(404);
    expect((await post(b, '/dispute', ref)).status).toBe(404);
    expect((await post(b, '/skip', ref)).status).toBe(404);
    expect((await post(b, '/finish', { sessionId: s.sessionId })).status).toBe(404);
    expect((await post(b, '/start', { kind: 'board', boardId: w.b })).status).toBe(404);
    expect((await post(b, '/finish', { sessionId: 'not-a-uuid' })).status).toBe(422);
  });
  it('streams feedback for a text answer, then returns the stored verdict without grading again', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    let calls = 0;
    const fake: GradeStream = async function* () {
      calls += 1;
      yield { feedback: 'Faltou ' };
      yield { feedback: 'volume.' };
      yield { verdict: { verdict: 'partial', matched: [], missing: ['volume'], criticalError: false, feedback: 'Faltou volume.', model: 'stream-test' } };
    };
    const streaming = mk(mockGrader, fake);
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const it = s.items.find((i) => i.subId === 's1')!;
    const ask = () => streaming.request('/v1/challenge/answer', {
      method: 'POST',
      headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ sessionId: s.sessionId, itemId: it.id, durationMs: 4000, inputKind: 'text', text: 'pouco volume' }),
    });
    const res = await ask();
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = (await res.text()).trim().split('\n\n').map((block) => JSON.parse(block.replace(/^data: /, '')) as { feedback?: string; result?: { verdict: { verdict: string } | null; fallback: string | null } });
    expect(events.filter((e) => e.feedback).map((e) => e.feedback).join('')).toBe('Faltou volume.');
    expect(events.at(-1)?.result?.verdict?.verdict).toBe('partial');
    const again = (await (await ask()).text()).trim().split('\n\n').map((block) => JSON.parse(block.replace(/^data: /, '')) as { feedback?: string; result?: { verdict: { verdict: string } | null } });
    expect(again.some((e) => e.feedback)).toBe(false);
    expect(again.at(-1)?.result?.verdict?.verdict).toBe('partial');
    expect(calls).toBe(1);
    const [c] = await dbm.db.select().from(dbm.usageCounters).where(eq(dbm.usageCounters.userId, u));
    expect(c!.aiGrades).toBe(1);
  });

  it('a grade stream that fails refunds the quota and still returns a result', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    const broken: GradeStream = async function* () {
      yield { feedback: 'Quase' };
      throw new Error('boom');
    };
    const streaming = mk(mockGrader, broken);
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    const it = s.items.find((i) => i.subId === 's1')!;
    const res = await streaming.request('/v1/challenge/answer', {
      method: 'POST',
      headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ sessionId: s.sessionId, itemId: it.id, durationMs: 4000, inputKind: 'text', text: 'quase' }),
    });
    const events = (await res.text()).trim().split('\n\n').map((block) => JSON.parse(block.replace(/^data: /, '')) as { feedback?: string; result?: { fallback: string | null; verdict: unknown } });
    expect(events.some((e) => e.feedback === 'Quase')).toBe(true);
    expect(events.at(-1)?.result).toMatchObject({ fallback: 'grader_error', verdict: null });
    const [c] = await dbm.db.select().from(dbm.usageCounters).where(eq(dbm.usageCounters.userId, u));
    expect(c?.aiGrades ?? 0).toBe(0);
  });

  it('G22 qa (P-616): the session ends while the model writes -> nothing saved and the ai_grades unit goes back', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    let sessionId = '';
    const ending: GradeStream = async function* () {
      await dbm.db.update(dbm.sessions).set({ endedAt: new Date() }).where(eq(dbm.sessions.id, sessionId));
      yield { verdict: { verdict: 'correct', matched: [], missing: [], criticalError: false, feedback: 'Certo.', model: 'stream-test' } };
    };
    const streaming = mk(mockGrader, ending);
    const s = await start(u, { kind: 'board', boardId: w.b }, true);
    sessionId = s.sessionId;
    const it = s.items.find((i) => i.subId === 's1')!;
    const res = await streaming.request('/v1/challenge/answer', {
      method: 'POST',
      headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ sessionId: s.sessionId, itemId: it.id, durationMs: 4000, inputKind: 'text', text: 'noradrenalina' }),
    });
    const events = (await res.text()).trim().split('\n\n').map((block) => JSON.parse(block.replace(/^data: /, '')) as { error?: { code: string } });
    expect(events.at(-1)?.error?.code).toBe('conflict');
    const [c] = await dbm.db.select().from(dbm.usageCounters).where(eq(dbm.usageCounters.userId, u));
    expect(c?.aiGrades ?? 0).toBe(0);
  });

  it('D-200: a note is neither an item nor an edge neighbour / distractor source', async () => {
    const u = await newUser();
    const b = await board(u);
    const x = await card(b, { title: 'X', front: 'Pergunta X', back: 'Resposta X' });
    const n = await card(b, { type: 'note', title: 'Conteudo' });
    await edge(b, x, n, 'ilustra');
    const s = await start(u, { kind: 'board', boardId: b });
    expect(s.items.map((i) => i.cardId)).toEqual([x]);
    expect(s.items[0].mode).not.toBe('edge'); // its only connection ends in a note
    expect(s.raw).not.toContain('Conteudo');
  });

  it('D-575: board sessions need 10 challengeable cards (notes and suspended do not count); daily is unaffected', async () => {
    const u = await newUser();
    const b = await board(u, 'private', false);
    for (let i = 0; i < 9; i++) await card(b, { title: `c${i}`, order: i });
    await card(b, { type: 'note', title: 'n' });
    const [sus] = await dbm.db.insert(dbm.cards).values({ boardId: b, title: 's', suspendedAt: new Date() }).returning();
    expect(sus).toBeTruthy();
    const low = await post(u, '/start', { kind: 'board', boardId: b });
    expect(low.status).toBe(422);
    expect(low.json.error).toMatchObject({ code: 'validation', message: 'challenge_min_cards' });
    await card(b, { title: 'c9', order: 9 });
    expect((await post(u, '/start', { kind: 'board', boardId: b })).status).toBe(200);
    const small = await board(u, 'private', false);
    await card(small, { title: 'x' });
    expect((await post(u, '/start', { kind: 'daily' })).status).toBe(200);
  });

  it("D-577: order 'flow' follows the arrows; random keeps the queue order", async () => {
    const u = await newUser();
    const b = await board(u, 'private', false);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await card(b, { title: `c${i}`, back: `r${i}`, order: i }));
    // arrows: 7 -> 2 -> 9 ; 4 -> 2 ; the other cards are isolated roots
    await edge(b, ids[7]!, ids[2]!, null);
    await edge(b, ids[2]!, ids[9]!, null);
    await edge(b, ids[4]!, ids[2]!, null);
    const s = await start(u, { kind: 'board', boardId: b, options: { order: 'flow' } });
    const got = s.items.map((i) => i.cardId);
    expect(got).toHaveLength(10);
    const at = (n: number) => got.indexOf(ids[n]!);
    expect(at(7)).toBeLessThan(at(2));
    expect(at(4)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(9));
    expect(got).toEqual(flowOrder(ids, [{ from: ids[7]!, to: ids[2]! }, { from: ids[2]!, to: ids[9]! }, { from: ids[4]!, to: ids[2]! }]));
  });

  it('D-577: self sessions never call the grader nor spend quota, and still keep the text and show the canonical', async () => {
    const u = await newUser();
    const w = await prancheta(u, RUBRIC('approved'));
    let calls = 0;
    const counting = mk(async (i) => (calls++, mockGrader(i)));
    const s = await start(u, { kind: 'board', boardId: w.b });
    const item = s.items.find((i) => i.subId === 's1')!;
    const r = await answer(u, s.sessionId, item.id, { inputKind: 'text', text: 'hemocultura' }, counting);
    expect(r.json.data).toMatchObject({ verdict: null, suggestedGrade: null, fallback: null, canonical: STEPS[0] });
    expect(r.json.data.preview).toBeTruthy();
    expect(calls).toBe(0);
    expect(await dbm.db.select().from(dbm.usageCounters).where(eq(dbm.usageCounters.userId, u))).toHaveLength(0);
    const [row] = await dbm.db.select().from(dbm.sessions).where(eq(dbm.sessions.id, s.sessionId));
    expect((row!.items as any[]).find((i) => i.id === item.id).x.answered.answerText).toBe('hemocultura'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});
