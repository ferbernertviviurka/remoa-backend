import { sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';

export const DEFAULT_TZ = 'America/Sao_Paulo';

/** Profile timezone, falling back to the default when absent or not a valid IANA name. */
export async function profileTz(tx: Tx, userId: string): Promise<string> {
  const [p] = await tx.execute<{ tz: string }>(sql`select timezone as tz from profiles where user_id = ${userId}`);
  const tz = p?.tz ?? DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Local wall clock fields of an event, derived from its own timezone. `s` = the db module (lazy: app.test.ts loads the app without a database). */
export const localCols = (s: typeof import('@remoa/db')) => {
  const e = s.calendarEvents;
  return {
    date: sql<string>`to_char(${e.startsAt} at time zone ${e.timezone}, 'YYYY-MM-DD')`,
    st: sql<string | null>`case when ${e.allDay} then null else to_char(${e.startsAt} at time zone ${e.timezone}, 'HH24:MI') end`,
    et: sql<string | null>`case when ${e.endsAt} is null then null else to_char(${e.endsAt} at time zone ${e.timezone}, 'HH24:MI') end`,
  };
};
