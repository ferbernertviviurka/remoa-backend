// P-441 (D-992), no database: @remoa/db is faked (claim = fresh row, no suppression) to see where the provider call happens.
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailExamples } from '@remoa/contracts/mocks';
import type { EmailData } from '@remoa/contracts';

const dialect = new PgDialect();
const updates: unknown[][] = [];
const execute = async (q: SQL) => {
  const { sql, params } = dialect.sqlToQuery(q);
  if (sql.trimStart().startsWith('insert into email_deliveries')) return [{ id: 'd-1' }];
  if (sql.trimStart().startsWith('update email_deliveries')) updates.push(params);
  return [];
};
vi.mock('@remoa/db', () => ({ db: { execute, transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) => fn({ execute }) } }));

const { deferEmails, deliverEmail, drainEmails, emailsInline, setEmailTestHooks, TRY_TIMEOUT_MS } = await import('./send');

const data = emailExamples.find((e) => e.template === 'map-ready')!.data as EmailData<'map-ready'>;
const input = { template: 'map-ready' as const, to: 'a@test.local', data, reference: 'test:defer', userId: '11111111-2222-4333-8444-555555555555' };
const quiet = () => [vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];

afterEach(() => {
  setEmailTestHooks({});
  updates.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('deferred e-mail (P-441)', () => {
  it('inside a user request: returns queued after the claim, the provider is called after, the row is updated to sent', async () => {
    quiet();
    let release!: () => void;
    const calls: string[] = [];
    setEmailTestHooks({ transport: async (m) => (calls.push(m.to), await new Promise<void>((r) => (release = r)), { id: 'p-1' }), sleep: async () => undefined });
    const r = await deferEmails(() => deliverEmail(input));
    expect(r).toEqual({ status: 'queued', deliveryId: 'd-1', duplicate: false });
    expect(calls).toHaveLength(0); // nothing of the provider happened before the answer
    await new Promise((res) => setImmediate(res));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    await drainEmails(1_000);
    expect(updates.at(-1)).toEqual(expect.arrayContaining(['sent', 1, 'p-1']));
  });

  it('a provider that hangs is cut at 3 s per try; inline (D-810 receipt) gives up after 1 retry', async () => {
    quiet();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let tries = 0;
    setEmailTestHooks({ transport: () => (tries++, new Promise(() => undefined)), sleep: async () => undefined });
    const p = emailsInline(() => deliverEmail(input));
    await vi.advanceTimersByTimeAsync(TRY_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TRY_TIMEOUT_MS);
    expect(await p).toMatchObject({ status: 'failed', deliveryId: 'd-1' });
    expect(tries).toBe(2);
    expect(updates.at(-1)).toEqual(expect.arrayContaining(['failed', 2]));
  });

  it('outside any request scope (jobs, cron): still inline with 3 tries, as before', async () => {
    quiet();
    let tries = 0;
    setEmailTestHooks({ transport: async () => (tries++ < 2 ? Promise.reject(new Error('flaky')) : { id: 'p-3' }), sleep: async () => undefined });
    expect(await deliverEmail(input)).toEqual({ status: 'sent', deliveryId: 'd-1', duplicate: false });
    expect(tries).toBe(3);
  });
});
