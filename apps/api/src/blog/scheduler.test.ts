import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ asJob: <T>(fn: () => T) => fn() }));
vi.mock('../inngest/blog', () => ({ publishScheduled: vi.fn() }));
vi.mock('@remoa/log', () => ({ createLogger: () => ({ error: vi.fn() }) }));
import { BLOG_SWEEP_MS, blogSchedulerInflight, msUntilNextBlogSweep, startBlogScheduler } from './scheduler';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

describe('blog process scheduler', () => {
  it('aligns five-minute UTC boundaries and runs immediately on boot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:02:00Z'));
    expect(msUntilNextBlogSweep()).toBe(180_000);
    expect(msUntilNextBlogSweep(Date.parse('2026-10-12T12:05:00Z'))).toBe(BLOG_SWEEP_MS);
    const run = vi.fn(async () => ({ published: 0 }));
    stop = startBlogScheduler(run);
    await blogSchedulerInflight();
    expect(run).toHaveBeenCalledExactlyOnceWith(new Date('2026-10-12T12:02:00Z'));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenLastCalledWith(new Date('2026-10-12T12:05:00Z'));
    await vi.advanceTimersByTimeAsync(BLOG_SWEEP_MS);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not duplicate starts or overlap slow sweeps; stops future ticks', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    stop = startBlogScheduler(run);
    const ignored = vi.fn(async () => undefined);
    startBlogScheduler(ignored)();
    await vi.advanceTimersByTimeAsync(3 * BLOG_SWEEP_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ignored).not.toHaveBeenCalled();
    resolve(); await blogSchedulerInflight();
    await vi.advanceTimersByTimeAsync(BLOG_SWEEP_MS);
    expect(run).toHaveBeenCalledTimes(2);
    stop(); resolve(); await blogSchedulerInflight();
    await vi.advanceTimersByTimeAsync(BLOG_SWEEP_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('recovers on the next tick after a failed sweep and can restart after stop', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    const run = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue({ published: 1 });
    stop = startBlogScheduler(run);
    await blogSchedulerInflight();
    await vi.advanceTimersByTimeAsync(BLOG_SWEEP_MS);
    expect(run).toHaveBeenCalledTimes(2);
    stop(); stop = startBlogScheduler(run); await blogSchedulerInflight();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
