import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  purge: vi.fn(async () => 2), expire: vi.fn(async () => 5), remind: vi.fn(async () => 1),
  referrals: vi.fn(async () => ({ expired: 0 })), support: vi.fn(async () => ({ purged: 0 })), metrics: vi.fn(async () => 2),
  trial: vi.fn(async () => ({ d3: 0, d0: 0 })),
}));
vi.mock('./jobs', () => ({ purgeDeletedAccounts: m.purge, expireAnswerTexts: m.expire }));
vi.mock('../cleanup/assets', () => ({ purgeDeletedCards: vi.fn(async () => 3), cleanOrphanAssets: vi.fn(async () => 4) }));
vi.mock('./reminders', () => ({ sendDailyReminders: m.remind }));
vi.mock('../referral/sweep', () => ({ sweepReferrals: m.referrals }));
vi.mock('../support/retention', () => ({ sweepSupport: m.support }));
vi.mock('../onboarding/emails', () => ({ sendOnboardingEmails: vi.fn(async () => ({ mapReady: 0, day3: 0 })) }));
vi.mock('../admin/overview/metrics', () => ({ refreshRecentMetrics: m.metrics }));
vi.mock('../billing/trial-notice', () => ({ sweepTrialNotices: m.trial }));
vi.mock('../billing/stripe', () => ({ createStripe: vi.fn(), installStripe: vi.fn() }));
vi.mock('../ai/service', () => ({ failStaleJobs: vi.fn(async () => 0) }));

import { runDaily, runHourly, runSteps } from './maintenance';
import { sendOnboardingEmails } from '../onboarding/emails';
import { maintenanceDaily, maintenanceHourly } from '../inngest/maintenance';

describe('maintenance schedule (F08 FR-8)', () => {
  const now = new Date('2026-10-04T06:00:00Z');

  it('daily runs purge and answer-text expiry with the same clock, and is safe to repeat', async () => {
    expect(await runDaily(now)).toEqual({ purged: 2, expired: 5, cards: 3, assets: 4 });
    await runDaily(now);
    expect(m.purge).toHaveBeenCalledTimes(2);
    expect(m.expire).toHaveBeenCalledWith(now);
  });

  it('hourly runs the sweeps, not the daily purges nor the old review reminder (now review.reminder, G18)', async () => {
    m.purge.mockClear(); m.expire.mockClear();
    const out = await runHourly(now);
    expect(out).not.toHaveProperty('reminded');
    expect(m.remind).not.toHaveBeenCalled();
    expect(m.referrals).toHaveBeenCalledWith(now);
    expect(m.trial).toHaveBeenCalledWith(now);
    expect(m.purge).not.toHaveBeenCalled();
    expect(m.expire).not.toHaveBeenCalled();
  });

  it('a step that throws does not stop the next ones (D-1570: the calendar reminders were skipped)', async () => {
    const reminders = vi.fn(async () => ({ sent: 1 }));
    const { out, failed } = await runSteps({ env: async () => { throw new Error('EnvError'); }, 'calendar.dispatch-reminders': reminders });
    expect(reminders).toHaveBeenCalled();
    expect(out).toEqual({ 'calendar.dispatch-reminders': { sent: 1 } });
    expect(failed).toEqual(['env']);
  });

  it('hourly still runs the later sweeps when one fails, then reports the failure', async () => {
    m.trial.mockClear();
    vi.mocked(sendOnboardingEmails).mockRejectedValueOnce(new Error('boom'));
    await expect(runHourly(now)).rejects.toThrow('maintenance hourly failed: onboarding');
    expect(m.trial).toHaveBeenCalledWith(now);
  });

  it('registers one hourly and one daily cron', () => {
    const cron = (f: unknown) => JSON.stringify((f as { opts: unknown }).opts);
    expect(cron(maintenanceHourly)).toContain('0 * * * *');
    expect(cron(maintenanceDaily)).toContain('0 6 * * *');
  });
});
