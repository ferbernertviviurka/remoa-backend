import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, isNoTransaction } from './migrate';

describe('migrate runner (D-1024)', () => {
  it('runs only the CONCURRENTLY file outside a transaction, and it has one statement per breakpoint', () => {
    const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
    const outside = files.filter((m) => isNoTransaction(m.sql));
    expect(outside).toHaveLength(1);
    const stmts = outside[0]!.sql.filter((s) => s.trim());
    expect(stmts.length).toBe(14);
    for (const s of stmts) expect(s).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    // no other file may use CONCURRENTLY (it would fail inside the transaction)
    for (const m of files.filter((f) => !isNoTransaction(f.sql))) expect(m.sql.join('\n')).not.toMatch(/\bCONCURRENTLY\b/i);
  });
});
