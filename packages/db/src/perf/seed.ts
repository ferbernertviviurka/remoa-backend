// G21 T2 FR-2 (D-985): `pnpm perf:seed` builds the isolated database `remoa_perf` (same Postgres as the local Supabase, never `postgres`)
// with a deterministic, realistic dataset. Schema: pg_dump --schema-only of the local `postgres` (public + auth) restored into the new
// database; no migrations replay (auth.* is Supabase-owned). Deterministic: ids are md5(text)::uuid, "random" is hashtext(text).
// Knobs: PERF_SEED_USERS (200), PERF_SEED_CARDS_MIN/MAX (2000/10000 per user), PERF_DATABASE_URL (local remoa_perf* only).
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { PG_CONTAINER, perfTarget } from './target';

const N = Number(process.env.PERF_SEED_USERS ?? 200);
const CMIN = Number(process.env.PERF_SEED_CARDS_MIN ?? 2000);
const CMAX = Number(process.env.PERF_SEED_CARDS_MAX ?? 10000);
const CHUNK = 10;

const t = perfTarget();
const psql = (db: string, args: string[], input?: string) => {
  const r = spawnSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'supabase_admin', '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', ...args], { input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`psql ${db} ${args.join(' ')}: ${r.stderr}`);
};

function recreate() {
  const dump = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres', '-s', '--no-owner', '-n', 'public', '-n', 'auth'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (dump.status !== 0) throw new Error(`pg_dump: ${dump.stderr}`);
  psql('postgres', ['-c', `drop database if exists ${t.db} with (force)`, '-c', `create database ${t.db}`]);
  psql(t.db, ['-c', 'create schema if not exists extensions', '-c', 'create extension "uuid-ossp" schema extensions', '-c', 'create extension pgcrypto schema extensions',
    '-c', 'create extension pg_stat_statements schema extensions', '-c', 'create extension pg_trgm schema public']);
  // the dump starts with CREATE SCHEMA public, which exists in a fresh database
  psql(t.db, [], dump.stdout.replace('CREATE SCHEMA public;', '-- CREATE SCHEMA public;'));
}

const sql = () => postgres(t.url.replace('//postgres:', '//supabase_admin:'), { max: 1, onnotice: () => {}, idle_timeout: 0 });
const H = (e: string) => `abs(hashtext(${e}))`;
const ts = Date.now();
const log = (m: string) => process.stdout.write(`[seed ${((Date.now() - ts) / 1000).toFixed(0)}s] ${m}\n`);

