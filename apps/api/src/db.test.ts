// G21 FR-25 (D-993) + D-991 against the real Postgres. Needs local Supabase; skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { asJob, asServer, final, firstStatement, pgArray, run, uuids, WRITES } from './db';

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

  // D-1091/D-1092: pipelined transactions
  it('D-1091: a write is committed (visible on another connection) when run() returns; reads answer without waiting for COMMIT', async () => {
    const { db } = await import('@remoa/db');
    const [b] = await db.execute<{ id: string }>(sql`insert into auth.users (id, email, instance_id, aud, role) values (gen_random_uuid(), gen_random_uuid() || '@t.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated') returning id`);
    const u = b!.id;
    try {
      const boardId = await run(u, async (tx) => (await tx.execute<{ id: string }>(sql`insert into boards (user_id, title) values (${u}, 'D-1091') returning id`))[0]!.id);
      const [seen] = await db.execute(sql`select id from boards where id = ${boardId}`); // server connection, another session
      expect(seen).toBeTruthy();
      expect((await run(u, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from boards where id = ${boardId}`)))[0]!.n).toBe(1);
    } finally {
      await db.execute(sql`delete from auth.users where id = ${u}`);
    }
  });

  it('D-1092: final() sends the statement with its COMMIT; a later statement is refused; a failing final statement rolls back', async () => {
    const { db } = await import('@remoa/db');
    const [b] = await db.execute<{ id: string }>(sql`insert into auth.users (id, email, instance_id, aud, role) values (gen_random_uuid(), gen_random_uuid() || '@t.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated') returning id`);
    const u = b!.id;
    try {
      await expect(run(u, async (tx) => {
        await final(tx.execute(sql`insert into boards (user_id, title) values (${u}, 'final-1')`));
        await tx.execute(sql`select 1`);
      })).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/after final/) }) }); // drizzle wraps it
      await expect(run(u, async (tx) => {
        await tx.execute(sql`insert into boards (user_id, title) values (${u}, 'final-2')`);
        await final(tx.execute(sql`insert into boards (user_id, title) values (${u}, null)`)); // not null violation
      })).rejects.toBeTruthy();
      const titles = (await db.execute<{ title: string }>(sql`select title from boards where user_id = ${u} order by title`)).map((r) => r.title);
      expect(titles).toEqual(['final-1']); // committed with its COMMIT; final-2 rolled back with the failed statement
    } finally {
      await db.execute(sql`delete from auth.users where id = ${u}`);
    }
  });

  it('D-1104 (P-532): asServer runs one statement as the login role and switches back to authenticated in the same transaction', async () => {
    const roles = await run(USER, async (tx) => {
      const [inner] = await asServer<{ r: string }>(tx, sql`select current_user as r`);
      const [after] = await tx.execute<{ r: string }>(sql`select current_user as r`);
      return [inner!.r, after!.r];
    });
    expect(roles).toEqual(['postgres', 'authenticated']);
  });

  it('D-1104 (P-532): 20 concurrent answers reserving AI quota inside run() (pool of 10) finish; a rollback gives the unit back', async () => {
    const { db } = await import('@remoa/db');
    const { reserveAi } = await import('./billing/quota');
    const [b] = await db.execute<{ id: string }>(sql`insert into auth.users (id, email, instance_id, aud, role) values (gen_random_uuid(), gen_random_uuid() || '@t.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated') returning id`);
    const u = b!.id;
    const used = async () => (await db.execute<{ n: number }>(sql`select coalesce(sum(ai_grades), 0)::int as n from usage_counters where user_id = ${u}`))[0]!.n;
    try {
      const t0 = performance.now();
      // each holds its pooled connection while reserving: on a second connection (before D-1104) 10 of them wait for an 11th until the
      // idle-in-transaction timeout (10 s)
      const r = await Promise.all(Array.from({ length: 20 }, () => run(u, async (tx) => {
        await tx.execute(sql`select pg_sleep(0.05)`); // all 10 connections busy at once
        return (await reserveAi(u, 'ai_grades', undefined, tx)).ok;
      })));
      expect(performance.now() - t0).toBeLessThan(5_000);
      const taken = r.filter(Boolean).length;
      expect(taken).toBeGreaterThan(0);
      expect(await used()).toBe(taken);
      await expect(run(u, async (tx) => {
        const held = await reserveAi(u, 'ai_grades', undefined, tx);
        if (held.ok) await held.refund(tx); // refund in the same tx: with the reservation, both undone below
        await reserveAi(u, 'ai_grades', undefined, tx);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(await used()).toBe(taken);
    } finally {
      await db.execute(sql`delete from auth.users where id = ${u}`);
    }
  });

  it('D-1105 (P-533): a list is one array parameter whatever its length (quoted elements)', async () => {
    const { db } = await import('@remoa/db');
    const texts = ['a"b', 'c,d', 'e\\f', '{g}'];
    const [r] = await db.execute<{ n: number; t: string[] }>(sql`select cardinality(${pgArray(texts, 'text')}) as n, ${pgArray(texts, 'text')} as t`);
    expect(r).toEqual({ n: 4, t: texts });
    const text = (ids: string[]) => new PgDialect().sqlToQuery(sql`select 1 where ${USER}::uuid = any(${uuids(ids)})`).sql;
    expect(text([USER])).toBe(text([USER, USER, USER])); // one prepared statement for every length
  });

  it('WRITES tells writes from reads by the statement text', () => {
    for (const q of ['insert into x values (1)', 'with a as (update t set v = 1 returning 1) select 1', 'select * from t for update', 'delete from t']) expect(WRITES.test(q), q).toBe(true);
    for (const q of ['select updated_at, deleted_at from t', 'select 1']) expect(WRITES.test(q), q).toBe(false);
  });
});
