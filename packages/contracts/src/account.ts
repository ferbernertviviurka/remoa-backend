// F13 Minha conta: profile, security, preferences, account snapshot. Pure helpers live here so UI and server agree.
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { entitlementsSchema, planDefinition, planFeatureKeys, quotaKeySchema, type Entitlements, type PlanFeatureKey } from './billing';
import { goalSchema, goalsSchema, segmentSchema, type Goal } from './onboarding';
import { institutionInputSchema } from './institutions';

/** FR-1: /conta/[secao]. */
export const accountSections = ['perfil', 'seguranca', 'plano', 'preferencias', 'dados'] as const;
export type AccountSection = (typeof accountSections)[number];

// --- constants ---------------------------------------------------------------
/** FR-17: retention shown on /conta/dados and used by the maintenance jobs (F08 `expireAnswerTexts`, `purgeDeletedAccounts`). */
export const RETENTION = {
  answerTextDays: 180,
  deletionGraceDays: 7,
  /** Voice answers are transcribed and discarded (CLAUDE.md rule 7). */
  audioDays: 0,
} as const;

/** Server-enforced account limits (counted in `account_events`). */
export const ACCOUNT_LIMITS = {
  exportsPerHour: 1,
  passwordAttemptsPerHour: 5,
  emailResendSeconds: 60,
  emailLinkHours: 24,
  reauthMinutes: 10,
  avatarUrlSeconds: 3600,
} as const;

// --- profile -----------------------------------------------------------------
export const stageSchema = segmentSchema; // same values as onboarding: see `segments`
export type Stage = z.infer<typeof stageSchema>;
export const AVATAR_COLOR_COUNT = 5;
export const avatarColorSchema = z.number().int().min(0).max(AVATAR_COLOR_COUNT - 1);