async function main() {
  log(`recreating ${t.db} (users ${N + 1}, cards ${CMIN}-${CMAX}/user)`);
  recreate();
  const db = sql();
  const x = (q: string) => db.unsafe(q);
  const uid = (c: string) => `md5('perf-user-'||${c})::uuid`;

  await x(`insert into public.matrix_items (id, area, code, title, target_cards, temporal_mark)
    select md5('mx:'||i)::uuid, 'CM', 'PERF.'||i, 'Tema '||i||' da Clínica Médica', 40, 'perf' from generate_series(1,40) i`);
  await x(`insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select '00000000-0000-0000-0000-000000000000', ${uid('u')}, 'authenticated', 'authenticated', 'perf'||u||'@remoa.local', '', now(),
      '{"provider":"email","providers":["email"]}', '{}', now() - make_interval(days => 5 + ${H("'u'||u")} % 200), now() from generate_series(0,${N}) u`);
  await x(`insert into auth.sessions (id, user_id, created_at, updated_at) select md5('perf-session-'||u)::uuid, ${uid('u')}, now(), now() from generate_series(0,${N}) u`);
  await x(`update public.profiles set name = 'Aluno Perf', timezone = 'America/Sao_Paulo', onboarding_done_at = now(), goal = 'residencia', year = 6
    where user_id in (select ${uid('u')} from generate_series(0,${N}) u)`);
  await x(`update public.profiles set role = 'admin' where user_id = ${uid('0')}`);
  log('users + sessions');

  // plan: per-user card and board counts; user 1 = heavy (10k cards, boards of 2000 and 500)
  await x(`create temp table pu as select u, ${uid('u')} as uid,
      case when u = 1 then 10000 when u = 0 then 50 else ${CMIN} + ${H("'c'||u")} % ${CMAX - CMIN + 1} end as cu,
      case when u = 1 then 20 when u = 0 then 2 else 20 + ${H("'b'||u")} % 31 end as nb from generate_series(0,${N}) u`);
  await x(`create temp table pb as select pu.u, pu.uid, b,
      case when pu.u = 1 and b = 1 then 2000 when pu.u = 1 and b = 2 then 500 when pu.u = 1 then (10000 - 2500) / 18 else greatest(1, pu.cu / pu.nb) end as n
    from pu, generate_series(1, pu.nb) b`);
  await x(`insert into public.boards (id, user_id, title, area, matrix_item_id, status, created_at)
    select md5('b:'||u||':'||b)::uuid, uid, case when u = 1 and b = 1 then 'Mapa grande 2000' when u = 1 and b = 2 then 'Mapa médio 500' else 'Mapa '||b||' de estudo' end, 'CM',
      md5('mx:'||(1 + ${H("u||':'||b")} % 40))::uuid, 'private', now() - make_interval(days => ${H("'bd'||u||b")} % 120) from pb`);
  log('boards');

  for (let a = 0; a <= N; a += CHUNK) {
    const w = `u between ${a} and ${Math.min(a + CHUNK - 1, N)}`;
    await x(`insert into public.cards (id, board_id, type, title, front, back, tags, x, y, status, "order", created_at)
      select md5('c:'||pb.u||':'||pb.b||':'||k)::uuid, md5('b:'||pb.u||':'||pb.b)::uuid, 'concept', 'Conceito '||pb.b||'.'||k||' '||(array['Insuficiência cardíaca','Diabetes','Sepse','Asma','IAM','Anemia'])[1 + k % 6],
        'Qual a conduta no quadro '||k||'?', repeat('Resposta objetiva com critério diagnóstico e conduta inicial. ', 4 + k % 4),
        array['cm','tema'||(k % 40)], (k % 25) * 220, (k / 25) * 140, 'approved', k, now() - make_interval(days => ${H("'cd'||pb.u||pb.b||k")} % 120)
      from pb, generate_series(1, pb.n) k where pb.${w}`);
    await x(`insert into public.edges (id, board_id, from_card_id, to_card_id, label)
      select md5('e:'||pb.u||':'||pb.b||':'||k)::uuid, md5('b:'||pb.u||':'||pb.b)::uuid, md5('c:'||pb.u||':'||pb.b||':'||(k / 2))::uuid, md5('c:'||pb.u||':'||pb.b||':'||k)::uuid,
        (array['causa','leva a','trata com','diferencia de'])[1 + k % 4]
      from pb, generate_series(2, pb.n) k where pb.${w}`);
    if (a % 50 === 0) log(`cards/edges users ${a}..`);
  }
  log('cards + edges done');

  // reviews: reviewed cards per user (user 1: 3000, others 60-159); each with 1-4 attempts and a coherent fsrs_state (reps = attempts, lapses = grade 1s)
  await x(`create temp table rv as
    select c.id as card_id, b.user_id, 1 + ${H("c.id::text||'r'")} % 4 as reps, ${H("c.id::text||'a'")} % 25 as ago, 1 + ${H("c.id::text||'s'")} % 20 as sched
    from public.cards c join public.boards b on b.id = c.board_id join pu on pu.uid = b.user_id
    where pu.u > 0 and ${H("c.id::text||'p'")} % 100000 < (case when pu.u = 1 then 3000 else 60 + ${H("'rc'||pu.u")} % 100 end)::numeric / pu.cu * 100000`);
  await x(`create temp table rg as select rv.*, s, case when ${H("rv.card_id::text||s")} % 100 < 15 then 1 when ${H("rv.card_id::text||s")} % 100 < 30 then 2 when ${H("rv.card_id::text||s")} % 100 < 80 then 3 else 4 end as grade
    from rv, generate_series(1, rv.reps) s where s <= rv.reps`);
  await x(`insert into public.attempts (id, user_id, card_id, sub_id, mode, input_kind, grade, duration_ms, created_at, updated_at)
    select md5('a:'||card_id||':'||s)::uuid, user_id, card_id, '', 'hidden_card', 'self', grade, 3000 + ${H("card_id::text||s")} % 20000,
      now() - make_interval(days => ago) - make_interval(days => (reps - s) * sched), now() - make_interval(days => ago) - make_interval(days => (reps - s) * sched) from rg`);
  await x(`insert into public.fsrs_state (user_id, card_id, sub_id, stability, difficulty, due, reps, lapses, last_review, state, scheduled_days, learning_steps)
    select rv.user_id, rv.card_id, '', rv.sched * 1.5, 3 + (${H("rv.card_id::text||'d'")} % 50) / 10.0, now() - make_interval(days => rv.ago) + make_interval(days => rv.sched), rv.reps,
      (select count(*) from rg where rg.card_id = rv.card_id and rg.grade = 1), now() - make_interval(days => rv.ago),
      (case when rv.reps >= 2 then 'review' else 'learning' end)::fsrs_card_state, rv.sched, 0 from rv`);
  log('attempts + fsrs_state');

  // notifications, calendar, support, referrals, payments
  await x(`insert into public.notifications (id, user_id, type, category, href, data, idempotency_key, created_at, read_at)
    select md5('n:'||u||':'||k)::uuid, uid,
      (array['review_reminder','calendar_d1','map_ready','referral_reward','support_reply','purchase'])[1 + k % 6]::notification_type,
      (array['review','calendar','maps','referrals','support','account_billing'])[1 + k % 6]::notification_category, '/app/revisar', '{}',
      (array['review_reminder','calendar_d1','map_ready','referral_reward','support_reply','purchase'])[1 + k % 6]||':'||k,
      now() - make_interval(hours => ${H("'nc'||u||k")} % 2160), case when ${H("'nr'||u||k")} % 10 < 7 then now() else null end
    from pu, generate_series(1, case when pu.u = 1 then 2000 else 20 + ${H("'nn'||pu.u")} % 180 end) k`);
  await x(`insert into public.calendar_labels (id, user_id, name, color, system_key, position)
    select md5('cl:'||u||':'||i)::uuid, uid, (array['Prova','Trabalho','Data importante','Plantão','Pessoal'])[i], (array['orange','amber','purple','teal','gray'])[i]::calendar_color,
      (array['exam','assignment','important_date','shift','personal'])[i], i from pu, generate_series(1,5) i`);
  await x(`insert into public.calendar_events (id, user_id, title, label_id, starts_at, ends_at, timezone)
    select md5('ce:'||u||':'||k)::uuid, uid, 'Evento '||k, md5('cl:'||u||':'||(1 + k % 5))::uuid,
      date_trunc('hour', now()) + make_interval(hours => (${H("'cs'||u||k")} % 2880) - 1440), date_trunc('hour', now()) + make_interval(hours => (${H("'cs'||u||k")} % 2880) - 1440 + 1), 'America/Sao_Paulo'
    from pu, generate_series(1, case when pu.u = 1 then 400 else 15 + ${H("'ce'||pu.u")} % 45 end) k`);
  await x(`insert into public.calendar_reminders (id, user_id, event_id, kind, occurrence_date, send_at)
    select md5('cr:'||e.id||kd)::uuid, e.user_id, e.id, kd::calendar_reminder_kind, (e.starts_at at time zone 'America/Sao_Paulo')::date, e.starts_at - (case when kd = 'd1' then interval '1 day' else interval '2 hours' end)
    from public.calendar_events e, unnest(array['d1','d0']) kd where e.starts_at > now()`);
  await x(`insert into public.support_tickets (id, user_id, type, subject, status, created_at, last_user_message_at)
    select md5('t:'||u||':'||k)::uuid, uid, (array['bug','billing','content','suggestion','other'])[1 + k % 5]::support_ticket_type, 'Chamado de teste '||u||'-'||k, 'open', now() - make_interval(days => k), now() - make_interval(days => k)
    from pu, generate_series(1, 1 + ${H("'tk'||pu.u")} % 3) k where pu.u % 10 = 3`);
  await x(`insert into public.support_messages (ticket_id, author_type, author_id, body, created_at)
    select t.id, (case when m = 1 then 'user' else 'admin' end)::support_author_type, case when m = 1 then t.user_id else null end, 'Mensagem '||m||' do chamado '||t.number, t.created_at + make_interval(hours => m) from public.support_tickets t, generate_series(1,2) m`);
  await x(`insert into public.referral_codes (user_id, code) select uid, translate(upper(left(md5('rc'||u), 8)), '01ILO', '9ABCD') from pu`);
  await x(`insert into public.referrals (id, referrer_id, referee_id, channel, status, signed_up_at, qualified_at, created_at)
    select md5('rf:'||u)::uuid, uid, md5('perf-user-'||(u + 1))::uuid, 'link', 'qualified', now() - interval '20 days', now() - interval '10 days', now() - interval '30 days' from pu where u % 5 = 0 and u < ${N} and u > 0`);
  await x(`insert into public.referrals (referrer_id, invited_email_hash, invited_email_masked, channel, status, created_at, expires_at)
    select uid, md5('inv'||u||k)||md5('inv2'||u||k), 'a***@exemplo.test', 'email', 'invited', now() - make_interval(days => k), now() + interval '20 days' from pu, generate_series(1,2) k where u % 5 = 0`);
  await x(`insert into public.payments (id, user_id, amount_cents, method, status, item, created_at)
    select 'pi_perf_'||u||'_'||k, uid, 3990, (array['pix','card'])[1 + k % 2], 'paid', 'pro_monthly', now() - make_interval(days => 30 * k) from pu, generate_series(1, 1 + ${H("'pm'||pu.u")} % 6) k where u % 7 = 0 and u > 0`);
  await x(`insert into public.subscriptions (user_id, plan, status, renews_at) select uid, 'pro', 'active', now() + interval '10 days' from pu where u % 7 = 0 and u > 0
    on conflict (user_id) do update set plan = 'pro'`);
  await x(`insert into public.usage_counters (user_id, period, ai_grades, boards, cards) select uid, current_date, u % 20, nb, cu from pu`);
  await x(`insert into public.admin_metrics_daily (day, new_accounts, new_maps, new_pro, revenue_cents) select (current_date - d), 5 + d % 7, 20 + d % 13, d % 3, 3990 * (d % 3) from generate_series(0,89) d`);
  await x(`insert into public.blog_categories (id, slug, name, position) select md5('bc:'||i)::uuid, 'categoria-'||i, 'Categoria '||i, i from generate_series(1,4) i`);
  await x(`insert into public.blog_posts (id, slug, title, description, excerpt, content_html, category_id, status, published_at, reading_minutes, word_count)
    select md5('bp:'||i)::uuid, 'post-'||i, 'Post de teste '||i, 'Descrição do post '||i, 'Resumo '||i, repeat('<p>Parágrafo de conteúdo clínico para o blog, com texto longo o bastante para pesar.</p>', 80),
      md5('bc:'||(1 + i % 4))::uuid, 'published', now() - make_interval(days => i), 5, 1200 from generate_series(1,30) i`);
  log('secondary tables');

  await db.end();
  const db2 = postgres(t.url.replace('//postgres:', '//supabase_admin:'), { max: 1, onnotice: () => {} });
  await db2.unsafe('analyze');
  const [c] = await db2.unsafe(`select (select count(*) from auth.users) users, (select count(*) from boards) boards, (select count(*) from cards) cards, (select count(*) from edges) edges,
    (select count(*) from attempts) attempts, (select count(*) from fsrs_state) fsrs, (select count(*) from notifications) notifications, (select count(*) from calendar_events) events,
    (select count(*) from support_tickets) tickets, (select count(*) from referrals) referrals, (select count(*) from payments) payments, pg_size_pretty(pg_database_size(current_database())) size`);
  await db2.end();
  log(`done ${JSON.stringify(c)}`);
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack : e}\n`); process.exit(1); });
