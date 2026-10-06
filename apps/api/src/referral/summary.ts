import { sql } from 'drizzle-orm';
import { generateReferralCode, ok, referralLink, REFERRAL_LIMITS, type ReferralFriend, type ReferralSummary, type RewardGrant } from '@remoa/contracts';
import { env } from '@remoa/config';
import { dbm, run } from '../db';

const DAY_MS = 86_400_000;
const iso = (d: unknown) => new Date(d as string);

/** D-382: created on first access. `on conflict do nothing` covers both the user race and a code collision (then the row is missing: retry). */
export async function ensureCode(userId: string): Promise<string> {
  const { db } = await dbm();
  for (let i = 0; i < 5; i++) {
    await db.execute(sql`insert into referral_codes (user_id, code) values (${userId}, ${generateReferralCode()}) on conflict do nothing`);
    const [r] = await db.execute<{ code: string }>(sql`select code from referral_codes where user_id = ${userId}`);
    if (r) return r.code;
  }
  throw new Error('referral code: 5 collisions');
}

/** Invites sent today (profile-local calendar day) -> how many are left. Optional tx so invites can count under the advisory lock. */
export async function invitesLeftToday(userId: string, db?: { execute: (q: ReturnType<typeof sql>) => Promise<Record<string, unknown>[]> }) {
  const x = db ?? (await dbm()).db;
  const [r] = (await x.execute(sql`
    select count(*)::int as n from referrals r join profiles p on p.user_id = r.referrer_id
    where r.referrer_id = ${userId} and r.channel = 'email'
      and (r.created_at at time zone p.timezone)::date = (now() at time zone p.timezone)::date`)) as { n: number }[];
  return Math.max(0, REFERRAL_LIMITS.invitesPerDay - (r?.n ?? 0));
}

type RewardRow = { id: string; kind: 'month' | 'credit'; side: 'referrer' | 'referee'; friend_name: string | null; granted_at: string; ends_at: string | null; amount: number | null };

export async function getReferralSummary(userId: string, now = new Date()) {
  const code = await ensureCode(userId);
  const { db } = await dbm();
  const origin = env().appUrl;
  const [friends, rewards, [months], [chain], [credit], [sub], left] = await Promise.all([
    run(userId, (tx) => tx.execute<{ id: string; display_name: string | null; removed: boolean; status: ReferralFriend['status']; invited_at: string | null; signed_up_at: string | null; qualified_at: string | null }>(sql`select * from public.referral_friends()`)),
    db.execute<RewardRow>(sql`
      select * from (
        select g.id, 'month' as kind, case when r.referrer_id = ${userId} then 'referrer' else 'referee' end as side,
          case when o.deleted_at is not null then null else public.referral_display_name(o.name) end as friend_name,
          g.created_at as granted_at, g.ends_at, null::int as amount
        from entitlement_grants g join referrals r on r.id = g.referral_id
        left join profiles o on o.user_id = case when r.referrer_id = ${userId} then r.referee_id else r.referrer_id end
        where g.user_id = ${userId} and g.source = 'referral' and g.revoked_at is null
        union all
        select c.id, 'credit', case when r.referrer_id = ${userId} then 'referrer' else 'referee' end,
          case when o.deleted_at is not null then null else public.referral_display_name(o.name) end,
          coalesce(c.applied_at, c.created_at), null, c.amount_cents
        from billing_credits c join referrals r on r.id = c.referral_id
        left join profiles o on o.user_id = case when r.referrer_id = ${userId} then r.referee_id else r.referrer_id end
        where c.user_id = ${userId}
      ) x order by granted_at desc limit 3`),
    db.execute<{ n: number }>(sql`select ((select count(*) from entitlement_grants where user_id = ${userId} and source = 'referral' and revoked_at is null)
      + (select count(*) from billing_credits where user_id = ${userId}))::int as n`),
    // D-1214: the chain may include the free trial (referral months queue after it), but only a live referral month shows "Pro grátis até" here
    db.execute<{ until: string | null; since: string | null; referral: boolean | null }>(sql`
      select max(ends_at) as until, min(starts_at) filter (where starts_at <= ${now.toISOString()}::timestamptz) as since,
        bool_or(source = 'referral') as referral from entitlement_grants
      where user_id = ${userId} and revoked_at is null and ends_at > ${now.toISOString()}::timestamptz`),
    db.execute<{ n: number }>(sql`select coalesce(sum(amount_cents), 0)::int as n from billing_credits where user_id = ${userId}`),
    // a paying subscriber has no "Pro grátis até" (D-384: they get credit instead)
    db.execute<{ pro: boolean }>(sql`select exists (select 1 from subscriptions where user_id = ${userId} and plan = 'pro' and status in ('active', 'trialing') and (renews_at is null or renews_at > ${now.toISOString()}::timestamptz)) as pro`),
    invitesLeftToday(userId),
  ]);
  // chain active only if some grant already started; `since` = start of the active chain (earliest running grant still unexpired)
  const until = chain?.since && chain.referral && !sub?.pro ? chain.until : null;
  const summary: ReferralSummary = {
    code,
    link: referralLink(origin, code),
    monthsEarned: months?.n ?? 0,
    proUntil: until ? iso(until) : null,
    proDaysTotal: until && chain?.since ? Math.ceil((new Date(until).getTime() - new Date(chain.since).getTime()) / DAY_MS) : 0,
    credit: credit?.n ?? 0,
    recentRewards: rewards.map((r): RewardGrant => ({ id: r.id, kind: r.kind, side: r.side, friendName: r.friend_name, grantedAt: iso(r.granted_at), endsAt: r.ends_at ? iso(r.ends_at) : null, amount: r.amount })),
    friends: friends.map((f) => ({
      id: f.id,
      displayName: f.display_name,
      removed: f.removed,
      status: f.status,
      when: iso(f.qualified_at ?? f.signed_up_at ?? f.invited_at),
      steps: { invitedAt: f.invited_at ? iso(f.invited_at) : null, signedUpAt: f.signed_up_at ? iso(f.signed_up_at) : null, qualifiedAt: f.qualified_at ? iso(f.qualified_at) : null },
    })),
    invitesLeftToday: left,
  };
  return ok(summary);
}
