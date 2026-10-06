// G21 FR-27/FR-31 (D-1025, P-451): `pnpm perf:explain <antes|depois> [nome...]` writes EXPLAIN (ANALYZE, BUFFERS) of the critical queries of
// docs/perf/QUERIES.md §2 to docs/perf/explain/<nome>-<antes|depois>.txt. Runs only against the isolated remoa_perf database (perfTarget),
// as the app does (D-021): same connection, `authenticated` role + request.jwt.claims set in the transaction, so RLS is in the plan.
// User = perf user 1 (heavy: 10k cards, boards of 2000 and 500); admin queries run on the plain connection like the API does.
// Every query runs in its own transaction that is rolled back (rate's writes leave nothing behind).
// SQL copied from the files cited on 2026-10-06; when a lane rewrites a query, update its text here before the "depois" run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { perfTarget, userUuid } from './target';

type Q = { name: string; src: string; admin?: boolean; sql: string };

const live = `join cards f on f.id = e.from_card_id and f.deleted_at is null join cards t on t.id = e.to_card_id and t.deleted_at is null`;
const subs = `case c.type when 'flow' then coalesce((select jsonb_agg(s->>'id') from jsonb_array_elements(c.payload->'steps') s), '[]'::jsonb)
  when 'image' then coalesce((select jsonb_agg(m.id::text) from masks m where m.card_id = c.id), '[]'::jsonb) else '[""]'::jsonb end`;
const tz = `'America/Sao_Paulo'`;
const day = `(now() at time zone ${tz} - interval '4 hours')::date`;

