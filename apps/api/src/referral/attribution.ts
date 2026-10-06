// F18 FR-14/FR-16 (D-383): first touch wins. A refusal is `{ attributed: false }`, never an error: sign-up must not fail here.
import { sql } from 'drizzle-orm';
import { REFERRAL_LIMITS, type AttributionResult, type attributionSkips } from '@remoa/contracts';
import type { Logger } from '@remoa/log';
import { dbm } from '../db';
import { emailHash } from './email-normalize';
import { flagWeakSignals } from './fraud';
import { invalidate } from '../cache';

type Skip = (typeof attributionSkips)[number];

/** `code` is already normalized by `attributionInputSchema`. */
export async function attributeReferral(userId: string, code: string, ctx: { log: Logger; ip: string; ua: string; now?: Date }): Promise<AttributionResult> {
  const now = ctx.now ?? new Date();
  const { db } = await dbm();
  let referrerId: string | null = null;
  const skip = await db
    .transaction(async (tx): Promise<Skip | null> => {
      const [c] = await tx.execute<{ user_id: string }>(sql`select c.user_id from referral_codes c join profiles p on p.user_id = c.user_id where c.code = ${code} and p.deleted_at is null`);
      if (!c) return 'unknown_code';
      if (c.user_id === userId) return 'self_referral';
      // both profiles locked in id order: a simultaneous mutual attempt (A takes B's code while B takes A's) serializes, no deadlock
      await tx.execute(sql`select 1 from profiles where user_id in (${userId}, ${c.user_id}) order by user_id for update`);
      // D-399: a referrer up the chain already referred by this user = cycle (mutual farming; would also deadlock the grant locks)
      const [cyc] = await tx.execute<{ hit: boolean }>(sql`
        with recursive up(id, depth) as (
          select referred_by, 1 from profiles where user_id = ${c.user_id}
          union all select p.referred_by, up.depth + 1 from profiles p join up on p.user_id = up.id where up.depth < 50)
        select exists (select 1 from up where id = ${userId}) as hit`);
      if (cyc?.hit) return 'self_referral';
      // locks the profile: two concurrent attributions for the same user serialize here
      const [u] = await tx.execute<{ referred_by: string | null; created_at: string; email: string | null; has_board: boolean; has_referral: boolean }>(sql`
        select p.referred_by, u.created_at, u.email,
          exists (select 1 from boards where user_id = ${userId}) as has_board,
          exists (select 1 from referrals where referee_id = ${userId}) as has_referral
        from profiles p join auth.users u on u.id = p.user_id where p.user_id = ${userId} for update of p`);
      if (!u) return 'not_new_account';
      if (u.referred_by || u.has_referral) return 'already_attributed';
      if (now.getTime() - new Date(u.created_at).getTime() >= REFERRAL_LIMITS.newAccountHours * 3_600_000 || u.has_board) return 'not_new_account';

      // an e-mail invite from this same referrer is promoted; otherwise a link row is created
      const promoted = u.email
        ? await tx.execute(sql`
            update referrals set referee_id = ${userId}, status = 'signed_up', signed_up_at = ${now.toISOString()}
            where id = (select id from referrals where referrer_id = ${c.user_id} and invited_email_hash = ${emailHash(u.email)} and status = 'invited' limit 1)
            returning id`)
        : [];
      if (!promoted.length)
        await tx.execute(sql`insert into referrals (referrer_id, referee_id, channel, status, signed_up_at) values (${c.user_id}, ${userId}, 'link', 'signed_up', ${now.toISOString()})`);
      await tx.execute(sql`update profiles set referred_by = ${c.user_id} where user_id = ${userId}`);
      referrerId = c.user_id;
      return null;
    })
    .catch((e: unknown) => {
      // unique referee_id lost a race to another referrer: the first touch already won
      const pg = e as { code?: string; cause?: { code?: string } };
      if (pg.code === '23505' || pg.cause?.code === '23505') return 'already_attributed' as const;
      throw e;
    });

  if (skip) {
    if (skip === 'self_referral') ctx.log.warn('referral_rejected', { event: 'referral_rejected', reason: 'self_referral' });
    else ctx.log.info('referral attribution skipped', { reason: skip });
    return { attributed: false };
  }
  for (const id of [referrerId!, userId]) await invalidate('referral.changed', { userId: id });
  flagWeakSignals(referrerId!, ctx.ip, ctx.ua, ctx.log);
  ctx.log.info('referral attributed');
  return { attributed: true };
}

/** `GET /v1/public/referral/:code`: inviter's first name for `/i/[code]`. Unknown = invalid (no enumeration hints). */
export async function lookupReferralCode(code: string) {
  const { db } = await dbm();
  const [r] = await db.execute<{ name: string | null }>(sql`
    select p.name from referral_codes c join profiles p on p.user_id = c.user_id where c.code = ${code} and p.deleted_at is null`);
  if (!r) return { valid: false as const };
  return { valid: true as const, code, inviterFirstName: r.name?.trim().split(/\s+/)[0]?.slice(0, 40) || null };
}
