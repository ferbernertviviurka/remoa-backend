// CCR-058 (P-513, D-1077): constants (and pure helpers over them: guards, billing math, the plan matrix) without zod, so the web can import them as
// `@remoa/contracts/constants` without zod (~13 KB gzip) in every page's initial JS. This module must never import zod (constants.test.ts).
// The modules that build schemas from them (errors, billing, account, events, calendar, notifications, challenge) re-export them: `@remoa/contracts` keeps
// the same names and values.
import type { Entitlements } from './billing';
import type { Plan } from './enums';

/** D-1213: free Pro days every account gets once (per normalized e-mail), from sign-up. The SQL trigger repeats the number (0039). */
export const TRIAL_DAYS = 15;
/** D-1213: days before the trial ends when the "teste acabando" notice goes out (and again on the last day). */
export const TRIAL_NOTICE_DAYS = 3;

export const errorCodes = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation',
  'quota_exceeded',
  'rate_limited',
  'conflict',
  'ai_unavailable',
  'internal',
] as const;

/**
 * D-647 plan table, shared by server (enforcement) and pricing page (display). null = unlimited.
 * Windows: ai_grades per local study day; ai_generations per calendar month; boards/cards = live totals;
 * newCardsPerDay per study day; ankiImportMaxCards per file; ankiImports per account (lifetime, completed imports).
 */
export const PLAN_LIMITS = {
  free: { limits: { ai_grades: 20, ai_generations: 0, boards: 2, cards: 50 }, newCardsPerDay: 10, ankiImportMaxCards: 200, ankiImports: 1 },
  pro: { limits: { ai_grades: 50, ai_generations: 5, boards: null, cards: null }, newCardsPerDay: null, ankiImportMaxCards: null, ankiImports: null },
  /** D-375/D-647: lifetime one-time purchase = Pro + unlimited AI grades and PDF maps. Never renews, never lapses. */
  founder: { limits: { ai_grades: null, ai_generations: null, boards: null, cards: null }, newCardsPerDay: null, ankiImportMaxCards: null, ankiImports: null },
} as const satisfies Record<Plan, Pick<Entitlements, 'limits' | 'newCardsPerDay' | 'ankiImportMaxCards' | 'ankiImports'>>;

/**
 * F30 (D-1601, D-1607): "Desafio com IA" and "Resumo com IA" quotas. null = unlimited. ai_question_batches per local day (profile
 * timezone, midnight); ai_summaries per calendar month. Beside PLAN_LIMITS, not inside it: PLAN_LIMITS[plan] is spread into
 * Entitlements objects, which these keys are not part of. Read through planDefinition.
 */
export const PLAN_CHALLENGE_AI_LIMITS = {
  free: { ai_question_batches: 2, ai_summaries: 1 },
  pro: { ai_question_batches: 10, ai_summaries: 20 },
  founder: { ai_question_batches: null, ai_summaries: null },
} as const satisfies Record<Plan, Record<(typeof CHALLENGE_AI_QUOTA_KEYS)[number], number | null>>;

/** Upper bound of `limit` (default stays SESSION_SIZE): the Revisar hub starts the whole filtered selection. */
export const REVIEW_SESSION_MAX = 100;

export const notificationTypes = [
  'calendar_d1',
  'calendar_d0',
  'calendar_digest',
  'review_reminder',
  'map_ready',
  'referral_reward',
  'support_reply',
  'purchase',
  'waitlist_joined',
  'inactivity',
  'account',
  'password_reset',
  // CCR-035 (D-760): e-mail-only notices that used to be plain text outside notify().
  'support_received',
  'password_changed',
  'welcome',
  'onboarding_nudge',
  'payment_receipt',
  'admin_alert',
  'dispute_resolved',
  // D-1213: the free Pro trial ends in TRIAL_NOTICE_DAYS days / today.
  'trial_ending',
] as const;

/** Chips on /notificacoes, in this order (Todas is "no category"). */
export const notificationCategories = ['calendar', 'review', 'maps', 'referrals', 'support', 'account_billing', 'store'] as const;

export const CALENDAR_LIMITS = {
  titleMin: 2,
  titleMax: 120,
  locationMax: 160,
  descriptionMax: 2000,
  labelNameMin: 2,
  labelNameMax: 40,
  /** Labels per user, defaults included. */
  labels: 20,
  coverMaxBytes: 5 * 1024 * 1024,
  /** GET /events?from&to: inclusive span. Visible range ± 1 month fits (FR-22). */
  rangeMaxDays: 100,
  upcomingDefault: 4,
  upcomingMax: 10,
  /** Duplicar = +7 days (FR-12). */
  duplicateDays: 7,
  /** Soft-deleted events (and their cover) are purged after this (calendar.cleanup). */
  deletedRetentionDays: 30,
  /** "Sem fim" lasts this long on the week grid. */
  defaultDurationMinutes: 60,
} as const;

/**
 * FR-13 / Q-051, profile timezone: d1 at 18:00 the day before; d0 at 07:00, or 1 h before the start when it starts before 08:00,
 * never before 05:00. All-day events use the same hours. A send time already past when (re)planned = `skipped`.
 */
