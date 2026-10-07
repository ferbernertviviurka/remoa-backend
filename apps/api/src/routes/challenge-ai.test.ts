import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { generateJson } from '@remoa/ai';
import { createLogger } from '@remoa/log';
import {
  aiAnswerResultSchema, aiChallengeSessionPublicSchema, err, mapSummaryPublicSchema, ok, questionBankItemPublicSchema, type ChallengeConfig, type Veredito,
} from '@remoa/contracts';
import type { Env } from '../app';
import { createApp } from '../app';
import { answerHash as sessionHash, type BankRow, type ItemRow, type SessionRow, type SessionStore } from '../challenge-ai/session';
import type { CardDue } from '../challenge-ai/grade';
import { gradeAnswer, gradeBatch, type GradeDeps } from '../challenge-ai/grade';
import type { Reservation } from '../billing/quota';
import {
  AI_CALLS_PER_MINUTE, bankQuerySchema, challengeAiRoutes, challengeReportSchema, createChallengeAiService, takeAiSlot,
  type AfterGrade, type ChallengeAiService, type DataPort, type Io, type Reference, type StoredAttempt,
} from './challenge-ai';

// Route tests with a mocked service (public-schema guard) and service tests over in-memory stores (the real session and grade modules).
// Synthetic text only. No database, no network, no live AI.

const SECRET = 'SEGREDO-GABARITO-7f3a';
const LEAK = /(correct_?key|expected_?answer|key_?points|reference_?ref|shuffle_?map|rubric)/i;
const USER = '44444444-4444-4444-8444-444444444444';
const BOARD = '55555555-5555-4555-8555-555555555555';
const ID = '66666666-6666-4666-8666-666666666666';
const T0 = new Date('2026-10-07T12:00:00.000Z');

