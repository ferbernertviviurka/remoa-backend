// G21 T2 FR-5 (D-986): `pnpm perf:bench [--strict]` runs the HTTP scenarios against a private API (port 4300+, isolated remoa_perf database,
// NODE_ENV=development STRIPE/GRADER/AI=mock) and prints Markdown; JSON goes to docs/perf/bench-<date>.json. Light load: PERF_BENCH_N requests
// per scenario (30), concurrency PERF_BENCH_C (3), 2 warm-up requests discarded. Uses PERF_API_URL instead if you already run a perf API.
// Per scenario it diffs pg_stat_statements (role `postgres` = the API), so queries per request come from the database; Server-Timing and
// X-Remoa-Queries headers (G21 T1) are read when the API sends them. `--strict` exits 1 when a budget (F26: p95 > 800 ms, > 2 s, FR-19 queries) is crossed.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { perfTarget, perfToken } from './target';
import { resetStatements, topQueries } from './queries';

const N = Number(process.env.PERF_BENCH_N ?? 30);
const C = Number(process.env.PERF_BENCH_C ?? 3);
const WARM = 2;
const SLOW = 800;
const VERY_SLOW = 2000;
const HEAVY = 1;
const TYPICAL = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const t = perfTarget();
const secret = process.env.SUPABASE_JWT_SECRET ?? '';
if (!secret) throw new Error('SUPABASE_JWT_SECRET missing (run through pnpm perf:bench, which loads .env)');
const root = join(import.meta.dirname, '..', '..', '..', '..');
const md5uuid = (s: string) => { const h = createHash('md5').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const bid = (u: number, b: number) => md5uuid(`b:${u}:${b}`);

type Ctx = { token: string; user: number; i: number; state: Record<string, unknown> };
type Scenario = {
  name: string; method?: 'GET' | 'POST'; /** user index (number), 'typical' (rotates) or null = no auth */ as: number | 'typical' | null;
  path: (c: Ctx) => string; body?: (c: Ctx) => unknown; qBudget?: number;
  /** called with the parsed JSON; may stash ids for the next scenario */ after?: (c: Ctx, json: any) => void; serial?: boolean; group: string;
};
const range = () => { const d = new Date(); const y = d.getFullYear(), m = d.getMonth(); const p = (n: number) => String(n).padStart(2, '0'); return `from=${y}-${p(m + 1)}-01&to=${y}-${p(m + 1)}-${p(new Date(y, m + 1, 0).getDate())}`; };

const S: Scenario[] = [
  // --- página Hoje (apps/web hoje/page.tsx): 6 chamadas em paralelo + fila -> board -> retrievability ---
  { group: 'Hoje', name: 'Hoje: GET /v1/home', as: 'typical', path: () => '/v1/home', qBudget: 8 },
  { group: 'Hoje', name: 'Hoje: GET /v1/boards (Biblioteca)', as: 'typical', path: () => '/v1/boards', qBudget: 4 },
  { group: 'Hoje', name: 'Hoje: GET /v1/coverage', as: 'typical', path: () => '/v1/coverage' },
  { group: 'Hoje', name: 'Hoje: GET /v1/onboarding', as: 'typical', path: () => '/v1/onboarding' },
  { group: 'Hoje', name: 'Hoje: GET /v1/calendar/upcoming?limit=4', as: 'typical', path: () => '/v1/calendar/upcoming?limit=4', qBudget: 3 },
  { group: 'Hoje', name: 'Hoje: GET /v1/account/me', as: 'typical', path: () => '/v1/account/me' },
  { group: 'Hoje', name: 'Hoje: GET /v1/review/queue?limit=1', as: 'typical', path: () => '/v1/review/queue?limit=1', qBudget: 6 },
  { group: 'Hoje', name: 'Hoje: GET /v1/review/retrievability?boardId', as: 'typical', path: (c) => `/v1/review/retrievability?boardId=${bid(c.user, 1)}` },
  { group: 'Hoje (usuário pesado, 10 mil cards)', name: 'Hoje (pesado): GET /v1/home', as: HEAVY, path: () => '/v1/home', qBudget: 8 },
  { group: 'Hoje (usuário pesado, 10 mil cards)', name: 'Hoje (pesado): GET /v1/boards', as: HEAVY, path: () => '/v1/boards', qBudget: 4 },
  { group: 'Hoje (usuário pesado, 10 mil cards)', name: 'Hoje (pesado): GET /v1/coverage', as: HEAVY, path: () => '/v1/coverage' },
  { group: 'Hoje (usuário pesado, 10 mil cards)', name: 'Hoje (pesado): GET /v1/review/queue?limit=1', as: HEAVY, path: () => '/v1/review/queue?limit=1', qBudget: 6 },
  // --- mapas ---
  { group: 'Mapas', name: 'Abrir mapa típico (~170 cards): GET /v1/boards/:id', as: 'typical', path: (c) => `/v1/boards/${bid(c.user, 1)}`, qBudget: 5 },
  { group: 'Mapas', name: 'Abrir mapa de 500 cards: GET /v1/boards/:id', as: HEAVY, path: () => `/v1/boards/${bid(HEAVY, 2)}`, qBudget: 5 },
  { group: 'Mapas', name: 'Abrir mapa de 2.000 cards: GET /v1/boards/:id', as: HEAVY, path: () => `/v1/boards/${bid(HEAVY, 1)}`, qBudget: 5 },
  // --- revisão ---
  { group: 'Revisar', name: 'Fila de revisão: GET /v1/review/queue', as: 'typical', path: () => '/v1/review/queue', qBudget: 6 },
  { group: 'Revisar', name: 'Fila de revisão (pesado): GET /v1/review/queue', as: HEAVY, path: () => '/v1/review/queue', qBudget: 6 },
  { group: 'Revisar', name: 'Revisar hub: GET /v1/review/hub', as: 'typical', path: () => '/v1/review/hub', qBudget: 6 },
  { group: 'Revisar', name: 'Revisar hub (pesado): GET /v1/review/hub', as: HEAVY, path: () => '/v1/review/hub', qBudget: 6 },
  { group: 'Revisar', name: 'Progresso: GET /v1/reports/progress', as: 'typical', path: () => '/v1/reports/progress' },
  { group: 'Revisar', name: 'Iniciar sessão: POST /v1/challenge/start (daily, 5)', method: 'POST', as: 'typical', serial: true, path: () => '/v1/challenge/start',
    body: () => ({ kind: 'daily', limit: 5 }), after: (c, j) => { if (!j?.data?.sessionId) return; const m = (c.state.sessions ??= {}) as Record<number, unknown[]>; (m[c.user] ??= []).push(j.data); } },
  { group: 'Revisar', name: 'Responder card: POST /v1/challenge/answer (self)', method: 'POST', as: 'typical', serial: true, path: () => '/v1/challenge/answer',
    body: (c) => { const s = pick(c); return s && { inputKind: 'self', sessionId: s.sessionId, itemId: s.items[0].id, durationMs: 4000 }; } },
  { group: 'Revisar', name: 'Responder card: POST /v1/challenge/rate', method: 'POST', as: 'typical', serial: true, qBudget: 4, path: () => '/v1/challenge/rate',
    body: (c) => { const s = pick(c); return s && { sessionId: s.sessionId, itemId: s.items[0].id, grade: 3, overridden: false }; } },
  // --- calendário, notificações ---
  { group: 'Calendário', name: 'Calendário (mês): GET /v1/calendar/events', as: 'typical', path: () => `/v1/calendar/events?${range()}`, qBudget: 3 },
  { group: 'Calendário', name: 'Calendário (mês, pesado, 400 eventos)', as: HEAVY, path: () => `/v1/calendar/events?${range()}`, qBudget: 3 },
  { group: 'Calendário', name: 'Calendário: GET /v1/calendar/labels', as: 'typical', path: () => '/v1/calendar/labels' },
  { group: 'Notificações', name: 'Notificações (lista): GET /v1/notifications', as: 'typical', path: () => '/v1/notifications', qBudget: 3 },
  { group: 'Notificações', name: 'Notificações (lista, pesado, 2.000)', as: HEAVY, path: () => '/v1/notifications', qBudget: 3 },
  { group: 'Notificações', name: 'Notificações (contagem): GET /v1/notifications/unread-count', as: 'typical', path: () => '/v1/notifications/unread-count', qBudget: 3 },
  { group: 'Notificações', name: 'Notificações (contagem, pesado)', as: HEAVY, path: () => '/v1/notifications/unread-count', qBudget: 3 },
  // --- admin, blog ---
  { group: 'Admin', name: 'Admin visão geral: GET /v1/admin/overview', as: 0, path: () => '/v1/admin/overview', qBudget: 6 },
  { group: 'Admin', name: 'Admin: GET /v1/admin/me', as: 0, path: () => '/v1/admin/me' },
  { group: 'Blog (público)', name: 'Blog lista: GET /v1/public/blog/posts', as: null, path: () => '/v1/public/blog/posts' },
  { group: 'Blog (público)', name: 'Blog post: GET /v1/public/blog/posts/:slug', as: null, path: (c) => `/v1/public/blog/posts/post-${1 + (c.i % 30)}` },
  { group: 'Blog (público)', name: 'Blog categorias: GET /v1/public/blog/categories', as: null, path: () => '/v1/public/blog/categories' },
];
// answer/rate use a session started by the 'start' scenario for the same user (serial scenarios share state)
const pick = (c: Ctx) => { const m = c.state.sessions as Record<number, { sessionId: string; items: { id: string }[] }[]> | undefined; return m?.[c.user]?.[c.i % (m[c.user]?.length || 1)]; };

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0; };
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const timing = (h: string | null, key: string) => { const m = h?.match(new RegExp(`${key};(?:[^,]*;)?dur=([0-9.]+)(?:;desc="?(\\d+) q)?`)); return m ? { dur: Number(m[1]), q: m[2] ? Number(m[2]) : undefined } : undefined; };

