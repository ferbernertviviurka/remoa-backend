import { afterEach, describe, expect, it } from 'vitest';
import { inngestConfigured } from './client';

describe('inngest dispatch', () => {
  const prevKey = process.env.INNGEST_EVENT_KEY;
  const prevDev = process.env.INNGEST_DEV;

  afterEach(() => {
    if (prevKey === undefined) delete process.env.INNGEST_EVENT_KEY;
    else process.env.INNGEST_EVENT_KEY = prevKey;
    if (prevDev === undefined) delete process.env.INNGEST_DEV;
    else process.env.INNGEST_DEV = prevDev;
  });

  it('stays inline until a key or INNGEST_DEV is set', () => {
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_DEV;
    expect(inngestConfigured()).toBe(false);
    process.env.INNGEST_DEV = '1';
    expect(inngestConfigured()).toBe(true);
  });
});
