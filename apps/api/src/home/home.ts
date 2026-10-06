import { sql } from 'drizzle-orm';
import { ok, type GetHomeSummary } from '@remoa/contracts';
import { dayWindow, dueByOffset } from '../review/queue';
import { run } from '../db';

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const STREAK_LOOKBACK_DAYS = 400; // ponytail: streaks cap at this

/**
 * G01 "Hoje". Study day = profile tz, rolls over at 04:00 (dayWindow); attempts are bucketed by that same rule.
 * G21 FR-22/FR-23: due counts by the `fsrs_state(user_id, due)` range, done per day from `user_daily_stats` (no scan of cards or attempts).
 */
export const getHomeSummary: GetHomeSummary = async (userId, now) =>
  ok(
    await run(userId, async (tx) => {
      const win = await dayWindow(tx, userId, now);
      const [due, rows] = await Promise.all([
        dueByOffset(tx, userId, win, 7),
        tx.execute<{ d: string; n: number }>(sql`
          select day::text as d, reviews as n from user_daily_stats where user_id = ${userId} and day >= ${win.day}::date - ${STREAK_LOOKBACK_DAYS}::int and reviews > 0`),
      ]);
      const done = new Map(rows.map((r) => [r.d, r.n]));
      const today = win.day;
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      const week = Array.from({ length: 7 }, (_, i) => {
        const date = addDays(today, i - dow);
        return { date, done: done.get(date) ?? 0, planned: i - dow >= 0 ? due[i - dow]! : 0 };
      });
      let streakDays = 0;
      for (let d = done.has(today) ? today : addDays(today, -1); done.has(d); d = addDays(d, -1)) streakDays++;
      return {
        reviewedToday: done.get(today) ?? 0,
        dueToday: due[0]!,
        week,
        streakDays,
        upcoming: [0, 1, 2, 3].map((k) => ({ date: addDays(today, k), count: due[k]! })),
      };
    }),
  );
