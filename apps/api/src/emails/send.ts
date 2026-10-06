// G18 F24 FR-15/FR-16/FR-20: the only place that talks to the e-mail provider (and the only importer of the `resend` SDK).
// Callers go through notify() (rule 10); the Supabase Send Email hook is the other caller allowed by contracts/api.ts.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { z } from 'zod';
import { env } from '@remoa/config';
import {
  EMAIL_CLASS, emailDataSchemas, emailReferenceSchema,
  type EmailData, type EmailLinks, type EmailTemplate, type SendEmail, type SendEmailInput, type SendEmailResult,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { render } from '@remoa/emails';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { emailHash } from '../referral/email-normalize';
import { unsubscribeUrl, type UnsubscribeScope, type UnsubscribeSubject } from './tokens';

const log = createLogger({ requestId: 'email' });

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
  /** Provider-side idempotency (Resend keeps it 24 h; email_deliveries keeps it forever). */
  idempotencyKey?: string;
  /** Only names the console outbox files. */
  label?: string;
};
/** Throws EmailSendError on failure. */
export type Transport = (mail: OutgoingEmail) => Promise<{ id: string }>;

export class EmailSendError extends Error {
  /** permanent = retrying cannot help (bad request, bad key, bad sender). */
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = 'EmailSendError';
  }
}

const PERMANENT = new Set(['validation_error', 'missing_api_key', 'restricted_api_key', 'invalid_api_key', 'invalid_from_address', 'invalid_parameter', 'missing_required_field', 'invalid_idempotency_key', 'invalid_idempotent_request', 'invalid_access', 'security_error']);

function resendTransport(apiKey: string): Transport {
  const client = new Resend(apiKey);
  return async (m) => {
    const e = env();
    const { data, error } = await client.emails.send(
      { from: e.emailFrom, replyTo: e.emailReplyTo, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), headers: m.headers, tags: m.tags },
      m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : undefined,
    );
    if (error || !data) throw new EmailSendError(`resend ${error?.name ?? 'no_data'}: ${error?.message ?? ''}`.slice(0, 300), !!error && PERMANENT.has(error.name));
    return { id: data.id };
  };
}

