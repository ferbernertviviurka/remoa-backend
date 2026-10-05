// G18 F24: sendEmail with a fake provider (tries, idempotency, redirect, suppression, List-Unsubscribe) and the unsubscribe tokens.
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emailExamples } from '@remoa/contracts/mocks';
import type { EmailData, EmailTemplate } from '@remoa/contracts';
import { emailHash } from '../referral/email-normalize';
import { inviteeUnsubscribeToken, unsubscribeToken } from '../account/reminders';
import { EmailSendError, sendEmail, setEmailTestHooks, type OutgoingEmail } from './send';
import { signUnsubscribeToken, verifyUnsubscribeToken } from './tokens';

config({ path: '../../.env' });

const U = '11111111-2222-4333-8444-555555555555';
const H = 'a'.repeat(64);

describe('unsubscribe tokens', () => {
  it('round-trip with the scope; address scopes take a hash, user scopes a uuid', () => {
    expect(verifyUnsubscribeToken(signUnsubscribeToken({ userId: U }, 'calendar_d1'))).toEqual({ subject: { userId: U }, scope: 'calendar_d1', legacy: false });
    expect(verifyUnsubscribeToken(signUnsubscribeToken({ emailHash: H }, 'referral_invite'))).toEqual({ subject: { emailHash: H }, scope: 'referral_invite', legacy: false });
    expect(verifyUnsubscribeToken(signUnsubscribeToken({ emailHash: H }, 'pause'))).toBeNull();
    expect(verifyUnsubscribeToken(signUnsubscribeToken({ userId: U }, 'landing_waitlist'))).toBeNull();
  });
  it('tampering fails: scope swap, other subject, garbage', () => {
    const t = signUnsubscribeToken({ userId: U }, 'calendar_d1');
    const [id, , sig] = t.split('.');
    expect(verifyUnsubscribeToken(`${id}.store.${sig}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${U.replace('1', '9')}.calendar_d1.${sig}`)).toBeNull();
    expect(verifyUnsubscribeToken('x')).toBeNull();
    expect(verifyUnsubscribeToken(`${U}.nope.${sig}`)).toBeNull();
  });
  it('legacy F13/F18 tokens still verify (review reminder / invite opt-out)', () => {
    expect(verifyUnsubscribeToken(unsubscribeToken(U))).toEqual({ subject: { userId: U }, scope: 'review_reminder', legacy: true });
    expect(verifyUnsubscribeToken(inviteeUnsubscribeToken(H))).toEqual({ subject: { emailHash: H }, scope: 'referral_invite', legacy: true });
  });
});

it('architecture: the resend SDK and the provider endpoint appear only in src/emails', () => {
  const root = new URL('../', import.meta.url);
  const offenders = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('emails/'))
    .filter((f) => /from 'resend'|api\.resend\.com/.test(readFileSync(new URL(f, root), 'utf8')));
  expect(offenders).toEqual([]);
});

const sample = <T extends EmailTemplate>(t: T, v?: string) => emailExamples.find((e) => e.template === t && (!v || e.version === v))!.data as EmailData<T>;

