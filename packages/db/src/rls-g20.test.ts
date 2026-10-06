// G20 (CCR-050): server-owned name/school/school_id; handle_new_user name from name|full_name, legal acceptance kept (P-430).
// Needs local Supabase; skipped without DATABASE_URL. Every case runs in a rolled-back transaction.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)('G20 profiles', () => {
  const db = sql!;
  afterAll(() => db.end());

  type Row = { name: string | null; terms: string | null; privacy: string | null; at: Date | null; acc: number };
  /** Creates an auth user with `meta` (legal_versions set to t1/p1) and returns its profile; always rolls back. */
  const signUp = (meta: Record<string, string>) =>
    db.begin(async (tx) => {
      await tx`insert into legal_versions (document, version) values ('terms', 't1'), ('privacy', 'p1')
        on conflict (document) do update set version = excluded.version`;
      const id = randomUUID();
      await tx`insert into auth.users (id, email, raw_user_meta_data) values (${id}, ${`${id}@test.remoa`}, ${tx.json(meta)})`;
      const [r] = await tx<Row[]>`select name, terms_accepted_version as terms, privacy_accepted_version as privacy, accepted_at as at,
        (select count(*)::int from legal_acceptances where user_id = ${id}) as acc from profiles where user_id = ${id}`;
      throw Object.assign(new Error('rollback'), { out: r });
    }).catch((e: { out?: Row }) => { if ('out' in e) return e.out!; throw e; });

  it.each([
    [{ name: '  Ana   Souza ' }, 'Ana Souza'],
    [{ full_name: 'José Ângelo D’Ávila-Souza' }, 'José Ângelo D’Ávila-Souza'],
    [{ name: '', full_name: 'Zoë Lima' }, 'Zoë Lima'],
    [{ name: 'Ana Souza', full_name: 'Outro Nome' }, 'Ana Souza'],
    [{ full_name: 'X'.repeat(70) }, 'X'.repeat(60)],
    [{ full_name: 'R2-D2' }, null],
    [{ name: 'A' }, null],
    [{}, null],
  ])('name from %j → %s', async (meta, name) => {
    expect((await signUp(meta)).name).toBe(name);
  });

  it('legal acceptance only with the current versions (0030 behaviour kept)', async () => {
    expect(await signUp({ name: 'Ana Souza', terms_version: 't1', privacy_version: 'p1' })).toMatchObject({ terms: 't1', privacy: 'p1', acc: 2 });
    expect((await signUp({ name: 'Ana Souza', terms_version: 't1', privacy_version: 'old' })).at).toBeNull();
    expect(await signUp({ full_name: 'Ana Souza' })).toMatchObject({ terms: null, privacy: null, at: null, acc: 0 });
  });

  it('name, school and school_id are server-only; school_id exists', async () => {
    const [p] = await db`select has_column_privilege('authenticated', 'public.profiles', 'name', 'UPDATE') as name,
      has_column_privilege('authenticated', 'public.profiles', 'school', 'UPDATE') as school,
      has_column_privilege('authenticated', 'public.profiles', 'school_id', 'UPDATE') as school_id,
      has_column_privilege('authenticated', 'public.profiles', 'school_id', 'SELECT') as read_school_id`;
    expect(p).toEqual({ name: false, school: false, school_id: false, read_school_id: true });
  });
});