/** :user :board :boards :cards5 :card :session are replaced by literals (fixed perf ids, never user input). */
export const QUERIES: Q[] = [
  { name: 'loadCards-daily', src: 'apps/api/src/review/queue.ts:31-40', sql: `
    select (c.suspended_at is not null) as suspended, b.area::text as area, c.id, c.board_id, c.type, c."order", c.x, c.y,
      (extract(epoch from b.updated_at) * 1000)::float8 as board_ms, (b.user_id = :user) as own, ${subs} as subs
    from cards c join boards b on b.id = c.board_id
    where c.deleted_at is null and (false or c.type <> 'note')
      and b.archived_at is null and (b.user_id = :user or exists (select 1 from fsrs_state s where s.user_id = :user and s.card_id = c.id))` },
  { name: 'loadCards-board', src: 'apps/api/src/review/queue.ts:31-40', sql: `
    select c.id, c.board_id, c.type, c."order", c.x, c.y, (b.user_id = :user) as own, ${subs} as subs
    from cards c join boards b on b.id = c.board_id where c.deleted_at is null and c.type <> 'note' and c.board_id = :board` },
  { name: 'loadStates', src: 'apps/api/src/review/queue.ts:46-55', sql: `
    select card_id, sub_id, stability, difficulty, (extract(epoch from due) * 1000)::float8 as due_ms, reps, lapses,
      (extract(epoch from last_review) * 1000)::float8 as last_ms, state, learning_steps, scheduled_days, (extract(epoch from created_at) * 1000)::float8 as created_ms
    from fsrs_state where user_id = :user` },
  { name: 'hub-attempts', src: 'apps/api/src/review/hub.ts:33-38', sql: `
    select ((a.created_at at time zone ${tz}) - interval '4 hours')::date::text as day, c.board_id, b.area::text as area,
      count(*)::int as n, (count(*) filter (where a.grade >= 3))::int as hits
    from attempts a join cards c on c.id = a.card_id join boards b on b.id = c.board_id
    where a.user_id = :user and a.created_at >= (${day} - 400) at time zone ${tz} + interval '4 hours' group by 1, 2, 3` },
  { name: 'boards-list', src: 'apps/api/src/boards/boards.ts:49-62', sql: `
    select boards.id, boards.title, boards.area, boards.matrix_item_id, boards.status, boards.updated_at, boards.access, boards.archived_at,
      coalesce((select array_agg(bm.matrix_item_id order by bm.created_at, bm.matrix_item_id) from board_matrix_items bm where bm.board_id = boards.id), '{}'),
      (select count(*)::int from cards c where c.board_id = boards.id and c.deleted_at is null),
      (select count(*)::int from edges e ${live} where e.board_id = boards.id)
    from boards where boards.user_id = :user and boards.archived_at is null order by boards.updated_at desc` },
  { name: 'boards-list-edges', src: 'apps/api/src/review/queue.ts:176-180', sql: `
    select e.board_id, e.from_card_id, e.to_card_id from edges e ${live} where e.board_id = any(:boards::uuid[])` },
  { name: 'getBoard-cards', src: 'apps/api/src/boards/boards.ts:71-83', sql: `
    select id, board_id, type, shape, title, front, front_asset_id, back, back_asset_id, width, height, tags, source, x, y, status, "order", reviewer_id, updated_at, payload, suspended_at
    from cards where board_id = :board and deleted_at is null order by "order", created_at` },
  { name: 'getBoard-edges', src: 'apps/api/src/boards/boards.ts:85-87', sql: `
    select e.id, e.board_id, e.from_card_id, e.to_card_id, e.label, e.question from edges e ${live} where e.board_id = :board order by e.created_at, e.id` },
  { name: 'getBoard-version', src: 'apps/api/src/boards/boards.ts:90-95', sql: `
    select changelog from board_versions where board_id = :board order by version desc limit 1` },
  { name: 'challenge-start-ctx-cards', src: 'apps/api/src/challenge/build.ts:179', sql: `
    select * from cards where board_id = any(:boards::uuid[]) and deleted_at is null and suspended_at is null and type <> 'note'` },
  { name: 'challenge-start-ctx-states', src: 'apps/api/src/challenge/build.ts:190', sql: `
    select * from fsrs_state where user_id = :user and card_id in (select id from cards where board_id = any(:boards::uuid[]))` },
  { name: 'challenge-start-last-mode', src: 'apps/api/src/challenge/build.ts:194-197', sql: `
    select distinct on (card_id) card_id, mode, count(*) over (partition by card_id)::int as n
    from attempts where user_id = :user and card_id = any(:cards5::uuid[]) order by card_id, created_at desc` },
  { name: 'challenge-rate-lock', src: 'apps/api/src/review/record-attempt.ts:79-84', sql: `
    insert into fsrs_state (user_id, card_id, sub_id, due, created_at)
    select :user, c.id, '', now(), now() from cards c where c.id = :card and c.deleted_at is null and c.type <> 'note'
    on conflict (user_id, card_id, sub_id) do update set user_id = excluded.user_id
    returning stability, difficulty, due, reps, lapses, last_review, state, learning_steps, scheduled_days` },
  { name: 'challenge-rate-write', src: 'apps/api/src/review/record-attempt.ts:95-106', sql: `
    with a as (
      insert into attempts (id, user_id, card_id, sub_id, session_id, mode, input_kind, grade, duration_ms, created_at)
      values (gen_random_uuid(), :user, :card, '', :session, 'hidden_card', 'self', 3, 5000, now()) on conflict (id) do nothing returning id
    ), f as (
      update fsrs_state set reps = reps + 1, due = now() + interval '3 days', last_review = now(), updated_at = now()
      where user_id = :user and card_id = :card and sub_id = '' and exists (select 1 from a) returning 1
    )
    update sessions set updated_at = now() where id = :session` },
  { name: 'home-attempts', src: 'apps/api/src/home/home.ts:16-19', sql: `
    select ((created_at at time zone ${tz}) - interval '4 hours')::date::text as d, count(*)::int as n
    from attempts where user_id = :user and created_at >= now() - make_interval(days => 400) group by 1` },
  { name: 'progress-attempts', src: 'apps/api/src/reports/progress.ts:11-24', sql: `
    select day, count(*)::int, count(*) filter (where grade >= 3)::int, area, matrix_item_id, max(matrix_title) from (
      select ((a.created_at at time zone ${tz}) - interval '4 hours')::date::text as day, a.grade, b.area, b.matrix_item_id, mi.title as matrix_title
      from attempts a join cards c on c.id = a.card_id join boards b on b.id = c.board_id left join matrix_items mi on mi.id = b.matrix_item_id
      where a.user_id = :user and a.created_at >= (${day} - 29) at time zone ${tz} + interval '4 hours') s
    group by day, area, matrix_item_id` },
  { name: 'progress-weak', src: 'apps/api/src/reports/progress.ts:25-36', sql: `
    select f.card_id, c.board_id, c.title, f.stability, f.difficulty, f.due, f.reps, f.lapses, f.last_review, f.state::text, f.learning_steps, f.scheduled_days
    from fsrs_state f join cards c on c.id = f.card_id where f.user_id = :user and f.sub_id = '' and f.reps > 0 and f.last_review is not null` },
  { name: 'progress-studied', src: 'apps/api/src/reports/progress.ts:37-42', sql: `
    select distinct ((a.created_at at time zone ${tz}) - interval '4 hours')::date::text as day from attempts a
    where a.user_id = :user and a.created_at >= (${day} - 399) at time zone ${tz} + interval '4 hours'` },
  { name: 'admin-overview-counts', src: 'apps/api/src/admin/overview/routes.ts:44-54', admin: true, sql: `
    select (select count(*)::int from profiles where deleted_at is null),
      (select count(*)::int from boards where status = 'private' and archived_at is null),
      (select count(*)::int from support_tickets where status in ('open', 'in_review')),
      (select count(*)::int from payments where status = 'failed' and updated_at > now() - interval '24 hours'),
      (select count(*)::int from boards where status = 'seed_draft' and archived_at is null)` },
  { name: 'admin-overview-maps', src: 'apps/api/src/admin/overview/routes.ts:58-61', admin: true, sql: `
    select b.id, b.title, b.user_id, pr.name, u.email, b.created_at, b.area::text,
      (select count(*)::int from cards c where c.board_id = b.id and c.deleted_at is null) as cards
    from (select * from boards where status = 'private' order by created_at desc limit 8) b
    left join profiles pr on pr.user_id = b.user_id left join auth.users u on u.id = b.user_id order by b.created_at desc` },
];

