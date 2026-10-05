// G18 F24 FR-16: Resend webhook events → email_deliveries status; hard bounce / complaint → email_suppressions (D-737: reason only goes up).
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { emailSuppressionReasons, type EmailStatus, type EmailSuppressionReason } from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';

const log = createLogger({ requestId: 'email-webhook' });

/** The 4 events the runbook subscribes; anything else is acknowledged and ignored. */
const resendEventSchema = z.object({
  type: z.enum(['email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained']),
  created_at: z.string().optional(),
  data: z.object({
    email_id: z.string().min(1).max(200),
    bounce: z.object({ type: z.string().max(60).optional(), subType: z.string().max(60).optional() }).passthrough().optional(),
  }).passthrough(),
});

/** Forward-only: a late `delivery_delayed` never overwrites `delivered`, a repeated event is a no-op. failed/suppressed never reach the provider. */
const PROGRESS: readonly EmailStatus[] = ['queued', 'sent', 'delivery_delayed', 'delivered', 'bounced', 'complained'];
const rankSql = (col: ReturnType<typeof sql>, order: readonly string[]) => sql`array_position(array[${sql.join(order.map((s) => sql`${s}`), sql`, `)}]::text[], ${col}::text)`;

export type WebhookOutcome = 'updated' | 'unchanged' | 'unknown_email' | 'ignored';

/** Upgrade-only (D-737): invite_opt_out < hard_bounce < complaint. */
export async function suppress(emailHash: string, reason: EmailSuppressionReason) {
  const { db } = await dbm();
  await db.execute(sql`
    insert into email_suppressions (email_hash, reason) values (${emailHash}, ${reason})
    on conflict (email_hash) do update set reason = excluded.reason
    where ${rankSql(sql`email_suppressions.reason`, emailSuppressionReasons)} < ${rankSql(sql`excluded.reason`, emailSuppressionReasons)}`);
}

export async function handleResendEvent(payload: unknown): Promise<WebhookOutcome> {
  const p = resendEventSchema.safeParse(payload);
  if (!p.success) return 'ignored';
  const { type, data } = p.data;
  const status = type.slice('email.'.length) as EmailStatus;
  // SES-style bounce types: only "Permanent" is a hard bounce. A soft bounce still marks the row, without suppressing the address.
  const permanent = type === 'email.complained' || (type === 'email.bounced' && data.bounce?.type?.toLowerCase() === 'permanent');
  const error = type === 'email.bounced' ? `bounce:${data.bounce?.type ?? '?'}/${data.bounce?.subType ?? '?'}`.slice(0, 120) : null;
  const at = p.data.created_at && !Number.isNaN(Date.parse(p.data.created_at)) ? new Date(p.data.created_at).toISOString() : new Date().toISOString();

  const { db } = await dbm();
  const [row] = await db.execute<{ id: string; to_hash: string; redirected: boolean; template: string }>(sql`
    select id, to_hash, redirected, template::text from email_deliveries where provider_id = ${data.email_id}`);
  if (!row) return 'unknown_email'; // another environment, or a provider id we never stored: acknowledged so Resend stops retrying

  const updated = await db.execute(sql`
    update email_deliveries set status = ${status},
      delivered_at = case when ${status} = 'delivered' then coalesce(delivered_at, ${at}::timestamptz) else delivered_at end,
      error = coalesce(${error}, error)
    where id = ${row.id} and ${rankSql(sql`status`, PROGRESS)} < ${rankSql(sql`${status}`, PROGRESS)}`);

  // EMAIL_TEST_REDIRECT: the bounce is about the staging inbox, not the real address behind to_hash.
  if (permanent && !row.redirected) await suppress(row.to_hash, type === 'email.complained' ? 'complaint' : 'hard_bounce');
  log.info('email_event', { event: `email_${status}`, template: row.template, permanent, changed: updated.count > 0 });
  return updated.count > 0 ? 'updated' : 'unchanged';
}