/** Repo-root `.emails/` (gitignored). */
const OUTBOX = new URL('../../../../.emails/', import.meta.url);
const consoleTransport: Transport = async (m) => {
  const e = env();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${(m.label ?? 'raw').replace(/[^\w.-]+/g, '_').slice(0, 120)}`;
  await mkdir(OUTBOX, { recursive: true });
  // The address only on local disk outside production (staging with console keeps the hash only).
  const meta = { to: e.production ? emailHash(m.to) : m.to, from: e.emailFrom, replyTo: e.emailReplyTo, subject: m.subject, headers: m.headers ?? {}, tags: m.tags ?? [] };
  await Promise.all([
    writeFile(new URL(`${base}.txt`, OUTBOX), m.text),
    writeFile(new URL(`${base}.json`, OUTBOX), JSON.stringify(meta, null, 2)),
    ...(m.html ? [writeFile(new URL(`${base}.html`, OUTBOX), m.html)] : []),
  ]);
  log.info('email (console)', { subject: m.subject, label: m.label });
  return { id: `console-${randomUUID()}` };
};

const hooks: { transport?: Transport; sleep?: (ms: number) => Promise<void> } = {};
/** Test seam: a fake provider and an instant backoff. Pass `{}` to restore. */
export const setEmailTestHooks = (h: typeof hooks) => {
  hooks.transport = h.transport;
  hooks.sleep = h.sleep;
};

/** The provider chosen by EMAIL_PROVIDER. */
export function emailTransport(): Transport {
  if (hooks.transport) return hooks.transport;
  const e = env();
  return e.emailProvider === 'resend' && e.resendApiKey ? resendTransport(e.resendApiKey) : consoleTransport;
}

/** Waits before the 2nd and 3rd tries. */
const BACKOFF_MS = [500, 2000];
/** FR-11: one provider call never holds a caller longer than this (Resend dedupes a late success by the idempotency key). */
export const TRY_TIMEOUT_MS = 3_000;

// P-441 (D-992): user and admin requests run inside `defer`: the claim (idempotency, suppression, reminder cap) stays in the request,
// render + provider calls go after the response, in this process. `inline` = the caller must know the outcome (D-810 receipt):
// in the request, at most 1 retry. No scope (jobs, cron, webhooks, Auth hook) = inline with 3 tries, as before.
const emailMode = new AsyncLocalStorage<'defer' | 'inline'>();
export const deferEmails = <T>(fn: () => T): T => emailMode.run('defer', fn);
export const emailsInline = <T>(fn: () => T): T => emailMode.run('inline', fn);
const inFlight = new Set<Promise<unknown>>();
/** SIGTERM: wait (bounded) for deferred sends. ponytail: a crash still loses them (row stays `queued`); a resend job needs the payload stored. */
export const drainEmails = (maxMs: number) => Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, maxMs).unref())]);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new EmailSendError(`timeout after ${ms} ms`, false)), ms)));
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
const sleep = (ms: number) => (hooks.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);

/** One-click unsubscribe scope of each reminder/list template (the preference row it turns off). */
function scopeOf<T extends EmailTemplate>(template: T, data: EmailData<T>): UnsubscribeScope | null {
  switch (template) {
    case 'calendar-reminder': {
      const d = data as EmailData<'calendar-reminder'>;
      return d.version === 'varios' ? `calendar_${d.window}` : `calendar_${d.version}`;
    }
    case 'review-reminder': return 'review_reminder';
    case 'inactivity':
    case 'onboarding-nudge': return 'inactivity';
    case 'waitlist-confirm': return 'store';
    case 'referral-invite': return 'referral_invite';
    case 'landing-waitlist': return 'landing_waitlist';
    default: return null;
  }
}
const ADDRESS_SCOPES = new Set<UnsubscribeScope>(['referral_invite', 'landing_waitlist']);

/** P-304: "Razão social · endereço" for the footer, when the .env has them. Also used by the /dev/emails preview. */
export function footerLegal(): Pick<EmailLinks, 'legal'> {
  const { emailFooterLegalName: n, emailFooterAddress: a } = env();
  const legal = [n, a].filter(Boolean).join(' · ');
  return legal ? { legal } : {};
}

type Links = { links: EmailLinks; headers: Record<string, string> } | { error: string };
function linksFor<T extends EmailTemplate>(template: T, data: EmailData<T>, userId: string | null, toHash: string): Links {
  const e = env();
  const links: EmailLinks = { appUrl: e.appUrl, ...footerLegal() };
  const kind = EMAIL_CLASS[template];
  if (kind === 'transactional') return { links, headers: {} };
  const scope = scopeOf(template, data);
  if (!scope) return { error: 'no_unsubscribe_scope' };
  const address = ADDRESS_SCOPES.has(scope);
  if (!address && !userId) return { error: 'no_unsubscribe_subject' };
  const subject: UnsubscribeSubject = address ? { emailHash: toHash } : { userId: userId! };
  links.unsubscribeUrl = unsubscribeUrl(subject, scope);
  if (userId) links.preferencesUrl = `${e.appUrl}/app/notificacoes`;
  if (kind === 'reminder' && userId) links.pauseUrl = unsubscribeUrl({ userId }, 'pause');
  const token = new URL(links.unsubscribeUrl).searchParams.get('token') ?? '';
  return {
    links,
    // RFC 2369 + RFC 8058: clients POST the URL for one-click; mailto reaches the reply-to inbox with the token.
    headers: {
      'List-Unsubscribe': `<${links.unsubscribeUrl}>, <mailto:${e.emailReplyTo}?subject=${encodeURIComponent(`unsubscribe ${token}`)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/** Rows that may be claimed again by the same (template, reference): nothing reached the provider. */
const RETRIABLE = ['failed', 'suppressed'];
/** Runs inside the claim transaction, under a per-user advisory lock; a string blocks the send (notify's reminder cap). */
export type ClaimGate = (tx: Tx) => Promise<string | null>;
export type DeliverResult = SendEmailResult | { status: 'blocked'; deliveryId: null; reason: string };

type Claim = { kind: 'claimed'; id: string } | { kind: 'duplicate'; id: string; status: string } | { kind: 'suppressed'; id: string } | { kind: 'blocked'; reason: string };

async function claim(input: SendEmailInput, toHash: string, gate?: ClaimGate): Promise<Claim> {
  const { db } = await dbm();
  const { template, reference, userId } = input;
  return db.transaction(async (tx) => {
    if (gate && userId) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`email-cap:${userId}`}))`);
    // A `queued` row older than 15 min is a send that crashed mid-way (process died): it may be claimed again.
    const [prev] = await tx.execute<{ id: string; status: string; stale: boolean }>(sql`
      select id, status, (status = 'queued' and updated_at < now() - interval '15 minutes') as stale
      from email_deliveries where template = ${template} and reference = ${reference} for update`);
    if (prev && !RETRIABLE.includes(prev.status) && !prev.stale) return { kind: 'duplicate', id: prev.id, status: prev.status };
    if (gate) {
      const reason = await gate(tx);
      if (reason) return { kind: 'blocked', reason };
    }
    // Hard bounce / complaint stop reminder and list mail; invite_opt_out stops referral invites only (FR-16, D-737).
    const kind = EMAIL_CLASS[template];
    const blocking = template === 'referral-invite' ? ['invite_opt_out', 'hard_bounce', 'complaint'] : kind === 'transactional' ? [] : ['hard_bounce', 'complaint'];
    const suppressed = blocking.length > 0 && (await tx.execute(sql`
      select 1 from email_suppressions where email_hash = ${toHash} and reason in (${sql.join(blocking.map((r) => sql`${r}`), sql`, `)})`)).length > 0;
    const status = suppressed ? 'suppressed' : 'queued';
    const [row] = prev
      ? await tx.execute<{ id: string }>(sql`update email_deliveries set status = ${status}, attempts = 0, error = null, to_hash = ${toHash}, user_id = ${userId}, provider_id = null where id = ${prev.id} returning id`)
      : await tx.execute<{ id: string }>(sql`
          insert into email_deliveries (user_id, template, reference, to_hash, status) values (${userId}, ${template}, ${reference}, ${toHash}, ${status})
          on conflict (template, reference) do nothing returning id`);
    if (!row) {
      // Lost the insert race to a concurrent call with the same key.
      const [other] = await tx.execute<{ id: string; status: string }>(sql`select id, status from email_deliveries where template = ${template} and reference = ${reference}`);
      return { kind: 'duplicate', id: other!.id, status: other!.status };
    }
    return suppressed ? { kind: 'suppressed', id: row.id } : { kind: 'claimed', id: row.id };
  });
}

const inputSchema = z.object({ to: z.string().trim().email(), reference: emailReferenceSchema, userId: z.string().uuid().nullable() });

/** sendEmail with an optional gate (notify's reminder cap). Never throws. */
export async function deliverEmail<T extends EmailTemplate>(input: SendEmailInput<T>, gate?: ClaimGate): Promise<DeliverResult> {
  const { template } = input;
  const fail = (reason: string, deliveryId: string | null = null): SendEmailResult => {
    log.warn('email_failed', { event: 'email_failed', template, reason });
    return { status: 'failed', deliveryId, reason };
  };
  try {
    const base = inputSchema.safeParse(input);
    const data = emailDataSchemas[template].safeParse(input.data);
    if (!base.success || !data.success) {
      log.warn('email input rejected', { template, paths: [...(base.error?.issues ?? []), ...(data.error?.issues ?? [])].map((i) => i.path.join('.')) });
      return fail('invalid_input');
    }
    const toHash = emailHash(base.data.to);
    const linked = linksFor(template, data.data as EmailData<T>, input.userId, toHash);
    if ('error' in linked) return fail(linked.error);

    const c = await claim(input, toHash, gate);
    if (c.kind === 'blocked') return { status: 'blocked', deliveryId: null, reason: c.reason };
    if (c.kind === 'duplicate') return { status: c.status === 'queued' ? 'queued' : 'sent', deliveryId: c.id, duplicate: true };
    if (c.kind === 'suppressed') {
      log.info('email suppressed', { template });
      return { status: 'suppressed', deliveryId: c.id, reason: 'suppressed' };
    }

    const { db } = await dbm();
    const done = (status: 'sent' | 'failed', attempts: number, extra: { providerId?: string; error?: string; redirected?: boolean }) => db.execute(sql`
      update email_deliveries set status = ${status}, attempts = ${attempts}, provider_id = ${extra.providerId ?? null}, error = ${extra.error ?? null},
        redirected = ${extra.redirected ?? false}, sent_at = ${status === 'sent' ? sql`now()` : null} where id = ${c.id}`);

    const deliver = async (maxTries: number): Promise<DeliverResult> => {
      let rendered;
      try {
        rendered = await render(template, data.data as EmailData<T>, linked.links);
      } catch (e) {
        await done('failed', 0, { error: `render: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
        return fail('render_error', c.id);
      }

      const e = env();
      const redirected = !!e.emailTestRedirect;
      const mail: OutgoingEmail = {
        to: e.emailTestRedirect ?? base.data.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: linked.headers,
        tags: [{ name: 'template', value: template }, { name: 'class', value: EMAIL_CLASS[template] }],
        idempotencyKey: `${template}/${input.reference}`,
        label: `${template}-${input.reference}`,
      };
      const transport = emailTransport();
      let lastError = '';
      let tries = 0;
      for (; tries < maxTries; ) {
        tries++;
        try {
          const { id } = await withTimeout(transport(mail), TRY_TIMEOUT_MS);
          await done('sent', tries, { providerId: id, redirected });
          log.info('email_sent', { event: 'email_sent', template, attempts: tries, redirected });
          return { status: 'sent', deliveryId: c.id, duplicate: false };
        } catch (err) {
          lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
          if (err instanceof EmailSendError && err.permanent) break;
          if (tries < maxTries) await sleep(BACKOFF_MS[tries - 1]!);
        }
      }
      await done('failed', tries, { error: lastError, redirected });
      return fail(lastError.split(':')[0] || 'provider_error', c.id);
    };

    const mode = emailMode.getStore();
    if (mode !== 'defer') return await deliver(mode === 'inline' ? 2 : 3);
    // After the response: setImmediate lets the handler finish first; deliver never throws, the catch is for the `done` update.
    const job = new Promise<void>((r) => setImmediate(r))
      .then(() => deliver(3))
      .catch((e: unknown) => log.error('email crashed', { template, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => inFlight.delete(job));
    inFlight.add(job);
    return { status: 'queued', deliveryId: c.id, duplicate: false };
  } catch (e) {
    log.error('email crashed', { template, error: e instanceof Error ? e.message : String(e) });
    return fail('internal');
  }
}

/** contracts/api.ts SendEmail. `blocked` cannot happen without a gate. */
export const sendEmail: SendEmail = async (input) => {
  const r = await deliverEmail(input);
  return r.status === 'blocked' ? { status: 'failed', deliveryId: null, reason: r.reason } : r;
};