describe.skipIf(!process.env.DATABASE_URL)('sendEmail (fake provider, local Supabase)', () => {
  let sent: OutgoingEmail[] = [];
  let failNext: Error[] = [];
  const users: string[] = [];
  let supa: Awaited<ReturnType<typeof import('../account/auth-admin')['adminClient']>>;
  let db: typeof import('@remoa/db')['db'];
  const ref = () => `test:${randomUUID()}`;
  const row = async (id: string | null) => (await db.execute<{ status: string; attempts: number; redirected: boolean; to_hash: string; provider_id: string | null; user_id: string | null }>(sql`select * from email_deliveries where id = ${id}`))[0];

  beforeAll(async () => {
    supa = (await import('../account/auth-admin')).adminClient();
    db = (await import('@remoa/db')).db;
  });
  afterEach(() => {
    sent = [];
    failNext = [];
    delete process.env.EMAIL_TEST_REDIRECT;
  });
  afterAll(async () => {
    setEmailTestHooks({});
    for (const id of users) await supa.auth.admin.deleteUser(id);
  });
  setEmailTestHooks({
    transport: async (m) => {
      const e = failNext.shift();
      if (e) throw e;
      sent.push(m);
      return { id: `fake-${randomUUID()}` };
    },
    sleep: async () => undefined,
  });
  const newUser = async () => {
    const { data, error } = await supa.auth.admin.createUser({ email: `g18-${randomUUID()}@test.local`, email_confirm: true });
    if (error) throw error;
    users.push(data.user.id);
    return { id: data.user.id, email: data.user.email! };
  };

  it('sends once per (template, reference), even when called twice at the same time', async () => {
    const u = await newUser();
    const input = { template: 'map-ready' as const, to: u.email, data: sample('map-ready'), reference: ref(), userId: u.id };
    const [a, b] = await Promise.all([sendEmail(input), sendEmail(input)]);
    expect(sent).toHaveLength(1);
    expect([a, b].filter((r) => r.status === 'sent' && !r.duplicate)).toHaveLength(1);
    const again = await sendEmail(input);
    expect(again).toMatchObject({ status: 'sent', duplicate: true, deliveryId: a.deliveryId });
    expect(sent).toHaveLength(1);
    expect(await row(a.deliveryId)).toMatchObject({ status: 'sent', attempts: 1, to_hash: emailHash(u.email), user_id: u.id });
    expect(sent[0]!.idempotencyKey).toBe(`map-ready/${input.reference}`);
    expect(sent[0]!.headers).toEqual({}); // transactional: no List-Unsubscribe
  });

  it('retries transient failures with backoff (3 tries), then gives up; a later call with the same key retries', async () => {
    const u = await newUser();
    const input = { template: 'map-ready' as const, to: u.email, data: sample('map-ready'), reference: ref(), userId: u.id };
    failNext = [new Error('timeout'), new EmailSendError('resend internal_server_error: x', false)];
    const ok = await sendEmail(input);
    expect(ok).toMatchObject({ status: 'sent', duplicate: false });
    expect(await row(ok.deliveryId)).toMatchObject({ attempts: 3, status: 'sent' });

    const input2 = { ...input, reference: ref() };
    failNext = [new Error('a'), new Error('b'), new Error('c')];
    const bad = await sendEmail(input2);
    expect(bad).toMatchObject({ status: 'failed' });
    expect(await row(bad.deliveryId)).toMatchObject({ status: 'failed', attempts: 3 });
    const retry = await sendEmail(input2);
    expect(retry).toMatchObject({ status: 'sent', duplicate: false, deliveryId: bad.deliveryId });
  });

  it('permanent provider errors are not retried', async () => {
    const u = await newUser();
    failNext = [new EmailSendError('resend validation_error: bad', true)];
    const r = await sendEmail({ template: 'map-ready', to: u.email, data: sample('map-ready'), reference: ref(), userId: u.id });
    expect(r).toMatchObject({ status: 'failed', reason: 'resend validation_error' });
    expect(await row(r.deliveryId)).toMatchObject({ attempts: 1 });
  });

  it('EMAIL_TEST_REDIRECT: goes to the test inbox, the row keeps the real hash and says redirected', async () => {
    const u = await newUser();
    process.env.EMAIL_TEST_REDIRECT = 'qa@test.local';
    const r = await sendEmail({ template: 'map-ready', to: u.email, data: sample('map-ready'), reference: ref(), userId: u.id });
    expect(sent[0]!.to).toBe('qa@test.local');
    expect(await row(r.deliveryId)).toMatchObject({ redirected: true, to_hash: emailHash(u.email) });
  });

  it('reminders carry List-Unsubscribe (URL + mailto) and one-click; the token turns off that row', async () => {
    const u = await newUser();
    await sendEmail({ template: 'review-reminder', to: u.email, data: sample('review-reminder'), reference: ref(), userId: u.id });
    const h = sent[0]!.headers!;
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const [, url, mailto] = /^<([^>]+)>, <(mailto:[^>]+)>$/.exec(h['List-Unsubscribe']!) ?? [];
    expect(mailto).toMatch(/^mailto:[^?]+\?subject=unsubscribe%20/);
    const token = new URL(url!).searchParams.get('token')!;
    expect(new URL(url!).pathname).toBe('/v1/emails/unsubscribe');
    expect(verifyUnsubscribeToken(token)).toMatchObject({ subject: { userId: u.id }, scope: 'review_reminder' });
    expect(sent[0]!.text).toContain(url);
    expect(sent[0]!.tags).toEqual([{ name: 'template', value: 'review-reminder' }, { name: 'class', value: 'reminder' }]);
  });

  it('hard bounce / complaint block reminder and list mail, not transactional; invite opt-out only blocks invites', async () => {
    const u = await newUser();
    await db.execute(sql`insert into email_suppressions (email_hash, reason) values (${emailHash(u.email)}, 'hard_bounce')`);
    const rem = await sendEmail({ template: 'review-reminder', to: u.email, data: sample('review-reminder'), reference: ref(), userId: u.id });
    expect(rem.status).toBe('suppressed');
    expect(await row(rem.deliveryId)).toMatchObject({ status: 'suppressed' });
    const tx = await sendEmail({ template: 'password-changed', to: u.email, data: sample('password-changed'), reference: ref(), userId: u.id });
    expect(tx.status).toBe('sent');

    const addr = `inv-${randomUUID()}@test.local`;
    await db.execute(sql`insert into email_suppressions (email_hash, reason) values (${emailHash(addr)}, 'invite_opt_out')`);
    expect((await sendEmail({ template: 'referral-invite', to: addr, data: sample('referral-invite'), reference: ref(), userId: null })).status).toBe('suppressed');
    const land = await sendEmail({ template: 'landing-waitlist', to: addr, data: sample('landing-waitlist'), reference: ref(), userId: null });
    expect(land.status).toBe('sent');
    const token = new URL(/<([^>]+)>/.exec(sent.at(-1)!.headers!['List-Unsubscribe']!)![1]!).searchParams.get('token')!;
    expect(verifyUnsubscribeToken(token)).toMatchObject({ subject: { emailHash: emailHash(addr) }, scope: 'landing_waitlist' });
    await db.execute(sql`delete from email_suppressions where email_hash in (${emailHash(u.email)}, ${emailHash(addr)})`);
  });

  it('bad input never throws and writes nothing', async () => {
    const r = await sendEmail({ template: 'map-ready', to: 'not-an-address', data: sample('map-ready'), reference: 'has space', userId: null });
    expect(r).toEqual({ status: 'failed', deliveryId: null, reason: 'invalid_input' });
    const noUser = await sendEmail({ template: 'review-reminder', to: 'a@test.local', data: sample('review-reminder'), reference: ref(), userId: null });
    expect(noUser).toMatchObject({ status: 'failed', reason: 'no_unsubscribe_subject' });
    expect(sent).toHaveLength(0);
  });
});
