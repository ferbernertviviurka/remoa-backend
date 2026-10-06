import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// ponytail: module-level singleton; in dev HMR may leak connections, add a globalThis cache if it bites.
// G21 D-1090 (CCR-059, revises D-977): prepared statements. Unprepared, postgres.js sends every parameterized query as Parse+Describe,
// waits for the parameter types, then Bind+Execute: 2 round trips per query and no pipelining. With the API ~124 ms from the database
// (D-1084) that was half of every request. Named statements are cached per connection (only the first use pays the Describe); the
// Session pooler (5432, D-977/P-291) keeps them. Never the transaction pooler (6543), which drops them.
const sql = postgres(url, { max: Number(process.env.G21_POOL ?? 10), prepare: true });
export const db = drizzle(prepared(sql), { schema });

/**
 * Drizzle runs everything through `client.unsafe(text, params)`, which postgres.js never prepares by default; this turns it on for
 * queries with parameters (without, postgres.js uses the simple protocol: one round trip already), here and inside transactions.
 * ponytail: statements are cached per connection without a cap. Lists go as one array parameter (D-1105, `uuids()` in the API),
 * so texts no longer vary with list lengths, except multi-row inserts (`values(rows)`: one text per row count, rare write paths).
 * Cap it if a backend's memory says so.
 */
export function prepared<T extends object>(c: T): T {
  return new Proxy(c, {
    get(t, p) {
      const v = Reflect.get(t, p) as unknown;
      if (typeof v !== 'function') return v;
      const f = v as (...a: unknown[]) => unknown;
      if (p === 'unsafe') return (q: string, args: unknown[] = [], o: object = {}) => f.call(t, q, args, args.length ? { prepare: true, ...o } : o);
      if (p === 'begin' || p === 'savepoint') return (...a: unknown[]) => {
        const fn = a.pop() as (x: object) => unknown;
        return f.call(t, ...a, (x: object) => fn(prepared(x)));
      };
      return v;
    },
  });
}
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Run fn as `authenticated` user `userId`, so RLS applies. The connection itself is a superuser: never query outside this for user data. */
export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
    await tx.execute(dsql`select set_config('request.jwt.claims', ${claims}, true), set_config('role', 'authenticated', true)`);
    return fn(tx);
  });
}

export { sql, schema };
