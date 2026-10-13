import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ execute: vi.fn(), txExecute: vi.fn(), transaction: vi.fn(), invalidate: vi.fn(), sitemap: vi.fn() }));
vi.mock('../db', () => ({ dbm: async () => ({ db: { execute: fake.execute, transaction: fake.transaction } }) }));
vi.mock('../cache', () => ({ invalidate: fake.invalidate }));
vi.mock('../blog/sitemap', () => ({ regenerateSitemap: fake.sitemap }));
vi.mock('@remoa/log', () => ({ createLogger: () => ({ info: vi.fn() }), newRequestId: () => 'test' }));
import { publishScheduled } from './blog';

const now = new Date('2026-10-12T12:00Z');
const due = { id: 'due-id', slug: 'due', publish_at: '2026-10-10T12:00Z', category_slug: 'study' };
const dialect = new PgDialect();
beforeEach(() => {
  vi.clearAllMocks();
  fake.transaction.mockImplementation((fn) => fn({ execute: fake.txExecute }));
  fake.txExecute.mockResolvedValue([]); fake.execute.mockResolvedValue([]);
  fake.invalidate.mockResolvedValue({ tags: [], dropped: 0 }); fake.sitemap.mockResolvedValue({});
});

describe('scheduled blog publication and cache reconciliation', () => {
  it('atomically publishes only due scheduled live posts, audits once and deduplicates effects', async () => {
    fake.txExecute.mockResolvedValueOnce([due]); fake.execute.mockResolvedValueOnce([due]);
    expect(await publishScheduled(now)).toEqual({ published: 1 });
    const statement = dialect.sqlToQuery(fake.txExecute.mock.calls[0]![0]);
    expect(statement.sql).toContain("where status = 'scheduled'");
    expect(statement.sql).toContain('publish_at <='); expect(statement.sql).toContain('deleted_at is null');
    expect(statement.sql).toContain('published_at = publish_at');
    expect(statement.params).toContain(now.toISOString());
    expect(fake.txExecute).toHaveBeenCalledTimes(2); // one atomic UPDATE and one audit
    expect(dialect.sqlToQuery(fake.txExecute.mock.calls[1]![0]).sql).toContain('insert into admin_audit_log');
    expect(fake.invalidate).toHaveBeenCalledWith('blog.changed', { slugs: ['due'], categorySlugs: ['study'] }, expect.anything());
    expect(fake.sitemap).toHaveBeenCalledWith({ reason: 'blog.publish-scheduled' }, now);
    expect(fake.execute).toHaveBeenCalledTimes(1); // fixed reconciliation query per tick
  });

  it('retries effects on an already published row after an earlier cache failure without another audit', async () => {
    fake.txExecute.mockResolvedValueOnce([due]); fake.invalidate.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(publishScheduled(now)).rejects.toThrow('cache unavailable');
    fake.execute.mockResolvedValueOnce([due]);
    expect(await publishScheduled(now)).toEqual({ published: 0 });
    expect(fake.txExecute).toHaveBeenCalledTimes(3); // two UPDATEs but only the first creates an audit
    expect(fake.invalidate).toHaveBeenCalledTimes(2);
    expect(fake.sitemap).toHaveBeenCalledTimes(1);
    const retry = dialect.sqlToQuery(fake.execute.mock.calls[1]![0]);
    expect(retry.sql).toContain("p.status = 'published'");
    expect(retry.sql).toContain('p.published_at = p.publish_at');
    expect(retry.sql).toContain('p.updated_at >='); expect(retry.params).toContain(24);
  });

  it('retries sitemap generation when the previous transaction committed but the sitemap failed', async () => {
    fake.txExecute.mockResolvedValueOnce([due]); fake.sitemap.mockRejectedValueOnce(new Error('sitemap unavailable'));
    await expect(publishScheduled(now)).rejects.toThrow('sitemap unavailable');
    fake.execute.mockResolvedValueOnce([due]);
    expect(await publishScheduled(now)).toEqual({ published: 0 });
    expect(fake.sitemap).toHaveBeenCalledTimes(2);
  });

  it('does not perform cache or sitemap effects when nothing was published or reconciled', async () => {
    expect(await publishScheduled(now)).toEqual({ published: 0 });
    expect(fake.invalidate).not.toHaveBeenCalled(); expect(fake.sitemap).not.toHaveBeenCalled();
    expect(fake.txExecute).toHaveBeenCalledTimes(1); expect(fake.execute).toHaveBeenCalledTimes(1);
  });
});
