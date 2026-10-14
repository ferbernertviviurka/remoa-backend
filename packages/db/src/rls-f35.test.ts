// G28-P / F35 (0057, CCR-160): down -> up with backfill, RLS A/B on study_profiles, audit trigger, reference seed, search plan.
// Needs an isolated TEST_DATABASE_URL with 0057 applied; skipped otherwise. Everything runs in one rolled-back transaction.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeSearch } from '@remoa/contracts';
import { readReference, seedReference } from './seed/reference';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
const file = readFileSync(new URL('../migrations/0057_f35_study_profile.sql', import.meta.url), 'utf8');
const down = file.slice(file.indexOf('-- DOWN-BEGIN'), file.indexOf('-- DOWN-END')).split('\n').slice(1).map((l) => l.replace(/^-- /, '')).join('\n');
const up = file.split('--> statement-breakpoint');

describe('0057 SQL (static)', () => {
  it('no auth.users, owner policies, server-only audit and suggestions', () => {
    expect(file).not.toMatch(/CREATE TABLE "auth"/);
    expect(file).toMatch(/CREATE POLICY study_profiles_update ON public\.study_profiles FOR UPDATE TO authenticated USING \(user_id = \(select auth\.uid\(\)\)\) WITH CHECK/);
    expect(file).toMatch(/REVOKE ALL ON public\.study_profile_audit, public\.reference_suggestions FROM PUBLIC, anon, authenticated;/);
    expect(down).toMatch(/DROP TABLE IF EXISTS public\.study_profile_audit/);
  });
});

