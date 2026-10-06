// G21 FR-21/FR-18/FR-20 (D-1033..D-1036): no database. A fake transaction counts statements; the HTTP part mocks the domain functions.
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { MapOp } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { rateInTx } from '../review/record-attempt';
import { applyOp, arr, decodeCursor, encodeCursor, etagMatches } from './boards';

const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]);
const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
const board = crypto.randomUUID();

/** Fake Tx: `execute` is the only door the batch paths use; each call is one statement. */
const fakeTx = (rows: unknown[][] = []) => {
  const execute = vi.fn<(q: unknown) => Promise<unknown[]>>(async () => rows.shift() ?? []);
  return { tx: { execute } as unknown as Tx, execute };
};

describe('batch writes (FR-21)', () => {
  it('dragging 50 cards is ONE statement (was 50), with unnest and the board guard', async () => {
    const { tx, execute } = fakeTx();
    const op: MapOp = { op: 'moveCards', opId: crypto.randomUUID(), boardId: board, moves: ids.map((cardId, i) => ({ cardId, position: { x: i + 0.4, y: -i } })) };
    await applyOp(tx, {} as never, op, { userId: 'u', cardLimit: null });
    expect(execute).toHaveBeenCalledTimes(1);
    const q = render(execute.mock.calls[0]![0]);
    expect(q.sql).toMatch(/update cards set x = v\.x.*from unnest\(.*as v\(id, x, y\).*cards\.board_id = /s);
    expect(q.params[0]).toBe(`{${ids.join(',')}}`);
    expect(q.params[1]).toBe(`{${ids.map((_, i) => Math.round(i + 0.4)).join(',')}}`);
  });

  it('resizing keeps null sizes as NULL and is one statement', async () => {
    const { tx, execute } = fakeTx();
    const op: MapOp = { op: 'resizeCards', opId: crypto.randomUUID(), boardId: board, sizes: [{ cardId: ids[0]!, size: { w: 200, h: 100 } }, { cardId: ids[1]!, size: null }] };
    await applyOp(tx, {} as never, op, { userId: 'u', cardLimit: null });
    expect(execute).toHaveBeenCalledTimes(1);
    const q = render(execute.mock.calls[0]![0]);
    expect(q.params.slice(1, 3)).toEqual(['{200,NULL}', '{100,NULL}']);
  });

  it('empty batches write nothing', async () => {
    const { tx, execute } = fakeTx();
    await applyOp(tx, {} as never, { op: 'moveCards', opId: crypto.randomUUID(), boardId: board, moves: [] } as MapOp, { userId: 'u', cardLimit: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it('arr builds a Postgres array literal', () => {
    expect(arr(['a', 1, null])).toBe('{a,1,NULL}');
  });
});

describe('rate in one transaction (FR-22)', () => {
  const attempt = {
    id: crypto.randomUUID(), userId: crypto.randomUUID(), cardId: ids[0]!, subId: '', sessionId: crypto.randomUUID(), mode: 'hidden_card', inputKind: 'text', answerText: 'x',
    verdict: null, grade: 'good', gradeOverridden: false, durationMs: 1200, createdAt: new Date('2026-10-05T12:00:00Z'),
  } as const;
  const fresh = { stability: 0, difficulty: 0, due: '2026-10-05T12:00:00Z', reps: 0, lapses: 0, last_review: null, state: 'new', learning_steps: 0, scheduled_days: 0 };

  it('is exactly 2 statements (lock+read, then one CTE with attempt + FSRS state + session) and returns the new due', async () => {
    const { tx, execute } = fakeTx([[fresh]]);
    const items = [{ id: 'i1' }];
    const r = await rateInTx(tx, attempt as never, () => ({ sessionId: attempt.sessionId, items }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(render(execute.mock.calls[0]![0]).sql).toMatch(/on conflict \(user_id, card_id, sub_id\) do update/);
    const cte = render(execute.mock.calls[1]![0]);
    expect(cte.sql).toMatch(/insert into attempts.*on conflict \(id\) do nothing.*update fsrs_state.*exists \(select 1 from a\).*update sessions set items/s);
    expect(r.due.getTime()).toBeGreaterThan(attempt.createdAt.getTime());
  });

  it('a deleted card (lock statement returns no row) is not_found and writes nothing', async () => {
    const { tx, execute } = fakeTx([[]]);
    await expect(rateInTx(tx, attempt as never, () => ({ sessionId: 's', items: [] }))).rejects.toMatchObject({ error: { code: 'not_found' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('cursor and ETag helpers (FR-18/FR-20)', () => {
  it('cursor round-trips the exact text timestamp (microseconds) and rejects garbage', () => {
    const id = crypto.randomUUID();
    const c = encodeCursor('2026-10-05 12:00:00.123456+00', id);
    expect(decodeCursor(c)).toEqual({ ts: '2026-10-05 12:00:00.123456+00', id });
    expect(decodeCursor(Buffer.from("x'; drop table boards;--|" + id).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(`2026-10-05 12:00:00+00|not-a-uuid`).toString('base64url'))).toBeNull();
  });

  it('If-None-Match: weak/strong, lists and *', () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"x", W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('*', 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"zzz"', 'W/"abc"')).toBe(false);
    expect(etagMatches(null, 'W/"abc"')).toBe(false);
  });
});

describe('GET /v1/boards/:id over HTTP: ETag, 304, compression', () => {
  it('sends the ETag, answers 304 without body, gzips big JSON and exposes the next cursor', async () => {
    const big = { board: { id: 'b' }, cards: Array.from({ length: 300 }, (_, i) => ({ id: String(i), title: 'Hipertensão arterial sistêmica '.repeat(4) })), edges: [] };
    vi.resetModules();
    vi.doMock('./boards', async (orig) => ({
      ...(await orig<typeof import('./boards')>()),
      getBoardView: vi.fn(async (_u: string, _id: string, o: { ifNoneMatch?: string | null }) =>
        ({ ok: true, data: o.ifNoneMatch === 'W/"v1"' ? { etag: 'W/"v1"', notModified: true } : { etag: 'W/"v1"', notModified: false, data: big } })),
      listBoardsPage: vi.fn(async () => ({ ok: true, data: { items: [], nextCursor: 'CUR' } })),
    }));
    const { boardsRoutes } = await import('../routes/boards');
    const app = new Hono().use('*', async (c, next) => { c.set('userId' as never, 'u' as never); await next(); }).route('/v1/boards', boardsRoutes as never);
    const id = crypto.randomUUID();

    const first = await app.request(`/v1/boards/${id}?view=structure`, { headers: { 'accept-encoding': 'gzip' } });
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe('W/"v1"');
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    expect(first.headers.get('content-encoding')).toBe('gzip');

    const again = await app.request(`/v1/boards/${id}`, { headers: { 'if-none-match': 'W/"v1"' } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');

    expect((await app.request('/v1/boards?limit=1')).headers.get('x-next-cursor')).toBe('CUR');
    expect((await app.request(`/v1/boards/${id}?view=nope`)).status).toBe(422);
    vi.doUnmock('./boards');
  });
});