export const CALENDAR_REMINDER_RULES = { d1Hour: 18, d0Hour: 7, earlyStartBeforeHour: 8, earlyLeadMinutes: 60, notBeforeHour: 5 } as const;

/** 8-colour label palette (FR-9). Keys are stored; hex lives here and in docs/DESIGN.md "Paleta de etiquetas" (D-741). */
export const calendarColors = ['orange', 'amber', 'purple', 'teal', 'gray', 'blue', 'pink', 'green'] as const;
/** `text` on `bg` and on white is >= 4.5:1; `dot` is the bar/dot/cover colour and never carries meaning alone (the name is always shown). */
export const CALENDAR_PALETTE: Record<(typeof calendarColors)[number], { dot: string; text: string; bg: string }> = {
  orange: { dot: '#C2410C', text: '#9A3412', bg: '#FFEDD5' },
  amber: { dot: '#CA8A04', text: '#854D0E', bg: '#FEF3C7' },
  purple: { dot: '#6D5BD0', text: '#3F3579', bg: '#F3F2FB' },
  teal: { dot: '#0F766E', text: '#0F766E', bg: '#CCFBF1' },
  gray: { dot: '#8F8AAE', text: '#5F5B7A', bg: '#EEEDF6' },
  blue: { dot: '#2563EB', text: '#1E40AF', bg: '#DBEAFE' },
  pink: { dot: '#BE185D', text: '#9D174D', bg: '#FCE7F3' },
  green: { dot: '#15803D', text: '#166534', bg: '#DCFCE7' },
};

/** `notificationTypeSchema.safeParse(x).success`, without zod. */
export const isNotificationType = (x: unknown): x is (typeof notificationTypes)[number] => (notificationTypes as readonly unknown[]).includes(x);

/**
 * `httpErrorBodySchema.safeParse(body)` -> the AppError (extra fields dropped), or null when the body is not an API error; without zod.
 * The API is the one that validates; clients only read its error body.
 */
export function readErrorBody(body: unknown): { code: (typeof errorCodes)[number]; message: string } | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (!error || typeof error !== 'object') return null;
  const { code, message } = error as Record<string, unknown>;
  return (errorCodes as readonly unknown[]).includes(code) && typeof message === 'string' ? { code: code as (typeof errorCodes)[number], message } : null;
}

// --- billing (F15) ----------------------------------------------------------------------------------------------------
/** Metered quotas = columns of `usage_counters`. */
export const quotaKeys = ['ai_grades', 'ai_generations', 'boards', 'cards'] as const;
/** F30 (D-1601): AI quotas of "Desafio com IA" and "Resumo com IA", also `usage_counters` columns (like ai_rubrics, outside QuotaKey). */
export const CHALLENGE_AI_QUOTA_KEYS = ['ai_question_batches', 'ai_summaries'] as const;
/** `anki` = per-account Anki import cap (D-648); the server answers `quota_exceeded` 'anki'. */
export const paywallReasons = ['ai_quota', 'boards', 'cards', 'pdf', 'anki'] as const;
/** `upgrade_clicked` sources. */
export const upgradeSources = ['account_plan', 'usage_nudge', 'navbar_upgrade', 'plan_popover', 'map_slider_lock', 'library_lock', 'header_new_map_lock', 'referral'] as const;
/** F15 `/planos?de=`: an upgrade_clicked source, a paywall reason, or 'direct' (missing or unknown `de`). */
export const plansFromSources = [...upgradeSources, ...paywallReasons, 'direct'] as const;

type Amounts = { monthly: { amount: number }; annual: { amount: number } };
/** FR-2: round((1 − annual ÷ (monthly × 12)) × 100); 0 when there is nothing to compare. */
export const annualDiscountPercent = ({ monthly, annual }: Amounts) =>
  monthly.amount > 0 ? Math.max(0, Math.round((1 - annual.amount / (monthly.amount * 12)) * 100)) : 0;
/** FR-5 "Economize R$ X por ano", in centavos. */
export const annualSavings = ({ monthly, annual }: Amounts) => Math.max(0, monthly.amount * 12 - annual.amount);
/** FR-5 annual shown per month, in centavos (rounded). */
export const monthlyEquivalent = ({ annual }: Amounts) => Math.round(annual.amount / 12);

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Centavos → "R$ 39,00" (Intl uses a no-break space after R$). */
export const formatBRL = (amountCents: number) => brl.format(amountCents / 100);

/** F15 FR-4 matrix rows, in display order. Values derive from PLAN_LIMITS (still the single source). */
export const planFeatureKeys = ['boards', 'cards', 'ai_grades', 'ai_generations', 'anki_imports', 'anki_import_cards', 'new_cards_per_day'] as const;
export type PlanFeatureKey = (typeof planFeatureKeys)[number];
/**
 * null = unlimited. ai_grades = correções por IA/dia; ai_generations = mapas de PDF/mês (0 = não incluso); anki_imports = importações Anki na conta;
 * anki_import_cards = cards por arquivo (F06); ai_question_batches = lotes de perguntas geradas/dia; ai_summaries = resumos/mês (F30, D-1601).
 * The challenge AI keys are not matrix rows (planFeatureKeys).
 */