const logger = createLogger({ requestId: 'test' });
function appFor(service: ChallengeAiService, userId = USER) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    c.set('requestId', 'req-1');
    c.set('log', logger);
    await next();
  });
  app.route('/v1/challenge-ai', challengeAiRoutes(service));
  app.onError(() => Response.json({ error: { code: 'internal', message: 'internal error' } }, { status: 500 })); // as app.ts does: no detail
  return app;
}
const send = (app: ReturnType<typeof appFor>, method: string, path: string, body?: unknown) =>
  app.request(`/v1/challenge-ai${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

const cfg = (over: Partial<ChallengeConfig> = {}): ChallengeConfig => ({
  boardId: BOARD, scope: { kind: 'board' }, format: 'map', n: 10, difficulty: 'mixed', grading: 'immediate', timerSec: null, preset: 'practice', ...over,
});

const publicSession = (over: Record<string, unknown> = {}) => ({
  id: ID, boardId: BOARD, format: 'generated', status: 'active', total: 1, position: 0, expiresAt: T0, aiUnits: 1,
  current: { id: ID, position: 0, type: 'discursive', stem: 'Enunciado sintético' }, ...over,
});

/** A service whose every method returns what the test gives it (and can be asserted on). */
function mockService(over: Partial<ChallengeAiService> = {}) {
  const service = {
    start: vi.fn(async () => ok({ session: publicSession(), generation: null })),
    session: vi.fn(async () => ok(publicSession())),
    answer: vi.fn(async () => ok({ attemptId: ID, attemptNo: 1, verdict: 'incorrect', gradedBy: 'ai', rating: 'again', feedback: 'Revise o gatilho.', hint: null, canRetry: false, manipulation: false })),
    finish: vi.fn(async () => ok({})),
    dispute: vi.fn(async () => ok({ attemptId: ID, disputed: true })),
    bank: vi.fn(async () => ok([])),
    archive: vi.fn(async () => ok({ id: ID, status: 'archived' as const })),
    edit: vi.fn(async () => ok({ id: ID, boardId: BOARD, type: 'discursive', difficulty: 'easy', stem: 'Enunciado novo', source: 'ai', status: 'draft', enamedAreaId: null, enamedDomainId: null, enamedTopicId: null, enamedTopicName: null, enamedConfirmed: false, stats: { seen: 0, correct: 0, partial: 0, incorrect: 0 }, createdAt: T0 })),
    confirmTopic: vi.fn(async () => ok({ id: ID, boardId: BOARD, type: 'discursive', difficulty: 'easy', stem: 'Enunciado', source: 'ai', status: 'draft', enamedAreaId: null, enamedDomainId: null, enamedTopicId: null, enamedTopicName: null, enamedConfirmed: true, stats: { seen: 0, correct: 0, partial: 0, incorrect: 0 }, createdAt: T0 })),
    topics: vi.fn(async () => ok([])),
    report: vi.fn(async () => ok({ itemId: ID, reported: true as const })),
    summarize: vi.fn(async () => err('internal', 'unused')),
    summaries: vi.fn(async () => ok([])),
    ...over,
  } satisfies ChallengeAiService;
  return service;
}

const summary = (over: Record<string, unknown> = {}) => ({
  id: ID, boardId: BOARD, boardVersion: 3, size: 'standard', focus: 'overview', stale: false, createdAt: T0,
  sections: [{ kind: 'overview', title: 'Visão geral', items: [{ text: 'Ponto sintético', cardIds: [ID] }] }], ...over,
});

// --- Routes: the public-schema guard ------------------------------------------------------------------------------------

describe('rotas /v1/challenge-ai: nada de gabarito na resposta', () => {
  it('a response fixture with a planted secret fails the public schema and nothing is sent', async () => {
    // the schema itself refuses the planted key (strict at every level)
    const planted = publicSession({ current: { id: ID, position: 0, type: 'discursive', stem: 'Enunciado', expectedAnswer: SECRET } });
    expect(aiChallengeSessionPublicSchema.safeParse(planted).success).toBe(false);
    expect(aiChallengeSessionPublicSchema.safeParse(publicSession({ current: { id: ID, position: 0, type: 'discursive', stem: 'x', correctKey: 'B' } })).success).toBe(false);
    expect(aiAnswerResultSchema.safeParse({ attemptId: ID, attemptNo: 1, verdict: 'correct', gradedBy: 'ai', rating: 'good', feedback: null, hint: null, canRetry: false, manipulation: false, expectedAnswer: SECRET }).success).toBe(false);
    expect(questionBankItemPublicSchema.safeParse({ id: ID, correctKey: 'A' }).success).toBe(false);
    expect(mapSummaryPublicSchema.safeParse(summary({ keyPoints: [SECRET] })).success).toBe(false);

    // and the route sends a 500 with no value of the fixture, for every handler that carries an item
    const service = mockService({
      start: vi.fn(async () => ok({ session: planted, generation: null })),
      session: vi.fn(async () => ok(planted)),
      answer: vi.fn(async () => ok({ attemptId: ID, attemptNo: 1, verdict: 'incorrect', gradedBy: 'ai', rating: 'again', feedback: null, hint: null, canRetry: false, manipulation: false, expectedAnswer: SECRET, shuffleMap: { kind: 'steps' } })),
      bank: vi.fn(async () => ok([{ id: ID, stem: 'x', correctKey: 'B', expectedAnswer: SECRET }])),
      summaries: vi.fn(async () => ok([summary({ keyPoints: [SECRET] })])),
      summarize: vi.fn(async () => ok(summary({ rubric: SECRET }))),
      finish: vi.fn(async () => ok({ sessionId: ID, items: [{ expectedAnswer: SECRET }] })),
    });
    const app = appFor(service);
    const calls = [
      send(app, 'POST', '/sessions', cfg({ format: 'generated', n: 5, questionType: 'mixed' })),
      send(app, 'GET', `/sessions/${ID}`),
      send(app, 'POST', `/sessions/${ID}/answers`, { itemId: ID, answer: { kind: 'text', text: 'resposta' } }),
      send(app, 'GET', '/bank'),
      send(app, 'GET', `/boards/${BOARD}/summaries`),
      send(app, 'POST', '/summaries', { boardId: BOARD, size: 'standard', focus: 'overview' }),
      send(app, 'POST', `/sessions/${ID}/finish`),
    ];
    for (const res of await Promise.all(calls)) {
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(LEAK);
      expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'internal error' } });
    }
  });

  it('a clean public response goes out as { ok, data } and a service error keeps its status', async () => {
    const service = mockService({
      session: vi.fn(async () => err('not_found', 'session_not_found')),
      bank: vi.fn(async () => ok([{ id: ID, boardId: BOARD, type: 'objective', difficulty: 'easy', stem: 'Enunciado', source: 'ai', status: 'draft', enamedAreaId: null, enamedDomainId: null, enamedTopicId: null, enamedTopicName: null, enamedConfirmed: false, stats: { seen: 0, correct: 0, partial: 0, incorrect: 0 }, createdAt: T0 }])),
    });
    const app = appFor(service);
    const a = await send(app, 'POST', `/sessions/${ID}/answers`, { itemId: ID, answer: { kind: 'text', text: 'resposta' } });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true, data: { attemptId: ID, attemptNo: 1, verdict: 'incorrect', gradedBy: 'ai', rating: 'again', feedback: 'Revise o gatilho.', hint: null, canRetry: false, manipulation: false } });
    expect((await send(app, 'GET', `/sessions/${ID}`)).status).toBe(404);
    const b = await send(app, 'GET', '/bank');
    expect(b.status).toBe(200);
    const body = (await b.json()) as { data: unknown[]; page: unknown };
    expect(body.data).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(LEAK);
  });

  it('start returns the public session and, for format 1, only the numbers of the generation', async () => {
    const service = mockService({
      start: vi.fn(async () => ok({ session: publicSession(), generation: { requested: 5, reused: 2, generated: 2, shortfall: 1, stoppedBy: 'quota' as const } })),
    });
    const res = await send(appFor(service), 'POST', '/sessions', cfg({ format: 'generated', n: 5, questionType: 'objective' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { current: Record<string, unknown> }; generation: unknown };
    expect(body.generation).toEqual({ requested: 5, reused: 2, generated: 2, shortfall: 1, stoppedBy: 'quota' });
    expect(Object.keys(body.data.current).sort()).toEqual(['id', 'position', 'stem', 'type']);
  });

  it('summaries: the body is parsed and the history carries `stale`', async () => {
    const service = mockService({
      summarize: vi.fn(async () => ok(summary())),
      summaries: vi.fn(async () => ok([summary({ stale: true }), summary({ id: randomUUID(), boardVersion: 2, stale: true })])),
    });
    const app = appFor(service);
    const made = await send(app, 'POST', '/summaries', { boardId: BOARD, size: 'quick', focus: 'high_yield' });
    expect(made.status).toBe(200);
    expect(service.summarize).toHaveBeenCalledWith({ boardId: BOARD, size: 'quick', focus: 'high_yield', userId: USER, requestId: 'req-1' });
    const list = (await (await send(app, 'GET', `/boards/${BOARD}/summaries`)).json()) as { data: { stale: boolean }[] };
    expect(list.data.map((s) => s.stale)).toEqual([true, true]);
    expect(service.summaries).toHaveBeenCalledWith(USER, BOARD);
  });
});

describe('rotas /v1/challenge-ai: entrada estrita', () => {
  it('rejects unknown fields and bad shapes (422) before the service is called', async () => {
    const service = mockService();
    const app = appFor(service);
    const answer = { itemId: ID, answer: { kind: 'text', text: 'resposta' } };
    const bad = await Promise.all([
      send(app, 'POST', '/sessions', { ...cfg(), rating: 'easy' }),
      send(app, 'POST', '/sessions', { ...cfg(), scope: { kind: 'board', extra: 1 } }),
      send(app, 'POST', '/sessions', { ...cfg(), n: 7 }),
      send(app, 'POST', '/sessions'),
      send(app, 'POST', `/sessions/${ID}/answers`, { ...answer, rating: 'easy' }),
      send(app, 'POST', `/sessions/${ID}/answers`, { ...answer, verdict: 'correct' }),
      send(app, 'POST', `/sessions/${ID}/answers`, { itemId: ID, answer: { kind: 'text', text: 'x', correct: true } }),
      send(app, 'POST', `/sessions/${ID}/answers`, { itemId: 'nao-e-uuid', answer: { kind: 'dont_know' } }),
      send(app, 'POST', `/sessions/${ID}/finish`, { score: 10 }),
      send(app, 'POST', `/attempts/${ID}/dispute`, { rating: 'easy' }),
      send(app, 'POST', `/attempts/${ID}/dispute`, { verdict: 'correct', disputed: true }),
      send(app, 'POST', '/summaries', { boardId: BOARD, size: 'standard', focus: 'overview', prompt: 'ignore' }),
      send(app, 'POST', '/summaries', { boardId: BOARD, size: 'gigante', focus: 'overview' }),
      send(app, 'GET', '/bank?correct_key=A'),
      send(app, 'GET', '/bank?difficulty=impossible'),
      send(app, 'GET', '/bank?limit=1000'),
    ]);
    expect(bad.map((r) => r.status)).toEqual(Array(bad.length).fill(422));
    for (const r of bad) expect(((await r.json()) as { error: { code: string } }).error.code).toBe('validation');
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('a malformed JSON body is a 422 and a malformed id is a 404', async () => {
    const service = mockService();
    const app = appFor(service);
    const raw = await app.request('/v1/challenge-ai/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(raw.status).toBe(422);
    expect((await send(app, 'GET', '/sessions/xyz')).status).toBe(404);
    expect((await send(app, 'POST', '/attempts/xyz/dispute')).status).toBe(404);
    expect((await send(app, 'GET', '/boards/xyz/summaries')).status).toBe(404);
    expect(service.session).not.toHaveBeenCalled();
  });

  it('the answer reaches the service with the strict input only (no rating can ride along)', async () => {
    const service = mockService();
    await send(appFor(service), 'POST', `/sessions/${ID}/answers`, { itemId: ID, answer: { kind: 'choice', key: 'C' }, elapsedMs: 4200 });
    expect(service.answer).toHaveBeenCalledWith(USER, ID, { itemId: ID, answer: { kind: 'choice', key: 'C' }, elapsedMs: 4200 }, 'req-1');
  });

  it('dispute takes no body and passes only the attempt id', async () => {
    const service = mockService();
    const app = appFor(service);
    const res = await send(app, 'POST', `/attempts/${ID}/dispute`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { attemptId: ID, disputed: true } });
    expect(service.dispute).toHaveBeenCalledWith(USER, ID);
    const empty = await send(app, 'POST', `/attempts/${ID}/dispute`, {});
    expect(empty.status).toBe(200);
  });

  it('archive and report return only the public flag, and a planted key is not sent', async () => {
    const service = mockService();
    const app = appFor(service);
    const archived = await send(app, 'POST', `/bank/${ID}/archive`, {});
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ ok: true, data: { id: ID, status: 'archived' } });
    expect(service.archive).toHaveBeenCalledWith(USER, ID);
    const reported = await send(app, 'POST', `/items/${ID}/report`, {});
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({ ok: true, data: { itemId: ID, reported: true } });
    const leaked = appFor(mockService({ archive: vi.fn(async () => ok({ id: ID, status: 'archived', correctKey: SECRET })) }));
    const hidden = await send(leaked, 'POST', `/bank/${ID}/archive`, {});
    expect(hidden.status).toBe(500);
    expect(await hidden.text()).not.toContain(SECRET);
    const edited = await send(app, 'POST', `/bank/${ID}`, { stem: 'Enunciado novo', difficulty: 'easy' });
    expect(edited.status).toBe(200);
    expect(JSON.parse(await edited.text()).data).toMatchObject({ stem: 'Enunciado novo', status: 'draft' });
    expect(service.edit).toHaveBeenCalledWith(USER, ID, { stem: 'Enunciado novo', difficulty: 'easy' });
  });

  it('confirming a topic returns the public row and refuses a body that is not just the topic id', async () => {
    const topic = '00000000-0000-4000-8000-000000000077';
    const row = { id: ID, boardId: BOARD, type: 'discursive', difficulty: 'easy', stem: 'Enunciado', source: 'ai', status: 'draft', enamedAreaId: null, enamedDomainId: null, enamedTopicId: topic, enamedTopicName: 'Sepse', enamedConfirmed: true, stats: { seen: 0, correct: 0, partial: 0, incorrect: 0 }, createdAt: T0 };
    const service = mockService({ confirmTopic: vi.fn(async () => ok(row)) });
    const app = appFor(service);
    const res = await send(app, 'POST', `/bank/${ID}/confirm`, { topicId: topic });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { enamedConfirmed: true, enamedTopicId: topic, enamedTopicName: 'Sepse', stem: 'Enunciado' } });
    expect(service.confirmTopic).toHaveBeenCalledWith(USER, ID, { topicId: topic });
    const dirty = await send(app, 'POST', `/bank/${ID}/confirm`, { topicId: topic, expectedAnswer: SECRET });
    expect(dirty.status).toBe(422);
    expect(await dirty.text()).not.toContain(SECRET);
    expect(service.confirmTopic).toHaveBeenCalledTimes(1);
    const leaked = appFor(mockService({ confirmTopic: vi.fn(async () => ok({ ...row, correctKey: SECRET })) }));
    const hidden = await send(leaked, 'POST', `/bank/${ID}/confirm`, { topicId: topic });
    expect(hidden.status).toBe(500);
    expect(await hidden.text()).not.toContain(SECRET);
  });

  it('lists closed-list topics and refuses a query that is not just the area', async () => {
    const topic = '00000000-0000-4000-8000-000000000077';
    const service = mockService({ topics: vi.fn(async () => ok([{ id: topic, name: 'Sepse' }])) });
    const app = appFor(service);
    const res = await send(app, 'GET', `/topics?areaId=${topic}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: [{ id: topic, name: 'Sepse' }] });
    expect(service.topics).toHaveBeenCalledWith(USER, topic);
    expect((await send(app, 'GET', `/topics?areaId=${topic}&correctKey=A`)).status).toBe(422);
    const leaked = appFor(mockService({ topics: vi.fn(async () => ok([{ id: topic, name: 'Sepse', expectedAnswer: SECRET }])) }));
    const hidden = await send(leaked, 'GET', '/topics');
    expect(hidden.status).toBe(500);
    expect(await hidden.text()).not.toContain(SECRET);
  });

  it('bank filters are parsed and passed on (board, area, difficulty, type, status)', async () => {
    const service = mockService();
    const area = randomUUID();
    const res = await send(appFor(service), 'GET', `/bank?board=${BOARD}&area=${area}&difficulty=hard&type=objective&status=draft&limit=20&offset=40`);
    expect(res.status).toBe(200);
    expect(service.bank).toHaveBeenCalledWith(USER, { board: BOARD, area, difficulty: 'hard', type: 'objective', status: 'draft', limit: 20, offset: 40 });
    expect(bankQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });
});

