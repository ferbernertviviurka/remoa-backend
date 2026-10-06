// D-1213 (FR-10 of F30): "seu teste do Pro termina em 3 dias / hoje", in-app + e-mail. Runs in the hourly maintenance; notify() dedupes
// by reference (`trial:<grant>:d3|d0`), so each notice goes out once per trial however often the sweep runs.
import { sql } from 'drizzle-orm';
import { TRIAL_NOTICE_DAYS, type Notify } from '@remoa/contracts';
import { env } from '@remoa/config';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { notify } from '../notifications/notify';

const log = createLogger({ requestId: 'trial-notice' });
const BATCH = 500;

type Due = { grant_id: string; user_id: string; ends_at: string | Date; name: string | null; timezone: string; last: boolean };

/**
 * Trials ending within TRIAL_NOTICE_DAYS (d3) or within 24 h (d0, `last`), only when the trial is what ends the Pro: not for a paying
 * subscriber (Founder or a running Pro) nor when a referral/support/promo grant takes over at the trial's end. Within 24 h only d0
 * goes out, even if d3 never did. Rows whose in-app notice already exists are skipped, so a batch always makes progress.
 */
export async function sweepTrialNotices(now = new Date(), send: Notify = notify): Promise<{ d3: number; d0: number }> {
  const { db } = await dbm();
  const at = now.toISOString();
  const due = await db.execute<Due>(sql`
    select x.* from (
      select g.id as grant_id, g.user_id, g.ends_at, p.name, p.timezone, g.ends_at <= ${at}::timestamptz + interval '1 day' as last
      from entitlement_grants g
      join profiles p on p.user_id = g.user_id and p.deleted_at is null
      left join subscriptions s on s.user_id = g.user_id
      where g.source = 'trial' and g.revoked_at is null and g.starts_at <= ${at}::timestamptz
        and g.ends_at > ${at}::timestamptz and g.ends_at <= ${at}::timestamptz + make_interval(days => ${TRIAL_NOTICE_DAYS})
        and not coalesce(s.plan = 'founder' or (s.plan = 'pro' and s.status in ('active', 'trialing', 'past_due')
          and (s.renews_at is null or s.renews_at > ${at}::timestamptz)), false)
        and not exists (select 1 from entitlement_grants o where o.user_id = g.user_id and o.source <> 'trial' and o.revoked_at is null
          and o.starts_at <= g.ends_at and o.ends_at > g.ends_at)
    ) x
    where not exists (select 1 from notifications n where n.user_id = x.user_id
      and n.idempotency_key = 'trial_ending:trial:' || x.grant_id || case when x.last then ':d0' else ':d3' end)
    order by x.ends_at limit ${BATCH}`);
  const plansUrl = `${env().appUrl}/app/planos`;
  const out = { d3: 0, d0: 0 };
  for (const d of due) {
    const version = d.last ? 'd0' : 'd3';
    const endsAt = new Date(d.ends_at).toISOString();
    const r = await send(d.user_id, 'trial_ending', {
      reference: `trial:${d.grant_id}:${version}`,
      href: '/app/planos',
      data: { endsAt, last: d.last },
      email: { version, name: d.name?.trim().split(/\s+/)[0]?.slice(0, 80) || null, endsAt, timezone: d.timezone, plansUrl },
    });
    if (r.inApp === 'created' || r.email === 'queued') out[version]++;
  }
  log.info('trial notices done', out);
  return out;
}
