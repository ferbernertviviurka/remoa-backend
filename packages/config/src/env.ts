// G18 (D-732): the one place that reads the e-mail / notification / cron settings from the environment.
// Production is ready by changing only `.env`: no key, domain, sender or service URL is written in code.
// Development (NODE_ENV=development|test) works with no keys: EMAIL_PROVIDER=console and neutral local defaults (D-733).
// An unset NODE_ENV counts as production (same fail-closed rule as STRIPE/AI/GRADER=mock in apps/api/src/index.ts).
import { z } from 'zod';

export const emailProviders = ['console', 'resend'] as const;
export type EmailProvider = (typeof emailProviders)[number];

export type Env = {
  production: boolean;
  /** Web origin for links in e-mails, no trailing slash. APP_URL, else the legacy WEB_ORIGIN. */
  appUrl: string;
  /** API public origin (unsubscribe, .ics and webhook URLs), no trailing slash. */
  apiOrigin: string;
  emailProvider: EmailProvider;
  /** Set whenever emailProvider is 'resend'. */
  resendApiKey: string | undefined;
  /** `Name <address>` or a bare address. */
  emailFrom: string;
  /** EMAIL_REPLY_TO, else the address inside EMAIL_FROM. */
  emailReplyTo: string;
  /** Only read by `emails:check`; when set, EMAIL_FROM must be on it (or a subdomain). */
  emailDomain: string | undefined;
  /** Svix secret of the Resend webhook; required in production with resend. */
  resendWebhookSecret: string | undefined;
  /** HMAC key of unsubscribe links (>= 32 chars). EMAIL_UNSUBSCRIBE_SECRET, else the legacy UNSUBSCRIBE_SECRET. */
  emailUnsubscribeSecret: string;
  /** When set, every e-mail goes to this address instead (staging). */
  emailTestRedirect: string | undefined;
  /** Standard Webhooks secret of the Supabase Auth "Send Email" hook; required in production with resend. */
  sendEmailHookSecret: string | undefined;
  /** Bearer secret of /v1/cron/* (>= 32 chars). */
  cronSecret: string;
  /** P-304: razão social and address printed in every e-mail footer (optional, Q-057). */
  emailFooterLegalName: string | undefined;
  emailFooterAddress: string | undefined;
};

/** Local-only fallbacks (never used in production; D-733). */
const DEV = {
  appUrl: 'http://localhost:3000',
  emailFrom: 'Remoa <dev@localhost.test>',
  emailUnsubscribeSecret: 'dev-only-email-unsubscribe-secret-not-for-production',
  cronSecret: 'dev-only-cron-secret-not-for-production-000000',
};