export type PlanDefinition = Record<PlanFeatureKey | (typeof CHALLENGE_AI_QUOTA_KEYS)[number], number | null>;
export const planDefinition = (plan: Plan): PlanDefinition => {
  const p = PLAN_LIMITS[plan];
  return { ...p.limits, ...PLAN_CHALLENGE_AI_LIMITS[plan], anki_imports: p.ankiImports, anki_import_cards: p.ankiImportMaxCards, new_cards_per_day: p.newCardsPerDay };
};

export const usageTones = ['normal', 'warn', 'full'] as const;
export type UsageTone = (typeof usageTones)[number];
/** FR-12: warn from 80%, full at 100%; null limit = unlimited (always normal). */
export const usageTone = (used: number, limit: number | null): UsageTone =>
  limit === null ? 'normal' : used >= limit ? 'full' : used >= limit * 0.8 ? 'warn' : 'normal';

export type ComparisonRow = {
  key: PlanFeatureKey;
  free: number | null;
  pro: number | null;
  /** Student usage in the current plan's column; null = not metered (Anki, new cards/day) or entitlements failed to load (FR-12). */
  usage: { used: number; limit: number | null; tone: UsageTone } | null;
};
const meteredKeys: readonly string[] = quotaKeys;
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

// --- profile and onboarding (F13, F14, CCR-017) ---------------------------------------------------------------------------
/** Trim and collapse repeated whitespace. */
export const normalizeName = (s: string) => s.trim().replace(/\s+/g, ' ');
/** Unicode letters, combining marks, space, apostrophes and hyphen (account.ts `nameSchema` uses the same). */
export const NAME_CHARS = /^[\p{L}\p{M} '’-]+$/u;
/** FR-6: 2–60 chars after normalizing; Unicode letters, space, hyphen, apostrophe; at least one letter. Same as `nameSchema.safeParse(s).success`. */
export const isValidName = (s: string) => {
  const n = normalizeName(s);
  return n.length >= 2 && n.length <= 60 && NAME_CHARS.test(n) && /\p{L}/u.test(n);
};
export const userTypes = ['aluno', 'professor', 'medico_formado'] as const;
/**
 * BR phone → E.164 (`+55` + DDD + number), or null if invalid. Accepts any mask ("(11) 91234-5678", "+55 11 ...").
 * DDD 11–99 without a 0; 11-digit numbers are mobiles (start with 9); 10-digit landlines start with 2–5.
 */
export function normalizeBrPhone(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (!/^[1-9][1-9]/.test(d)) return null;
  const n = d.slice(2);
  if (n.length === 9 ? n[0] !== '9' : n.length !== 8 || !/^[2-5]/.test(n)) return null;
  return `+55${d}`;
}
/** CCR-017 (D-570): objectives are multi-select, up to this many. */
export const MAX_GOALS = 5;

// --- auth and password (F13 FR-9, G20) -------------------------------------------------------------------------------
export const PASSWORD_MAX = 72; // GoTrue/bcrypt limit
/** FR-9 minimum policy: 8+ chars with a letter and a digit. */
export const isValidPassword = (pw: string) =>
  pw.length >= 8 && pw.length <= PASSWORD_MAX && /\p{L}/u.test(pw) && /\d/.test(pw);
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
/** zod 3's `z.string().email()` pattern, so the forms can check an address without zod (constants.test.ts compares them). */
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
/** Same as `signUpInputSchema.shape.email.safeParse(v).success` (trim, lower case, then the e-mail pattern). */
export const isValidEmail = (v: string) => EMAIL.test(v.trim().toLowerCase());

// --- referral (F18) --------------------------------------------------------------------------------------------------
/** `/app/indicar?de=` (FR-1); missing or unknown = 'direct'. */
export const referralEntryPoints = ['navbar', 'home', 'plans', 'plan_panel', 'account', 'direct'] as const;
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
/** `AppError.message` values for this lane (the `code` is the generic ErrorCode in parentheses). */
export const referralErrors = {
  /** rate_limited — 20 invites per local day */
  dailyLimit: 'invite_daily_limit',
  /** validation — malformed code (well-formed but unknown is `{ valid: false }`, not an error) */
  invalidCode: 'invalid_code',
  /** rate_limited — public lookup per IP */
  lookupLimit: 'lookup_rate_limited',
} as const;
/** Cookie set by `/i/[code]` (FR-14). */
export const REFERRAL_COOKIE = 'rf';

// --- board (F17) -------------------------------------------------------------------------------------------------------
/** F17 FR-5: at most 10 matrix items per board (leaf items of the board's area; the API answers 422 otherwise). */
export const MAX_MATRIX_ITEMS_PER_BOARD = 10;
/** Q-034: share password length, 6..64 characters. */
export const SHARE_PASSWORD_MIN = 6;
export const SHARE_PASSWORD_MAX = 64;
