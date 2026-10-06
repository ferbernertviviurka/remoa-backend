// G21 FR-29 (D-1024): `pnpm db:migrate`. Same bookkeeping as drizzle-kit migrate (drizzle.__drizzle_migrations, hash + journal `when`),
// but a file whose first line is `-- no-transaction` runs statement by statement outside a transaction (CREATE INDEX CONCURRENTLY).
// Every other file runs in its own transaction together with its bookkeeping row (drizzle wraps all pending files in one).
import { config } from 'dotenv';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
export const isNoTransaction = (stmts: string[]) => /^\s*-- no-transaction\b/.test(stmts[0] ?? '');

async function main() {
  config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
  const sql = postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1, onnotice: () => {} });
  try {
    // D-1204: every API container runs this on boot (Dockerfile CMD); replicas starting together wait here instead of applying a file twice.
    // Session lock: DATABASE_URL must be a direct or session-mode connection (Supabase pooler :5432), not transaction mode (:6543).
    await sql`select pg_advisory_lock(hashtext('remoa:migrate'))`;
    await sql`create schema if not exists drizzle`;
    await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
    const [last] = await sql<{ created_at: string }[]>`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
    for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
      if (last && Number(last.created_at) >= m.folderMillis) continue;
      const stmts = m.sql.filter((s) => s.trim());
      const record = (q: postgres.Sql | postgres.TransactionSql) =>
        q`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
      if (isNoTransaction(stmts)) {
        for (const s of stmts) await sql.unsafe(s);
        await record(sql);
      } else {
        await sql.begin(async (tx) => {
          for (const s of stmts) await tx.unsafe(s);
          await record(tx);
        });
      }
      process.stdout.write(`applied ${m.folderMillis} ${isNoTransaction(stmts) ? '(no transaction)' : ''}\n`);
    }
    const [n] = await sql<{ n: number }[]>`select count(*)::int n from drizzle.__drizzle_migrations`;
    process.stdout.write(`migrations: ${n!.n} applied, database up to date\n`);
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
