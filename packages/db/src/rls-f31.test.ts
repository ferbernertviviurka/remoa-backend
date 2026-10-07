// F31 (0040, CCR-080): card_prereqs RLS, seed_draft trail hidden from students, badges only on seeds, slug unique among seeds.
// Needs local Supabase; skipped without DATABASE_URL. Everything runs in one rolled-back transaction (same harness as rls-g21).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)('F31 trail RLS', () => {
  const db = sql!;
  afterAll(() => db.end());

  it('prereqs follow card visibility and board ownership', async () => {
    const out = await db.begin(async (tx) => {
      const [a, b, r] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [a, b, r]) await tx`insert into auth.users (id, email) values (${id}, ${`${id}@test.remoa`})`;
      await tx`update profiles set role = 'reviewer' where user_id = ${r}`;
      const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;
      const path = { slug: `t-${a}`, modulos: ['M1'], area: 'Clínica Médica', dominios: [], competencias: [], revisarAte: '2027-01-01', versao: '1' };
      const draft = await one(tx`insert into boards (user_id, title, status, path, badges) values (${r}, 'd', 'seed_draft', ${tx.json(path)}, '{top10_enamed}') returning id`);
      const priv = await one(tx`insert into boards (user_id, title) values (${a}, 'p') returning id`);
      const other = await one(tx`insert into boards (user_id, title) values (${a}, 'o') returning id`);
      const [d1, d2] = [await one(tx`insert into cards (board_id, title, path_order) values (${draft}, 'd1', 1) returning id`), await one(tx`insert into cards (board_id, title, path_order) values (${draft}, 'd2', 2) returning id`)];
      await tx`insert into card_prereqs (card_id, prereq_card_id) values (${d2}, ${d1})`;
      const [p1, p2] = [await one(tx`insert into cards (board_id, title) values (${priv}, 'p1') returning id`), await one(tx`insert into cards (board_id, title) values (${priv}, 'p2') returning id`)];
      const o1 = await one(tx`insert into cards (board_id, title) values (${other}, 'o1') returning id`);

      type Q = postgres.TransactionSql;
      const as = <T>(uid: string, fn: (q: Q) => Promise<T>) => tx.savepoint(async (sp) => {
        await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
        await sp`set local role authenticated`;
        const res = await fn(sp);
        await sp`reset role`;
        return res;
      });
      const denied = (uid: string, fn: (q: Q) => Promise<unknown>) => as(uid, fn).then(() => false, () => true);
      const n = (rows: { count: number }[]) => rows[0]!.count;
      const asSuper = (fn: (q: Q) => Promise<unknown>) => tx.savepoint(fn).then(() => false, () => true);

      const res = {
        bDraftBoard: n(await as(b, (q) => q`select count(*)::int from boards where id = ${draft}`)),
        bDraftPrereq: n(await as(b, (q) => q`select count(*)::int from card_prereqs where card_id = ${d2}`)),
        rDraftPrereq: n(await as(r, (q) => q`select count(*)::int from card_prereqs where card_id = ${d2}`)),
        aOwn: await denied(a, (q) => q`insert into card_prereqs (card_id, prereq_card_id) values (${p2}, ${p1})`),
        aOwnRead: n(await as(a, (q) => q`select count(*)::int from card_prereqs where card_id = ${p2}`)),
        aCrossBoard: await denied(a, (q) => q`insert into card_prereqs (card_id, prereq_card_id) values (${p1}, ${o1})`),
        bOnA: await denied(b, (q) => q`insert into card_prereqs (card_id, prereq_card_id) values (${p1}, ${p2})`),
        bDelA: n(await as(b, (q) => q`with d as (delete from card_prereqs where card_id = ${p2} returning 1) select count(*)::int from d`)),
        self: await asSuper((q) => q`insert into card_prereqs (card_id, prereq_card_id) values (${p1}, ${p1})`),
        badgeOnPrivate: await asSuper((q) => q`update boards set badges = '{top10_enamed}' where id = ${priv}`),
        unknownBadge: await asSuper((q) => q`update boards set badges = '{x}' where id = ${draft}`),
        aSetPath: await denied(a, (q) => q`update boards set path = '{}' where id = ${priv}`),
        dupSlugSeed: await asSuper((q) => q`insert into boards (user_id, title, status, path) values (${r}, 'd2', 'seed_draft', ${q.json(path)})`),
        dupSlugCopy: await asSuper((q) => q`insert into boards (user_id, title, path) values (${a}, 'copy', ${q.json(path)})`),
        cascade: await tx`delete from cards where id = ${d1}`.then(async () => n(await tx`select count(*)::int from card_prereqs where card_id = ${d2}`)),
      };
      throw Object.assign(new Error('rollback'), { out: res });
    }).catch((e: { out?: Record<string, unknown> }) => { if (e.out) return e.out; throw e; });

    expect(out).toEqual({
      bDraftBoard: 0, bDraftPrereq: 0, rDraftPrereq: 1, aOwn: false, aOwnRead: 1, aCrossBoard: true, bOnA: true, bDelA: 0,
      self: true, badgeOnPrivate: true, unknownBadge: true, aSetPath: true, dupSlugSeed: true, dupSlugCopy: false, cascade: 0,
    });
  });
});
