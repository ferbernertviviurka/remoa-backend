import { sql } from 'drizzle-orm';
import { ok, type FsrsCardState, type FsrsMemory, type GetProgress } from '@remoa/contracts';
import { dayWindow } from '../review/queue';
import { run } from '../db';
import { summarizeBuckets, weakFromMemory, type AttemptBucket } from './aggregate';

export const getProgress: GetProgress = async (userId, now) =>
  ok(
    await run(userId, async (tx) => {
      const win = await dayWindow(tx, userId, now);
      const attempts = await tx.execute<{ day: string; attempts: number; hits: number; area: 'CM'; matrix_item_id: string | null; matrix_title: string | null }>(sql`
        select day, count(*)::int as attempts, count(*) filter (where grade >= 3)::int as hits, area, matrix_item_id, max(matrix_title) as matrix_title
        from (
          select ((a.created_at at time zone ${win.tz}::text) - interval '4 hours')::date::text as day,
                 a.grade, b.area, b.matrix_item_id, mi.title as matrix_title
          from attempts a
          join cards c on c.id = a.card_id
          join boards b on b.id = c.board_id
          left join matrix_items mi on mi.id = b.matrix_item_id
          where a.user_id = ${userId}
            and a.created_at >= (${win.day}::date - 29) at time zone ${win.tz}::text + interval '4 hours'
        ) s
        group by day, area, matrix_item_id
      `);
      const weak = await tx.execute<{
        card_id: string; board_id: string; title: string; stability: number; difficulty: number;
        due: Date | string; reps: number; lapses: number; last_review: Date | string | null;
        state: FsrsCardState; learning_steps: number; scheduled_days: number;
      }>(sql`
        select f.card_id, c.board_id, c.title,
               f.stability, f.difficulty, f.due, f.reps, f.lapses, f.last_review, f.state::text as state,
               f.learning_steps, f.scheduled_days
        from fsrs_state f
        join cards c on c.id = f.card_id
        where f.user_id = ${userId} and f.sub_id = '' and f.reps > 0 and f.last_review is not null
      `);
      const studied = await tx.execute<{ day: string }>(sql`
        select distinct ((a.created_at at time zone ${win.tz}::text) - interval '4 hours')::date::text as day
        from attempts a
        where a.user_id = ${userId}
          and a.created_at >= (${win.day}::date - 399) at time zone ${win.tz}::text + interval '4 hours'
      `);
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
