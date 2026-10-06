import { describe, expect, it } from 'vitest';
import { EnvError, addressOf, emailHealth, parseEnv, perfEnv } from './env';

const S32 = 'x'.repeat(32);
const prod = {
  NODE_ENV: 'production',
  APP_URL: 'https://app.example.com/',
  API_ORIGIN: 'https://api.example.com',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'Remoa <contato@example.com>',
  EMAIL_DOMAIN: 'example.com',
  RESEND_WEBHOOK_SECRET: 'whsec_test',
  EMAIL_UNSUBSCRIBE_SECRET: S32,
  SEND_EMAIL_HOOK_SECRET: 'v1,whsec_test',
  CRON_SECRET: S32,
  SITE_URL: 'https://www.example.com/',
  BLOG_PREVIEW_SECRET: S32,
  S3_PUBLIC_BUCKET: 'blog-public',
  R2_PUBLIC_BASE_URL: 'https://img.example.com',
  REVALIDATE_SECRET: S32,
  LEGAL_TERMS_VERSION: '2026-10-01',
  LEGAL_PRIVACY_VERSION: '2026-10-01',
};
const problems = (src: Record<string, string | undefined>) => {
  try {
    parseEnv(src);
    return [];
  } catch (e) {
    if (e instanceof EnvError) return e.problems;
    throw e;
  }
};

