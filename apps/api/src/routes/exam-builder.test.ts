import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@remoa/log';
import { err, ok } from '@remoa/contracts';
import type { Env } from '../app';
import type { generateQuestions } from '../challenge-ai/generate';
import { sourceWhere } from '../questions/builder/service';
import { examBuilderRoutes } from './exam-builder';

type Gen = typeof generateQuestions;
const BOARD = randomUUID();
const out = (over: Record<string, unknown> = {}) => ok({ questions: [{ id: randomUUID(), stem: 'S', correctKey: 'A' }, { id: randomUUID(), stem: 'S2', correctKey: 'B' }], requested: 3, reused: 1, generated: 1, shortfall: 1, calls: 1, discarded: {}, stoppedBy: null, ...over }) as unknown as Awaited<ReturnType<Gen>>;
function appFor(generate: Gen, userId = randomUUID()) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('userId', userId); c.set('requestId', 'req-1'); c.set('log', createLogger({ requestId: 'test' })); await next(); });
  return app.route('/v1/exam-builder', examBuilderRoutes(generate));
}
const post = (app: ReturnType<typeof appFor>, body: unknown) => app.request('/v1/exam-builder/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /v1/exam-builder/generate', () => {
  it('returns ids and counts only, objective questions of the whole map', async () => {
    const gen = vi.fn<Gen>(async () => out());
    const userId = randomUUID();
    const res = await post(appFor(gen, userId), { boardId: BOARD, count: 3 });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['generated', 'questionIds', 'requested', 'reused', 'shortfall', 'stoppedBy']);
    expect(body.data).toMatchObject({ requested: 3, reused: 1, generated: 1, shortfall: 1, stoppedBy: null });
    expect(JSON.stringify(body)).not.toMatch(/stem|correctKey/);
    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ userId, boardId: BOARD, scope: { kind: 'board' }, n: 3, questionType: 'objective', difficulty: 'mixed', requestId: 'req-1' }));
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
    for (const body of [{ boardId: 'x', count: 3 }, { boardId: BOARD, count: 21 }, { boardId: BOARD, count: 0 }, { boardId: BOARD, count: 3, extra: 1 }, null]) {
      const res = await post(app, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation');
    }
    expect(gen).not.toHaveBeenCalled();
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
