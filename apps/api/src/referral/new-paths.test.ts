// F18 D-485: qualification also runs after F05 generation and F10 copySeed. Needs local Supabase; skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateReferralCode } from '@remoa/contracts';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('F18 qualification on generation and copySeed', () => {
  let dbm: typeof import('@remoa/db');
  const users: string[] = [];
  const exec = <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) => dbm.db.execute<T>(q) as unknown as Promise<T[]>;

  /** referred, confirmed-email referee (status signed_up) + its referrer. */
  async function pair() {
    const [referrer, referee] = [uuid(), uuid()];
    users.push(referrer, referee);
    for (const id of [referrer, referee]) {
      await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role, email_confirmed_at)
        values (${id}, ${`${id}@test.local`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now())`);
    }
    await dbm.db.execute(sql`insert into referral_codes (user_id, code) values (${referrer}, ${generateReferralCode()})`);
    await dbm.db.execute(sql`update profiles set referred_by = ${referrer} where user_id = ${referee}`);
    await dbm.db.execute(sql`insert into referrals (referrer_id, referee_id, status, channel, signed_up_at) values (${referrer}, ${referee}, 'signed_up', 'link', now())`);
    return { referrer, referee };
  }
  const grantCount = async (referee: string) =>
    (await exec<{ n: number }>(sql`select count(*)::int n from entitlement_grants g join referrals r on r.id = g.referral_id where r.referee_id = ${referee}`))[0]!.n;

  beforeAll(async () => {
    dbm = await import('@remoa/db');
  });
  afterAll(async () => {
    if (!dbm || !users.length) return;
    await dbm.db.execute(sql`delete from boards where user_id in (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
    await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
  });

  it('copySeed with >= 3 cards qualifies the referral (two grants)', async () => {
    const { referee } = await pair();
    const author = uuid();
    users.push(author);
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role) values (${author}, ${`${author}@test.local`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    const [seed] = await exec<{ id: string }>(sql`insert into boards (user_id, title, status) values (${author}, 'Seed', 'seed_approved') returning id`);
    for (let i = 0; i < 3; i++) await dbm.db.execute(sql`insert into cards (board_id, type, title, "order", status) values (${seed!.id}, 'concept', ${'c' + i}, ${i}, 'approved')`);
    const { copySeed } = await import('../editorial/editorial');
    expect((await copySeed(referee, seed!.id)).ok).toBe(true);
    expect(await grantCount(referee)).toBe(2);
  });

  it('F05 generation (inline job, draft cards) with >= 3 cards qualifies the referral', async () => {
    const { referee } = await pair();
    const keys = ['OPENROUTER_API_KEY', 'INNGEST_EVENT_KEY', 'INNGEST_DEV'] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    try {
      const { startGeneration, generationOf } = await import('../ai/service');
      const text = [
        'Sepse.', 'Disfuncao organica por infeccao que exige reconhecimento clinico.', '',
        'Fluxo: Conduta de sepse', '1. Reconhecer a disfuncao organica', '2. Reavaliar o pacote inicial', '',
        'Caso: Caso de sepse', 'Apresentacao: febre e hipotensao', 'Conduta: reconhecer e reavaliar',
      ].join('\n');
      const started = await startGeneration(referee, { kind: 'text', title: 'Sepse', area: 'CM', text } as Parameters<typeof startGeneration>[1]);
      expect(started.ok).toBe(true);
      if (!started.ok || !('data' in started)) return;
      let job = generationOf(referee, started.data.jobId);
      for (let i = 0; i < 200 && job?.status !== 'done' && job?.status !== 'failed'; i++) {
        await new Promise((r) => setTimeout(r, 25));
        job = generationOf(referee, started.data.jobId);
      }
      expect(job).toMatchObject({ status: 'done' });
      const [n] = await exec<{ n: number }>(sql`select count(*)::int n from cards where board_id = ${job!.boardId}`);
      expect(n!.n).toBeGreaterThanOrEqual(3);
      expect(await grantCount(referee)).toBe(2);
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});
