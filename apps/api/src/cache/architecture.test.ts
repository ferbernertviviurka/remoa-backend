// G21/F29 T6 (FR-32, FR-41): cache architecture, read from the source as text. No database.
//   (b) cached() without TTL / without userId in user scope is a type error (cache.test.ts, checked by tsc); here: nobody bypasses it.
//   (c) every module that writes (drizzle insert/update/delete or raw SQL) calls invalidate( or is listed in no-invalidate.json.
//   (d) every event has a tag: @remoa/contracts cache.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheEvents, type CacheEvent } from '@remoa/contracts';
import exceptions from './no-invalidate.json';

const SRC = join(import.meta.dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join('/');
const code = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const files = walk(SRC).map((p) => ({ path: rel(p), code: code(p) }));

// Drizzle receivers used in apps/api (db, tx, dbOrTx, q); in-memory Maps (`hits.delete`) are not writes.
const DRIZZLE_WRITE = /\b(?:db|tx|dbOrTx|q)\.(?:insert|update|delete)\s*\(/;
const SQL_WRITE = /\b(?:insert\s+into|delete\s+from|update\s+[\w.]+\s+set)\b/i;
const writes = (c: string) => DRIZZLE_WRITE.test(c) || SQL_WRITE.test(c);
const INVALIDATES = /\binvalidate\s*\(/;

type Exception = { reason: string; todo?: string; event?: string };
const list = exceptions as Record<string, Exception>;

describe('cache architecture (G21 T6)', () => {
  it('(c) every module that writes to the database calls invalidate( or is listed in cache/no-invalidate.json', () => {
    const missing = files.filter((f) => !f.path.startsWith('cache/') && writes(f.code) && !INVALIDATES.test(f.code) && !list[f.path]).map((f) => f.path);
    expect(missing, 'add invalidate(event, ctx) after the commit, or an entry with the reason in cache/no-invalidate.json').toEqual([]);
  });

  it('no-invalidate.json has no stale entries: each still writes and does not invalidate yet', () => {
    const byPath = new Map(files.map((f) => [f.path, f.code]));
    const stale = Object.keys(list).filter((p) => !byPath.has(p) || !writes(byPath.get(p)!) || INVALIDATES.test(byPath.get(p)!));
    expect(stale, 'remove these entries (the file now invalidates, or no longer writes)').toEqual([]);
  });

  it('every exception has a reason, and a pending one names a catalog event', () => {
    for (const [p, e] of Object.entries(list)) {
      expect(e.reason.length, p).toBeGreaterThanOrEqual(8);
      if (e.todo) expect(cacheEvents, p).toContain(e.event as CacheEvent);
    }
  });

  it('(b) only cache/ touches the store; nobody re-implements next/cache here', () => {
    const bad = files.filter((f) => !f.path.startsWith('cache/') && (/from ['"][./]*cache\/store['"]/.test(f.code) || /from ['"]next\/cache['"]/.test(f.code))).map((f) => f.path);
    expect(bad).toEqual([]);
  });
});
