// F19 FR-9 / Q-046 (provisional): attachments 90 days and tickets 12 months after resolution. Run by account/maintenance.ts.
import { sql } from 'drizzle-orm';
import { dbm } from '../db';
import { deleteObject } from '../storage/storage';

export const ATTACHMENT_RETENTION_DAYS = 90;
export const TICKET_RETENTION_MONTHS = 12;

export async function sweepSupport(now = new Date()) {
  const { db } = await dbm();
  const at = now.toISOString();
  const files = await db.execute<{ id: string; key: string }>(sql`select a.id, a.key from support_attachments a join support_tickets t on t.id = a.ticket_id
    where t.resolved_at is not null and t.resolved_at <= ${at}::timestamptz - make_interval(days => ${ATTACHMENT_RETENTION_DAYS})`);
  let attachments = 0;
  for (const f of files) {
    try {
      await deleteObject(f.key); // object first: a failure leaves the row, so the next run retries
      await db.execute(sql`delete from support_attachments where id = ${f.id}`);
      attachments++;
    } catch { /* retried next run */ }
  }
  // Remaining attachment rows (resolved < 12 months) are gone by now; cascade covers messages. Objects of a ticket whose rows are not yet deleted are not orphaned: they were swept above (90 d < 12 mo).
  const tickets = (await db.execute(sql`delete from support_tickets where resolved_at is not null and resolved_at <= ${at}::timestamptz - make_interval(months => ${TICKET_RETENTION_MONTHS}) returning id`)).length;
  return { attachments, tickets };
}
