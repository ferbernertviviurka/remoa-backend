import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@remoa/log';
import { err, ok } from '@remoa/contracts';
import type { Env } from '../app';
import type { generateQuestions } from '../challenge-ai/generate';
import type { generateFromTopics } from '../questions/builder/generate-topic';
import { eligibleWhere, sourceWhere } from '../questions/builder/service';
import { examBuilderRoutes, shortfallReason } from './exam-builder';

type Gen = typeof generateQuestions;
type GenTopic = typeof generateFromTopics;
const BOARD = randomUUID();
const out = (over: Record<string, unknown> = {}) => ok({ questions: [{ id: randomUUID(), stem: 'S', correctKey: 'A' }, { id: randomUUID(), stem: 'S2', correctKey: 'B' }], requested: 3, reused: 1, generated: 1, shortfall: 1, calls: 1, discarded: {}, stoppedBy: null, ...over }) as unknown as Awaited<ReturnType<Gen>>;
function appFor(generate: Gen, userId = randomUUID(), generateTopic?: GenTopic) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('userId', userId); c.set('requestId', 'req-1'); c.set('log', createLogger({ requestId: 'test' })); await next(); });
  return app.route('/v1/exam-builder', examBuilderRoutes(generate, generateTopic));
}
const post = (app: ReturnType<typeof appFor>, body: unknown, accept = 'application/json') => app.request('/v1/exam-builder/generate', { method: 'POST', headers: { 'content-type': 'application/json', accept }, body: JSON.stringify(body) });

describe('POST /v1/exam-builder/generate', () => {
  it('returns ids and counts only, objective questions of the whole map', async () => {
    const gen = vi.fn<Gen>(async () => out());
    const userId = randomUUID();
    const res = await post(appFor(gen, userId), { boardId: BOARD, count: 3 });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['generated', 'questionIds', 'requested', 'reused', 'shortfall', 'shortfallReason', 'stoppedBy']);
    expect(body.data).toMatchObject({ requested: 3, reused: 1, generated: 1, shortfall: 1, stoppedBy: null, shortfallReason: 'rejected' });
    expect(JSON.stringify(body)).not.toMatch(/stem|correctKey/);
    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ userId, boardId: BOARD, scope: { kind: 'board' }, n: 3, questionType: 'objective', difficulty: 'mixed', requestId: 'req-1', batchSize: 5, extraBatches: 2 }));
  });
  it('a board the user does not own (or missing) is 404 not_found', async () => {
    const res = await post(appFor(async () => err('not_found', 'board not found')), { boardId: BOARD, count: 2 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'board not found' } });
  });
  it('quota stop with something delivered is 200 with stoppedBy; with nothing it is the quota error', async () => {
    const partial = await post(appFor(async () => out({ stoppedBy: 'quota' })), { boardId: BOARD, count: 3 });
    expect(partial.status).toBe(200);
    expect(((await partial.json()) as { data: { stoppedBy: string } }).data.stoppedBy).toBe('quota');
    const none = await post(appFor(async () => err('quota_exceeded', 'quota')), { boardId: BOARD, count: 3 });
    expect(none.status).toBeGreaterThanOrEqual(400);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded');
  });
  it('rejects bad input without calling the model', async () => {
    const gen = vi.fn<Gen>(async () => out());
    const app = appFor(gen);
    for (const body of [{ count: 3 }, { boardId: null, theme: '   ', count: 3 }, { theme: 'x'.repeat(201), count: 3 }, { boardId: 'x', count: 3 }, { boardId: BOARD, count: 21 }, { boardId: BOARD, count: 0 }, { boardId: BOARD, count: 3, extra: 1 }, null]) {
      const res = await post(app, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation');
    }
    expect(gen).not.toHaveBeenCalled();
  });
});

