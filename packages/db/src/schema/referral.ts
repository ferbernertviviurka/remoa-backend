// F18 Indicação de amigos (CCR-010, D-380–D-389). RLS, grants and referral_friends() in migrations/0018_f18_referral.sql (hand-appended).
import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { emailSuppressionReasons, grantRevokeReasons, grantSources, referralChannels, referralRejectReasons, referralStatuses } from '@remoa/contracts';
import { authUsers, planEnum, userId } from './common';

export const referralStatusEnum = pgEnum('referral_status', referralStatuses);
export const referralChannelEnum = pgEnum('referral_channel', referralChannels);
export const referralRejectReasonEnum = pgEnum('referral_reject_reason', referralRejectReasons);
export const grantSourceEnum = pgEnum('grant_source', grantSources);
export const grantRevokeReasonEnum = pgEnum('grant_revoke_reason', grantRevokeReasons);

/** One stable code per user, created lazily by GET /v1/referral/summary (D-382). */
export const referralCodes = pgTable('referral_codes', {
  userId: userId().primaryKey(),
  code: text('code').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [check('referral_codes_code', sql`${t.code} ~ '^[2-9A-HJKMNP-Z]{8}$'`)]);

/**
 * One row per (referrer, invited person). `channel='email'` rows start as `invited` with only hash + mask;
 * `channel='link'` rows start at `signed_up`. Referee account deleted → referee_id null ("Conta removida", D-387).
 */
export const referrals = pgTable('referrals', {
  id: uuid('id').primaryKey().defaultRandom(),
  referrerId: uuid('referrer_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  refereeId: uuid('referee_id').references(() => authUsers.id, { onDelete: 'set null' }),
  /** sha256 hex of the normalized e-mail (D-386); never the address. */
  invitedEmailHash: text('invited_email_hash'),
  invitedEmailMasked: text('invited_email_masked'),
  channel: referralChannelEnum('channel').notNull(),
  status: referralStatusEnum('status').notNull(),
  rejectReason: referralRejectReasonEnum('reject_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  signedUpAt: timestamp('signed_up_at', { withTimezone: true }),
  qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
  /** invited rows: created_at + 30 days (FR-22). */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (t) => [
  // One referee has one referrer (FR-16); also makes (referrer_id, referee_id) unique.
  uniqueIndex('referrals_referee_idx').on(t.refereeId).where(sql`${t.refereeId} is not null`),
  // Re-inviting the same address is a no-op (ON CONFLICT DO NOTHING).
  uniqueIndex('referrals_referrer_email_idx').on(t.referrerId, t.invitedEmailHash).where(sql`${t.invitedEmailHash} is not null`),
  // Summary list, daily invite limit, 30-day velocity limit.
  index('referrals_referrer_idx').on(t.referrerId, t.createdAt),
  // Sweep: pending qualifications and invite expiry.
  index('referrals_pending_idx').on(t.status, t.expiresAt).where(sql`${t.status} in ('invited', 'signed_up')`),
  check('referrals_not_self', sql`${t.referrerId} <> ${t.refereeId}`),
  check('referrals_email_channel', sql`${t.channel} <> 'email' or (${t.invitedEmailHash} is not null and ${t.invitedEmailMasked} is not null)`),
  check('referrals_reject_reason', sql`(${t.status} = 'rejected') = (${t.rejectReason} is not null)`),
  check('referrals_qualified_at', sql`${t.status} <> 'qualified' or ${t.qualifiedAt} is not null`),
  check('referrals_signed_up_at', sql`${t.status} in ('invited', 'expired') or ${t.signedUpAt} is not null`),
]);

/**
 * Free Pro time (FR-18). Per user, grants chain: starts_at = greatest(now, last active ends_at) (D-381).
 * Pro is active while some non-revoked grant has starts_at <= now < ends_at.
 */
export const entitlementGrants = pgTable('entitlement_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  source: grantSourceEnum('source').notNull(),
  /** Referrer deletes the account → set null; the referee keeps the month. */
  referralId: uuid('referral_id').references(() => referrals.id, { onDelete: 'set null' }),
  plan: planEnum('plan').notNull().default('pro'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: grantRevokeReasonEnum('revoked_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  // Idempotency of the double grant (FR-18): one grant per (referral, user); re-running the job conflicts.
  uniqueIndex('entitlement_grants_referral_user_idx').on(t.referralId, t.userId),
  index('entitlement_grants_user_idx').on(t.userId, t.endsAt),
  check('entitlement_grants_range', sql`${t.endsAt} > ${t.startsAt}`),
  check('entitlement_grants_revoked', sql`(${t.revokedAt} is null) = (${t.revokedReason} is null)`),
  check('entitlement_grants_plan', sql`${t.plan} = 'pro'`),
]);

/** Pro subscriber's month as Stripe customer balance credit (FR-19, Q-042). Row first, Stripe call after commit (D-384). */
export const billingCredits = pgTable('billing_credits', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  referralId: uuid('referral_id').references(() => referrals.id, { onDelete: 'set null' }),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('brl'),
  /** Set when Stripe confirmed; null = pending (retried by the sweep with idempotency key `referral-credit:<id>`). */
  stripeBalanceTxnId: text('stripe_balance_txn_id').unique(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('billing_credits_referral_user_idx').on(t.referralId, t.userId),
  index('billing_credits_user_idx').on(t.userId),
  check('billing_credits_amount', sql`${t.amountCents} > 0`),
  check('billing_credits_currency', sql`${t.currency} = 'brl'`),
  check('billing_credits_applied', sql`(${t.appliedAt} is null) = (${t.stripeBalanceTxnId} is null)`),
]);

/**
 * P-192 (D-494): addresses that clicked "não quero mais convites" without having an account. Keyed by the D-386 hash
 * (sha256 hex of the normalized e-mail); never the plaintext. Server only (RLS on, no policy, no grant).
 */
export const emailSuppressions = pgTable('email_suppressions', {
  emailHash: text('email_hash').primaryKey(),
  /** G18 (D-737): invite_opt_out (F18, stops invites only) | hard_bounce | complaint (stop reminder and list mail). One row per address: upgrade the reason, never downgrade. */
  reason: text('reason').notNull().default('invite_opt_out'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  check('email_suppressions_hash', sql`${t.emailHash} ~ '^[0-9a-f]{64}$'`),
  check('email_suppressions_reason', sql.raw(`reason in (${emailSuppressionReasons.map((r) => `'${r}'`).join(', ')})`)),
]);
