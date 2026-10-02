// F13 account mocks: fixtures for the frontend (Free and Pro snapshots, sessions, identities) + in-memory handlers.
import { err, ok, parseWith } from '../errors';
import { PLAN_LIMITS, type Entitlements } from '../billing';
import {
  DEFAULT_PREFERENCES,
  computeCompleteness,
  updatePreferencesInputSchema,
  updateProfileInputSchema,
  type AccountSnapshot,
  type LinkedIdentity,
  type SessionInfo,
} from '../account';
import type * as Api from '../api';
import { FIXTURE_NOW, fixtureUserId } from './fixtures';

const DAY = 86_400_000;
const at = (days: number) => new Date(FIXTURE_NOW.getTime() + days * DAY);

export const sessionsFixture: SessionInfo[] = [
  { id: '00000000-0000-4000-8000-0000000000a1', browser: 'Chrome', os: 'macOS', createdAt: at(-20), lastActiveAt: FIXTURE_NOW, current: true },
  { id: '00000000-0000-4000-8000-0000000000a2', browser: 'Safari', os: 'iOS', createdAt: at(-9), lastActiveAt: at(-1), current: false },
  { id: '00000000-0000-4000-8000-0000000000a3', browser: 'Firefox', os: 'Windows', createdAt: at(-30), lastActiveAt: at(-6), current: false },
];

export const identitiesFixture: LinkedIdentity[] = [
  { provider: 'email', email: 'ana@remoa.test', createdAt: at(-40), lastSignInAt: FIXTURE_NOW },
  { provider: 'google', email: 'ana@gmail.test', createdAt: at(-12), lastSignInAt: at(-3) },
];

const freeEntitlements: Entitlements = {
  plan: 'free', status: null, ...PLAN_LIMITS.free, limits: PLAN_LIMITS.free.limits,
  usage: { ai_grades: 17, ai_generations: 1, boards: 2, cards: 120 },
  renewsAt: null, cancelAtPeriodEnd: false, graceUntil: null,
};
const proEntitlements: Entitlements = {
  plan: 'pro', status: 'active', ...PLAN_LIMITS.pro, limits: PLAN_LIMITS.pro.limits,
  usage: { ai_grades: 42, ai_generations: 3, boards: 7, cards: 830 },
  renewsAt: at(18), cancelAtPeriodEnd: false, graceUntil: null,
};

/** Free, 60% complete (no photo, reminder off). */
export const accountFreeFixture: AccountSnapshot = {
  profile: { userId: fixtureUserId, name: 'Ana Souza', avatarKey: null, avatarColor: 2, goal: 'enamed_2027_1', stage: 'y5_6', timezone: 'America/Sao_Paulo' },
  email: 'ana@remoa.test',
  pendingEmail: null,
  emailConfirmed: true,
  identities: identitiesFixture.slice(0, 1),
  preferences: { ...DEFAULT_PREFERENCES, newCardsPerDay: PLAN_LIMITS.free.newCardsPerDay },
  entitlements: freeEntitlements,
  completeness: { percent: 60, missing: ['photo', 'reminder'] },
  streakDays: 4,
  joinedAt: at(-40),
  deletionScheduledFor: null,
  passwordChangedAt: at(-90),
  avatarUrls: null,
};

/** Pro, 100% complete, Google linked. */
export const accountProFixture: AccountSnapshot = {
  ...accountFreeFixture,
  profile: { ...accountFreeFixture.profile, avatarKey: `avatars/${fixtureUserId}/1.webp` },
  identities: identitiesFixture,
  preferences: { ...DEFAULT_PREFERENCES, reminderEnabled: true, reminderHour: 21, newCardsPerDay: 20 },
  entitlements: proEntitlements,
  completeness: { percent: 100, missing: [] },
  avatarUrls: { large: 'https://storage.remoa.test/avatars/512.webp?sig=x', small: 'https://storage.remoa.test/avatars/96.webp?sig=x' },
};

/** Deletion scheduled: the frontend shows the banner and routes to /conta/dados. */
export const accountDeletionFixture: AccountSnapshot = { ...accountFreeFixture, deletionScheduledFor: at(7) };

// --- in-memory handlers (state shared, reset with resetAccountMocks) ---------
let account: AccountSnapshot = structuredClone(accountFreeFixture);
let sessions: SessionInfo[] = structuredClone(sessionsFixture);
export function resetAccountMocks(base: AccountSnapshot = accountFreeFixture) {
  account = structuredClone(base);
  sessions = structuredClone(sessionsFixture);
}
const recompute = () => {
  account.completeness = computeCompleteness(account.profile, account.preferences, { emailConfirmed: account.emailConfirmed, emailPending: !!account.pendingEmail });
};