describe('D-1882: generate without a map, progress stream, shortfall reason', () => {
  const topicOut = (n: number, over: Record<string, unknown> = {}) => ok({ questions: Array.from({ length: n }, () => ({ id: randomUUID(), stem: 'S', correctKey: 'A' })), requested: 3, reused: 0, generated: n, shortfall: 3 - n, calls: 1, discarded: { format: 0, duplicate: 0, untagged: 0 }, stoppedBy: null, ...over }) as unknown as Awaited<ReturnType<GenTopic>>;
  it('theme mode (no boardId) goes to the topic generator with the chosen taxonomy and theme', async () => {
    const gen = vi.fn<Gen>(async () => out());
    const topic = vi.fn<GenTopic>(async () => topicOut(3));
    const T = randomUUID(), A = randomUUID(), userId = randomUUID();
    const res = await post(appFor(gen, userId, topic), { areaIds: [A], topicIds: [T], theme: '  sepse  ', count: 3, difficulty: 'hard' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ generated: 3, shortfall: 0, shortfallReason: null, reused: 0 });
    expect(gen).not.toHaveBeenCalled();
    expect(topic).toHaveBeenCalledWith(expect.objectContaining({ userId, areaIds: [A], topicIds: [T], theme: 'sepse', n: 3, difficulty: 'hard' }));
    const onlyTheme = vi.fn<GenTopic>(async () => topicOut(3));
    expect((await post(appFor(gen, userId, onlyTheme), { theme: 'sepse', count: 3 })).status).toBe(200);
    expect(onlyTheme).toHaveBeenCalledWith(expect.objectContaining({ areaIds: [], topicIds: [], theme: 'sepse' }));
  });
  it('streams monotonic progress, then the result (Accept: text/event-stream)', async () => {
    const topic = vi.fn<GenTopic>(async (i) => { for (const n of [0, 2, 2, 3]) await i.onProgress?.(n); return topicOut(3); });
    const res = await post(appFor(vi.fn<Gen>(), randomUUID(), topic), { topicIds: [randomUUID()], count: 3 }, 'text/event-stream');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = (await res.text()).split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')) as Record<string, unknown>);
    expect(events.slice(0, 3)).toEqual([{ progress: { generated: 0, requested: 3 } }, { progress: { generated: 2, requested: 3 } }, { progress: { generated: 3, requested: 3 } }]);
    expect(events[3]).toMatchObject({ result: { generated: 3, shortfall: 0 } });
    expect(JSON.stringify(events)).not.toMatch(/stem|correctKey/);
  });
  it('a failure inside the stream ends with an error event; validation stays a plain 422', async () => {
    const res = await post(appFor(async () => err('not_found', 'board not found')), { boardId: BOARD, count: 2 }, 'text/event-stream');
    expect(await res.text()).toBe(`data: ${JSON.stringify({ error: { code: 'not_found', message: 'board not found' } })}\n\n`);
    const boom = await post(appFor(async () => { throw new Error('db down'); }), { boardId: BOARD, count: 2 }, 'text/event-stream');
    expect(await boom.text()).toContain('"code":"internal"');
    expect((await post(appFor(vi.fn<Gen>()), { count: 2 }, 'text/event-stream')).status).toBe(422);
  });
  it('shortfallReason says why the request came back short', () => {
    const d = (over: Record<string, unknown>) => ({ questions: [], requested: 10, reused: 0, generated: 9, shortfall: 1, stoppedBy: null, discarded: {}, ...over }) as Parameters<typeof shortfallReason>[0];
    expect(shortfallReason(d({ shortfall: 0 }))).toBeNull();
    expect(shortfallReason(d({ stoppedBy: 'quota' }))).toBe('quota');
    expect(shortfallReason(d({ stoppedBy: 'ai_error' }))).toBe('ai_error');
    expect(shortfallReason(d({ discarded: { evidence: 1, untagged: 0 } }))).toBe('rejected');
    expect(shortfallReason(d({ discarded: { evidence: 0, numbers: 0, format: 0, duplicate: 0, untagged: 2 } }))).toBe('unclassified');
  });
});

describe('builder pool predicate (D-1846)', () => {
  const d = new PgDialect();
  const q = (source: 'catalog' | 'ai' | 'catalog_and_ai', boardId: string | null) => d.sqlToQuery(sourceWhere('u1', source, boardId));
  it('boardId restricts only the private AI part', () => {
    expect(q('ai', BOARD).sql).toContain('q.board_id=');
    expect(q('ai', BOARD).params).toContain(BOARD);
    expect(q('catalog_and_ai', BOARD).sql).toContain("q.visibility='public' OR");
    expect(q('catalog_and_ai', BOARD).sql).toContain('q.board_id=');
    expect(q('catalog', BOARD).sql).not.toContain('board_id');
    expect(q('ai', null).sql).not.toContain('board_id');
  });
});

describe('builder course predicate (D-1861)', () => {
  const sqlOf = (course: 'medicine' | 'nursing' | null) => new PgDialect().sqlToQuery(eligibleWhere('u1', 'catalog_and_ai', 'all', null, course)).sql;
  it('only a course other than medicine empties the public part', () => {
    expect(sqlOf('nursing')).toContain("q.visibility<>'public'");
    expect(sqlOf('medicine')).not.toContain("q.visibility<>'public'");
    expect(sqlOf(null)).not.toContain("q.visibility<>'public'");
  });
});