describe('rotas /v1/challenge-ai: quem chama e quanto', () => {
  it('every route needs the logged-in user (401 without a token) once mounted in the app', async () => {
    const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (t === 'ok' ? USER : null) });
    const paths: [string, string][] = [
      ['POST', '/v1/challenge-ai/sessions'], ['GET', `/v1/challenge-ai/sessions/${ID}`], ['POST', `/v1/challenge-ai/sessions/${ID}/answers`],
      ['POST', `/v1/challenge-ai/sessions/${ID}/finish`], ['POST', `/v1/challenge-ai/attempts/${ID}/dispute`], ['GET', '/v1/challenge-ai/bank'],
      ['POST', '/v1/challenge-ai/summaries'], ['GET', `/v1/challenge-ai/boards/${BOARD}/summaries`],
    ];
    for (const [method, path] of paths) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    }
    // with a token the route is reached: a bad body is the router's 422, not a 404/401
    const bad = await app.request('/v1/challenge-ai/summaries', { method: 'POST', headers: { authorization: 'Bearer ok', 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(422);
  });

  it('the AI calls of one user are capped per minute; another user is not affected', () => {
    const now = 1_000_000;
    for (let i = 0; i < AI_CALLS_PER_MINUTE; i++) expect(takeAiSlot('u-a', now + i).ok).toBe(true);
    expect(takeAiSlot('u-a', now + 100)).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(takeAiSlot('u-b', now + 100).ok).toBe(true);
    expect(takeAiSlot('u-a', now + 61_000).ok).toBe(true);
  });
});