const MIN_SECRET = 32;
const email = z.string().email();
const url = z.string().url().refine((u) => /^https?:\/\//.test(u), 'must be http(s)');

/** `Remoa <a@b.c>` or `a@b.c` → the address, or null. */
export const addressOf = (from: string): string | null => {
  const a = /<([^<>\s]+)>\s*$/.exec(from)?.[1] ?? from.trim();
  return email.safeParse(a).success ? a : null;
};

/** Thrown at boot. Lists variable names and the problem, never a value. */
export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid environment: ${problems.join('; ')}`);
    this.name = 'EnvError';
  }
}

type Source = Record<string, string | undefined>;

export function parseEnv(source: Source = process.env): Env {
  const get = (k: string) => {
    const v = source[k]?.trim();
    return v ? v : undefined;
  };
  const production = source.NODE_ENV !== 'development' && source.NODE_ENV !== 'test';
  const problems: string[] = [];
  const need = (name: string, v: string | undefined, devDefault?: string) => {
    if (v !== undefined) return v;
    if (!production && devDefault !== undefined) return devDefault;
    problems.push(`${name} is required${production ? ' in production' : ''}`);
    return '';
  };
  const checkUrl = (name: string, v: string) => {
    if (v && !url.safeParse(v).success) problems.push(`${name} must be an http(s) URL`);
    return v.replace(/\/+$/, '');
  };
  const checkSecret = (name: string, v: string) => {
    if (v && v.length < MIN_SECRET) problems.push(`${name} must have at least ${MIN_SECRET} characters`);
    return v;
  };

  const appUrl = checkUrl('APP_URL', need('APP_URL (or WEB_ORIGIN)', get('APP_URL') ?? get('WEB_ORIGIN'), DEV.appUrl));
  const apiOrigin = checkUrl('API_ORIGIN', need('API_ORIGIN', get('API_ORIGIN'), `http://localhost:${get('PORT') ?? 4000}`));

  const rawProvider = get('EMAIL_PROVIDER');
  let emailProvider: EmailProvider = 'console';
  if (rawProvider === undefined) {
    if (production) problems.push(`EMAIL_PROVIDER is required in production (${emailProviders.join(' | ')})`);
  } else if ((emailProviders as readonly string[]).includes(rawProvider)) emailProvider = rawProvider as EmailProvider;
  else problems.push(`EMAIL_PROVIDER must be ${emailProviders.join(' | ')}`);
  const resend = emailProvider === 'resend';

  const resendApiKey = get('RESEND_API_KEY');
  if (resend && !resendApiKey) problems.push('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');

  // resend always needs a real sender; console in development may use the neutral local one.
  const emailFrom = need('EMAIL_FROM', get('EMAIL_FROM'), resend ? undefined : DEV.emailFrom);
  const fromAddress = emailFrom ? addressOf(emailFrom) : null;
  if (emailFrom && !fromAddress) problems.push('EMAIL_FROM must be "Name <address>" or an address');

  const replyTo = get('EMAIL_REPLY_TO');
  if (replyTo && !email.safeParse(replyTo).success) problems.push('EMAIL_REPLY_TO must be an e-mail address');

  const emailDomain = get('EMAIL_DOMAIN')?.toLowerCase();
  if (emailDomain && fromAddress) {
    const d = fromAddress.split('@')[1]!.toLowerCase();
    if (d !== emailDomain && !d.endsWith(`.${emailDomain}`)) problems.push('EMAIL_FROM must use EMAIL_DOMAIN (or a subdomain of it)');
  }

  const resendWebhookSecret = get('RESEND_WEBHOOK_SECRET');
  const sendEmailHookSecret = get('SEND_EMAIL_HOOK_SECRET');
  if (production && resend) {
    if (!resendWebhookSecret) problems.push('RESEND_WEBHOOK_SECRET is required in production with resend');
    if (!sendEmailHookSecret) problems.push('SEND_EMAIL_HOOK_SECRET is required in production with resend');
  }

  // D-734: EMAIL_UNSUBSCRIBE_SECRET replaces UNSUBSCRIBE_SECRET (F13); the old name is still read so links already sent keep working.
  const emailUnsubscribeSecret = checkSecret(
    'EMAIL_UNSUBSCRIBE_SECRET',
    need('EMAIL_UNSUBSCRIBE_SECRET', get('EMAIL_UNSUBSCRIBE_SECRET') ?? get('UNSUBSCRIBE_SECRET'), DEV.emailUnsubscribeSecret),
  );
  const cronSecret = checkSecret('CRON_SECRET', need('CRON_SECRET', get('CRON_SECRET'), DEV.cronSecret));

  const emailTestRedirect = get('EMAIL_TEST_REDIRECT');
  if (emailTestRedirect && !email.safeParse(emailTestRedirect).success) problems.push('EMAIL_TEST_REDIRECT must be an e-mail address');

  const emailFooterLegalName = get('EMAIL_FOOTER_LEGAL_NAME');
  const emailFooterAddress = get('EMAIL_FOOTER_ADDRESS');
  if ((emailFooterLegalName?.length ?? 0) + (emailFooterAddress?.length ?? 0) > 290) problems.push('EMAIL_FOOTER_LEGAL_NAME + EMAIL_FOOTER_ADDRESS must have at most 290 characters');

  if (problems.length) throw new EnvError(problems);
  return {
    production,
    appUrl,
    apiOrigin,
    emailProvider,
    resendApiKey,
    emailFrom,
    emailReplyTo: replyTo ?? fromAddress!,
    emailDomain,
    resendWebhookSecret,
    emailUnsubscribeSecret,
    emailTestRedirect,
    sendEmailHookSecret,
    cronSecret,
    emailFooterLegalName,
    emailFooterAddress,
  };
}

/** Parsed on every call (cheap): tests can change process.env freely. apps/api calls it once at boot to fail early. */
export const env = (): Env => parseEnv();

export type EmailHealth = {
  /** true only when e-mail really leaves (resend with a key). */
  configured: boolean;
  provider: EmailProvider;
  testRedirect: boolean;
  webhook: boolean;
  authHook: boolean;
};

/** For GET /health: booleans only, never a secret, address or domain. */
export const emailHealth = (e: Env = env()): EmailHealth => ({
  configured: e.emailProvider === 'resend' && !!e.resendApiKey,
  provider: e.emailProvider,
  testRedirect: !!e.emailTestRedirect,
  webhook: !!e.resendWebhookSecret,
  authHook: !!e.sendEmailHookSecret,
});
