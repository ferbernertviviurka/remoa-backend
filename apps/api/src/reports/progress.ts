import { sql } from 'drizzle-orm';
import { ok, type FsrsCardState, type FsrsMemory, type GetProgress } from '@remoa/contracts';
import { REVIEW_BELOW } from '@remoa/fsrs';
import { dayWindow, recallSql } from '../review/queue';
import { run } from '../db';
import { summarizeBuckets, weakFromMemory, type AttemptBucket } from './aggregate';

const WEAK_MAX = 20; // = summarize's weakCards cap

export const getProgress: GetProgress = async (userId, now) =>
  ok(
    await run(userId, async (tx) => {
      const win = await dayWindow(tx, userId, now);
      const attempts = await tx.execute<{ day: string; attempts: number; hits: number; area: 'CM'; matrix_item_id: string | null; matrix_title: string | null }>(sql`
        -- G21: attempts are first grouped per (day, card) on attempts_user_created_idx, then one PK probe per card (no join per attempt,
        -- no seq scan of cards under RLS)
        select a.day, sum(a.n)::int as attempts, sum(a.hits)::int as hits, b.area, b.matrix_item_id, max(mi.title) as matrix_title
        from (
          select ((created_at at time zone ${win.tz}::text) - interval '4 hours')::date::text as day, card_id, count(*) as n, count(*) filter (where grade >= 3) as hits
          from attempts
          where user_id = ${userId} and created_at >= (${win.day}::date - 29) at time zone ${win.tz}::text + interval '4 hours'
          group by 1, 2
        ) a
        cross join lateral (select c.board_id from cards c where c.id = a.card_id offset 0) c
        cross join lateral (select b.area, b.matrix_item_id from boards b where b.id = c.board_id offset 0) b
        left join matrix_items mi on mi.id = b.matrix_item_id
        group by a.day, b.area, b.matrix_item_id
      `);
      // G21 FR-22/FR-23: the 20 weakest by the recall expression in SQL (was every state of the user); studied days from user_daily_stats
      const [weak, studied] = await Promise.all([
        tx.execute<{
          card_id: string; board_id: string; title: string; stability: number; difficulty: number;
          due: Date | string; reps: number; lapses: number; last_review: Date | string | null;
          state: FsrsCardState; learning_steps: number; scheduled_days: number;
        }>(sql`
          select f.card_id, c.board_id, c.title,
                 f.stability, f.difficulty, f.due, f.reps, f.lapses, f.last_review, f.state::text as state,
                 f.learning_steps, f.scheduled_days
          from fsrs_state f
          cross join lateral (select c.board_id, c.title from cards c where c.id = f.card_id offset 0) c -- PK probe (see queue.ts stateItemsSql)
          where f.user_id = ${userId} and f.sub_id = '' and f.reps > 0 and f.last_review is not null and ${recallSql(now.getTime())} < ${REVIEW_BELOW}
          order by ${recallSql(now.getTime())}, f.card_id limit ${WEAK_MAX}
        `),
        tx.execute<{ day: string }>(sql`select day::text as day from user_daily_stats where user_id = ${userId} and day >= ${win.day}::date - 399 and reviews > 0`),
      ]);
      const buckets: AttemptBucket[] = attempts.map((a) => ({
        day: a.day, attempts: Number(a.attempts), hits: Number(a.hits), area: 'CM', matrixItemId: a.matrix_item_id, matrixTitle: a.matrix_title,
      }));
      const weaks = weakFromMemory(weak.map((w) => ({
        cardId: w.card_id,
        boardId: w.board_id,
        title: w.title,
        memory: {
          stability: Number(w.stability),
          difficulty: Number(w.difficulty),
          due: new Date(w.due),
          reps: Number(w.reps),
          lapses: Number(w.lapses),
          lastReview: w.last_review ? new Date(w.last_review) : null,
          state: w.state,
          learningSteps: Number(w.learning_steps),
          scheduledDays: Number(w.scheduled_days),
        } satisfies FsrsMemory,
      })), now);
      return summarizeBuckets(buckets, weaks, win.day, studied.map((d) => d.day));
    }),
  );

export async function attemptsCsv(userId: string): Promise<string> {
  return run(userId, async (tx) => {
    const rows = await tx.execute<{ id: string; created_at: string; grade: number; mode: string; input_kind: string }>(sql`
      select id::text, created_at::text, grade, mode::text, input_kind::text
      from attempts where user_id = ${userId} order by created_at desc limit 5000
    `);
    const header = 'id,created_at,grade,mode,input_kind';
    const cell = (value: unknown) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const body = rows.map((r) => [r.id, r.created_at, r.grade, r.mode, r.input_kind].map(cell).join(','));
    return [header, ...body].join('\n');
  });
}