// --- Service over in-memory stores (real session.ts and grade.ts) --------------------------------------------------------

type Mem = {
  sessions: (SessionRow & { finishedAt: Date | null })[]; items: ItemRow[]; rows: (StoredAttempt & { answerHash: string })[]; disputes: string[]; scores: unknown[];
  grades: AfterGrade[]; refs: Map<string, Reference>;
};

function fixture(o: { bank?: BankRow[]; refs?: Record<string, Reference>; replies?: (Veredito | Error)[]; units?: number; limitBatch?: number; card?: CardDue } = {}) {
  const mem: Mem = { sessions: [], items: [], rows: [], disputes: [], scores: [], grades: [], refs: new Map(Object.entries(o.refs ?? {})) };
  const counts = (id: string) => {
    const its = mem.items.filter((i) => i.sessionId === id);
    const s = mem.sessions.find((x) => x.id === id)!;
    const total = Math.max(its.length, s.format === 'generated' && s.status === 'active' ? s.params.n : 0);
    return { total, aiUnits: its.filter((i) => ['discursive', 'hidden_card', 'edge', 'case'].includes(i.type)).length };
  };
  const store: SessionStore = {
    boardCards: async () => ({ cards: [], edges: [] }),
    bankQuestions: async (_u, ids) => (o.bank ?? []).filter((b) => ids.includes(b.id)),
    createSession: async (s, items) => {
      mem.sessions.push({ ...s, status: 'active', position: 0, total: 0, aiUnits: 0, finishedAt: null });
      for (const i of items) mem.items.push({ ...i, sessionId: s.id });
    },
    appendItem: async (_u, sessionId, i) => {
      if (!mem.items.some((x) => x.sessionId === sessionId && (x.position === i.position || x.bankId === i.bankId))) mem.items.push({ ...i, sessionId });
    },
    session: async (userId, id) => {
      const s = mem.sessions.find((x) => x.id === id && x.userId === userId);
      return s ? { ...s, ...counts(id) } : null;
    },
    publicItemAt: async (id, position) => mem.items.find((i) => i.sessionId === id && i.position === position)?.payloadPublic ?? null,
    itemAt: async (_u, id, position) => mem.items.find((i) => i.sessionId === id && i.position === position) ?? null,
    expire: async (_u, id) => {
      const s = mem.sessions.find((x) => x.id === id && x.status === 'active');
      if (s) s.status = 'expired';
    },
    moveTo: async (_u, id, position, finishedAt) => {
      const s = mem.sessions.find((x) => x.id === id && x.status === 'active');
      if (!s) return;
      s.position = position;
      if (finishedAt) Object.assign(s, { status: 'finished', finishedAt });
    },
    lastAttempt: async (_u, itemId) => {
      const mine = mem.rows.filter((a) => a.itemId === itemId);
      const top = Math.max(0, ...mine.map((a) => a.attemptNo));
      const a = mine.filter((x) => x.attemptNo === top).at(-1);
      return a ? { id: a.id, attemptNo: a.attemptNo, answerHash: a.answerHash } : null;
    },
    appendAttempt: async (a) => {
      if (mem.rows.some((x) => x.itemId === a.itemId && x.attemptNo === a.attemptNo && x.gradedBy === 'pending')) return null;
      const id = randomUUID();
      mem.rows.push({
        id, itemId: a.itemId, attemptNo: a.attemptNo, answer: a.answer, answerHash: a.answerHash, gradedBy: 'pending', verdict: null, feedback: null, hint: null,
        manipulation: false, covered: [], missing: [], criticalError: false, confidence: null, model: null, promptVersion: null, rating: null, disputed: false,
      });
      return { id };
    },
  };
  const data: DataPort = {
    attempts: async (_u, itemId) => mem.rows.filter((a) => a.itemId === itemId).sort((a, b) => a.attemptNo - b.attemptNo),
    sessionAttempts: async (_u, sid) => {
      const ids = new Set(mem.items.filter((i) => i.sessionId === sid).map((i) => i.id));
      return mem.rows.filter((a) => ids.has(a.itemId)).sort((a, b) => a.attemptNo - b.attemptNo);
    },
    items: async (_u, sid) => mem.items.filter((i) => i.sessionId === sid).sort((a, b) => a.position - b.position),
    reference: async (_u, _s, item) => (item.bankId ? (mem.refs.get(item.bankId) ?? null) : null),
    recentAiGradings: async () => 0,
    saveGraded: async (_u, itemId, g) => {
      if (mem.rows.some((x) => x.itemId === itemId && x.attemptNo === g.attemptNo && x.gradedBy !== 'pending')) return null;
      const id = randomUUID();
      mem.rows.push({
        id, itemId, attemptNo: g.attemptNo, answer: g.answer, answerHash: sessionHash(g.answer), gradedBy: g.gradedBy, verdict: g.verdict, feedback: g.feedback, hint: g.hint,
        manipulation: g.manipulation, covered: g.covered, missing: g.missing, criticalError: g.criticalError, confidence: g.confidence, model: g.model,
        promptVersion: g.promptVersion, rating: g.rating, disputed: false,
      });
      return id;
    },
    saveScore: async (_u, _s, score) => void mem.scores.push(score),
    dispute: async (_u, id) => {
      mem.disputes.push(id);
      return ok({ attemptId: id, disputed: true as const });
    },
    bank: async () => [],
    cardDue: async () => o.card ?? null,
    afterGrade: async (_u, spec) => { mem.grades.push(spec); },
    archive: async () => null,
    edit: async () => null,
    confirmTopic: async () => null,
    topics: async () => [],
    report: async () => null,
  };
  let units = o.units ?? 100;
  const queue = [...(o.replies ?? [])];
  const refunds = vi.fn();
  const reserve = vi.fn(async () => {
    if (units <= 0) return { ok: false as const, error: { code: 'quota_exceeded' as const, message: 'ai_grades' } };
    units -= 1;
    const r: Reservation = { ok: true, quota: { key: 'ai_grades', used: 1, limit: 10, remaining: 9, nearLimit: false, period: '2026-10-07' }, refund: refunds };
    return r;
  });
  const model = vi.fn(async (...args: Parameters<typeof generateJson>) => {
    const next = queue.shift() ?? reply();
    if (next instanceof Error) throw next;
    return { text: '', model: 'test/model', tokensIn: 1, tokensOut: 1, latencyMs: 7, attempts: 1, fallback: false, billable: true as const, data: args[0].parse(next), repaired: false };
  });
  const limits = { sessionTtlMin: 120, maxGradingsPerCardHour: 5, batchGradeMax: o.limitBatch ?? 10, genBatchSize: 10, dupThreshold: 0.8, answerMaxChars: 1200 };
  const deps: GradeDeps = { reserve, generateJson: model as unknown as typeof generateJson, limits };
  const generate = vi.fn<Io['generate']>(async () => err('internal', 'generate not stubbed'));
  const io: Io = {
    tx: async (_u, fn) => fn(store),
    data,
    grade: vi.fn((i, d) => gradeAnswer(i, { ...deps, ...d })),
    gradeBatch: vi.fn((i, d) => gradeBatch(i, { ...deps, ...d })),
    generate,
    summarize: vi.fn(async () => err('internal', 'unused')),
    summaries: vi.fn(async () => ok([])),
    now: () => T0,
  };
  return { io, mem, store, model, reserve, generate, service: createChallengeAiService(io) };
}