/** G21 "depois": SQL built by the current app code (apps/api/src/review/queue.ts, stats.ts, hub.ts), rendered with its parameters inlined. */
export async function generated(user: string, sqlc: postgres.Sql): Promise<Q[]> {
  const root = '../../../../apps/api/src/review/';
  const [{ PgDialect }, { sql }, q, st] = await Promise.all([import('drizzle-orm/pg-core'), import('drizzle-orm'), import(`${root}queue`), import(`${root}stats`)]);
  const d = new PgDialect();
  const render = (x: ReturnType<typeof sql>) => { const r = d.sqlToQuery(x); return r.sql.replace(/\$(\d+)/g, (_, i: string) => { const v = r.params[Number(i) - 1]; return typeof v === 'number' || typeof v === 'boolean' ? String(v) : lit(String(v)); }); };
  const now = new Date();
  const [w] = await sqlc.unsafe<{ end_ms: number }[]>(`with w as (${render(q.windowSql(user, now))}) select end_ms from w`);
  const endMs = Math.round(w!.end_ms);
  const scope = { userId: user, boardId: null };
  const mk = (name: string, src: string, x: ReturnType<typeof sql> | null): Q[] => (x ? [{ name, src, sql: render(x) }] : []);
  return [
    ...mk('queue-daily-limit1', 'review/queue.ts queueRowsSql (Hoje, limit=1)', q.queueRowsSql(scope, { now, endMs, due: 1, weak: 1, fresh: { limit: 1, perBoard: null } })),
    ...mk('queue-daily-full', 'review/queue.ts queueRowsSql (fila inteira, 20 novos)', q.queueRowsSql(scope, { now, endMs, due: null, weak: null, fresh: { limit: 20, perBoard: null } })),
    ...mk('hub-queue', 'review/hub.ts via queueRowsSql (20 novos por mapa)', q.queueRowsSql(scope, { now, endMs, due: null, weak: null, fresh: { limit: null, perBoard: 20 } })),
    ...mk('hub-due-forecast', 'review/queue.ts dueByOffsetSql (30 dias)', q.dueByOffsetSql(user, { endMs }, 30)),
    ...mk('boards-list-mapstats', 'review/stats.ts mapStatsSql (lista de mapas)', sql`select ${st.mapStatsSql(user, sql`array(select id from boards where user_id = ${user} and archived_at is null)`, now.getTime(), sql`${endMs}::float8`)}`),
    ...mk('hub-days', 'review/hub.ts user_daily_stats (400 dias)', sql`select day::text, reviews as n, hits from user_daily_stats where user_id = ${user} and day >= current_date - 400`),
  ];
}

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
export const fill = (q: string, p: Record<string, string>) => q.replace(/:(user|boards|board|cards5|card|session)\b/g, (_, k: string) => p[k]!);