async function freePort(from: number) { for (let p = from; p < from + 50; p++) if (await new Promise<boolean>((r) => { const s = createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p); })) return p; throw new Error('no free port'); }

async function main() {
  const sqlc = postgres(t.url.replace('//postgres:', '//supabase_admin:'), { max: 2, onnotice: () => {} });
  const [{ n: users }] = await sqlc`select count(*)::int n from auth.users`;
  if (!users) throw new Error('empty remoa_perf: run pnpm perf:seed first');
  const rtts: number[] = [];
  for (let i = 0; i < 30; i++) { const s = performance.now(); await sqlc`select 1`; rtts.push(performance.now() - s); }
  const rtt = pct(rtts.slice(5), 50);

  let child: ChildProcess | undefined;
  let base = process.env.PERF_API_URL ?? '';
  let port = 0;
  if (!base) {
    port = await freePort(4300);
    child = spawn('pnpm', ['--filter', '@remoa/api', 'exec', 'tsx', `--env-file=${join(root, '.env')}`, 'src/perf/server.ts'], { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, NODE_ENV: 'development', STRIPE: 'mock', GRADER: 'mock', AI: 'mock', PORT: String(port), DATABASE_URL: t.url, LOG_LEVEL: 'error', WEB_ORIGIN: 'http://localhost:3000' } });
    base = `http://localhost:${port}`;
  }
  const stop = () => { if (child?.pid) try { process.kill(-child.pid); } catch { /* gone */ } };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  try {
    for (let i = 0; ; i++) { if (i > 120) throw new Error('perf API did not start'); if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 500)); }
    await resetStatements();
    const load0 = loadavg();
    const state: Record<string, unknown> = {};
    const results: any[] = [];
    const snap = async () => new Map((await sqlc.unsafe(`select queryid::text id, calls::float c, total_exec_time t, rows::float r, left(query, 4000) q from extensions.pg_stat_statements
      where userid = (select oid from pg_roles where rolname = 'postgres') and dbid = (select oid from pg_database where datname = current_database())`) as any[]).map((r) => [r.id, r]));
    for (const sc of S) {
      const before = await snap();
      const lat: number[] = [], bytes: number[] = [], dbMs: number[] = [], extMs: number[] = [], appMs: number[] = [], qs: number[] = [], status: Record<number, number> = {};
      let next = 0;
      const one = async (i: number) => {
        const user = sc.as === null ? 0 : sc.as === 'typical' ? TYPICAL[i % TYPICAL.length] : sc.as;
        const c: Ctx = { token: sc.as === null ? '' : perfToken(user, secret), user, i, state };
        const body = sc.body?.(c);
        const t0 = performance.now();
        const r = await fetch(`${base}${sc.path(c)}`, { method: sc.method ?? 'GET', headers: { ...(c.token ? { authorization: `Bearer ${c.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'accept-encoding': 'identity' }, body: body ? JSON.stringify(body) : undefined });
        const buf = Buffer.from(await r.arrayBuffer());
        const ms = performance.now() - t0;
        if (i >= WARM) {
          lat.push(ms); bytes.push(buf.length); status[r.status] = (status[r.status] ?? 0) + 1;
          const st = r.headers.get('server-timing');
          const d = timing(st, 'db'), e = timing(st, 'ext'), a = timing(st, 'app');
          if (d) dbMs.push(d.dur); if (e) extMs.push(e.dur); if (a) appMs.push(a.dur);
          const q = r.headers.get('x-remoa-queries') ?? d?.q; if (q !== undefined && q !== null) qs.push(Number(q));
        }
        if (sc.after && r.ok) sc.after(c, JSON.parse(buf.toString()));
      };
      // serial scenarios (start/answer/rate) run one at a time; the rest at concurrency C
      const conc = sc.serial ? 1 : C;
      await Promise.all(Array.from({ length: conc }, async () => { for (;;) { const i = next++; if (i >= N + WARM) return; await one(i).catch(() => { status[0] = (status[0] ?? 0) + 1; }); } }));
      const after = await snap();
      const calls = N + WARM;
      const queries = [...after].map(([id, a]) => { const b = before.get(id); return { q: a.q.replace(/\s+/g, ' ').slice(0, 300), calls: a.c - (b?.c ?? 0), total: a.t - (b?.t ?? 0), rows: a.r - (b?.r ?? 0) }; })
        .filter((x) => x.calls > 0).sort((x, y) => y.total - x.total).map((x) => ({ ...x, perReq: x.calls / calls, meanMs: x.total / x.calls }));
      const dbQ = queries.reduce((s, x) => s + x.calls, 0) / calls;
      results.push({ group: sc.group, name: sc.name, n: lat.length, status, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.max(0, ...lat), bytes: Math.round(avg(bytes)),
        queriesHeader: qs.length ? avg(qs) : null, queriesDb: dbQ, qBudget: sc.qBudget ?? null, dbMsHeader: dbMs.length ? avg(dbMs) : null, extMsHeader: extMs.length ? avg(extMs) : null, appMsHeader: appMs.length ? avg(appMs) : null,
        dbMsStatements: queries.reduce((s, x) => s + x.total, 0) / calls, queries });
      process.stdout.write(`  ${sc.name}: p50 ${results.at(-1).p50.toFixed(0)} ms, p95 ${results.at(-1).p95.toFixed(0)} ms, ${dbQ.toFixed(1)} q/req, ${results.at(-1).bytes} B\n`);
    }
    const load1 = loadavg();
    const top = await topQueries();
    const day = new Date().toISOString().slice(0, 10);
    const out = join(root, '..', 'docs', 'perf'); mkdirSync(out, { recursive: true });
    const [counts] = await sqlc`select (select count(*)::int from cards) cards, (select count(*)::int from boards) boards, (select count(*)::int from attempts) attempts, (select count(*)::int from auth.users) users`;
    const meta = { date: new Date().toISOString(), n: N, concurrency: C, warmup: WARM, rttDbMs: rtt, loadBefore: load0, loadAfter: load1, dataset: counts, node: process.version, budgets: { slowMs: SLOW, verySlowMs: VERY_SLOW } };
    writeFileSync(join(out, `bench-${day}.json`), JSON.stringify({ meta, results }, null, 1));
    const flag = (r: any) => [r.p95 > VERY_SLOW ? 'p95 > 2 s' : r.p95 > SLOW ? 'p95 > 800 ms' : '', r.qBudget !== null && r.queriesDb > r.qBudget ? `queries ${r.queriesDb.toFixed(0)} > ${r.qBudget}` : ''].filter(Boolean).join('; ');
    const f1 = (n: number | null) => (n === null ? 'n/d' : n.toFixed(n < 10 ? 1 : 0));
    const md = [`## Bench ${meta.date} (N=${N}, concorrência ${C}, load antes/depois ${load0.map((x) => x.toFixed(1)).join('/')} -> ${load1.map((x) => x.toFixed(1)).join('/')}, RTT API->banco ${rtt.toFixed(2)} ms)`,
      '', '| Cenário | p50 | p95 | p99 | Bytes | Queries (banco) | Queries (cab.) | DB ms (stmt) | Orçamento |', '|---|---|---|---|---|---|---|---|---|',
      ...results.map((r) => `| ${r.name} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.p99)} | ${r.bytes} | ${r.queriesDb.toFixed(1)} | ${f1(r.queriesHeader)} | ${f1(r.dbMsStatements)} | ${flag(r) || 'ok'} |`), '', top].join('\n');
    writeFileSync(join(out, `bench-${day}.md`), md);
    process.stdout.write(`\n${md}\n`);
    if (process.argv.includes('--strict') && results.some((r) => flag(r))) process.exitCode = 1;
  } finally { stop(); await sqlc.end(); }
}
main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack : e}\n`); process.exit(1); });
