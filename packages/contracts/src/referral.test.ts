import { beforeEach, describe, expect, it } from 'vitest';
import {
  REFERRAL_CODE_ALPHABET,
  attributionInputSchema,
  eventSchemas,
  formatReferralCode,
  generateReferralCode,
  inviteInputSchema,
  normalizeReferralCode,
  referralInvitePublicSchema,
  referralSummarySchema,
} from './index';
import { referralMocks as m, referralSummaryFixtures, resetReferralMocks } from './mocks';

describe('referral code (FR-2)', () => {
  it('alphabet has no 0/O/1/I/L and 31 symbols', () => {
    expect(REFERRAL_CODE_ALPHABET).toHaveLength(31);
    expect(REFERRAL_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });
  it('generates 8 chars from the alphabet, varied', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateReferralCode()));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(normalizeReferralCode(c)).toBe(c);
  });
  it('rejection sampling skips bytes >= 248', () => {
    let calls = 0;
    const rand = (n: number) => new Uint8Array(n).fill(calls++ === 0 ? 250 : 0);
    expect(generateReferralCode(rand)).toBe('22222222');
  });
  it('normalizes case, spaces and hyphens; rejects ambiguous chars and wrong length', () => {
    expect(normalizeReferralCode(' 4k2f-9qxm ')).toBe('4K2F9QXM');
    expect(normalizeReferralCode('4K2F9QX0')).toBeNull();
    expect(normalizeReferralCode('4K2F9QXL')).toBeNull();
    expect(normalizeReferralCode('4K2F9QX')).toBeNull();
    expect(formatReferralCode('4K2F9QXM')).toBe('4K2F-9QXM');
    expect(attributionInputSchema.parse({ code: '4k2f-9qxm' }).code).toBe('4K2F9QXM');
    expect(attributionInputSchema.safeParse({ code: 'nope' }).success).toBe(false);
  });
});

describe('referral contracts', () => {
  beforeEach(() => resetReferralMocks());
  it('invite input: 1..5 unique e-mails, lower-cased', () => {
    expect(inviteInputSchema.parse({ emails: [' A@B.com '] }).emails).toEqual(['a@b.com']);
    expect(inviteInputSchema.safeParse({ emails: [] }).success).toBe(false);
    expect(inviteInputSchema.safeParse({ emails: Array.from({ length: 6 }, (_, i) => `a${i}@b.com`) }).success).toBe(false);
    expect(inviteInputSchema.safeParse({ emails: ['a@b.com', 'A@b.com'] }).success).toBe(false);
    expect(inviteInputSchema.safeParse({ emails: ['not-an-email'] }).success).toBe(false);
  });
  it('fixtures parse', () => {
    for (const f of Object.values(referralSummaryFixtures)) expect(referralSummarySchema.safeParse(f).success).toBe(true);
    expect(referralInvitePublicSchema.safeParse({ valid: false, inviterFirstName: 'x' }).success).toBe(false); // invalid leaks nothing
  });
  it('mocks: invites mask, decrement and hit the daily limit', async () => {
    resetReferralMocks(referralSummaryFixtures.limitReached);
    expect(await m.sendReferralInvites('u', { emails: ['a@b.com'] })).toMatchObject({ ok: false, error: { code: 'rate_limited', message: 'invite_daily_limit' } });
    resetReferralMocks();
    const r = await m.sendReferralInvites('u', { emails: ['dani@gmail.com'] });
    expect(r).toMatchObject({ ok: true, data: { sent: 1, invitesLeftToday: 19 } });
    const s = await m.getReferralSummary('u');
    expect(s.ok && s.data.friends[0]).toMatchObject({ displayName: 'd***@gmail.com', status: 'invited' });
  });
  it('mocks: public invite and attribution', async () => {
    expect(await m.getReferralInvite('4k2f-9qxm')).toMatchObject({ ok: true, data: { valid: true, code: '4K2F9QXM' } });
    expect(await m.getReferralInvite('ZZZZ-2222')).toMatchObject({ ok: true, data: { valid: false } });
    expect(await m.attributeReferral('u', { code: '4K2F9QXM' })).toMatchObject({ ok: true, data: { attributed: false } }); // own code
    expect(await m.attributeReferral('u', { code: 'ABCD2345' })).toMatchObject({ ok: true, data: { attributed: true } });
  });
  it('events carry no PII', () => {
    expect(eventSchemas.referral_share_clicked.safeParse({ channel: 'whatsapp' }).success).toBe(true);
    expect(eventSchemas.referral_invites_sent.safeParse({ count: 2, emails: ['a@b.c'] }).success).toBe(false);
    expect(eventSchemas.referral_signup.safeParse({ valid: true, method: 'google', code: '4K2F9QXM' }).success).toBe(false);
    expect(eventSchemas.upgrade_clicked.safeParse({ source: 'referral' }).success).toBe(true);
    expect(eventSchemas.first_board_created.safeParse({}).success).toBe(true);
  });
});