/** Trim and collapse repeated whitespace. */
export const normalizeName = (s: string) => s.trim().replace(/\s+/g, ' ');
const NAME_CHARS = /^[\p{L}\p{M} '’-]+$/u;
/** FR-6: 2–60 chars after normalizing; Unicode letters, space, hyphen, apostrophe; at least one letter. */
export const nameSchema = z
  .string()
  .transform(normalizeName)
  .pipe(z.string().min(2).max(60).regex(NAME_CHARS).regex(/\p{L}/u));
export const isValidName = (s: string) => nameSchema.safeParse(s).success;

// --- personal data (CCR-017, D-570/D-571) -------------------------------------
// PII: owner-only (profiles RLS select = own row; written only by the API). Never in logs, Mixpanel/telemetry, admin views,
// or the referral/share surfaces. Included in the LGPD export (whole profiles row) and gone with the account (cascade).
export const userTypes = ['aluno', 'professor', 'medico_formado'] as const;
export const userTypeSchema = z.enum(userTypes);
export type UserType = z.infer<typeof userTypeSchema>;
/** "Sexo" in the form; inclusive options + "Prefiro não dizer". Labels in @remoa/strings. */
export const sexes = ['feminino', 'masculino', 'nao_binario', 'outro', 'prefiro_nao_dizer'] as const;
export const sexSchema = z.enum(sexes);
export type Sex = z.infer<typeof sexSchema>;
export const brUfs = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;
export const brUfSchema = z.enum(brUfs);
export type BrUf = z.infer<typeof brUfSchema>;

const digits = (s: string) => s.replace(/\D/g, '');
/**
 * BR phone → E.164 (`+55` + DDD + number), or null if invalid. Accepts any mask ("(11) 91234-5678", "+55 11 ...").
 * DDD 11–99 without a 0; 11-digit numbers are mobiles (start with 9); 10-digit landlines start with 2–5.
 */
export function normalizeBrPhone(input: string): string | null {
  let d = digits(input);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (!/^[1-9][1-9]/.test(d)) return null;
  const n = d.slice(2);
  if (n.length === 9 ? n[0] !== '9' : n.length !== 8 || !/^[2-5]/.test(n)) return null;
  return `+55${d}`;
}
export const BR_PHONE_E164 = /^\+55[1-9]{2}(9\d{8}|[2-5]\d{7})$/;
export const brPhoneSchema = z.string().max(30).transform((v, ctx) => normalizeBrPhone(v) ?? (ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid phone' }), z.NEVER));
/** CEP → 8 digits ("01310-100" → "01310100"). The web fills the rest from ViaCEP; the server never calls it. */
export const cepSchema = z.string().max(9).transform(digits).pipe(z.string().regex(/^\d{8}$/));
const line = (max: number) => z.string().trim().min(1).max(max);
export const addressSchema = z
  .object({
    cep: cepSchema,
    street: line(120),
    /** "S/N" allowed. */
    number: line(10),
    complement: z.string().trim().max(60).transform((v) => v || null).nullable().default(null),
    district: line(80),
    city: line(80),
    uf: brUfSchema,
  })
  .strict();
export type Address = z.infer<typeof addressSchema>;
export type AddressInput = z.input<typeof addressSchema>;

export const profileSchema = z.object({
  userId: idSchema,
  name: z.string().nullable(),
  /** Storage key of the processed 512 px avatar; server-owned (no column GRANT). */
  avatarKey: z.string().nullable(),
  avatarColor: avatarColorSchema,
  /** Primary goal = `goals[0]` (kept for completeness and older readers; the server keeps both in sync). */
  goal: goalSchema.nullable(),
  /** CCR-017: every selected objective, in the order picked. */
  goals: z.array(goalSchema),
  stage: stageSchema.nullable(),
  timezone: z.string().min(1),
  /** CCR-017 personal data (PII, owner-only). null = not given; users from before G14 have userType null (D-571). */
  userType: userTypeSchema.nullable(),
  sex: sexSchema.nullable(),
  /** E.164 (+55…). null only on accounts that have not finished "Conte quem você é" yet (missingRequiredProfile). */
  phone: z.string().regex(BR_PHONE_E164).nullable(),
  address: addressSchema.nullable(),
  /** G20 (D-843): institution name as shown (list name or free text); null = not given. */
  school: z.string().nullable(),
  /** G20: MEDICAL_SCHOOLS id; null for free text ("Outra instituição") or not given. */
  schoolId: z.string().nullable(),
});
export type Profile = z.infer<typeof profileSchema>;

/** G20 (D-844): fields every account must have before using /app. Used by the web guard and the API. */
export type RequiredProfileField = 'name' | 'phone' | 'userType';
export const missingRequiredProfile = (p: Pick<Profile, 'name' | 'phone' | 'userType'>): RequiredProfileField[] => [
  ...(p.name !== null && isValidName(p.name) ? [] : (['name'] as const)),
  ...(p.phone !== null && BR_PHONE_E164.test(p.phone) ? [] : (['phone'] as const)),
  ...(p.userType !== null ? [] : (['userType'] as const)),
];

/** Signed URLs (ACCOUNT_LIMITS.avatarUrlSeconds) of the 512 and 96 px WebP variants. */
export const avatarVariantsSchema = z.object({ large: z.string().url(), small: z.string().url() });
export type AvatarVariants = z.infer<typeof avatarVariantsSchema>;

const nonEmpty = (v: object) => Object.keys(v).length > 0;
/** CCR-037 (P-323): an IANA zone the runtime knows ("America/Sao_Paulo"); aliases like "UTC" pass, offsets ("-03:00") do not. */
export const ianaTimezoneSchema = z.string().min(1).max(64).regex(/^[A-Za-z][\w+-]*(\/[\w+-]+)*$/).refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'unknown timezone');
export const updateProfileInputSchema = z
  .object({
    name: nameSchema,
    /** Legacy single goal: the server stores it as `goals = [goal]`. Send `goals` instead. */
    goal: goalSchema,
    goals: goalsSchema,
    stage: stageSchema,
    avatarColor: avatarColorSchema,
    // CCR-017 (D-571): userType can be changed, not cleared; null clears sex or address.
    userType: userTypeSchema,
    sex: sexSchema.nullable(),
    /** G20 (D-842): required; can be replaced, never cleared. */
    phone: brPhoneSchema,
    address: addressSchema.nullable(),
    /** G20 (D-843): the only writer of profiles.school/school_id (onboarding step and Minha conta); null clears both. */
    institution: institutionInputSchema.nullable(),
    /** CCR-037 (P-323): editable profile timezone; the server replans pending calendar reminders in the same transaction. */
    timezone: ianaTimezoneSchema,
  })
  .partial()
  .strict()
  .refine(nonEmpty, 'nothing to update')
  .refine((v) => v.goal === undefined || v.goals === undefined, 'send goal or goals, not both');
export type UpdateProfileInput = z.input<typeof updateProfileInputSchema>;
/** D-570: `goal`/`goals` in an update → both columns, kept in sync (goal = goals[0]). Used by the API and the mock. */
export const syncGoals = (i: { goal?: Goal; goals?: Goal[] }): { goal?: Goal | null; goals?: Goal[] } =>
  i.goals !== undefined ? { goals: i.goals, goal: i.goals[0] ?? null } : i.goal !== undefined ? { goals: [i.goal], goal: i.goal } : {};

/**
 * CCR-017 (D-570/D-571): the sign-up's "Sobre você" step. `userType` and (G20, D-842) `phone` are required; sex and address optional.
 * The web validates the form with this and sends it (without nulls) to PATCH /v1/account/profile right after sign-up.
 * Goals, stage and area are no longer asked here: the onboarding (F12) asks them.
 */
export const signUpProfileInputSchema = z
  .object({ userType: userTypeSchema, sex: sexSchema.optional(), phone: brPhoneSchema, address: addressSchema.optional() })
  .strict();
export type SignUpProfileInput = z.input<typeof signUpProfileInputSchema>;

/** POST /v1/account/avatar: `key` returned by POST /v1/uploads/sign with kind 'avatar'. */
export const confirmAvatarInputSchema = z.object({ key: z.string().min(1).max(300) });
export type ConfirmAvatarInput = z.infer<typeof confirmAvatarInputSchema>;

// --- password ----------------------------------------------------------------
const PASSWORD_MAX = 72; // GoTrue/bcrypt limit
/** FR-9 minimum policy: 8+ chars with a letter and a digit. */
export const isValidPassword = (pw: string) =>
  pw.length >= 8 && pw.length <= PASSWORD_MAX && /\p{L}/u.test(pw) && /\d/.test(pw);
export const passwordSchema = z.string().refine(isValidPassword, 'weak password');

export const passwordLabels = ['weak', 'fair', 'good', 'strong'] as const;
export type PasswordLabel = (typeof passwordLabels)[number];
export type PasswordStrength = {
  /** 0 = empty; 1 = below policy; 2–4 = valid. Meter segments filled = score. */
  score: 0 | 1 | 2 | 3 | 4;
  label: PasswordLabel;
  checks: { minLength: boolean; lettersAndNumbers: boolean; long: boolean };
};
export function passwordStrength(pw: string): PasswordStrength {
  const checks = { minLength: pw.length >= 8, lettersAndNumbers: /\p{L}/u.test(pw) && /\d/.test(pw), long: pw.length >= 12 };
  const varied = /[^\p{L}\d]/u.test(pw) || (/\p{Lu}/u.test(pw) && /\p{Ll}/u.test(pw));
  const score = !pw ? 0 : !isValidPassword(pw) ? 1 : ((2 + Number(checks.long) + Number(varied)) as 2 | 3 | 4);
  return { score, label: passwordLabels[Math.max(score, 1) - 1]!, checks };
}

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

// --- email -------------------------------------------------------------------
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
/** `currentPassword` absent = Google-only user, who reauthenticates via OAuth (≤ reauthMinutes). */
export const requestEmailChangeInputSchema = z.object({
  newEmail: emailSchema,
  currentPassword: z.string().min(1).max(PASSWORD_MAX).optional(),
});
export type RequestEmailChangeInput = z.input<typeof requestEmailChangeInputSchema>;

// --- preferences -------------------------------------------------------------
export const themes = ['light', 'dark', 'system'] as const;
/** G18 (D-744): 07:00 · 08:00 · 12:00 · 20:00 (F26 FR-6); 19 and 21 were migrated to 20. Same column as NotificationPrefs.reviewReminderTime. */
export const REMINDER_HOURS = [7, 8, 12, 20] as const;
export const reminderHourSchema = z.union([z.literal(7), z.literal(8), z.literal(12), z.literal(20)]);
/** FR-13: 5–20 step 5. Free is capped at PLAN_LIMITS.free.newCardsPerDay by the server (D-122). */
export const newCardsPerDaySchema = z.number().int().min(5).max(20).multipleOf(5);

export const preferencesSchema = z.object({
  theme: z.enum(themes),
  /** null = follow the system's prefers-reduced-motion. */
  reduceMotion: z.boolean().nullable(),
  /** @deprecated G18 (D-743, P-301): the review reminder e-mail is now notification_preferences 'review_reminder'.email; kept until F13 code moves. */
  reminderEnabled: z.boolean(),
  reminderHour: reminderHourSchema,
  /** Effective value (already min'ed with the plan cap); null = unlimited (D-647). */
  newCardsPerDay: z.number().int().positive().nullable(),
  /** @deprecated G18 (D-743, P-301): see reminderEnabled. */
  emailReviewReminders: z.boolean(),
  emailProductNews: z.boolean(),
});
export type Preferences = z.infer<typeof preferencesSchema>;

/** Values when the user has no `user_preferences` row (newCardsPerDay then = plan cap). */
export const DEFAULT_PREFERENCES: Omit<Preferences, 'newCardsPerDay'> = {
  theme: 'light',
  reduceMotion: null,
  reminderEnabled: false,
  reminderHour: 20,
  emailReviewReminders: true,
  emailProductNews: false,
};

/** Stored choice (null = never chosen / no personal cap) capped by the plan (null = unlimited); used by GET /me and the review queue. */
export const effectiveNewCardsPerDay = (stored: number | null, planCap: number | null) => (planCap === null ? stored : Math.min(stored ?? planCap, planCap));

export const updatePreferencesInputSchema = preferencesSchema
  /** null = drop the personal cap and follow the plan (unlimited on Pro/Founder). */
  .extend({ newCardsPerDay: newCardsPerDaySchema.nullable() })
  .partial()
  .strict()
  .refine(nonEmpty, 'nothing to update');
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesInputSchema>;

// --- completeness ------------------------------------------------------------
export const completenessItems = ['photo', 'name', 'email', 'goal', 'reminder'] as const;
export type CompletenessItem = (typeof completenessItems)[number];
export const completenessSchema = z.object({
  percent: z.number().int().min(0).max(100),
  missing: z.array(z.enum(completenessItems)),
});
export type Completeness = z.infer<typeof completenessSchema>;

/** FR-3: mean of 5 items; `missing` keeps completenessItems order. */
export function computeCompleteness(
  profile: Pick<Profile, 'avatarKey' | 'name' | 'goal'>,
  prefs: Pick<Preferences, 'reminderEnabled'>,
  { emailConfirmed, emailPending }: { emailConfirmed: boolean; emailPending: boolean },
): Completeness {
  const done: Record<CompletenessItem, boolean> = {
    photo: !!profile.avatarKey,
    name: normalizeName(profile.name ?? '').length >= 2,
    email: emailConfirmed && !emailPending,
    goal: !!profile.goal,
    reminder: prefs.reminderEnabled,
  };
  const missing = completenessItems.filter((i) => !done[i]);
  return { percent: Math.round(((completenessItems.length - missing.length) / completenessItems.length) * 100), missing };
}

// --- usage -------------------------------------------------------------------
export const usageTones = ['normal', 'warn', 'full'] as const;
export type UsageTone = (typeof usageTones)[number];
/** FR-12: warn from 80%, full at 100%; null limit = unlimited (always normal). */
export const usageTone = (used: number, limit: number | null): UsageTone =>
  limit === null ? 'normal' : used >= limit ? 'full' : used >= limit * 0.8 ? 'warn' : 'normal';

export const usageRowSchema = z.object({
  key: quotaKeySchema,
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  tone: z.enum(usageTones),
});
export type UsageRow = z.infer<typeof usageRowSchema>;
export const usageRows = (e: Pick<Entitlements, 'usage' | 'limits'>): UsageRow[] =>
  quotaKeySchema.options.map((key) => ({ key, used: e.usage[key], limit: e.limits[key], tone: usageTone(e.usage[key], e.limits[key]) }));

// --- sessions and identities -------------------------------------------------
export const sessionInfoSchema = z.object({
  id: idSchema, // auth.sessions.id (= JWT session_id)
  browser: z.string().nullable(), // parsed from user_agent by the server
  os: z.string().nullable(),
  createdAt: timestampSchema,
  lastActiveAt: timestampSchema,
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const identityProviders = ['email', 'google'] as const;
export const identityProviderSchema = z.enum(identityProviders);
export const linkedIdentitySchema = z.object({
  provider: identityProviderSchema,
  email: z.string().nullable(),
  createdAt: timestampSchema,
  lastSignInAt: timestampSchema.nullable(),
});
export type LinkedIdentity = z.infer<typeof linkedIdentitySchema>;

// --- snapshot (GET /v1/account/me) -------------------------------------------
export const accountSnapshotSchema = z.object({
  profile: profileSchema,
  email: z.string(),
  pendingEmail: z.string().nullable(),
  emailConfirmed: z.boolean(),
  identities: z.array(linkedIdentitySchema),
  preferences: preferencesSchema,
  entitlements: entitlementsSchema,
  completeness: completenessSchema,
  /** null = no attempts yet (chip hidden). */
  streakDays: z.number().int().nonnegative().nullable(),
  joinedAt: timestampSchema,
  /** Hard-delete instant (deleted_at + RETENTION.deletionGraceDays); null = not scheduled. */
  deletionScheduledFor: timestampSchema.nullable(),
  /** Last `password_changed` in account_events; null = never changed in Remoa (line hidden). */
  passwordChangedAt: timestampSchema.nullable(),
  avatarUrls: avatarVariantsSchema.nullable(),
  /** F19 FR-11 (D-471): shows the rail "Admin" item only; cosmetic, `/v1/admin/*` re-checks on every request. Same test as requireAdmin. */
  isAdmin: z.boolean(),
});
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

/**
 * GET|POST /v1/public/unsubscribe?token= — opaque signed token `<subject>.<hmac>` (UNSUBSCRIBE_SECRET).
 * Subject = user id (uuid): turns the review reminder off (F13). Subject = 64-hex D-386 e-mail hash (P-192, D-494): an invitee
 * without an account; inserts into `email_suppressions`, and invites to that hash are no longer sent. Same page, same answer.
 */
export const unsubscribeQuerySchema = z.object({ token: z.string().min(16).max(512) });

// --- audit log (account_events.type) -----------------------------------------
export const accountEventTypes = [
  'email_change_requested',
  'email_change_resent',
  'email_change_canceled',
  'password_changed',
  'password_change_failed',
  'session_revoked',
  'identity_unlinked',
  'avatar_changed',
  'export_requested',
  'deletion_requested',
  'deletion_canceled',
  'reminder_unsubscribed',
] as const;
export type AccountEventType = (typeof accountEventTypes)[number];

// --- F15 matrix (lives here, not in billing.ts: billing → account would be an import cycle; D-183) ---
export type ComparisonRow = {
  key: PlanFeatureKey;
  free: number | null;
  pro: number | null;
  /** Student usage in the current plan's column; null = not metered (Anki, new cards/day) or entitlements failed to load (FR-12). */
  usage: { used: number; limit: number | null; tone: UsageTone } | null;
};
const meteredKeys: readonly string[] = quotaKeySchema.options;
/** FR-4: matrix rows with the student's usage in the current plan column. */
export const comparisonRows = (e: Pick<Entitlements, 'usage' | 'limits'> | null): ComparisonRow[] => {
  const free = planDefinition('free');
  const pro = planDefinition('pro');
  return planFeatureKeys.map((key) => {
    if (!e || !meteredKeys.includes(key)) return { key, free: free[key], pro: pro[key], usage: null };
    const q = key as keyof Entitlements['usage'];
    return { key, free: free[key], pro: pro[key], usage: { used: e.usage[q], limit: e.limits[q], tone: usageTone(e.usage[q], e.limits[q]) } };
  });
};
