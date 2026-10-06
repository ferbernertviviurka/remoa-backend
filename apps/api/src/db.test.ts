// G21 FR-25 (D-993) + D-991 against the real Postgres. Needs local Supabase; skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { asJob, firstStatement, run } from './db';

config({ path: '../../.env' });
const USER = '00000000-0000-0000-0000-000000000000';

describe.skipIf(!process.env.DATABASE_URL)('run() timeouts and first statement (local Supabase)', () => {
  const show = (tx: Parameters<Parameters<typeof run>[1]>[0]) =>
    tx.execute<{ st: string; idle: string; role: string }>(sql`select current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as idle, current_user as role`);

  it('requests get 5 s / 10 s, jobs 30 s / 60 s, as authenticated; nothing leaks to the pooled connection after commit', async () => {
    expect((await run(USER, show))[0]).toEqual({ st: '5s', idle: '10s', role: 'authenticated' });
    expect((await asJob(() => run(USER, show)))[0]).toEqual({ st: '30s', idle: '1min', role: 'authenticated' });
    const { db } = await import('@remoa/db');
    for (let i = 0; i < 12; i++) {
      // more than the pool size: every connection that ran a run() is back to the defaults
      const [r] = await db.execute<{ st: string; role: string }>(sql`select current_setting('statement_timeout') as st, current_user as role`);
      expect(r).toEqual({ st: '0', role: 'postgres' });
    }
  });

  it('a statement past the timeout fails with 57014 instead of hanging', async () => {
    const { db } = await import('@remoa/db');
    const err = await db
      .transaction(async (tx) => {
        await tx.execute(firstStatement(USER, { statementMs: 100, idleTxMs: 1_000 }));
        await tx.execute(sql`select pg_sleep(0.5)`);
      })
      .catch((e: unknown) => e as { code?: string; cause?: { code?: string } });
    expect((err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code).toBe('57014');
  });

  it('D-990: the session columns read auth.* in the same statement that switches to authenticated (no live session → nulls)', async () => {
    const { db } = await import('@remoa/db');
    const rows = await db.transaction((tx) => tx.execute<{ live: boolean | null }>(firstStatement(USER, { statementMs: 5_000, idleTxMs: 10_000 }, '00000000-0000-0000-0000-000000000001')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.live).toBeNull();
  });
});
