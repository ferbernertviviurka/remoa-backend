// G18 F26 FR-7/FR-12 (D-764–D-766): notify() is the only door for user notices (CLAUDE.md rule 10).
// In-app row by the App preference; e-mail by the E-mail preference, the reminder pause, suppressions and the reminder cap.
import { sql } from 'drizzle-orm';
import {
  ADDRESS_NOTICES, NOTIFICATION_PREFS, NOTIFICATION_TYPES, REMINDER_EMAIL_CAP, effectivePref, notificationDataSchemas, notificationPrefKey,
  type EmailTemplate, type InAppNotificationType, type NotificationType, type Notify, type NotifyAddress, type NotifyEmailOutcome, type NotifyResult,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { deliverEmail, type DeliverResult } from '../emails/send';

const log = createLogger({ requestId: 'notify' });

/** `type:reference` must fit email_deliveries.reference (≤ 200, [\w:.-]) and carry no personal data. */
const REFERENCE = /^[\w:.-]{1,160}$/;

/** Templates under the reminder cap (capRank set), derived from the type table. */
const CAPPED_TEMPLATES = [...new Set(Object.values(NOTIFICATION_TYPES).filter((t) => t.capRank !== null).map((t) => t.email))] as EmailTemplate[];

const emailOutcome = (r: DeliverResult): NotifyEmailOutcome => {
  if (r.status === 'blocked') return 'capped';
  if (r.status === 'suppressed') return 'suppressed';
  if (r.status === 'failed') return 'failed';
  return 'duplicate' in r && r.duplicate ? 'duplicate' : 'queued';
};

/**
 * FR-12 / Q-056: at most REMINDER_EMAIL_CAP.max reminder e-mails per rolling 24 h. Priority Calendário (1) > Revisão (2) > Volte quando sumir (3):
 * a lower-priority e-mail also counts the calendar e-mails already scheduled for the next 24 h (one per kind + local day), so it never takes
 * the slot a calendar reminder will need. Runs under the per-user lock taken by deliverEmail's claim, so two sends cannot both pass.
 * ponytail: counts the last 24 h plus the next 24 h (conservative near the edges); review (2) does not reserve a slot ahead of inactivity (3),
 * add a reservation if the daily review reminder starts losing to inactivity.
 */
const capGate = (userId: string, rank: 1 | 2 | 3, now: Date) => async (tx: Tx) => {
  const at = now.toISOString();
  const templates = sql.join(CAPPED_TEMPLATES.map((t) => sql`${t}`), sql`, `);
  const upcoming = rank === 1 ? sql`0` : sql`(
    select count(distinct (r.kind, r.occurrence_date))::int from calendar_reminders r
    join calendar_events e on e.id = r.event_id and e.deleted_at is null
    where r.user_id = ${userId} and r.status = 'scheduled'
      and r.send_at > ${at}::timestamptz and r.send_at <= ${at}::timestamptz + make_interval(hours => ${REMINDER_EMAIL_CAP.windowHours})
      and ((r.kind = 'd1' and e.remind_d1) or (r.kind = 'd0' and e.remind_d0))
      and coalesce((select np.email from notification_preferences np where np.user_id = r.user_id and np.key = ('calendar_' || r.kind::text)::notification_pref_key), true))`;
  const [r] = await tx.execute<{ used: number; upcoming: number }>(sql`
    select (select count(*)::int from email_deliveries
            where user_id = ${userId} and template in (${templates}) and status not in ('failed', 'suppressed')
              and coalesce(sent_at, updated_at) > ${at}::timestamptz - make_interval(hours => ${REMINDER_EMAIL_CAP.windowHours})) as used,
           ${upcoming} as upcoming`);
  return (r?.used ?? 0) + (r?.upcoming ?? 0) >= REMINDER_EMAIL_CAP.max ? 'capped' : null;
};

/** Pure part of the e-mail decision (FR-7): 'send' still goes through suppression, the cap and idempotency in deliverEmail. */
export function emailDecision(
  type: NotificationType,
  s: { prefEmail: boolean; paused: boolean; hasAddress: boolean; skipEmail?: boolean; window?: 'd1' | 'd0' },
): 'send' | Extract<NotifyEmailOutcome, 'not_applicable' | 'disabled' | 'paused'> {
  if (!NOTIFICATION_TYPES[type].email || s.skipEmail || !s.hasAddress) return 'not_applicable';
  if (!s.prefEmail) return 'disabled';
  return NOTIFICATION_PREFS[notificationPrefKey(type, { window: s.window })].pausable && s.paused ? 'paused' : 'send';
}

type State = { email: string | null; paused: boolean; in_app: boolean | null; email_pref: boolean | null };

export const notify: Notify = async (userId, type, payload, opts = {}) => {
  const res: NotifyResult = { inApp: 'not_applicable', notificationId: null, email: 'not_applicable', emailDeliveryId: null };
  const spec = NOTIFICATION_TYPES[type];
  const p = payload as { reference: string; href?: string; groupKey?: string; data?: unknown; email?: unknown };
  try {
    if (!REFERENCE.test(p.reference)) {
      log.error('notify: bad reference', { type });
      return res;
    }
    const key = `${type}:${p.reference}`;
    const prefKey = notificationPrefKey(type, p.data as { window?: 'd1' | 'd0' } | undefined); // calendar_digest: by its window
    const { db } = await dbm();
    const [st] = await db.execute<State>(sql`
      select u.email, coalesce(up.notif_pause_reminders, false) as paused, np.in_app, np.email as email_pref
      from auth.users u
      left join user_preferences up on up.user_id = u.id
      left join notification_preferences np on np.user_id = u.id and np.key = ${prefKey}
      where u.id = ${userId}`);
    if (!st) {
      log.warn('notify: no such user', { type });
      return res;
    }
    const pref = effectivePref(prefKey, st.in_app === null || st.email_pref === null ? null : { inApp: st.in_app, email: st.email_pref });

    if (spec.inApp) {
      if (!pref.inApp) res.inApp = 'disabled';
      else {
        const data = notificationDataSchemas[type as InAppNotificationType].safeParse(p.data);
        if (!data.success) log.error('notify: bad data', { type, paths: data.error.issues.map((i) => i.path.join('.')) });
        else {
          const href = p.href?.startsWith('/') ? p.href : null;
          const [row] = await db.execute<{ id: string }>(sql`
            insert into notifications (user_id, type, category, href, data, group_key, idempotency_key)
            values (${userId}, ${type}, ${spec.category}, ${href}, ${JSON.stringify(data.data)}::jsonb, ${p.groupKey ?? null}, ${key})
            on conflict (user_id, idempotency_key) do nothing returning id`);
          const [old] = row ? [] : await db.execute<{ id: string }>(sql`select id from notifications where user_id = ${userId} and idempotency_key = ${key}`);
          res.inApp = row ? 'created' : 'duplicate';
          res.notificationId = (row ?? old)?.id ?? null;
        }
      }
    }

    const window = (p.data as { window?: 'd1' | 'd0' } | undefined)?.window;
    const decision = emailDecision(type, { prefEmail: pref.email, paused: st.paused, hasAddress: !!st.email, skipEmail: opts.skipEmail, window });
    if (decision !== 'send') res.email = decision;
    else if (spec.email && st.email) {
      const gate = spec.capRank === null ? undefined : capGate(userId, spec.capRank, opts.now ?? new Date());
      const r = await deliverEmail({ template: spec.email, to: st.email, data: p.email as never, reference: key, userId }, gate);
      res.email = emailOutcome(r);
      res.emailDeliveryId = r.deliveryId;
    }
    log.info('notify', { event: 'notify', type, inApp: res.inApp, email: res.email });
    return res;
  } catch (e) {
    log.error('notify failed', { type, error: e instanceof Error ? e.message : String(e) });
    return res;
  }
};

/** CCR-035 (D-762): e-mail to an address without an account (referral invite, landing waitlist). Never a notifications row. */
export const notifyAddress: NotifyAddress = async (to, type, payload) => {
  if (!REFERENCE.test(payload.reference)) {
    log.error('notifyAddress: bad reference', { type });
    return { email: 'failed', emailDeliveryId: null };
  }
  const r = await deliverEmail({ template: ADDRESS_NOTICES[type].email, to, data: payload.email, reference: `${type}:${payload.reference}`, userId: null });
  log.info('notify', { event: 'notify', type, email: emailOutcome(r) });
  return { email: emailOutcome(r), emailDeliveryId: r.deliveryId };
};
