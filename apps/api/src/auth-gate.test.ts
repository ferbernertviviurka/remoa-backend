// G21 D-978/D-990/D-993, no database: @remoa/db is faked, so these count statements and check what each one carries.
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const executed: string[] = [];
let sessionRow: Row | undefined;
const dialect = new PgDialect();
const execute = async (q: SQL) => {
  const text = dialect.sqlToQuery(q).sql;
  executed.push(text);
  if (!text.includes('auth.sessions')) return [{}];
  // run(): (select 1) left join → always one row; standalone liveSession → zero or one row
  return text.includes('left join (') ? [sessionRow ?? { live: null, deleted_at: null, suspended_at: null, has_profile: null }] : sessionRow ? [sessionRow] : [];
};
vi.mock('@remoa/db', () => ({
  db: { execute, transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) => fn({ execute }) },
}));

const { createApp } = await import('./app');
const { run, firstStatement, asJob, currentTimeouts, TIMEOUTS } = await import('./db');
const { sessionGate, SessionRejected } = await import('./auth-session');

const USER = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const live = (p: Partial<Row> = {}): Row => ({ live: true, deleted_at: null, suspended_at: null, has_profile: true, ...p });
const quiet = async <T>(fn: () => T | Promise<T>) => {
  const a = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const b = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await fn();
  } finally {
    a.mockRestore();
    b.mockRestore();
  }
};

beforeEach(() => {
  executed.length = 0;
  sessionRow = live();
});

describe('requireUser runs once per request (D-978)', () => {
  const PREFIXES = ['account', 'boards', 'cards', 'onboarding', 'notifications', 'calendar', 'home', 'matrix', 'coverage', 'review', 'challenge', 'uploads', 'imports', 'ai', 'reports', 'editorial', 'assets', 'support', 'store', 'referral', 'billing'];
  it('root and nested paths of every prefix verify the token exactly once', async () => {
    let calls = 0;
    const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async () => (calls++, { userId: USER, sessionId: SID, account: null }) });
    for (const p of PREFIXES)
      for (const path of [`/v1/${p}`, `/v1/${p}/x`]) {
        calls = 0;
        await quiet(() => app.request(path, { method: 'POST', headers: { authorization: 'Bearer t' } }));
        expect(calls, `POST ${path}`).toBe(1);
      }
  });
});

describe('fused session check on reads (D-990)', () => {
  const app = createApp({
    webOrigin: 'http://localhost:3000',
    verifyToken: async (_t, o) => (o?.defer ? { userId: USER, sessionId: SID, pending: true } : { userId: USER, sessionId: SID, account: null }),
  });
  const get = (path: string) => quiet(() => app.request(path, { headers: { authorization: 'Bearer t' } }));

  it('a GET that never opens run() pays the session query once, at the end', async () => {
    expect((await get('/v1/me')).status).toBe(200);
    expect(executed.filter((q) => q.includes('auth.sessions'))).toHaveLength(1);
    expect(executed).toHaveLength(1);
  });

  it('revoked or banned session on such a GET: 401 (revocation stays immediate)', async () => {
    sessionRow = undefined;
    const res = await get('/v1/me');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('a GET whose handler opens run(): session columns ride in the first statement; dead session = 401 and the handler body never runs', async () => {
    sessionRow = undefined;
    const res = await get('/v1/boards');
    expect(res.status).toBe(401);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatch(/set_config\('request\.jwt\.claims'.*auth\.sessions/s);
  });

  it('deleted account on a GET: 403 account_deleted, except GET /v1/account/me (D-123); suspended likewise (D-430)', async () => {
    sessionRow = live({ deleted_at: new Date() });
    const res = await get('/v1/boards');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('account_deleted');
    sessionRow = live({ suspended_at: new Date() });
    expect((await get('/v1/boards')).status).toBe(403);
    sessionRow = live({ suspended_at: new Date(), deleted_at: new Date() });
    expect((await get('/v1/me')).status).toBe(403); // /v1/me is not an exception
  });

  it('writes keep the eager check (the verifier reads the session before the handler)', async () => {
    let deferred: boolean | undefined;
    const w = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (_t, o) => ((deferred = o?.defer), null) });
    await quiet(() => w.request('/v1/boards', { method: 'POST', headers: { authorization: 'Bearer t' } }));
    expect(deferred).toBe(false);
  });

  it('FUSED_WRITES (D-1047): POST /v1/challenge/rate defers; dead session = 401 from the first statement, nothing else runs', async () => {
    sessionRow = undefined;
    const body = JSON.stringify({ sessionId: SID, itemId: 'i1', grade: 'good', overridden: false });
    const res = await quiet(() => app.request('/v1/challenge/rate', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body }));
    expect(res.status).toBe(401);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatch(/set_config\('request\.jwt\.claims'.*auth\.sessions/s);
  });
});

describe('run(): one fixed statement (D-991) with timeouts (D-993)', () => {
  const gate = () => ({ userId: USER, sessionId: SID, route: 'GET /v1/x', state: 'pending' as const });

  it('first run of the request checks the session in its first statement; later runs do not repeat it', async () => {
    const g = { ...gate() } as { userId: string; sessionId: string; route: string; state: 'pending' | 'ok' | object };
    await sessionGate.run(g as never, async () => {
      await run(USER, async (tx) => tx.execute(firstStatement(USER, TIMEOUTS.app))); // body: one more statement
      await run(USER, async () => undefined);
    });
    expect(g.state).toBe('ok');
    expect(executed.filter((q) => q.includes('auth.sessions'))).toHaveLength(1);
    expect(executed).toHaveLength(3);
  });

  it('dead session: run rejects with SessionRejected before fn, and so does every later run of the request', async () => {
    sessionRow = undefined;
    const fn = vi.fn(async () => 1);
    await sessionGate.run(gate() as never, async () => {
      await expect(run(USER, fn)).rejects.toBeInstanceOf(SessionRejected);
      await expect(run(USER, fn)).rejects.toBeInstanceOf(SessionRejected);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('a run for another user id (admin acting on someone) is not taken as the check', async () => {
    const g = gate();
    await sessionGate.run(g as never, () => run('33333333-3333-4333-8333-333333333333', async () => undefined));
    expect(executed[0]).not.toContain('auth.sessions');
    expect(g.state).toBe('pending');
  });

  it('timeouts: 5 s statement / 10 s idle in transaction for requests, 30 s / 60 s inside asJob, set local to the transaction', () => {
    expect(currentTimeouts()).toEqual({ statementMs: 5_000, idleTxMs: 10_000 });
    expect(asJob(() => currentTimeouts())).toEqual({ statementMs: 30_000, idleTxMs: 60_000 });
    const q = dialect.sqlToQuery(firstStatement(USER, TIMEOUTS.app));
    expect(q.sql).toMatch(/set_config\('statement_timeout', \$\d, true\), set_config\('idle_in_transaction_session_timeout', \$\d, true\)/);
    expect(q.params).toEqual(expect.arrayContaining(['5000', '10000']));
  });
});
