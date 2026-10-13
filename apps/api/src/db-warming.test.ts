import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Held = { unsafe: () => Promise<unknown> & { cancel: () => void }; release: () => void };
const fake = vi.hoisted(() => ({ reserve: vi.fn<() => Promise<Held>>(), options: { max: 2 } }));
vi.mock('@remoa/db', () => ({ db: { $client: fake, _: { fullSchema: {}, schema: {}, tableNamesMap: {} } }, prepared: (r: Held) => r }));
import { WARM_OPERATION_MS, warmPool, warmStatements, run } from './db';

/** A FIFO pool where two separately held leases really exhaust capacity; no database is involved. */
function finitePool(capacity: number) {
  let active = 0;
  let peak = 0;
  const queue: Array<(held: Held) => void> = [];
  const next = () => {
    if (active >= capacity || !queue.length) return;
    active++; peak = Math.max(peak, active);
    let released = false;
    const held: Held = {
      unsafe: () => Object.assign(Promise.resolve([]), { cancel: vi.fn() }),
      release: () => { if (released) throw new Error('double release'); released = true; active--; next(); },
    };
    queue.shift()!(held);
  };
  return {
    reserve: () => new Promise<Held>((r) => { queue.push(r); next(); }),
    active: () => active, peak: () => peak, queued: () => queue.length,
  };
}

beforeAll(async () => { await import('@remoa/db'); });
beforeEach(() => { fake.reserve.mockReset(); fake.options.max = 2; });
afterEach(() => vi.useRealTimers());

describe('speculative database warming liveness', () => {
  it.each([warmPool, warmStatements])('allows a concurrent job holding one lease to get its nested connection (%#)', async (warm) => {
    const pool = finitePool(2); fake.reserve.mockImplementation(pool.reserve);
    const jobLock = await pool.reserve();
    const warming = warm();
    // Queue after the warmer has acquired its first lease. The old all-reserve barrier deadlocks here.
    await Promise.resolve(); await Promise.resolve();
    const nested = await pool.reserve();
    nested.release(); jobLock.release(); await warming;
    expect(pool.active()).toBe(0); expect(pool.queued()).toBe(0);
  });

  it('concurrent warm passes leave all leases available for real traffic', async () => {
    const pool = finitePool(2); fake.reserve.mockImplementation(pool.reserve);
    await Promise.all([warmPool(), warmStatements(), warmPool()]);
    expect(pool.active()).toBe(0); expect(pool.peak()).toBeLessThanOrEqual(2);
    const traffic = await pool.reserve(); traffic.release();
  });

  it('releases an earlier lease when the next reservation fails', async () => {
    const released = vi.fn();
    fake.reserve.mockResolvedValueOnce({ unsafe: () => Object.assign(Promise.resolve([]), { cancel: vi.fn() }), release: released })
      .mockRejectedValueOnce(new Error('connection failure'));
    await expect(warmPool()).rejects.toThrow('connection failure');
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('releases a reservation that arrives after cancellation instead of leaking it', async () => {
    let deliver!: (held: Held) => void;
    fake.reserve.mockImplementation(() => new Promise<Held>((r) => { deliver = r; }));
    const controller = new AbortController(); const work = warmPool(controller.signal);
    await vi.waitFor(() => expect(fake.reserve).toHaveBeenCalledTimes(1)); controller.abort();
    await expect(work).rejects.toThrow('interrupted');
    const release = vi.fn();
    deliver({ unsafe: () => Object.assign(Promise.resolve([]), { cancel: vi.fn() }), release });
    await Promise.resolve(); await Promise.resolve(); expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps an active query leased on abort, then releases after settlement without cancelling a future query', async () => {
    let resolve!: (value: unknown) => void;
    const cancel = vi.fn();
    const query = Object.assign(new Promise<unknown>((r) => { resolve = r; }), { cancel });
    const release = vi.fn(); const unsafe = vi.fn(() => query);
    fake.reserve.mockResolvedValue({ unsafe, release });
    const controller = new AbortController(); const work = warmStatements(controller.signal);
    await vi.waitFor(() => expect(unsafe).toHaveBeenCalledTimes(1));
    controller.abort(); await Promise.resolve();
    expect(release).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    resolve([]); await work;
    expect(release).toHaveBeenCalledTimes(1); expect(fake.reserve).toHaveBeenCalledTimes(1);
  });

  it('times out queued warm reservation and returns a late lease to the pool', async () => {
    vi.useFakeTimers(); let deliver!: (held: Held) => void;
    fake.reserve.mockImplementation(() => new Promise<Held>((r) => { deliver = r; }));
    const work = warmPool(); const failed = expect(work).rejects.toThrow('interrupted');
    await vi.advanceTimersByTimeAsync(WARM_OPERATION_MS); await failed;
    const release = vi.fn(); deliver({ unsafe: () => Object.assign(Promise.resolve([]), { cancel: vi.fn() }), release });
    await Promise.resolve(); expect(release).toHaveBeenCalledTimes(1);
  });

  it('bounds real learned-statement prepares and retries a failed describe on the next pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); fake.options.max = 1;
    const release = vi.fn();
    const describe = vi.fn().mockRejectedValueOnce(new Error('describe failed')).mockResolvedValue([]);
    let pid = 101;
    const unsafe = () => Object.assign(Promise.resolve([]), { cancel: vi.fn(), state: { pid }, describe });
    fake.reserve.mockResolvedValue({ unsafe, release });
    await run('00000000-0000-0000-0000-000000000001', async (tx) => {
      for (let i = 0; i < 5; i++) await tx.execute(sql`select ${i}::int as ${sql.identifier(`warm_test_${i}`)}`);
    });
    await Promise.resolve(); await Promise.resolve();
    expect(describe).not.toHaveBeenCalled(); // request lease is never held for speculative replay
    pid = 202;
    await warmStatements();
    expect(describe).toHaveBeenCalledTimes(1); // failed prepare stops this finite pass
    expect(release).toHaveBeenCalledTimes(2);
    await warmStatements();
    expect(describe).toHaveBeenCalledTimes(5); // same failed first statement retried; maximum four successful prepares
    expect(release).toHaveBeenCalledTimes(3);
    await warmStatements();
    expect(describe).toHaveBeenCalledTimes(7); // remaining two of six learned statements
    expect(release).toHaveBeenCalledTimes(4);
  });

  it('an already aborted sweep never reserves a connection', async () => {
    const controller = new AbortController(); controller.abort();
    await warmPool(controller.signal); await warmStatements(controller.signal);
    expect(fake.reserve).not.toHaveBeenCalled();
  });
});
