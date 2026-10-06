// G21 FR-27 (0032, D-1022): coverage for policies rewritten with (select auth.uid()) / semi-joins that rls.test.ts does not exercise:
// masks, board_matrix_items, board_versions, review_queue, imports, and cards/edges writes on another user's seed.
// Needs local Supabase; skipped without DATABASE_URL. Everything runs in one rolled-back transaction.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)('G21 RLS rewrite keeps semantics', () => {
  const db = sql!;
  afterAll(() => db.end());

  it('owner, other student and reviewer see and write exactly what they did before', async () => {
    const out = await db.begin(async (tx) => {
      const [a, b, r] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [a, b, r]) await tx`insert into auth.users (id, email) values (${id}, ${`${id}@test.remoa`})`;
      await tx`update profiles set role = 'reviewer' where user_id = ${r}`;
      const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;
      const mi = await one(tx`insert into matrix_items (area, code, title) values ('CM', ${`G21.${a}`}, 't') returning id`);
      const priv = await one(tx`insert into boards (user_id, title) values (${a}, 'p') returning id`);
      const seed = await one(tx`insert into boards (user_id, title, status) values (${a}, 's', 'seed_approved') returning id`);
      const rBoard = await one(tx`insert into boards (user_id, title) values (${r}, 'r') returning id`);
      const cp = await one(tx`insert into cards (board_id, title) values (${priv}, 'cp') returning id`);
      const cp2 = await one(tx`insert into cards (board_id, title) values (${priv}, 'cp2') returning id`);
      const cs = await one(tx`insert into cards (board_id, title) values (${seed}, 'cs') returning id`);
      const asset = await one(tx`insert into assets (user_id, key, mime) values (${a}, 'k', 'image/webp') returning id`);
      const mp = await one(tx`insert into masks (card_id, asset_id, polygon) values (${cp}, ${asset}, '[]') returning id`);
      const ms = await one(tx`insert into masks (card_id, asset_id, polygon) values (${cs}, ${asset}, '[]') returning id`);
      await tx`insert into board_matrix_items (board_id, matrix_item_id) values (${priv}, ${mi}), (${seed}, ${mi})`;
      await tx`insert into board_versions (board_id, version, snapshot) values (${priv}, 1, '{}'), (${seed}, 1, '{}')`;
      const ep = await one(tx`insert into edges (board_id, from_card_id, to_card_id) values (${priv}, ${cp}, ${cp2}) returning id`);
      await tx`insert into review_queue (card_id) values (${cs})`;
      await tx`insert into imports (user_id, kind) values (${a}, 'anki')`;

      type Q = postgres.TransactionSql;
      /** Runs fn as `uid` (authenticated) in a savepoint; a rejected write rolls back only the savepoint. */
      const as = <T>(uid: string, fn: (q: Q) => Promise<T>) => tx.savepoint(async (sp) => {
        await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
        await sp`set local role authenticated`;
        const res = await fn(sp);
        await sp`reset role`;
        return res;
      });
      const denied = (uid: string, fn: (q: Q) => Promise<unknown>) => as(uid, fn).then(() => false, () => true);
      const ids = (rows: { id: string }[]) => rows.map((x) => x.id).sort();
      const n = (rows: { count: number }[]) => rows[0]!.count;

      const res = {
        bMasks: ids(await as(b, (q) => q`select id from masks where id in (${mp}, ${ms})`)),
        aMasks: ids(await as(a, (q) => q`select id from masks where id in (${mp}, ${ms})`)),
        bCards: ids(await as(b, (q) => q`select id from cards where board_id in (${priv}, ${seed})`)),
        bEdges: n(await as(b, (q) => q`select count(*)::int from edges where id = ${ep}`)),
        aEdges: n(await as(a, (q) => q`select count(*)::int from edges where id = ${ep}`)),
        bBmi: ids(await as(b, (q) => q`select board_id as id from board_matrix_items where matrix_item_id = ${mi}`)),
        bVersions: ids(await as(b, (q) => q`select board_id as id from board_versions where board_id in (${priv}, ${seed})`)),
        bCardOnSeed: await denied(b, (q) => q`insert into cards (board_id, title) values (${seed}, 'x')`),
        bUpdCard: n(await as(b, (q) => q`with u as (update cards set title = 'x' where id = ${cs} returning 1) select count(*)::int from u`)),
        bDelEdge: n(await as(b, (q) => q`with d as (delete from edges where id = ${ep} returning 1) select count(*)::int from d`)),
        bMask: await denied(b, (q) => q`insert into masks (card_id, asset_id, polygon) values (${cs}, ${asset}, '[]')`),
        bBmiWrite: await denied(b, (q) => q`insert into board_matrix_items (board_id, matrix_item_id) values (${seed}, ${mi})`),
        aCard: await denied(a, (q) => q`insert into cards (board_id, title) values (${priv}, 'ok')`),
        aUpdMask: n(await as(a, (q) => q`with u as (update masks set label = 'l' where id = ${mp} returning 1) select count(*)::int from u`)),
        aEdge: await denied(a, (q) => q`insert into edges (board_id, from_card_id, to_card_id) values (${priv}, ${cp2}, ${cp})`),
        aEdgeCross: await denied(a, (q) => q`insert into edges (board_id, from_card_id, to_card_id) values (${priv}, ${cp}, ${cs})`),
        aVersion: await denied(a, (q) => q`insert into board_versions (board_id, version, snapshot) values (${priv}, 2, '{}')`),
        rVersionOwn: await denied(r, (q) => q`insert into board_versions (board_id, version, snapshot) values (${rBoard}, 1, '{}')`),
        rVersionOther: await denied(r, (q) => q`insert into board_versions (board_id, version, snapshot) values (${priv}, 2, '{}')`),
        aQueue: n(await as(a, (q) => q`select count(*)::int from review_queue where card_id = ${cs}`)),
        rQueue: n(await as(r, (q) => q`select count(*)::int from review_queue where card_id = ${cs}`)),
        aImports: n(await as(a, (q) => q`select count(*)::int from imports where user_id = ${a}`)),
        bImports: n(await as(b, (q) => q`select count(*)::int from imports where user_id = ${a}`)),
        bImportForA: await denied(b, (q) => q`insert into imports (user_id, kind) values (${a}, 'anki')`),
      };
      throw Object.assign(new Error('rollback'), { out: { ...res, mp, ms, cs, seed } });
    }).catch((e: { out?: Record<string, unknown> }) => { if (e.out) return e.out; throw e; });

    expect(out).toMatchObject({
      bMasks: [out.ms], aMasks: [out.mp, out.ms].sort(), bCards: [out.cs], bEdges: 0, aEdges: 1, bBmi: [out.seed], bVersions: [out.seed],
      bCardOnSeed: true, bUpdCard: 0, bDelEdge: 0, bMask: true, bBmiWrite: true,
      aCard: false, aUpdMask: 1, aEdge: false, aEdgeCross: true, aVersion: true, rVersionOwn: false, rVersionOther: true,
      aQueue: 0, rQueue: 1, aImports: 1, bImports: 0, bImportForA: true,
    });
  });
});