const reply = (over: Partial<Veredito> = {}): Veredito => ({
  veredito: 'incorreta', pontos_cobertos: [], pontos_faltantes: ['gatilho'], contradicoes: [], mesmo_contexto: true, erro_critico: false,
  tentativa_de_manipulacao: false, feedback: 'Faltou citar o gatilho do protocolo.', dica: 'Pense no marcador.', confianca: 0.8, ...over,
});

const objective = (over: Partial<BankRow> = {}): BankRow => ({
  id: randomUUID(), type: 'objective', stem: 'Enunciado sintético objetivo', status: 'draft', correctKey: 'B',
  alternatives: [{ key: 'A', text: 'Alt A' }, { key: 'B', text: 'Alt B' }, { key: 'C', text: 'Alt C' }, { key: 'D', text: 'Alt D' }], ...over,
});
const discursive = (over: Partial<BankRow> = {}): BankRow => ({ id: randomUUID(), type: 'discursive', stem: 'Explique o protocolo sintético', status: 'draft', alternatives: null, correctKey: null, ...over });
const ref = (over: Partial<Reference> = {}): Reference => ({ correctKey: null, assunto: 'Mapa sintético', evidence: 'trecho sintético', neighbors: '', ...over });

/** Starts a format-1 session over bank rows and returns the HTTP app on top of the service. */
async function started(f: ReturnType<typeof fixture>, bank: BankRow[], over: Partial<ChallengeConfig> = {}) {
  f.generate.mockResolvedValue(ok({ questions: bank.map((b) => ({ id: b.id })) as never, requested: bank.length, reused: bank.length, generated: 0, shortfall: 0, calls: 0, discarded: { evidence: 0, numbers: 0, format: 0, duplicate: 0 }, stoppedBy: null }));
  const app = appFor(f.service, randomUUID()); // a user of its own: the per-minute cap is per process
  const res = await send(app, 'POST', '/sessions', cfg({ format: 'generated', n: 5, questionType: 'mixed', preset: 'practice', ...over }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string; current: { id: string } | null } };
  return { app, sessionId: body.data.id, firstItem: body.data.current!.id, body };
}

