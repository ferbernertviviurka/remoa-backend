// G21 T2 FR-4 (D-987): `pnpm perf:queries [--reset]` prints the 20 heaviest queries (total time and mean time) of the isolated perf
// database from pg_stat_statements, as Markdown for docs/perf/BASELINE.md. `--reset` clears the counters (the bench does it before running).
import postgres from 'postgres';
import { perfTarget } from './target';

type Row = { calls: string; mean: number; total: number; rows: string; q: string };
const cell = (q: string) => q.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 140);

export async function resetStatements() {
  const sql = postgres(perfTarget().url.replace('//postgres:', '//supabase_admin:'), { max: 1, onnotice: () => {} });
  await sql.unsafe('select extensions.pg_stat_statements_reset()');
  await sql.end();
}

export async function topQueries(): Promise<string> {
  const sql = postgres(perfTarget().url.replace('//postgres:', '//supabase_admin:'), { max: 1, onnotice: () => {} });
  const base = `select calls::text, mean_exec_time as mean, total_exec_time as total, rows::text, query as q from extensions.pg_stat_statements
    where dbid = (select oid from pg_database where datname = current_database()) and query !~* 'pg_stat_statements|^(analyze|vacuum|set |show |begin|commit|rollback|deallocate)|pg_catalog|information_schema'`;
  const [byTotal, byMean] = await Promise.all([
    sql.unsafe<Row[]>(`${base} order by total_exec_time desc limit 20`),
    sql.unsafe<Row[]>(`${base} and calls >= 3 order by mean_exec_time desc limit 20`),
  ]);
  await sql.end();
  const table = (rows: Row[]) => ['| # | Chamadas | Média (ms) | Total (ms) | Linhas | Query (normalizada, truncada) |', '|---|---|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${r.calls} | ${r.mean.toFixed(2)} | ${r.total.toFixed(0)} | ${r.rows} | \`${cell(r.q)}\` |`)].join('\n');
  return `### 20 queries por tempo total\n\n${table(byTotal)}\n\n### 20 queries por tempo médio (mín. 3 chamadas)\n\n${table(byMean)}\n`;
}

if (process.argv[1]?.endsWith('queries.ts')) {
  (process.argv.includes('--reset') ? resetStatements().then(() => 'pg_stat_statements zerado\n') : topQueries()).then((s) => process.stdout.write(s));
}
