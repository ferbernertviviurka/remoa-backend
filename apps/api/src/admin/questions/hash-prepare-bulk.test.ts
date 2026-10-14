/** Offline SQL adapters: synthetic text, no PostgreSQL connection or provider. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { ok, questionHashPrepareInputSchema, type QuestionHashPrepareInput } from '@remoa/contracts';
const mocks = vi.hoisted(() => ({ lock: vi.fn(async () => ({ ok: true, data: undefined })) }));
vi.mock('./recovery', () => ({ lockAssociatedQuestionGraphs: mocks.lock }));
vi.mock('../../storage/storage', () => ({ getBytes: vi.fn(), headObject: vi.fn() }));
import { prepareUnlinkedHashes } from './hash-prepare-bulk';
import { prepareContentHashes } from './operations';
import { contentHash } from '../../questions/imports/domain';

type Row = Record<string, unknown>;
const dialect = new PgDialect();
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-13T12:00:00.123Z';
const row = (n = 1, changes: Row = {}): Row => ({ id: id(n), userId: null, visibility: 'public', origin: 'remoa_authored',
  canonicalId: id(n), supersedesId: null, hasChildren: false, hasCandidates: false, hasOccurrences: false,
  catalogStatus: 'draft', wasPublished: false, contentHash: null, version: 1, sourceId: null, fresh: true,
  stem: 'Conteúdo autoral sintético', alternatives: [{ key: 'A', text: 'Primeira' }, { key: 'B', text: 'Segunda' }],
  correctKey: 'A', explanation: 'Comentário autoral sintético', areaId: null, topicId: null,
  availability: 'active', assets: [], ...changes });
const canonical = (q: Row) => contentHash({ stem: String(q.stem), alternatives: q.alternatives,
  correctKey: q.correctKey as string | null, explanation: q.explanation as string | null,
  areaId: q.areaId as string | null, topicId: q.topicId as string | null,
  annulled: q.availability === 'annulled', assets: q.assets });
const input = (ids = [id(1)], changes: Partial<QuestionHashPrepareInput> = {}): QuestionHashPrepareInput =>
  questionHashPrepareInputSchema.parse({ items: ids.map(id => ({ id, revision: 1, expectedUpdatedAt: at })),
    idempotencyKey: randomUUID(), sourceId: null, reason: 'Conferência autoral sintética', ...changes });

function fixture(options: { initial?: Row[]; locked?: Row[]; current?: Row[]; applied?: string[]; replay?: Row } = {}) {
  const initial = options.initial ?? [row()], locked = options.locked ?? initial, current = options.current ?? locked;
  let discovery = 0;
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    queries.push(compiled);
    if (compiled.sql.includes('pg_advisory_xact_lock')) return [];
    if (compiled.sql.includes('FROM admin_audit_log')) return options.replay ? [options.replay] : [];
    if (compiled.sql.includes('"hasChildren"')) return discovery++ === 0 ? initial : current;
    if (compiled.sql.includes('FOR UPDATE OF q')) return locked;
    if (compiled.sql.includes('FROM question_sources')) return [{ id: id(9) }];
    if (compiled.sql.includes('FROM (VALUES')) return (options.applied ?? locked.map(q => String(q.id))).map(id => ({ id }));
    if (compiled.sql.includes('FROM question_bank WHERE')) {
      const requestedId = compiled.params.find(p => typeof p === 'string' && p.startsWith('10000000-'));
      return locked.filter(q => q.id === requestedId);
    }
    if (compiled.sql.startsWith('UPDATE question_bank')) return [];
    throw Error('Unexpected test statement');
  });
  return { tx: { execute } as unknown as Tx, execute, queries };
}

describe('G28 unlinked institutional hash preparation', () => {
  it('500 drafts use four ordered statements and identical Node hashes; no content/right/review writes', async () => {
    const rows = Array.from({ length: 500 }, (_, n) => row(n + 1));
    const f = fixture({ initial: rows });
    const out = await prepareUnlinkedHashes(f.tx, input(rows.map(q => String(q.id)).reverse()));
    expect(f.execute).toHaveBeenCalledTimes(4);
    expect(out?.results).toHaveLength(500);
    expect(out?.before).toHaveLength(500);
    expect(out?.results.every(r => r.outcome === 'prepared' && r.contentHash === canonical(rows[0]!))).toBe(true);
    expect(out?.results.map(r => r.id)).toEqual(rows.map(q => q.id));
    expect(f.queries[0]!.sql).not.toMatch(/FOR UPDATE|FOR SHARE|UPDATE question/);
    expect(f.queries[1]!.sql).toContain('ORDER BY q.id FOR UPDATE OF q');
    const update = f.queries[3]!;
    expect(update.sql).toContain('SET content_hash = prepared.hash');
    expect(update.sql).toContain('q.content_hash IS NULL AND q.version = prepared.version');
    expect(update.sql).toContain("date_trunc('milliseconds', q.updated_at) = prepared.at");
    expect(update.sql).not.toMatch(/SET.*(?:rights_status|reviewed_hash|source_id|integrity_confirmed|correct_key|stem|alternatives)/);
    expect(update.params.filter(p => p === canonical(rows[0]!))).toHaveLength(500);
    expect(JSON.stringify([out?.before, out?.results])).not.toMatch(/Conteúdo|Primeira|correctKey/);
  });
  it('stored hash comparison precedes stale revision/time CAS, without rehashing any stored value', async () => {
    const good = row(1, { version: 2, fresh: false }); good.contentHash = canonical(good);
    const bad = row(2, { contentHash: 'f'.repeat(64), version: 2, fresh: false });
    const f = fixture({ initial: [good, bad] });
    const out = await prepareUnlinkedHashes(f.tx, input([id(1), id(2)]));
    expect(out?.results.map(r => r.outcome)).toEqual(['already_prepared', 'conflict']);
    expect(out?.results[1]?.contentHash).toBe('f'.repeat(64));
    expect(out?.before).toEqual([]);
    expect(f.execute).toHaveBeenCalledTimes(3);
  });
  it('mixed missing/version/time/published/previously-published/eligible outcomes preserve null privacy fields', async () => {
    const rows = [row(1, { version: 2 }), row(2, { fresh: false }), row(3, { catalogStatus: 'published' }),
      row(4, { wasPublished: true }), row(5)];
    const f = fixture({ initial: rows });
    const out = await prepareUnlinkedHashes(f.tx, input([id(6), ...rows.map(q => String(q.id))]));
    expect(out?.results.map(r => r.outcome)).toEqual(['conflict', 'conflict', 'not_eligible', 'not_eligible', 'prepared', 'not_found']);
    expect(out?.results[2]).toEqual({ id: id(3), outcome: 'not_eligible', version: null, contentHash: null, sourceId: null });
    expect(out?.before.map(q => q.id)).toEqual([id(5)]);
    expect(f.queries[3]?.params).not.toContain(id(1));
  });
  it.each([
    { supersedesId: id(9) }, { canonicalId: id(9) }, { hasChildren: true },
    { hasCandidates: true }, { hasOccurrences: true }, { userId: id(9) },
    { visibility: 'private' }, { origin: 'ai_generated' }, { origin: 'official_exam' },
  ])('falls back before any lock for associated/noninstitutional row %j', async changes => {
    const f = fixture({ initial: [row(1, changes)] });
    expect(await prepareUnlinkedHashes(f.tx, input())).toBeNull();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.queries[0]?.sql).not.toContain('FOR UPDATE');
  });
  it('sourceId nonnull falls back without any fast-path discovery or lock', async () => {
    const f = fixture();
    expect(await prepareUnlinkedHashes(f.tx, input([id(1)], { sourceId: id(9) }))).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([{ hasChildren: true }, { hasCandidates: true }, { hasOccurrences: true },
    { canonicalId: id(9) }, { supersedesId: id(9) }, { origin: 'official_exam' }])(
    'graph change after lock conflicts without update or late fallback %j', async changes => {
      const f = fixture({ initial: [row()], current: [row(1, changes)] });
      const out = await prepareUnlinkedHashes(f.tx, input());
      expect(out?.results[0]?.outcome).toBe('conflict');
      expect(out?.before).toEqual([]);
      expect(f.execute).toHaveBeenCalledTimes(3);
      expect(f.queries.map(q => q.sql).join('\n')).not.toContain('UPDATE question_bank');
    });
  it('newly inserted requested id after discovery conflicts without acquiring a graph lock', async () => {
    const f = fixture({ initial: [], locked: [row()], current: [row()] });
    expect((await prepareUnlinkedHashes(f.tx, input()))?.results[0]?.outcome).toBe('conflict');
    expect(f.execute).toHaveBeenCalledTimes(3);
  });
  it('under-lock version/CAS is authoritative when it changed after preflight', async () => {
    const f = fixture({ initial: [row()], locked: [row(1, { version: 2 })] });
    expect((await prepareUnlinkedHashes(f.tx, input()))?.results[0]?.outcome).toBe('conflict');
    expect(f.execute).toHaveBeenCalledTimes(3);
  });
  it('RETURNING missing update is a conflict, never an invented prepared outcome/audit before', async () => {
    const f = fixture({ applied: [] });
    const out = await prepareUnlinkedHashes(f.tx, input());
    expect(out?.results[0]?.outcome).toBe('conflict');
    expect(out?.results[0]?.contentHash).toBeNull();
    expect(out?.before).toEqual([]);
  });
  it('null canonical self, source and nested asset values preserve exact hash semantics', async () => {
    const q = row(1, { canonicalId: null, sourceId: id(8), availability: 'annulled', correctKey: null,
      assets: [{ objectKey: 'synthetic', alt: 'Figura autoral', provenance: { page: 1 }, url: 'https://example.invalid/temp' }] });
    const f = fixture({ initial: [q] });
    const out = await prepareUnlinkedHashes(f.tx, input());
    expect(out?.results[0]).toMatchObject({ outcome: 'prepared', sourceId: id(8), contentHash: canonical(q) });
    expect(f.queries[3]?.sql).not.toContain('source_id');
  });
  it('missing rows preserve not_found, with no UPDATE', async () => {
    const f = fixture({ initial: [] });
    expect((await prepareUnlinkedHashes(f.tx, input()))?.results[0]?.outcome).toBe('not_found');
    expect(f.execute).toHaveBeenCalledTimes(3);
  });
  it('SQL failures propagate so the enclosing audited transaction rolls back', async () => {
    const f = fixture(); f.execute.mockRejectedValueOnce(Error('synthetic SQL error'));
    await expect(prepareUnlinkedHashes(f.tx, input())).rejects.toThrow('synthetic SQL error');
  });
});

describe('existing operation wiring / audit / idempotency', () => {
  it('keeps replay ahead of fast-path discovery; no update or graph lock', async () => {
    mocks.lock.mockClear();
    const body = input();
    const { requestHash } = await import('./operations');
    const hash = requestHash({ items: body.items.map(i => ({ ...i, expectedUpdatedAt: new Date(i.expectedUpdatedAt).toISOString() })), sourceId: null });
    const results = [{ id: id(1), outcome: 'prepared', version: 1, contentHash: 'a'.repeat(64), sourceId: null }];
    const f = fixture({ replay: { id: 9, requestHash: hash, results, after: {} } });
    const audit = { before: vi.fn(), after: vi.fn() };
    const out = await prepareContentHashes(f.tx, randomUUID(), body, audit);
    expect(out).toEqual(ok({ hashVersion: 'f33-content-v2-jsonb-assets', replayed: true, results }));
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(audit.after).toHaveBeenCalledOnce();
    expect(audit.before).not.toHaveBeenCalled();
  });
  it('fast path captures one before/after envelope for the existing withAdmin audit', async () => {
    const f = fixture(); const audit = { before: vi.fn(), after: vi.fn() };
    const out = await prepareContentHashes(f.tx, randomUUID(), input(), audit);
    expect(out.ok).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(6); // idempotency2 + bulk4; audit INSERT owned by withAdmin unchanged
    expect(audit.before).toHaveBeenCalledOnce(); expect(audit.after).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.before.mock.calls)).not.toContain('Conteúdo');
  });
  it('linked fallback calls original graph locker only after read-only discovery', async () => {
    mocks.lock.mockClear();
    const f = fixture({ initial: [row(1, { hasCandidates: true })] });
    const audit = { before: vi.fn(), after: vi.fn() };
    const out = await prepareContentHashes(f.tx, randomUUID(), input(), audit);
    expect(out.ok).toBe(true);
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(f.queries[2]?.sql).toContain('"hasCandidates"');
    expect(f.queries[2]?.sql).not.toContain('FOR UPDATE');
    expect(f.queries[3]?.sql).toContain('FOR UPDATE');
  });
  it('nonnull optional source preserves existing source existence / linking path', async () => {
    mocks.lock.mockClear();
    const f = fixture(); const audit = { before: vi.fn(), after: vi.fn() };
    const out = await prepareContentHashes(f.tx, randomUUID(), input([id(1)], { sourceId: id(9) }), audit);
    expect(out.ok).toBe(true);
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(f.queries.some(q => q.sql.includes('"hasChildren"'))).toBe(false);
    expect(f.queries.at(-1)?.sql).toContain('source_id =');
  });
  it.each([{ userId: id(8), visibility: 'private', origin: 'ai_generated' },
    { visibility: 'private' }, { origin: 'licensed_dataset' }])('private/foreign fallback preserves hidden not_eligible results %j', async changes => {
    const f = fixture({ initial: [row(1, changes)] });
    const out = await prepareContentHashes(f.tx, randomUUID(), input(), { before: vi.fn(), after: vi.fn() });
    expect(out.ok && out.data.results).toEqual([{ id: id(1), outcome: 'not_eligible', version: null, contentHash: null, sourceId: null }]);
    expect(f.queries.some(q => q.sql.startsWith('UPDATE'))).toBe(false);
  });
  it('idempotency mismatch aborts without fast-path or graph discovery', async () => {
    const f = fixture({ replay: { id: 9, requestHash: 'different', results: [], after: {} } });
    const out = await prepareContentHashes(f.tx, randomUUID(), input(), { before: vi.fn(), after: vi.fn() });
    expect(out).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
});

// Explicit opt-in only; never reads production config or establishes a connection
// when disabled. Rollback removes every synthetic row even after assertion failure.
const pgOptIn = process.env.G28_BULK_PG_TEST === '1';
if (pgOptIn) {
  const configured = process.env.TEST_DATABASE_URL;
  if (!configured) throw Error('G28_BULK_PG_TEST needs explicit isolated TEST_DATABASE_URL');
  const url = new URL(configured);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/f33_test')
    throw Error('G28_BULK_PG_TEST only permits local f33_test; production forbidden');
}
describe.skipIf(!pgOptIn)('G28 real PostgreSQL bulk preparation (local f33_test, opt-in)', () => {
  it('500 raw synthetic drafts preserve fields, exact hashes and replay outcomes; rollback all fixtures', async () => {
    const { db } = await import('@remoa/db');
    class RollbackFixture extends Error {}
    const rollback = new RollbackFixture('scoped synthetic rollback');
    try {
      await db.transaction(async tx => {
        const tag = 'G28-bulk-' + randomUUID();
        await tx.execute(sql`INSERT INTO question_bank(user_id,visibility,origin,source,type,difficulty,stem,expected_answer,alternatives,correct_key,explanation,status,catalog_status)
          SELECT NULL,'public','remoa_authored','ai','objective','easy',${tag} || ' autoral ' || g,'Resposta autoral',
          '[{"key":"A","text":"Primeira"},{"key":"B","text":"Segunda"}]'::jsonb,'A','Comentário autoral','draft','draft'
          FROM generate_series(1,500) g`);
        const rows = await tx.execute<Row>(sql`SELECT *, to_char(date_trunc('milliseconds',updated_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at
          FROM question_bank WHERE stem LIKE ${tag + '%'} ORDER BY id`);
        expect(rows).toHaveLength(500);
        const body = input(rows.map(q => String(q.id)), { items: rows.map(q => ({ id: String(q.id), revision: Number(q.version), expectedUpdatedAt: new Date(String(q.at)) })) });
        const prepared = await prepareUnlinkedHashes(tx, body);
        expect(prepared?.results.every(q => q.outcome === 'prepared')).toBe(true);
        const after = await tx.execute<Row>(sql`SELECT * FROM question_bank WHERE stem LIKE ${tag + '%'} ORDER BY id`);
        for (let i = 0; i < rows.length; i++) {
          const old = rows[i]!, next = after[i]!;
          const hash = contentHash({ stem: String(old.stem), alternatives: old.alternatives, correctKey: String(old.correct_key),
            explanation: old.explanation as string | null, areaId: old.enamed_area_id as string | null,
            topicId: old.enamed_topic_id as string | null, annulled: false, assets: old.assets });
          expect(next.content_hash).toBe(hash);
          for (const field of ['source_id', 'rights_status', 'reviewed_hash', 'reviewer_name', 'reviewer_crm', 'validation_kind',
            'catalog_status', 'status', 'integrity_confirmed', 'key_final', 'enamed_confirmed', 'stem', 'alternatives', 'correct_key', 'explanation'])
            expect(next[field]).toEqual(old[field]);
        }
        const again = await prepareUnlinkedHashes(tx, body);
        expect(again?.results.every(q => q.outcome === 'already_prepared')).toBe(true);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    finally { await db.$client.end({ timeout: 1 }); }
  }, 30_000);
});
