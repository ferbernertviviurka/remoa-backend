import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackServer } from './server';

describe('trackServer', () => {
  const fetchMock = vi.fn(async () => new Response('1'));
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.MIXPANEL_TOKEN; });

  it('is a no-op without a token', async () => {
    await trackServer('subscription_started', {}, 'u1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the event with the user id and validated props', async () => {
    process.env.MIXPANEL_TOKEN = 'tok';
    await trackServer('referral_reward_granted', { side: 'referrer', kind: 'month' }, 'u1', { plan: 'pro' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.mixpanel.com/track');
    const [e] = JSON.parse(init.body);
    expect(e).toMatchObject({ event: 'referral_reward_granted', properties: { token: 'tok', distinct_id: 'u1', side: 'referrer', plan: 'pro' } });
  });

  it('drops events with props the contract does not allow, and swallows network errors', async () => {
    process.env.MIXPANEL_TOKEN = 'tok';
    await trackServer('subscription_started', { email: 'a@b.c' } as never, 'u1');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expect(trackServer('subscription_canceled', {}, 'u1')).resolves.toBeUndefined();
  });
});