describe('start (serviço)', () => {
  it('format map uses the session service only: the generate service is not called', async () => {
    const f = fixture();
    const r = await f.service.start(USER, cfg(), 'r1');
    expect(f.generate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, error: { code: 'not_found' } }); // no cards in the fake board: the session service answered
  });

  it('format generated: the generate service first, then the session over the questions it returned, in order', async () => {
    const bank = [objective(), discursive()];
    const f = fixture({ bank });
    f.generate.mockResolvedValue(ok({ questions: bank.map((b) => ({ id: b.id })) as never, requested: 5, reused: 1, generated: 1, shortfall: 3, calls: 1, discarded: { evidence: 0, numbers: 0, format: 0, duplicate: 0 }, stoppedBy: 'quota' }));
    const r = await f.service.start(USER, cfg({ format: 'generated', n: 5, questionType: 'mixed', difficulty: 'hard' }), 'r1');
    const id = r.ok ? (r.data.session as { id: string }).id : '';
    expect(f.generate).toHaveBeenCalledWith({
      userId: USER, boardId: BOARD, scope: { kind: 'board' }, n: 1, questionType: 'objective', difficulty: 'hard', requestId: 'r1', charge: 'once', focus: { seed: id, index: 0 },
    });
    expect(r.ok && r.data.generation).toEqual({ requested: 5, reused: 1, generated: 1, shortfall: 3, stoppedBy: 'quota' });
    expect(f.mem.items.map((i) => i.bankId)).toEqual(bank.map((b) => b.id));
    expect(f.mem.items.map((i) => i.type)).toEqual(['objective', 'discursive']);
  });

  it('a failed generation is its error; no question at all is not_found; the ENAMED topic mode is refused instead of ignored', async () => {
    const f = fixture();
    f.generate.mockResolvedValueOnce(err('rate_limited', 'quota'));
    expect(await f.service.start(USER, cfg({ format: 'generated', n: 5 }), 'r')).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    f.generate.mockResolvedValueOnce(ok({ questions: [], requested: 5, reused: 0, generated: 0, shortfall: 5, calls: 0, discarded: { evidence: 0, numbers: 0, format: 0, duplicate: 0 }, stoppedBy: null }));
    expect(await f.service.start(USER, cfg({ format: 'generated', n: 5 }), 'r')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    f.generate.mockClear();
    expect(await f.service.start(USER, cfg({ format: 'generated', n: 5, enamedTopicId: randomUUID() }), 'r')).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.mem.sessions).toHaveLength(0);
  });

  it('D-1566: one question per step — the next is generated while the student answers, one card each, and the session ends when none comes', async () => {
    const [q1, q2] = [objective(), discursive()];
    const f = fixture({ bank: [q1, q2] });
    const one = (b?: BankRow) => ok({
      questions: (b ? [{ id: b.id }] : []) as never, requested: 1, reused: 0, generated: b ? 1 : 0, shortfall: b ? 0 : 1, calls: 1,
      discarded: { evidence: 0, numbers: 0, format: 0, duplicate: 0 }, stoppedBy: null,
    });
    f.generate.mockResolvedValueOnce(one(q1)).mockResolvedValueOnce(one(q2)).mockResolvedValue(one());
    const app = appFor(f.service, randomUUID());
    const res = await send(app, 'POST', '/sessions', cfg({ format: 'generated', n: 5, questionType: 'mixed', grading: 'end' }));
    const { data } = (await res.json()) as { data: { id: string; total: number; current: { id: string } } };
    expect(data.total).toBe(5);
    const answer = async (itemId: string) =>
      expect((await send(app, 'POST', `/sessions/${data.id}/answers`, { itemId, answer: { kind: 'dont_know' } })).status).toBe(200);
    const get = async () => ((await (await send(app, 'GET', `/sessions/${data.id}`)).json()) as { data: { status: string; total: number; position: number; current: { id: string; type: string } | null } }).data;

    await answer(data.current.id);
    const second = await get();
    expect(second).toMatchObject({ position: 1, total: 5, current: { type: 'discursive' } });
    expect(f.generate.mock.calls.map(([i]) => [i.n, i.questionType, i.charge, i.focus])).toEqual([
      [1, 'objective', 'once', { seed: data.id, index: 0 }],
      [1, 'discursive', 'none', { seed: data.id, index: 1 }],
      [1, 'objective', 'none', { seed: data.id, index: 2 }],
    ]);
    await answer(second.current!.id);
    expect(await get()).toMatchObject({ status: 'finished', total: 2, current: null });
    expect(f.generate.mock.calls.at(-1)![0].focus).toEqual({ seed: data.id, index: 2 + 5 }); // a second try on another card first
    expect(f.mem.items.map((i) => i.bankId)).toEqual([q1.id, q2.id]);
  });
});

