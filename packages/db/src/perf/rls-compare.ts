// G21 (D-1056, P-495): compares cards/edges RLS variants on remoa_perf (isolated, local only: perfTarget). Each query runs 3x per variant
// in a rolled-back transaction where the variant's ALTER POLICYs are applied first (as supabase_admin, the table owner), then as
// `authenticated` + claims of perf user 1. Prints min Execution Time and whether `Seq Scan on cards` showed up.
// Usage (packages/db): pnpm exec tsx --env-file=../../.env src/perf/rls-compare.ts 0031 0032 exists any   [SEEDS=4 marks ~25% of the
// other users' boards seed_approved inside the transaction, to stress the visible-board array]. Variant `0032` = no change = what is applied (0035 once migrated); `in` = the 0032 policies.
import postgres from 'postgres';
import { QUERIES, fill, generated } from './explain';
import { perfTarget, userUuid } from './target';

const OWN = `SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())`;
const V: Record<string, string[]> = {
  '0032': [],
  '0031': [
    `ALTER POLICY boards_select ON public.boards USING (user_id = auth.uid() OR status = 'seed_approved' OR (status = 'seed_draft' AND public.is_reviewer()))`,
    `ALTER POLICY cards_select ON public.cards USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id))`,
    `ALTER POLICY cards_write ON public.cards USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()))`,
    `ALTER POLICY edges_select ON public.edges USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id))`,
    `ALTER POLICY edges_write ON public.edges USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()))`,
  ],
  exists: ['cards', 'edges'].flatMap((t) => [
    `ALTER POLICY ${t}_select ON public.${t} USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = ${t}.board_id))`,
    `ALTER POLICY ${t}_write ON public.${t} USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = ${t}.board_id AND b.user_id = (select auth.uid())))`,
  ]),
  in: ['cards', 'edges'].flatMap((t) => [
    `ALTER POLICY ${t}_select ON public.${t} USING (board_id IN (SELECT b.id FROM public.boards b))`,
    `ALTER POLICY ${t}_write ON public.${t} USING (board_id IN (${OWN}))`,
  ]),
  any: ['cards', 'edges'].flatMap((t) => [
    `ALTER POLICY ${t}_select ON public.${t} USING (board_id = ANY (ARRAY(SELECT b.id FROM public.boards b)))`,
    `ALTER POLICY ${t}_write ON public.${t} USING (board_id = ANY (ARRAY(${OWN})))`,
  ]),
};
const lit = (v: string) => `'${v}'`;
const EXTRA = [
  { name: 'prod-loadCards-all (preview)', sql: `select c.id, c.board_id from cards c join boards b on b.id = c.board_id where c.deleted_at is null and b.archived_at is null and c.board_id = any(array(
      select id from boards where user_id = :user and archived_at is null union select c3.board_id from fsrs_state s join cards c3 on c3.id = s.card_id where s.user_id = :user))
      and (b.user_id = :user or exists (select 1 from fsrs_state s where s.user_id = :user and s.card_id = c.id))` },
  { name: 'prod-rebuild-boards', sql: `select id from boards where user_id = :user union select distinct c.board_id from fsrs_state f join cards c on c.id = f.card_id where f.user_id = :user` },
  { name: 'prod-moveCards', sql: `update cards set x = v.x, y = v.y, updated_at = now() from unnest(:cards5::uuid[], '{1,2,3,4,5}'::int[], '{1,2,3,4,5}'::int[]) as v(id, x, y) where cards.id = v.id and cards.board_id = :board` },
  { name: 'prod-card-live', sql: `select id from cards where id = :card and deleted_at is null` },
  { name: 'prod-progress-weak (lateral)', sql: `select f.card_id, c.board_id, c.title from fsrs_state f cross join lateral (select c.board_id, c.title from cards c where c.id = f.card_id offset 0) c
      where f.user_id = :user and f.sub_id = '' and f.reps > 0 and f.last_review is not null order by f.stability, f.card_id limit 20` },
  { name: 'prod-masks-board', sql: `select m.* from masks m where m.card_id in (select id from cards where board_id = :board)` },
];

async function main() {
  const variants = process.argv.slice(2);
  const sql = postgres(perfTarget().url.replace('//postgres:', '//supabase_admin:'), { max: 1, onnotice: () => {} });
  const user = userUuid(1);
  const [ids] = await sql<{ board: string; boards: string; cards5: string; card: string; session: string }[]>`select
      (select c.board_id from cards c join boards b on b.id = c.board_id where b.user_id = ${user} group by 1 order by count(*) desc limit 1)::text as board,
      (select array_agg(id)::text from (select id from boards where user_id = ${user} and archived_at is null order by updated_at desc limit 3) x) as boards,
      (select array_agg(card_id)::text from (select card_id from fsrs_state where user_id = ${user} order by due limit 5) x) as cards5,
      (select card_id::text from fsrs_state where user_id = ${user} order by due limit 1) as card,
      coalesce((select id::text from sessions where user_id = ${user} limit 1), gen_random_uuid()::text) as session`;
  const p = { user: lit(user), board: lit(ids!.board), boards: lit(ids!.boards), cards5: lit(ids!.cards5), card: lit(ids!.card), session: lit(ids!.session) };
  const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null; // e.g. ONLY='^(?!loadCards-daily)' skips the retired full scan
  const all = [...QUERIES.filter((q) => !q.admin), ...(await generated(user, sql)), ...EXTRA].filter((q) => !only || only.test(q.name));
  const res: Record<string, Record<string, string>> = {};
  for (const v of variants) for (const q of all) {
    const ts: number[] = []; let seq = false;
    for (let i = 0; i < 3; i++) {
      const plan = await sql.begin(async (tx) => {
        for (const a of V[v]!) await tx.unsafe(a);
        if (process.env.SEEDS) await tx.unsafe(`update boards set status = 'seed_approved' where user_id <> ${p.user} and id::text < '${process.env.SEEDS}'`);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: 'authenticated' })}, true), set_config('role', 'authenticated', true)`;
        if (q.name === 'challenge-rate-write') await tx.unsafe(`insert into sessions (id, user_id, kind, started_at, items, options) values (${p.session}::uuid, ${p.user}, 'daily', now(), '[]'::jsonb, '{}'::jsonb) on conflict do nothing`);
        const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(`explain (analyze, buffers) ${fill(q.sql, p)}`);
        throw Object.assign(new Error('rollback'), { plan: rows.map((r) => r['QUERY PLAN']).join('\n') });
      }).catch((e: { plan?: string }) => { if (e.plan !== undefined) return e.plan; throw e; });
      ts.push(Number(/Execution Time: ([\d.]+)/.exec(plan)?.[1])); seq ||= /Seq Scan on cards/.test(plan);
      if (process.env.DUMP === q.name) process.stdout.write(`--- ${v}\n${plan}\n`);
    }
    (res[q.name] ??= {})[v] = `${Math.min(...ts).toFixed(1)}${seq ? ' (seq cards)' : ''}`;
  }
  for (const [n, r] of Object.entries(res)) process.stdout.write(`${n.padEnd(30)} ${variants.map((v) => (r[v] ?? '').padEnd(20)).join(' ')}\n`);
  await sql.end();
}
main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
