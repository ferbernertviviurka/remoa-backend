// F18 Indicação de amigos (CCR-010, D-380–D-389). Enum arrays are the single source for zod here and pgEnum in @remoa/db.
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';

/** DB states (FR-17). The UI only ever sees `friendStatuses` (D-385). */
export const referralStatuses = ['invited', 'signed_up', 'qualified', 'rejected', 'expired'] as const;
export const referralChannels = ['link', 'email'] as const;
/** FR-20. Never shown to the referrer; carried by `referral_rejected`. */
export const referralRejectReasons = ['self_referral', 'disposable_email', 'existing_account', 'velocity_limit', 'fraud_signals', 'manual'] as const;
export const grantSources = ['referral', 'promo', 'support'] as const;
export const grantRevokeReasons = ['account_deleted', 'fraud', 'manual', 'converted'] as const;
/** What /app/indicar shows: rejected looks like signed_up, expired is hidden (D-385). */
export const friendStatuses = ['invited', 'signed_up', 'qualified'] as const;
export const referralSides = ['referrer', 'referee'] as const;
/** `/app/indicar?de=` (FR-1); missing or unknown = 'direct'. */
export const referralEntryPoints = ['navbar', 'home', 'plans', 'plan_panel', 'account', 'direct'] as const;
export const referralShareChannels = ['whatsapp', 'telegram', 'email', 'more'] as const;

export type ReferralStatus = (typeof referralStatuses)[number];
export type FriendStatus = (typeof friendStatuses)[number];
export type ReferralRejectReason = (typeof referralRejectReasons)[number];

export const REFERRAL_LIMITS = {
  invitesPerRequest: 5,
  invitesPerDay: 20,
  /** FR-17 (Q-040, provisional): the referee's first board needs this many live cards. */
  qualifyMinCards: 3,
  /** Q-041 (provisional): above this many qualified in 30 days, new ones go to manual review. */
  qualifiedPer30Days: 10,
  inviteExpiryDays: 30,
  cookieDays: 30,
  /** Attribution only for accounts created this recently (FR-16 "conta nova"). */
  newAccountHours: 24,
  /** Referee deletes the account within this many days of the grant: their grant is revoked (regras de negócio). */
  revokeOnDeleteDays: 7,
  messageMaxChars: 400,
  /** Public GET /v1/public/referral/:code, per IP per minute. */
  publicLookupsPerMinute: 30,
} as const;

// --- code (FR-2) --------------------------------------------------------------
/** 31 symbols: 2–9 and A–Z without I, L, O (no 0/O, 1/I/L ambiguity). */
export const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const REFERRAL_CODE_LENGTH = 8;
const CODE_RE = /^[2-9A-HJKMNP-Z]{8}$/;