export const getAccount: Api.GetAccount = async () => ok(structuredClone(account));
export const updateProfile: Api.UpdateProfile = async (_u, input) => {
  const p = parseWith(updateProfileInputSchema, input);
  if (!p.ok) return p;
  Object.assign(account.profile, p.data);
  recompute();
  return ok(structuredClone(account.profile));
};
export const confirmAvatar: Api.ConfirmAvatar = async (_u, { key }) => {
  account.profile.avatarKey = key;
  account.avatarUrls = accountProFixture.avatarUrls;
  recompute();
  return ok(account.avatarUrls!);
};
export const removeAvatar: Api.RemoveAvatar = async () => {
  account.profile.avatarKey = null;
  account.avatarUrls = null;
  recompute();
  return ok(null);
};
export const requestEmailChange: Api.RequestEmailChange = async (_u, { newEmail }) => {
  if (account.deletionScheduledFor) return err('forbidden', 'account_deleted');
  account.pendingEmail = newEmail.trim().toLowerCase();
  recompute();
  return ok({ pendingEmail: account.pendingEmail });
};
export const resendEmailChange: Api.ResendEmailChange = async () =>
  account.pendingEmail ? ok({ pendingEmail: account.pendingEmail }) : err('not_found', 'no pending email change');
export const cancelEmailChange: Api.CancelEmailChange = async () => {
  account.pendingEmail = null;
  recompute();
  return ok(null);
};
export const changePassword: Api.ChangePassword = async (_u, sessionId, { currentPassword }) => {
  if (currentPassword === 'wrong') return err('validation', 'currentPassword: invalid');
  const before = sessions.length;
  sessions = sessions.filter((s) => s.id === sessionId);
  return ok({ revokedSessions: before - sessions.length });
};
export const listSessions: Api.ListSessions = async (_u, sessionId) => ok(sessions.map((s) => ({ ...s, current: s.id === sessionId })));
export const revokeSession: Api.RevokeSession = async (_u, sessionId, targetId) => {
  if (targetId === sessionId) return err('validation', 'cannot revoke the current session');
  if (!sessions.some((s) => s.id === targetId)) return err('not_found', 'session not found');
  sessions = sessions.filter((s) => s.id !== targetId);
  return ok(null);
};
export const revokeOtherSessions: Api.RevokeOtherSessions = async (_u, sessionId) => {
  const count = sessions.filter((s) => s.id !== sessionId).length;
  sessions = sessions.filter((s) => s.id === sessionId);
  return ok({ count });
};
export const unlinkIdentity: Api.UnlinkIdentity = async (_u, provider) => {
  if (account.identities.length <= 1) return err('conflict', 'last sign-in method');
  account.identities = account.identities.filter((i) => i.provider !== provider);
  return ok(structuredClone(account.identities));
};
export const updatePreferences: Api.UpdatePreferences = async (_u, input) => {
  const p = parseWith(updatePreferencesInputSchema, input);
  if (!p.ok) return p;
  if ((p.data.newCardsPerDay ?? 0) > account.entitlements.newCardsPerDay) return err('forbidden', 'pro_required');
  Object.assign(account.preferences, p.data);
  recompute();
  return ok(structuredClone(account.preferences));
};
export const cancelDeletion: Api.CancelDeletion = async () => {
  account.deletionScheduledFor = null;
  return ok(null);
};
export const unsubscribeReminder: Api.UnsubscribeReminder = async () => {
  account.preferences.reminderEnabled = false;
  recompute();
  return ok(null);
};

export const accountMocks = {
  getAccount, updateProfile, confirmAvatar, removeAvatar, requestEmailChange, resendEmailChange, cancelEmailChange,
  changePassword, listSessions, revokeSession, revokeOtherSessions, unlinkIdentity, updatePreferences, cancelDeletion, unsubscribeReminder,
} satisfies {
  getAccount: Api.GetAccount; updateProfile: Api.UpdateProfile; confirmAvatar: Api.ConfirmAvatar; removeAvatar: Api.RemoveAvatar;
  requestEmailChange: Api.RequestEmailChange; resendEmailChange: Api.ResendEmailChange; cancelEmailChange: Api.CancelEmailChange;
  changePassword: Api.ChangePassword; listSessions: Api.ListSessions; revokeSession: Api.RevokeSession;
  revokeOtherSessions: Api.RevokeOtherSessions; unlinkIdentity: Api.UnlinkIdentity; updatePreferences: Api.UpdatePreferences;
  cancelDeletion: Api.CancelDeletion; unsubscribeReminder: Api.UnsubscribeReminder;
};
