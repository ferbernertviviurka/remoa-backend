// F18 mocks for the frontend (T5–T8) until T2/T3 land. Names are fictional; e-mails are masked like the server does.
import { err, ok, parseWith } from '../errors';
import {
  REFERRAL_LIMITS,
  attributionInputSchema,
  formatReferralCode,
  inviteInputSchema,
  normalizeReferralCode,
  referralLink,
  type ReferralFriend,
  type ReferralInvitePublic,
  type ReferralSummary,
  type RewardGrant,
} from '../referral';
import type * as Api from '../api';
import { FIXTURE_NOW, MOCK_APP_URL, fid } from './fixtures';

const DAY = 86_400_000;
const at = (days: number) => new Date(FIXTURE_NOW.getTime() + days * DAY);
export const referralCodeFixture = '4K2F9QXM';
/** A valid-looking code that the mock treats as unknown. */
export const referralUnknownCodeFixture = 'ZZZZ2222';

const friend = (n: number, displayName: string | null, status: ReferralFriend['status'], ago: number, extra: Partial<ReferralFriend> = {}): ReferralFriend => {
  const invitedAt = displayName?.includes('***') ? at(-ago - 2) : null;
  const signedUpAt = status === 'invited' ? null : at(-ago - 1);
  const qualifiedAt = status === 'qualified' ? at(-ago) : null;
  return { id: fid(5000 + n), displayName, removed: false, status, when: qualifiedAt ?? signedUpAt ?? invitedAt ?? at(-ago), steps: { invitedAt, signedUpAt, qualifiedAt }, ...extra };
};
const reward = (n: number, friendName: string | null, ago: number, kind: RewardGrant['kind'] = 'month', side: RewardGrant['side'] = 'referrer'): RewardGrant => ({
  id: fid(6000 + n), kind, side, friendName, grantedAt: at(-ago), endsAt: kind === 'month' ? at(30 - ago) : null, amount: kind === 'credit' ? 3900 : null,
});

const base = { code: referralCodeFixture, link: referralLink(MOCK_APP_URL, referralCodeFixture), invitesLeftToday: REFERRAL_LIMITS.invitesPerDay };
const inProgressFriends = [
  friend(1, 'Daniel S.', 'qualified', 3),
  friend(2, 'Marina C.', 'signed_up', 1),
  friend(3, 'r***@gmail.com', 'invited', 0),
  friend(4, null, 'signed_up', 5, { removed: true }),
];

export const referralSummaryFixtures = {
  /** indicar-vazio.png */
  empty: { ...base, monthsEarned: 0, proUntil: null, proDaysTotal: 0, credit: 0, recentRewards: [], friends: [] },
  /** indicar-andamento.png: Free with one month earned */
  inProgress: { ...base, monthsEarned: 1, proUntil: at(27), proDaysTotal: 30, credit: 0, recentRewards: [reward(1, 'Daniel S.', 3)], friends: inProgressFriends },
  /** indicar-muitos.png: more than 8 friends (map shows 8, list shows all) */
  many: {
    ...base, invitesLeftToday: 3, monthsEarned: 5, proUntil: at(140), proDaysTotal: 150, credit: 0,
    recentRewards: [reward(1, 'Daniel S.', 3), reward(2, 'Ana P.', 6), reward(3, 'Bruno L.', 9)],
    friends: [
      ...inProgressFriends,
      friend(5, 'Ana P.', 'qualified', 6), friend(6, 'Bruno L.', 'qualified', 9), friend(7, 'Carla M.', 'qualified', 12),
      friend(8, 'Felipe T.', 'qualified', 15), friend(9, 'j***@hotmail.com', 'invited', 1), friend(10, 'Lia R.', 'signed_up', 2),
    ],
  },
  /** indicar-pro.png: paying subscriber, months became Stripe credit */
  pro: { ...base, monthsEarned: 2, proUntil: null, proDaysTotal: 0, credit: 7800, recentRewards: [reward(1, 'Daniel S.', 3, 'credit'), reward(2, 'Ana P.', 6, 'credit')], friends: inProgressFriends },
  /** Daily invite limit reached (FR-24) */
  limitReached: { ...base, invitesLeftToday: 0, monthsEarned: 0, proUntil: null, proDaysTotal: 0, credit: 0, recentRewards: [], friends: [friend(3, 'r***@gmail.com', 'invited', 0)] },
} satisfies Record<string, ReferralSummary>;

export const referralInviteFixtures = {
  valid: { valid: true, code: referralCodeFixture, inviterFirstName: 'Fernanda' },
  validNoName: { valid: true, code: referralCodeFixture, inviterFirstName: null },
  invalid: { valid: false },
} satisfies Record<string, ReferralInvitePublic>;

let summary: ReferralSummary = structuredClone(referralSummaryFixtures.inProgress);
/** Pick the starting state (default `inProgress`). */
export function resetReferralMocks(start: ReferralSummary = referralSummaryFixtures.inProgress) {
  summary = structuredClone(start);
}

/** The rule the server uses for invited rows (D-386): first char + *** + domain. */
const mask = (email: string) => `${email[0]}***${email.slice(email.indexOf('@'))}`;

export const getReferralSummary: Api.GetReferralSummary = async () => ok(structuredClone(summary));
export const sendReferralInvites: Api.SendReferralInvites = async (_u, raw) => {
  const p = parseWith(inviteInputSchema, raw);
  if (!p.ok) return p;
  if (p.data.emails.length > summary.invitesLeftToday) return err('rate_limited', 'invite_daily_limit');
  for (const e of p.data.emails) summary.friends.unshift(friend(9000 + summary.friends.length, mask(e), 'invited', 0));
  summary.invitesLeftToday -= p.data.emails.length;
  return ok({ sent: p.data.emails.length, invitesLeftToday: summary.invitesLeftToday });
};
export const getReferralInvite: Api.GetReferralInvite = async (code) => {
  const c = normalizeReferralCode(code);
  return ok(c && c !== referralUnknownCodeFixture ? { ...referralInviteFixtures.valid, code: c } : referralInviteFixtures.invalid);
};
export const attributeReferral: Api.AttributeReferral = async (_u, raw) => {
  const p = parseWith(attributionInputSchema, raw);
  if (!p.ok) return p;
  return ok({ attributed: p.data.code !== referralCodeFixture && p.data.code !== referralUnknownCodeFixture }); // own code never attributes
};
/** For stories: "4K2F-9QXM". */
export const referralCodeDisplayFixture = formatReferralCode(referralCodeFixture);

export const referralMocks = { getReferralSummary, sendReferralInvites, getReferralInvite, attributeReferral, reset: resetReferralMocks };
