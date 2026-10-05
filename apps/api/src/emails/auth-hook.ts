// G18 F24 FR-7/FR-9: Supabase Auth "Send Email" hook. Supabase stops sending its own e-mails and calls POST /v1/auth/send-email;
// we build the verify link and send account-confirm / password-reset through notifyAddress (rule 10; by address, D-795).
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { notifyAddress } from '../notifications/notify';
import { emailHash } from '../referral/email-normalize';

const log = createLogger({ requestId: 'auth-email-hook' });

const DEFAULT_TZ = 'America/Sao_Paulo';
/** FR-9: at most 3 reset e-mails per address per rolling hour; the 4th is answered 200 and not sent (nothing revealed). */
export const RESET_LIMIT = { max: 3, windowMinutes: 60 } as const;

const opt = z.string().max(2000).optional().nullable();
export const sendEmailHookSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email().optional().nullable(),
    new_email: z.string().email().optional().nullable().or(z.literal('')),
    user_metadata: z.record(z.unknown()).optional().nullable(),
  }).passthrough(),
  email_data: z.object({
    token: opt,
    token_hash: z.string().max(2000),
    redirect_to: opt,
    email_action_type: z.string().max(60),
    site_url: opt,
    token_new: opt,
    token_hash_new: opt,
  }).passthrough(),
});
export type SendEmailHook = z.infer<typeof sendEmailHookSchema>;

/** 200 `{}` = handled (sent, deduplicated, rate limited or ignored); 'failed' = the provider refused after the retries. */
export type HookOutcome = { status: 'ok'; note: string } | { status: 'failed'; message: string };

/** `${SUPABASE_URL}/auth/v1/verify?token=<token_hash>&type=<action>&redirect_to=<redirect_to>` (no URL hard-coded: NEXT_PUBLIC_SUPABASE_URL). */
export function verifyUrl(supabaseUrl: string, tokenHash: string, type: string, redirectTo: string | null | undefined): string {
  const u = new URL(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/verify`);
  u.searchParams.set('token', tokenHash);
  u.searchParams.set('type', type);
  if (redirectTo) u.searchParams.set('redirect_to', redirectTo);
  return u.toString();
}

const firstName = (m: Record<string, unknown> | null | undefined) => {
  const raw = m?.name ?? m?.full_name;
  const n = typeof raw === 'string' ? raw.trim().split(/\s+/)[0]?.slice(0, 80) : '';
  return n || null;
};

async function resetsInWindow(address: string): Promise<number> {
  const { db } = await dbm();
  const [r] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from email_deliveries
    where template = 'password-reset' and to_hash = ${emailHash(address)} and status not in ('failed', 'suppressed')
      and created_at > now() - make_interval(mins => ${RESET_LIMIT.windowMinutes})`);
  return r?.n ?? 0;
}

async function profileTz(userId: string): Promise<string> {
  const { db } = await dbm();
  const [r] = await db.execute<{ tz: string }>(sql`select timezone as tz from profiles where user_id = ${userId} and timezone in (select name from pg_timezone_names)`);
  return r?.tz ?? DEFAULT_TZ;
}

/**
 * `hookId` (the webhook-id header) is the idempotency reference: Supabase retries a timed-out call with the same id, so the
 * person never gets two copies. The token hash never goes into the reference (it is a credential).
 */
export async function handleSendEmailHook(h: SendEmailHook, hookId: string, supabaseUrl: string, now = new Date()): Promise<HookOutcome> {
  const { user, email_data: d } = h;
  const action = d.email_action_type;
  const ref = hookId.replace(/[^\w.-]/g, '').slice(0, 120) || 'none';
  const name = firstName(user.user_metadata);
  const link = (tokenHash: string) => verifyUrl(supabaseUrl, tokenHash, action, d.redirect_to);
  const results: Awaited<ReturnType<typeof notifyAddress>>[] = [];

  switch (action) {
    case 'signup':
    case 'invite':
    case 'magiclink': {
      if (!user.email) return { status: 'ok', note: 'no_address' };
      const version = action === 'magiclink' ? 'magiclink' : 'signup';
      results.push(await notifyAddress(user.email, 'account', { reference: `${action}:${ref}`, email: { version, name, confirmUrl: link(d.token_hash) } }));
      break;
    }
    case 'email_change': {
      // Secure e-mail change (double_confirm_changes): Supabase swaps the names — token_hash_new goes to the CURRENT address,
      // token_hash to the NEW one. Without it, only the new address gets token_hash.
      const sends: [string | null | undefined, string | null | undefined, string][] = d.token_hash_new
        ? [[user.email, d.token_hash_new, 'current'], [user.new_email, d.token_hash, 'new']]
        : [[user.new_email || user.email, d.token_hash, 'new']];
      for (const [to, hash, side] of sends) {
        if (!to || !hash) continue;
        results.push(await notifyAddress(to, 'account', { reference: `email_change:${side}:${ref}`, email: { version: 'email_change', name, confirmUrl: link(hash) } }));
      }
      break;
    }
    case 'recovery': {
      if (!user.email) return { status: 'ok', note: 'no_address' };
      // ponytail: count-then-send is not atomic; two simultaneous requests could make it 4. Supabase's own max_frequency per user already spaces them.
      if ((await resetsInWindow(user.email)) >= RESET_LIMIT.max) {
        log.warn('password reset rate limited', { event: 'password_reset_limited' });
        return { status: 'ok', note: 'rate_limited' };
      }
      results.push(await notifyAddress(user.email, 'password_reset', {
        reference: `recovery:${ref}`,
        // The hook payload carries no user agent or IP: the device line is left out (template handles null).
        email: { email: user.email, resetUrl: link(d.token_hash), device: null, requestedAt: now.toISOString(), timezone: await profileTz(user.id) },
      }));
      break;
    }
    default:
      // reauthentication (OTP code), "email" OTP and the *_notification types: not used by the web (D-796); we send our own
      // password-changed notice through notify(). Acknowledged so the Auth request does not fail.
      log.info('auth e-mail ignored', { action });
      return { status: 'ok', note: 'ignored' };
  }
  const failed = results.find((r) => r.email === 'failed');
  if (failed) return { status: 'failed', message: 'email provider failed' };
  return { status: 'ok', note: results.map((r) => r.email).join(',') || 'nothing' };
}
