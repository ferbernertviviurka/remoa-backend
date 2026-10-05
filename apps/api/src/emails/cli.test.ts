// G18 F24: emails:check readiness rule (pure) — what blocks the first real send.
import { describe, expect, it } from 'vitest';
import { parseEnv } from '@remoa/config';
import { domainProblems, sendingDomain } from './cli';

describe('emails:check', () => {
  it('ready only when the domain exists, is verified and both trackings are off', () => {
    expect(domainProblems({ name: 'remoa.com.br', found: true, status: 'verified', openTracking: false, clickTracking: false })).toEqual([]);
    expect(domainProblems({ name: 'remoa.com.br', found: false })).toHaveLength(1);
    expect(domainProblems({ name: 'remoa.com.br', found: true, status: 'pending', openTracking: false, clickTracking: false })).toHaveLength(1);
    expect(domainProblems({ name: 'remoa.com.br', found: true, status: 'verified', openTracking: true, clickTracking: undefined })).toHaveLength(2);
  });
  it('sending domain: EMAIL_DOMAIN, else the EMAIL_FROM domain', () => {
    const dev = { NODE_ENV: 'test' };
    expect(sendingDomain(parseEnv({ ...dev, EMAIL_FROM: 'Remoa <contato@remoa.com.br>' }))).toBe('remoa.com.br');
    expect(sendingDomain(parseEnv({ ...dev, EMAIL_FROM: 'Remoa <contato@mail.remoa.com.br>', EMAIL_DOMAIN: 'remoa.com.br' }))).toBe('remoa.com.br');
  });
});
