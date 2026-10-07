// F30 (0041, CCR-090): challenge_attempts append-only, reference columns hidden from `authenticated`, owner-only rows, public taxonomy.
// Needs local Supabase; skipped without DATABASE_URL. Everything runs in one rolled-back transaction (same harness as rls-f31).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)('F30 challenge AI RLS', () => {
  const db = sql!;
  afterAll(() => db.end());

  it('append-only attempts, server-only reference, owner rows, public taxonomy', async () => {
    const out = await db.begin(async (tx) => {
      const [u, v] = [randomUUID(), randomUUID()];
      for (const id of [u, v]) await tx`insert into auth.users (id, email) values (${id}, ${`${id}@test.remoa`})`;
      const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;
      const s = await one(tx`insert into challenge_sessions (user_id, scope, format, params, expires_at)
        values (${u}, '{"kind":"board"}', 'map', '{}', now() + interval '2 hours') returning id`);
      const i = await one(tx`insert into challenge_items (session_id, user_id, position, kind, type, payload_public, reference_ref)
        values (${s}, ${u}, 0, 'card', 'discursive', '{"stem":"x"}', '{"kind":"card"}') returning id`);
      const a = await one(tx`insert into challenge_attempts (item_id, user_id, attempt_no, answer, answer_hash, verdict, graded_by)
        values (${i}, ${u}, 1, '{"kind":"dont_know"}', 'h', 'incorrect', 'prefilter') returning id`);
      await tx`insert into enamed_taxonomy (code, kind, area, name) values (${`T-${u}`}, 'area', 'CM', 'CM')`;

      type Q = postgres.TransactionSql;
      const fails = (fn: (q: Q) => Promise<unknown>) => tx.savepoint(fn).then(() => false, () => true);
      const as = <T>(uid: string | null, fn: (q: Q) => Promise<T>) => tx.savepoint(async (sp) => {
        if (uid) await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
        await sp.unsafe(uid ? 'set local role authenticated' : 'set local role anon');
        const res = await fn(sp);
        await sp`reset role`;
        return res;
      });
      const denied = (uid: string | null, fn: (q: Q) => Promise<unknown>) => as(uid, fn).then(() => false, () => true);
      const n = (rows: { count: number }[]) => rows[0]!.count;

      const res = {
        updateVerdict: await fails((q) => q`update challenge_attempts set verdict = 'correct' where id = ${a}`),
        disputeWithOther: await fails((q) => q`update challenge_attempts set disputed = true, feedback = 'x' where id = ${a}`),
        dispute: !(await fails((q) => q`update challenge_attempts set disputed = true where id = ${a}`)),
        directDelete: await fails((q) => q`delete from challenge_attempts where id = ${a}`),
        crossUserItem: await fails((q) => q`insert into challenge_items (session_id, user_id, position, kind, type, payload_public, reference_ref)
          values (${s}, ${v}, 1, 'card', 'discursive', '{}', '{}')`),
        ownerItems: await as(u, async (q) => n(await q`select count(*)::int from challenge_items`)),
        ownerPublic: !(await denied(u, (q) => q`select id, payload_public from challenge_items`)),
        referenceRef: await denied(u, (q) => q`select reference_ref from challenge_items`),
        shuffleMap: await denied(u, (q) => q`select shuffle_map from challenge_items`),
        correctKey: await denied(u, (q) => q`select correct_key from question_bank`),
        expectedAnswer: await denied(u, (q) => q`select expected_answer from question_bank`),
        missingPoints: await denied(u, (q) => q`select missing from challenge_attempts`),
        coveredPoints: await denied(u, (q) => q`select covered from challenge_attempts`),
        hintColumn: await denied(u, (q) => q`select hint from challenge_attempts`),
        rubrics: await denied(u, (q) => q`select 1 from card_rubrics`),
        clientInsert: await denied(u, (q) => q`insert into challenge_attempts (item_id, user_id, attempt_no, answer, answer_hash, verdict, graded_by)
          values (${i}, ${u}, 2, '{}', 'h', 'correct', 'ai')`),
        otherSessions: await as(v, async (q) => n(await q`select count(*)::int from challenge_sessions`)),
        anonTaxonomy: await as(null, async (q) => n(await q`select count(*)::int from enamed_taxonomy where code = ${`T-${u}`}`)),
        anonSessions: await denied(null, (q) => q`select 1 from challenge_sessions`),
        cascade: await tx.savepoint(async (q) => {
          await q`delete from auth.users where id = ${u}`;
          return n(await q`select count(*)::int from challenge_attempts where id = ${a}`);
        }),
      };
      throw Object.assign(new Error('rollback'), { out: res });
    }).catch((e: { out?: Record<string, unknown> }) => { if (e.out) return e.out; throw e; });
    expect(out).toEqual({
      updateVerdict: true, disputeWithOther: true, dispute: true, directDelete: true, crossUserItem: true,
      ownerItems: 1, ownerPublic: true, referenceRef: true, shuffleMap: true, correctKey: true, expectedAnswer: true,
      missingPoints: true, coveredPoints: true, hintColumn: true, rubrics: true, clientInsert: true,
      otherSessions: 0, anonTaxonomy: 1, anonSessions: true, cascade: 0,
    });
  });
});