async function main() {
  const [label, ...only] = process.argv.slice(2);
  if (label !== 'antes' && label !== 'depois') throw new Error('uso: pnpm perf:explain <antes|depois> [nome...]');
  const sql = postgres(perfTarget().url, { max: 1, onnotice: () => {} });
  const user = userUuid(1);
  const out = fileURLToPath(new URL('../../../../../docs/perf/explain/', import.meta.url));
  mkdirSync(out, { recursive: true });
  try {
    // ids picked once on the plain connection (perf data is deterministic): largest board, 3 most recent boards, 5 most due cards
    const [ids] = await sql<{ board: string; boards: string; cards5: string; card: string; session: string }[]>`select
      (select c.board_id from cards c join boards b on b.id = c.board_id where b.user_id = ${user} group by 1 order by count(*) desc limit 1)::text as board,
      (select array_agg(id)::text from (select id from boards where user_id = ${user} and archived_at is null order by updated_at desc limit 3) x) as boards,
      (select array_agg(card_id)::text from (select card_id from fsrs_state where user_id = ${user} order by due limit 5) x) as cards5,
      (select card_id::text from fsrs_state where user_id = ${user} order by due limit 1) as card,
      coalesce((select id::text from sessions where user_id = ${user} limit 1), gen_random_uuid()::text) as session`;
    if (!ids?.board || !ids.card) throw new Error('remoa_perf sem dados do usuário 1: rode pnpm perf:seed');
    const p = { user: lit(user), board: lit(ids.board), boards: lit(ids.boards), cards5: lit(ids.cards5), card: lit(ids.card), session: lit(ids.session) };
    const all = label === 'depois' ? [...QUERIES, ...(await generated(user, sql))] : QUERIES;
    for (const q of all.filter((x) => !only.length || only.includes(x.name))) {
      const plan = await sql.begin(async (tx) => {
        if (!q.admin) {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: 'authenticated' })}, true), set_config('role', 'authenticated', true)`;
        }
        if (q.name === 'challenge-rate-write') await tx.unsafe(`insert into sessions (id, user_id, kind, started_at, items, options) values (${p.session}::uuid, ${p.user}, 'daily', now(), '[]'::jsonb, '{}'::jsonb) on conflict do nothing`);
        const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(`explain (analyze, buffers, settings) ${fill(q.sql, p)}`);
        throw Object.assign(new Error('rollback'), { plan: rows.map((r) => r['QUERY PLAN']).join('\n') });
      }).catch((e: { plan?: string }) => { if (e.plan !== undefined) return e.plan; throw e; });
      const head = [`-- ${q.name} (${label}) ${new Date().toISOString()} load ${loadavg().map((l) => l.toFixed(1)).join(' ')}`,
        `-- fonte: ${q.src}; papel: ${q.admin ? 'conexão do app (sem RLS)' : 'authenticated + claims do usuário perf 1'}`, fill(q.sql, p).trim(), ''];
      writeFileSync(`${out}${q.name}-${label}.txt`, `${head.join('\n')}\n${plan}\n`);
      process.stdout.write(`${q.name}-${label}.txt ${/Execution Time: ([\d.]+)/.exec(plan)?.[1] ?? '?'} ms\n`);
    }
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
