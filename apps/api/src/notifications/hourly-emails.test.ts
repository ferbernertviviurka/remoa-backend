import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  calendar: vi.fn(async () => ({ sent: 1 })),
  review: vi.fn(async () => 2),
  inactivity: vi.fn(async () => 3),
  onboarding: vi.fn(async () => ({ mapReady: 1, day3: 0 })),
  trial: vi.fn(async () => ({ d3: 1, d0: 0 })),
  locked: true,
  unlocks: 0,
  released: 0,
}));

vi.mock('../db', () => ({
  asJob: (fn: () => unknown) => fn(),
  dbm: async () => ({
    db: {
      $client: {
        reserve: async () => ({
          unsafe: async (q: string) => {
            if (q.includes('pg_try_advisory_lock')) return [{ locked: m.locked }];
            if (q.includes('pg_advisory_unlock')) {
              m.unlocks++;
              return [];
            }
            return [];
          },
          release: () => {
            m.released++;
          },
        }),
      },
    },
  }),
}));
vi.mock('../inngest/notices', () => ({
  noticeJobs: {
    'calendar.dispatch-reminders': { cron: '*/5 * * * *', run: m.calendar },
    'review.reminder': { cron: '*/15 * * * *', run: m.review },
    'inactivity.check': { cron: '0 13 * * *', run: m.inactivity },
  },
}));
vi.mock('../onboarding/emails', () => ({ sendOnboardingEmails: m.onboarding }));
vi.mock('../billing/trial-notice', () => ({ sweepTrialNotices: m.trial }));
vi.mock('../account/maintenance', () => ({
  runSteps: async (steps: Record<string, () => Promise<unknown>>) => {
    const out: Record<string, unknown> = {};
    const failed: string[] = [];
    for (const [name, run] of Object.entries(steps)) {
      try {
        out[name] = await run();
      } catch (e) {
        failed.push(name);
        out[name] = e instanceof Error ? e.message : String(e);
      }
    }
    return { out, failed };
  },
}));

import { HOUR_MS, dueNotificationEmailSteps, msUntilNextHour, runDueNotificationEmails, startHourlyNotificationEmails } from './hourly-emails';

describe('hourly notification emails', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    m.locked = true;
    m.unlocks = 0;
    m.released = 0;
  });

  it('includes the daily inactivity mail only during its UTC hour', () => {
    const morning = Object.keys(dueNotificationEmailSteps(new Date('2026-10-09T12:30:00Z')));
    const tenSaoPaulo = Object.keys(dueNotificationEmailSteps(new Date('2026-10-09T13:05:00Z')));
    expect(morning).toEqual(['calendar.dispatch-reminders', 'review.reminder', 'onboarding', 'trial']);
    expect(tenSaoPaulo).toContain('inactivity.check');
  });

  it('sends the due mails and releases the lock', async () => {
    const out = await runDueNotificationEmails(new Date('2026-10-09T13:05:00Z'));
    expect(m.calendar).toHaveBeenCalledOnce();
    expect(m.review).toHaveBeenCalledOnce();
    expect(m.inactivity).toHaveBeenCalledOnce();
    expect(m.onboarding).toHaveBeenCalledOnce();
    expect(m.trial).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ failed: [], 'review.reminder': 2 });
    expect(m.unlocks).toBe(1);
    expect(m.released).toBe(1);
  });

  it('skips the sweep when another replica holds the lock', async () => {
    m.locked = false;
    const out = await runDueNotificationEmails(new Date('2026-10-09T13:05:00Z'));
    expect(out).toEqual({ skipped: 'locked' });
    expect(m.calendar).not.toHaveBeenCalled();
    expect(m.unlocks).toBe(0);
    expect(m.released).toBe(1);
  });

  it('keeps going when one mail job throws', async () => {
    m.review.mockRejectedValueOnce(new Error('boom'));
    const out = await runDueNotificationEmails(new Date('2026-10-09T08:00:00Z'));
    expect(m.calendar).toHaveBeenCalledOnce();
    expect(m.trial).toHaveBeenCalledOnce();
    expect(m.inactivity).not.toHaveBeenCalled();
    expect(out).toMatchObject({ failed: ['review.reminder'] });
  });

  it('aligns the next run to the UTC hour and does not overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T13:20:00Z'));
    expect(msUntilNextHour(Date.now())).toBe(40 * 60 * 1000);
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((r) => {
      release = r;
    }));
    const stop = startHourlyNotificationEmails(run);
    try {
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(HOUR_MS);
      expect(run).toHaveBeenCalledTimes(1);
      release();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      release();
    }
  });
});
