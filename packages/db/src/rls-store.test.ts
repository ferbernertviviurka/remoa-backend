// G16 RLS (CCR-030, D-651): a user reads only the own store_waitlist row and cannot write it from the client.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)('G16 store_waitlist RLS', () => {
  const db = sql!;
  const [alice, bob] = [randomUUID(), randomUUID()];
  const as = <T>(uid: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    db.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
      await tx`set local role authenticated`;
      const out = await fn(tx);
      throw Object.assign(new Error('rollback'), { out });
    }).catch((e: { out?: T }) => { if ('out' in e) return e.out as T; throw e; });

  beforeAll(async () => {
    for (const id of [alice, bob]) await db`insert into auth.users (id, email) values (${id}, ${`${id}@test.remoa`})`;
    await db`insert into store_waitlist (user_id, email, wants_buy) values (${alice}, 'a@test.remoa', true), (${bob}, 'b@test.remoa', true)`;
  });
  afterAll(async () => {
    await db`delete from auth.users where id in (${alice}, ${bob})`;
    await db.end();
  });

  it('owner sees only the own row', async () => {
    expect((await as(alice, (tx) => tx`select user_id from store_waitlist`)).map((r) => r.user_id)).toEqual([alice]);
  });
  it('client cannot insert, update or delete', async () => {
    await expect(as(alice, (tx) => tx`update store_waitlist set wants_sell = true, seller_role = 'teacher' where user_id = ${alice}`)).rejects.toThrow();
    await expect(as(alice, (tx) => tx`delete from store_waitlist where user_id = ${alice}`)).rejects.toThrow();
  });
  it('account deletion cascades', async () => {
    const c = randomUUID();
    await db`insert into auth.users (id, email) values (${c}, ${`${c}@test.remoa`})`;
    await db`insert into store_waitlist (user_id, email, wants_buy) values (${c}, 'c@test.remoa', true)`;
    await db`delete from auth.users where id = ${c}`;
    expect(await db`select 1 from store_waitlist where user_id = ${c}`).toHaveLength(0);
  });
});