describe.skipIf(!sql)('F35 study profile (SQL real)', () => {
  const db = sql!;
  afterAll(() => db.end());

  it('down/up, backfill, RLS A/B, audit, seed and search', async () => {
    const out = await db.begin(async (tx) => {
      type Q = postgres.TransactionSql;
      // 1. reversible: down removes everything, up recreates it and backfills existing profiles.
      await tx.unsafe(down);
      const [gone] = await tx<{ n: number }[]>`select count(*)::int as n from pg_tables where schemaname = 'public'
        and tablename in ('study_profiles', 'health_courses', 'institutions', 'councils', 'study_goals', 'reference_suggestions', 'study_profile_audit')`;
      const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      for (const id of [a, b, c, d]) await tx`insert into auth.users (id, email) values (${id}, ${`${id}@test.remoa`})`;
      await tx`insert into profiles (user_id, goal, goals, stage) values (${a}, 'enamed_2027_1', '{enamed_2027_1,provas_faculdade}', 'y5_6'),
        (${b}, 'residencia_usp', '{residencia_usp}', 'graduated'), (${c}, 'enamed_2028_2', '{}', 'not_med')
        on conflict (user_id) do update set goal = excluded.goal, goals = excluded.goals, stage = excluded.stage`;
      await tx`delete from profiles where user_id = ${d}`; // d = account created after 0057 (no row until it saves)
      for (const s of up) await tx.unsafe(s);
      const backfill = await tx<{ user_id: string; source: string; course_code: string | null; situation: string | null; goals: string[] }[]>`
        select user_id, source, course_code, situation, goals from study_profiles where user_id in (${a}, ${b}, ${c}, ${d})`;
      const audit0 = await tx<{ n: number }[]>`select count(*)::int as n from study_profile_audit`;

      // 2. reference seed (real content files) twice: idempotent.
      const ref = readReference();
      const orm = drizzle(Object.assign(tx, { options: db.options }) as unknown as postgres.Sql); // drizzle reads options.parsers
      await seedReference(orm, ref);
      const counts = await seedReference(orm, ref);
      const [refRows] = await tx<{ c: number; i: number; g: number; k: number }[]>`select (select count(*)::int from health_courses) as c,
        (select count(*)::int from institutions) as i, (select count(*)::int from study_goals) as g, (select count(*)::int from councils) as k`;

      // 3. RLS A/B.
      const as = <T>(uid: string | null, fn: (q: Q) => Promise<T>) => tx.savepoint(async (sp) => {
        if (uid) await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
        await sp.unsafe(uid ? 'set local role authenticated' : 'set local role anon');
        const r = await fn(sp);
        await sp`reset role`;
        return r;
      });
      const denied = (uid: string | null, fn: (q: Q) => Promise<unknown>) => as(uid, fn).then(() => false, () => true);
      const [inst] = await tx<{ id: string }[]>`select id from institutions where search like '%ufpr%' limit 1`;
      // A confirms as nursing professional with a private council number; D (no row) inserts its own.
      const confirmA = await as(a, (q) => q`update study_profiles set source = 'profile', situation = 'profissional', course_code = 'nursing',
        goals = '{concursos_saude}', council_number = 'SP-123456', institution_id = ${inst?.id ?? null} where user_id = ${a} returning user_id`);
      const insertD = await as(d, (q) => q`insert into study_profiles (user_id, source, situation, course_code, goals, period)
        values (${d}, 'signup', 'graduacao', 'medicine', '{enamed}', 5) returning user_id`);
      const bSeesA = await as(b, (q) => q`select council_number from study_profiles where user_id = ${a}`);
      const bUpdatesA = await as(b, (q) => q`update study_profiles set council_number = 'X' where user_id = ${a} returning user_id`);
      const bInsertsForA = await denied(b, (q) => q`insert into study_profiles (user_id, source) values (${a}, 'signup')`);
      const anonReads = await denied(null, (q) => q`select 1 from study_profiles`);
      const backToMigration = await denied(a, (q) => q`update study_profiles set source = 'migration' where user_id = ${a}`);
      const incomplete = await denied(d, (q) => q`update study_profiles set goals = '{}' where user_id = ${d}`);
      const periodForPro = await denied(a, (q) => q`update study_profiles set period = 3 where user_id = ${a}`);
      const auditRead = await denied(a, (q) => q`select 1 from study_profile_audit`);
      const suggestRead = await denied(a, (q) => q`select 1 from reference_suggestions`);
      const refWrite = await denied(a, (q) => q`insert into councils (code, name) values ('CRM', 'x') on conflict do nothing`);
      const refRead = await as(a, (q) => q<{ n: number }[]>`select count(*)::int as n from health_courses`);
      const audit = await tx<{ user_id: string; actor_id: string | null; fields: string[] }[]>`select user_id, actor_id, fields from study_profile_audit order by at, user_id`;

      // 4. institution search plan over the real list (normalized prefix/contains).
      await tx`analyze institutions`;
      const plan = (q: string) => tx.unsafe(`explain (analyze, format json) select id, name, acronym, city, uf, type from institutions
        where search like '%' || $1 || '%' order by name limit 20`, [normalizeSearch(q)]);
      const timings: Record<string, number> = {};
      for (const q of ['ufpr', 'São Paulo', 'univ', 'faculdade de medicina']) {
        const [{ 'QUERY PLAN': p }] = (await plan(q)) as unknown as [{ 'QUERY PLAN': [{ 'Execution Time': number }] }];
        timings[q] = p[0]['Execution Time'];
      }
      throw Object.assign(new Error('rollback'), { out: {
        gone: gone!.n, backfill, audit0: audit0[0]!.n, counts, refRows, confirmA: confirmA.length, insertD: insertD.length, bSeesA: bSeesA.length,
        bUpdatesA: bUpdatesA.length, bInsertsForA, anonReads, backToMigration, incomplete, periodForPro, auditRead, suggestRead, refWrite,
        refRead: refRead[0]!.n, audit, timings, ids: { a, b, c, d } } });
    }).catch((e: { out?: unknown }) => { if (e.out) return e.out as never; throw e; });

    const o = out as {
      gone: number; backfill: { user_id: string; source: string; course_code: string | null; situation: string | null; goals: string[] }[];
      audit0: number; counts: { institutions: number }; refRows: { c: number; i: number; g: number; k: number }; confirmA: number; insertD: number;
      bSeesA: number; bUpdatesA: number; bInsertsForA: boolean; anonReads: boolean; backToMigration: boolean; incomplete: boolean;
      periodForPro: boolean; auditRead: boolean; suggestRead: boolean; refWrite: boolean; refRead: number;
      audit: { user_id: string; actor_id: string | null; fields: string[] }[]; timings: Record<string, number>; ids: Record<'a' | 'b' | 'c' | 'd', string>;
    };
    const { a, b, c, d } = o.ids;
    process.stdout.write(`F35 search timings (ms): ${JSON.stringify(o.timings)}; institutions ${o.refRows.i}\n`);
    expect(o.gone).toBe(0);
    const bf = Object.fromEntries(o.backfill.map((r) => [r.user_id, r]));
    expect(bf[a]).toMatchObject({ source: 'migration', course_code: null, situation: null, goals: ['enamed'] });
    expect(bf[b]).toMatchObject({ source: 'migration', course_code: null, goals: [] });
    expect(bf[c]).toMatchObject({ source: 'migration', course_code: null, goals: ['enamed'] });
    expect(bf[d]).toBeUndefined();
    expect(o.audit0).toBe(0);
    expect(o.refRows).toEqual({ c: 11, i: o.counts.institutions, g: 13, k: 14 });
    expect(o.confirmA).toBe(1);
    expect(o.insertD).toBe(1);
    expect([o.bSeesA, o.bUpdatesA]).toEqual([0, 0]);
    expect([o.bInsertsForA, o.anonReads, o.backToMigration, o.incomplete, o.periodForPro, o.auditRead, o.suggestRead, o.refWrite])
      .toEqual([true, true, true, true, true, true, true, true]);
    expect(o.refRead).toBe(11);
    expect(o.audit.find((r) => r.user_id === a)).toEqual({ user_id: a, actor_id: a,
      fields: ['council_number', 'course_code', 'goals', 'institution_id', 'situation', 'source'] });
    expect(o.audit.find((r) => r.user_id === d)).toEqual({ user_id: d, actor_id: d, fields: ['course_code', 'goals', 'period', 'situation', 'source'] });
    for (const t of Object.values(o.timings)) expect(t).toBeLessThan(150);
  });
});