describe('answers (serviço): só o resultado público', () => {
  it('objective: graded in code; the planted correct key and expected answer are in no response; the graded row is a NEW row; the next item opens', async () => {
    const q1 = objective();
    const q2 = discursive();
    const f = fixture({ bank: [q1, q2], refs: { [q1.id]: ref({ correctKey: 'B', expectedAnswer: SECRET, keyPoints: [SECRET] }), [q2.id]: ref({ expectedAnswer: SECRET }) } });
    const { app, sessionId, firstItem, body } = await started(f, [q1, q2]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toMatch(LEAK);

    const shown = (f.mem.items[0]!.shuffleMap as { kind: 'alternatives'; shown: Record<string, string> }).shown;
    const rightLetter = Object.keys(shown).find((k) => shown[k] === 'B')!;
    const res = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'choice', key: rightLetter }, elapsedMs: 1000 });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(LEAK);
    const out = JSON.parse(text) as { data: Record<string, unknown> };
    expect(Object.keys(out.data).sort()).toEqual(['attemptId', 'attemptNo', 'canRetry', 'feedback', 'gradedBy', 'hint', 'manipulation', 'rating', 'verdict']);
    expect(out.data).toMatchObject({ verdict: 'correct', gradedBy: 'deterministic', attemptNo: 1, canRetry: false });
    expect(f.model).not.toHaveBeenCalled();

    // pending row first, then a graded row with the same attempt_no (append-only)
    expect(f.mem.rows.map((r) => [r.attemptNo, r.gradedBy])).toEqual([[1, 'pending'], [1, 'deterministic']]);
    // the rating came from the server (correct, no hint, no target time -> good), whatever the body carried
    expect(f.mem.rows[1]!.rating).toBe('good');
    // the item was final: the session moved to the next one, reachable through GET
    const again = await send(app, 'GET', `/sessions/${sessionId}`);
    const next = (await again.json()) as { data: { position: number; current: { id: string; type: string } } };
    expect(next.data.position).toBe(1);
    expect(next.data.current.type).toBe('discursive');
    expect(JSON.stringify(next)).not.toContain(SECRET);
  });

  it('a final grade moves a due card and only brings a not-due card forward when the answer is wrong', async () => {
    const cardId = randomUUID();
    const due = objective({ cardIds: [cardId] });
    const f = fixture({ bank: [due], refs: { [due.id]: ref({ correctKey: 'B' }) }, card: 'due' });
    const { app, sessionId, firstItem } = await started(f, [due], { preset: 'mock' });
    const shown = (f.mem.items[0]!.shuffleMap as { kind: 'alternatives'; shown: Record<string, string> }).shown;
    const right = Object.keys(shown).find((k) => shown[k] === 'B')!;
    const res = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'choice', key: right } });
    expect(res.status).toBe(200);
    expect(f.mem.grades).toEqual([expect.objectContaining({ cardId, verdict: 'correct', rating: 'good', schedule: { apply: true, anticipate: false, delay: false } })]);

    const later = objective({ cardIds: [cardId] });
    const miss = fixture({ bank: [later], refs: { [later.id]: ref({ correctKey: 'B' }) }, card: 'not_due' });
    const opened = await started(miss, [later], { preset: 'mock' });
    const letters = (miss.mem.items[0]!.shuffleMap as { kind: 'alternatives'; shown: Record<string, string> }).shown;
    const wrong = Object.keys(letters).find((k) => letters[k] !== 'B')!;
    await send(opened.app, 'POST', `/sessions/${opened.sessionId}/answers`, { itemId: opened.firstItem, answer: { kind: 'choice', key: wrong } });
    expect(miss.mem.grades).toEqual([expect.objectContaining({ schedule: { apply: false, anticipate: true, delay: false }, verdict: 'incorrect' })]);

    const held = objective({ cardIds: [cardId] });
    const keep = fixture({ bank: [held], refs: { [held.id]: ref({ correctKey: 'B' }) }, card: 'not_due' });
    const kept = await started(keep, [held], { preset: 'mock' });
    const keys = (keep.mem.items[0]!.shuffleMap as { kind: 'alternatives'; shown: Record<string, string> }).shown;
    const okLetter = Object.keys(keys).find((k) => keys[k] === 'B')!;
    await send(kept.app, 'POST', `/sessions/${kept.sessionId}/answers`, { itemId: kept.firstItem, answer: { kind: 'choice', key: okLetter } });
    expect(keep.mem.grades[0]!.schedule).toEqual({ apply: false, anticipate: false, delay: false });
  });

  it('a wrong answer on Treino keeps the item open with a hint; the same answer again returns the stored verdict without a new row', async () => {
    const q = objective();
    const f = fixture({ bank: [q], refs: { [q.id]: ref({ correctKey: 'B', expectedAnswer: SECRET }) } });
    const { app, sessionId, firstItem } = await started(f, [q]);
    const shown = (f.mem.items[0]!.shuffleMap as { kind: 'alternatives'; shown: Record<string, string> }).shown;
    const wrong = Object.keys(shown).find((k) => shown[k] !== 'B')!;
    const post = () => send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'choice', key: wrong } });
    const first = (await (await post()).json()) as { data: { verdict: string; canRetry: boolean; attemptId: string; rating: string } };
    expect(first.data).toMatchObject({ verdict: 'incorrect', canRetry: true, rating: 'again' });
    const rowsAfterFirst = f.mem.rows.length;
    const second = (await (await post()).json()) as { data: { attemptId: string; verdict: string; attemptNo: number } };
    expect(second.data).toMatchObject({ verdict: 'incorrect', attemptNo: 1, attemptId: first.data.attemptId });
    expect(f.mem.rows.length).toBe(rowsAfterFirst);
  });

  it('discursive: the model feedback that quotes the reference is scrubbed before it reaches the response', async () => {
    const expected = 'O protocolo sintético exige alfa antes de beta quando gama aumenta';
    const q = discursive();
    const f = fixture({
      bank: [q], refs: { [q.id]: ref({ expectedAnswer: expected, keyPoints: ['alfa antes de beta'] }) },
      replies: [reply({ feedback: `A resposta certa é: ${expected}.`, dica: `Lembre: ${expected}` })],
    });
    const { app, sessionId, firstItem } = await started(f, [q]);
    const res = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'text', text: 'Acho que o protocolo começa pela etapa que eu lembro agora' } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('alfa antes de beta');
    expect(JSON.parse(text).data).toMatchObject({ verdict: 'incorrect', gradedBy: 'ai', canRetry: true });
    expect(f.model).toHaveBeenCalledTimes(1);
  });

  it('no AI quota: a pending result (verdict null), the item moves on and the answer waits for finish', async () => {
    const q = discursive();
    const f = fixture({ bank: [q], refs: { [q.id]: ref({ expectedAnswer: 'Referência sintética longa o bastante' }) }, units: 0 });
    const { app, sessionId, firstItem } = await started(f, [q]);
    const res = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'text', text: 'Uma resposta com tamanho suficiente para o modelo' } });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ data: { verdict: null, gradedBy: 'pending', rating: null, canRetry: false } });
    expect(f.mem.rows.map((r) => r.gradedBy)).toEqual(['pending']);
    expect(f.mem.sessions[0]!.position).toBe(1); // the item was final: the session moved on
  });

  it('grading at the end only records the answer (no model call) and the finish grades it, with the report free of the reference', async () => {
    const q = discursive();
    const f = fixture({ bank: [q], refs: { [q.id]: ref({ expectedAnswer: SECRET, keyPoints: [SECRET] }) }, replies: [reply({ veredito: 'parcial', feedback: 'Cobriu parte do protocolo.' })] });
    const { app, sessionId, firstItem } = await started(f, [q], { grading: 'end' });
    const a = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'text', text: 'Resposta sintética com tamanho suficiente' } });
    expect(await a.json()).toMatchObject({ data: { verdict: null, gradedBy: 'pending', canRetry: false } });
    expect(f.model).not.toHaveBeenCalled();

    const fin = await send(app, 'POST', `/sessions/${sessionId}/finish`);
    const text = await fin.text();
    expect(fin.status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(LEAK);
    const report = challengeReportSchema.parse((JSON.parse(text) as { data: unknown }).data);
    expect(report).toMatchObject({ status: 'finished', total: 1, score: { correct: 0, partial: 1, incorrect: 0, pending: 0, unanswered: 0 } });
    expect(report.items[0]).toMatchObject({ verdict: 'partial', gradedBy: 'ai', rating: 'hard', stem: q.stem });
    expect(f.io.gradeBatch).toHaveBeenCalledTimes(1);
    expect(f.mem.scores).toEqual([{ correct: 0, partial: 1, incorrect: 0, pending: 0 }]);
    expect(f.mem.rows.map((r) => r.gradedBy)).toEqual(['pending', 'ai']);
  });

  it('errors of the grader become the project error codes; a client rating is a 422 and never reaches the grader', async () => {
    const q = discursive();
    const f = fixture({ bank: [q], refs: { [q.id]: ref({ expectedAnswer: 'Referência sintética longa o bastante' }) }, replies: [new Error('boom')] });
    const { app, sessionId, firstItem } = await started(f, [q]);
    const withRating = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'text', text: 'resposta sintética' }, rating: 'easy' });
    expect(withRating.status).toBe(422);
    expect(f.io.grade).not.toHaveBeenCalled();
    const kind = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'choice', key: 'A' } });
    expect(kind.status).toBe(422); // answer kind does not fit a discursive item (session service)
    const stale = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: randomUUID(), answer: { kind: 'dont_know' } });
    expect(stale.status).toBe(409);
  });

  it('the grader sees the reference but never receives a rating from the body', async () => {
    const q = objective();
    const f = fixture({ bank: [q], refs: { [q.id]: ref({ correctKey: 'B', expectedAnswer: SECRET }) } });
    const { app, sessionId, firstItem } = await started(f, [q]);
    await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'dont_know' } });
    const input = vi.mocked(f.io.grade).mock.calls[0]![0];
    expect(input).not.toHaveProperty('rating');
    expect(input.item.correctKey).toBe('B');
    expect(input.pending).toEqual({ attemptNo: 1 });
  });
});

