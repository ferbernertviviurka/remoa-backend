// G18 F26 "Volte quando sumir" (inactivity.check, daily): one e-mail per absence, at most 2 in 60 days, only with something to review.
import { sql } from 'drizzle-orm';
import { env } from '@remoa/config';
import { createLogger } from '@remoa/log';
import type { Notify } from '@remoa/contracts';
import { dbm } from '../db';
import { computeReviewHub } from '../review/hub';

const log = createLogger({ requestId: 'job-inactivity' });
/** D-781: absent = no study session for more than `afterDays`; absences older than `lookbackDays` are left alone (no blast at launch). */
export const INACTIVITY = { afterDays: 10, maxPerWindow: 2, windowDays: 60, lookbackDays: 60 } as const;
const DAY = 86_400_000;

type Candidate = { user_id: string; name: string | null; tz: string; last: Date | string; recent: number };

export async function sendInactivityNotices(now: Date, notify: Notify): Promise<number> {
  const { db } = await dbm();
  const at = now.toISOString();
  const list = await db.execute<Candidate>(sql`
    select s.user_id, p.name, p.timezone as tz, s.last,
           (select count(*)::int from email_deliveries d where d.user_id = s.user_id and d.template = 'inactivity'
              and d.created_at > ${at}::timestamptz - make_interval(days => ${INACTIVITY.windowDays})) as recent
    from (select user_id, max(started_at) as last from sessions group by user_id) s
    join profiles p on p.user_id = s.user_id
    where p.deleted_at is null and p.suspended_at is null and p.timezone in (select name from pg_timezone_names)
      and s.last < ${at}::timestamptz - make_interval(days => ${INACTIVITY.afterDays})
      and s.last > ${at}::timestamptz - make_interval(days => ${INACTIVITY.lookbackDays})`);
  const { appUrl } = env();
  let sent = 0;
  for (const c of list) {
    if (c.recent >= INACTIVITY.maxPerWindow) continue;
    try {
      const hub = await computeReviewHub(c.user_id, now);
      if (!hub.queue.counts.due) continue;
      const last = new Date(c.last);
      const [next] = await db.execute<{ title: string; starts_at: Date | string; all_day: boolean }>(sql`
        select title, starts_at, all_day from calendar_events
        where user_id = ${c.user_id} and deleted_at is null and starts_at > ${at}::timestamptz order by starts_at limit 1`);
      const r = await notify(c.user_id, 'inactivity', {
        reference: `${c.user_id}:${last.toISOString()}`, // the absence (e-mail references are global): a new session starts a new one
        email: {
          name: c.name?.trim().split(/\s+/)[0] || null,
          days: Math.floor((now.getTime() - last.getTime()) / DAY),
          dueCards: hub.queue.counts.due,
          maps: hub.maps.length,
          nextEvent: next ? { title: next.title, startsAt: new Date(next.starts_at).toISOString(), allDay: next.all_day } : null,
          timezone: c.tz,
          resumeUrl: `${appUrl}/app/revisar`,
        },
      });
      if (r.email === 'queued') sent++;
    } catch (e) {
      log.error('inactivity notice failed', { userId: c.user_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return sent;
}