/** Case-insensitive; ignores spaces and hyphens ("4k2f-9qxm" → "4K2F9QXM"). null when it can't be a code. */
export const normalizeReferralCode = (raw: string): string | null => {
  const c = raw.replace(/[\s-]/g, '').toUpperCase();
  return CODE_RE.test(c) ? c : null;
};
/** "4K2F9QXM" → "4K2F-9QXM". */
export const formatReferralCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
/** Uniform over the alphabet (rejection sampling); collisions are retried by the caller (unique index). */
export const generateReferralCode = (rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string => {
  const max = 256 - (256 % REFERRAL_CODE_ALPHABET.length); // 248
  let out = '';
  while (out.length < REFERRAL_CODE_LENGTH) {
    for (const b of rand(16)) if (b < max && out.length < REFERRAL_CODE_LENGTH) out += REFERRAL_CODE_ALPHABET[b % REFERRAL_CODE_ALPHABET.length];
  }
  return out;
};
/** Wire schema: accepts any casing / hyphenation, yields the canonical 8-char code. */
export const referralCodeSchema = z.string().max(20).transform((s, ctx) => {
  const c = normalizeReferralCode(s);
  if (!c) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_code' });
  return c ?? z.NEVER;
});
/** `/i/{code}` link (FR-2). `origin` = public web origin, no trailing slash. */
export const referralLink = (origin: string, code: string) => `${origin}/i/${code}`;

// --- summary (GET /v1/referral/summary) ---------------------------------------
const cents = z.number().int().nonnegative();
export const friendStatusSchema = z.enum(friendStatuses);

/** One person in "Suas indicações" (FR-10/FR-11). Never e-mail or full name. */
export const referralFriendSchema = z.object({
  /** referrals.id */
  id: idSchema,
  /** "Daniel S." after sign-up; masked e-mail ("d***@gmail.com") while invited; null = no name on the profile (UI fallback). */
  displayName: z.string().max(80).nullable(),
  /** Account deleted: UI shows "Conta removida" (FR-15). */
  removed: z.boolean(),
  status: friendStatusSchema,
  /** Instant of the current status (sort key, "há 2 dias"). */
  when: timestampSchema,
  /** FR-11 timeline; a link sign-up has invitedAt null. */
  steps: z.object({ invitedAt: timestampSchema.nullable(), signedUpAt: timestampSchema.nullable(), qualifiedAt: timestampSchema.nullable() }),
});
export type ReferralFriend = z.infer<typeof referralFriendSchema>;

/** One reward the user received (FR-8 "últimas recompensas"). `month` = entitlement grant; `credit` = Stripe balance (Pro subscriber, D-384). */
export const rewardGrantSchema = z.object({
  id: idSchema,
  kind: z.enum(['month', 'credit']),
  side: z.enum(referralSides),
  /** The other person's display name (same masking as ReferralFriend); null when unknown or removed. */
  friendName: z.string().max(80).nullable(),
  grantedAt: timestampSchema,
  /** month only */
  endsAt: timestampSchema.nullable(),
  /** credit only, centavos */
  amount: cents.nullable(),
});
export type RewardGrant = z.infer<typeof rewardGrantSchema>;

export const referralSummarySchema = z.object({
  code: z.string().regex(CODE_RE),
  link: z.string().url(),
  /** Every reward ever received (months and credits, either side). */
  monthsEarned: z.number().int().nonnegative(),
  /** End of the active grant chain (Free with free months); null otherwise. */
  proUntil: timestampSchema.nullable(),
  /** Days in the active chain, for the FR-8 progress bar (proUntil − start of the current grant). */
  proDaysTotal: z.number().int().nonnegative(),
  /** Total credited to the Stripe balance, centavos (Pro). */
  credit: cents,
  /** Newest first, at most 3. */
  recentRewards: z.array(rewardGrantSchema).max(3),
  /** Newest first; all of them (the map shows 8, the list shows all). */
  friends: z.array(referralFriendSchema),
  invitesLeftToday: z.number().int().min(0).max(REFERRAL_LIMITS.invitesPerDay),
});
export type ReferralSummary = z.infer<typeof referralSummarySchema>;

// --- invites (POST /v1/referral/invites) ----------------------------------------
const emailSchema = z.string().trim().toLowerCase().email().max(254);
/** FR-7. No free-text message: the e-mail is Remoa's copy with the inviter's first name (D-386). */
export const inviteInputSchema = z.object({
  emails: z
    .array(emailSchema)
    .min(1)
    .max(REFERRAL_LIMITS.invitesPerRequest)
    .refine((a) => new Set(a).size === a.length, 'duplicate_email'),
});
export type InviteInput = z.input<typeof inviteInputSchema>;
/** Same shape whether or not an address already has an account (FR-7: never reveal it). */
export const inviteResultSchema = z.object({ sent: z.number().int().min(0).max(REFERRAL_LIMITS.invitesPerRequest), invitesLeftToday: z.number().int().nonnegative() });
export type InviteResult = z.infer<typeof inviteResultSchema>;

// --- public invite page (GET /v1/public/referral/:code) ------------------------------
/** What `/i/[code]` may show. Invalid and unknown look the same (no enumeration). */
export const referralInvitePublicSchema = z.discriminatedUnion('valid', [
  z.object({ valid: z.literal(true), code: z.string().regex(CODE_RE), inviterFirstName: z.string().max(40).nullable() }).strict(),
  z.object({ valid: z.literal(false) }).strict(),
]);
export type ReferralInvitePublic = z.infer<typeof referralInvitePublicSchema>;

// --- attribution (POST /v1/referral/attribution) -------------------------------------
/** Called once by the web right after the first session exists (D-383). */
export const attributionInputSchema = z.object({ code: referralCodeSchema });
export type AttributionInput = z.input<typeof attributionInputSchema>;
/** Always 200 for a well-formed code: the sign-up must never fail because of attribution. */
export const attributionResultSchema = z.object({ attributed: z.boolean() });
export type AttributionResult = z.infer<typeof attributionResultSchema>;

/** `AppError.message` values for this lane (the `code` is the generic ErrorCode in parentheses). */
export const referralErrors = {
  /** rate_limited — 20 invites per local day */
  dailyLimit: 'invite_daily_limit',
  /** validation — malformed code (well-formed but unknown is `{ valid: false }`, not an error) */
  invalidCode: 'invalid_code',
  /** rate_limited — public lookup per IP */
  lookupLimit: 'lookup_rate_limited',
} as const;
/** Attribution refusals; logged and sent as `referral_rejected.reason` where applicable, never returned to the client (D-383). */
export const attributionSkips = ['self_referral', 'already_attributed', 'not_new_account', 'unknown_code'] as const;

/** Cookie set by `/i/[code]` (FR-14). */
export const REFERRAL_COOKIE = 'rf';