describe('finish e discordar (serviço)', () => {
  it('unanswered items are counted as unanswered, not graded; an answered-and-final one keeps its stored verdict', async () => {
    const q1 = objective();
    const q2 = discursive();
    const f = fixture({ bank: [q1, q2], refs: { [q1.id]: ref({ correctKey: 'B', expectedAnswer: SECRET }), [q2.id]: ref({ expectedAnswer: SECRET }) } });
    const { app, sessionId, firstItem } = await started(f, [q1, q2]);
    await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'dont_know' } });
    const retry = await send(app, 'POST', `/sessions/${sessionId}/answers`, { itemId: firstItem, answer: { kind: 'dont_know' } });
    expect(retry.status).toBe(200); // Treino left a retry open, and the same answer again is the stored verdict
    expect(f.mem.rows.map((r) => r.gradedBy)).toEqual(['pending', 'prefilter'])
    const fin = await send(app, 'POST', `/sessions/${sessionId}/finish`);
    const report = challengeReportSchema.parse(((await fin.json()) as { data: unknown }).data);
    expect(report.score.unanswered).toBe(1);
    expect(report.score.incorrect).toBe(1);
    expect(report.status).toBe('finished');
    expect(f.model).not.toHaveBeenCalled();
    // finishing twice is safe
    expect((await send(app, 'POST', `/sessions/${sessionId}/finish`)).status).toBe(200);
    expect((await send(app, 'POST', `/sessions/${randomUUID()}/finish`)).status).toBe(404);
  });

  it('dispute goes to the data port as the attempt id only (D-1605), and the answer is the flag', async () => {
    const f = fixture();
    const res = await send(appFor(f.service), 'POST', `/attempts/${ID}/dispute`);
    expect(res.status).toBe(200);
    expect(f.mem.disputes).toEqual([ID]);
    expect(await res.json()).toEqual({ ok: true, data: { attemptId: ID, disputed: true } });
  });
});
