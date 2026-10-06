// G18 F24 FR-5 (P-316): what a verified unsubscribe token turns off. GET /v1/emails/unsubscribe only shows the confirm page;
// POST (button or RFC 8058 one-click) calls applyUnsubscribe. Idempotent: clicking twice changes nothing more.
import { sql } from 'drizzle-orm';
import { NOTIFICATION_PREFS, effectivePref, type NotificationPrefKey } from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import { dbm, uuids } from '../db';
import { recordEvent } from '../account/events';
import { emailHash } from '../referral/email-normalize';
import { suppress } from './webhook';
import type { UnsubscribeClaim } from './tokens';
import { invalidate } from '../cache';

const log = createLogger({ requestId: 'email-unsubscribe' });

/** Rows whose e-mail can never be turned off (conta, cobrança, suporte): a token for them is refused like a bad one. */
export const canUnsubscribe = (c: UnsubscribeClaim) => !(c.scope in NOTIFICATION_PREFS) || NOTIFICATION_PREFS[c.scope as NotificationPrefKey].email !== 'fixed';

export async function applyUnsubscribe(c: UnsubscribeClaim): Promise<void> {
  const { db } = await dbm();
  const { scope, subject } = c;
  if ('emailHash' in subject) {
    if (scope === 'referral_invite') await suppress(subject.emailHash, 'invite_opt_out');
    else if (scope === 'landing_waitlist') {
      // ponytail: the landing waitlist keeps the plain address (F16), so the hash is matched in JS; fine for thousands of rows, add a hash column past that.
      const rows = await db.execute<{ id: string; email: string }>(sql`select id, email from waitlist`);
      const ids = rows.filter((r) => emailHash(r.email) === subject.emailHash).map((r) => r.id);
      if (ids.length) await db.execute(sql`delete from waitlist where id = any(${uuids(ids)})`);
    }
  } else {
    const { userId } = subject;
    if (scope === 'pause') {
      await db.execute(sql`
        insert into user_preferences (user_id, notif_pause_reminders) select ${userId}::uuid, true where exists (select 1 from auth.users where id = ${userId}::uuid)
        on conflict (user_id) do update set notif_pause_reminders = true, updated_at = now()`);
    } else if (scope !== 'referral_invite' && scope !== 'landing_waitlist') {
      // Keeps the App channel as it was (default when there is no row); only the e-mail goes off.
      const inApp = effectivePref(scope, null).inApp;
      await db.execute(sql`
        insert into notification_preferences (user_id, key, in_app, email) select ${userId}::uuid, ${scope}, ${inApp}, false
        where exists (select 1 from auth.users where id = ${userId}::uuid)
        on conflict (user_id, key) do update set email = false, updated_at = now()`);
      if (scope === 'store') await db.execute(sql`delete from store_waitlist where user_id = ${userId}`); // "Sair da lista"
      if (scope === 'review_reminder') {
        // F13 columns still read by Minha conta › Preferências (D-781): keep them in step.
        const r = await db.execute(sql`update user_preferences set reminder_enabled = false, email_review_reminders = false, updated_at = now() where user_id = ${userId}`);
        if (r.count) await recordEvent(db, userId, 'reminder_unsubscribed');
      }
    }
    await invalidate('prefs.changed', { userId }); // after the writes: Preferências and the notification matrix
  }
  log.info('email_unsubscribed', { event: 'email_unsubscribed', scope, legacy: c.legacy });
}