describe('parseEnv', () => {
  it('development works with no keys: console + neutral local defaults', () => {
    const e = parseEnv({ NODE_ENV: 'development' });
    expect(e).toMatchObject({ production: false, emailProvider: 'console', appUrl: 'http://localhost:3000', apiOrigin: 'http://localhost:4000', resendApiKey: undefined });
    expect(e.emailReplyTo).toBe('dev@localhost.test');
    expect(e.emailUnsubscribeSecret.length).toBeGreaterThanOrEqual(32);
    expect(e.cronSecret.length).toBeGreaterThanOrEqual(32);
    expect(emailHealth(e)).toEqual({ configured: false, provider: 'console', testRedirect: false, webhook: false, authHook: false });
  });

  it('blank values count as unset (the .env.example style KEY=)', () => {
    expect(parseEnv({ NODE_ENV: 'test', RESEND_API_KEY: '', EMAIL_PROVIDER: ' ' }).emailProvider).toBe('console');
  });

  it('full production config parses; trailing slash dropped; reply-to from EMAIL_FROM', () => {
    const e = parseEnv(prod);
    expect(e).toMatchObject({ production: true, appUrl: 'https://app.example.com', emailReplyTo: 'contato@example.com' });
    expect(emailHealth(e)).toEqual({ configured: true, provider: 'resend', testRedirect: false, webhook: true, authHook: true });
  });

  it('unset NODE_ENV is production', () => {
    expect(problems({})).toContain('EMAIL_PROVIDER is required in production (console | resend)');
  });

  it('production with resend and no RESEND_API_KEY throws at boot', () => {
    expect(problems({ ...prod, RESEND_API_KEY: undefined })).toEqual(['RESEND_API_KEY is required when EMAIL_PROVIDER=resend']);
  });

  it('resend never falls back to a default sender, not even in development', () => {
    expect(problems({ NODE_ENV: 'development', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' })).toEqual(['EMAIL_FROM is required']);
  });

  it('production requires every secret and origin, and never prints values', () => {
    const p = problems({ NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_secret_value' });
    expect(p).toEqual(expect.arrayContaining([
      'APP_URL (or WEB_ORIGIN) is required in production',
      'API_ORIGIN is required in production',
      'EMAIL_FROM is required in production',
      'RESEND_WEBHOOK_SECRET is required in production with resend',
      'SEND_EMAIL_HOOK_SECRET is required in production with resend',
      'EMAIL_UNSUBSCRIBE_SECRET is required in production',
      'CRON_SECRET is required in production',
    ]));
    expect(p.join(' ')).not.toContain('re_secret_value');
  });

  it('secrets need 32+ characters', () => {
    expect(problems({ ...prod, CRON_SECRET: 'short' })).toEqual(['CRON_SECRET must have at least 32 characters']);
  });

  it('legacy names: WEB_ORIGIN and UNSUBSCRIBE_SECRET are read when the new ones are absent; new ones win', () => {
    const legacy = { ...prod, APP_URL: undefined, WEB_ORIGIN: 'https://web.example.com', EMAIL_UNSUBSCRIBE_SECRET: undefined, UNSUBSCRIBE_SECRET: 'y'.repeat(40) };
    expect(parseEnv(legacy)).toMatchObject({ appUrl: 'https://web.example.com', emailUnsubscribeSecret: 'y'.repeat(40) });
    expect(parseEnv({ ...legacy, APP_URL: 'https://new.example.com', EMAIL_UNSUBSCRIBE_SECRET: S32 })).toMatchObject({ appUrl: 'https://new.example.com', emailUnsubscribeSecret: S32 });
  });

  it('EMAIL_FROM must be on EMAIL_DOMAIN', () => {
    expect(problems({ ...prod, EMAIL_FROM: 'Remoa <a@other.com>' })).toEqual(['EMAIL_FROM must use EMAIL_DOMAIN (or a subdomain of it)']);
    expect(problems({ ...prod, EMAIL_FROM: 'Remoa <a@mail.example.com>' })).toEqual([]);
  });

  it('rejects bad values', () => {
    expect(problems({ ...prod, EMAIL_PROVIDER: 'smtp', APP_URL: 'ftp://x', EMAIL_TEST_REDIRECT: 'nope', EMAIL_REPLY_TO: 'nope' })).toEqual(expect.arrayContaining([
      'EMAIL_PROVIDER must be console | resend',
      'APP_URL must be an http(s) URL',
      'EMAIL_TEST_REDIRECT must be an e-mail address',
      'EMAIL_REPLY_TO must be an e-mail address',
    ]));
  });

  it('console is allowed in production (staging) but reports not configured', () => {
    expect(emailHealth(parseEnv({ ...prod, EMAIL_PROVIDER: 'console', EMAIL_TEST_REDIRECT: 'qa@example.com' }))).toMatchObject({ configured: false, provider: 'console', testRedirect: true });
  });
});

describe('addressOf', () => {
  it.each([
    ['Remoa <contato@example.com>', 'contato@example.com'],
    ['contato@example.com', 'contato@example.com'],
    ['Remoa', null],
  ])('%s', (from, want) => expect(addressOf(from)).toBe(want));

  it('G19 blog/legal: production values, revalidate default, dev fallbacks and validation', () => {
    const e = parseEnv(prod);
    expect(e).toMatchObject({ siteUrl: 'https://www.example.com', revalidateUrl: 'https://www.example.com/api/revalidate', s3PublicBucket: 'blog-public',
      r2PublicBaseUrl: 'https://img.example.com', indexNowKey: undefined, legalTermsVersion: '2026-10-01' });
    expect(parseEnv({ ...prod, REVALIDATE_URL: 'https://web.example.com/api/revalidate' }).revalidateUrl).toBe('https://web.example.com/api/revalidate');
    const d = parseEnv({ NODE_ENV: 'development' });
    expect(d).toMatchObject({ siteUrl: 'http://localhost:3000', revalidateUrl: 'http://localhost:3000/api/revalidate', legalTermsVersion: 'dev', s3PublicBucket: 'blog' });
    const p = problems({ ...prod, SITE_URL: undefined, BLOG_PREVIEW_SECRET: 'short', S3_PUBLIC_BUCKET: undefined, R2_PUBLIC_BASE_URL: 'ftp://x',
      REVALIDATE_SECRET: undefined, INDEXNOW_KEY: 'a b', LEGAL_TERMS_VERSION: 'v 1', LEGAL_PRIVACY_VERSION: undefined });
    expect(p).toEqual(expect.arrayContaining([
      'SITE_URL is required in production', 'BLOG_PREVIEW_SECRET must have at least 32 characters', 'S3_PUBLIC_BUCKET is required in production',
      'R2_PUBLIC_BASE_URL must be an http(s) URL', 'REVALIDATE_SECRET is required in production', 'INDEXNOW_KEY must be 8-128 letters, digits or hyphens',
      'LEGAL_TERMS_VERSION must be 1-32 letters, digits, ".", "_" or "-"', 'LEGAL_PRIVACY_VERSION is required in production',
    ]));
  });
  it('refuses the public blog bucket equal to the private one (P-431)', () => {
    expect(problems({ ...prod, S3_BUCKET: 'assets', S3_PUBLIC_BUCKET: 'assets' })).toContain('S3_PUBLIC_BUCKET must differ from S3_BUCKET (blog images would land in the private bucket)');
  });
});

describe('perfEnv (G21/F29 FR-3)', () => {
  it('defaults to 150 ms and quiet; reads PERF_SLOW_QUERY_MS and PERF_LOG_QUERIES=1; ignores bad values', () => {
    expect(perfEnv({})).toEqual({ slowQueryMs: 150, logQueries: false });
    expect(perfEnv({ PERF_SLOW_QUERY_MS: '0', PERF_LOG_QUERIES: '1' })).toEqual({ slowQueryMs: 0, logQueries: true });
    expect(perfEnv({ PERF_SLOW_QUERY_MS: 'abc', PERF_LOG_QUERIES: 'true' })).toEqual({ slowQueryMs: 150, logQueries: false });
  });
});
