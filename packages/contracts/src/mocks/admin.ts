// F19 admin mocks for the frontend (T7–T10) until T3–T5 land. Names and values are fictional (as in the *.dc.html mocks).
import { err, ok, parseWith } from '../errors';
import {
  adminExportInputSchema,
  adminTicketReplyInputSchema,
  markPaidInputSchema,
  reasonInputSchema,
  revokeGrantInputSchema,
  type AdminAction,
  type AdminOverview,
  type AdminPaymentDetail,
  type AdminReferralDetail,
  type AdminTicketDetail,
  type AdminUserDetail,
  type AuditEntry,
  type AuditTargetType,
} from '../admin';
import type * as Api from '../api';
import { FIXTURE_NOW, fid, sepseBoard, sepseCards, sepseEdges } from './fixtures';
import { supportContextFixture } from './support';

const at = (hours: number) => new Date(FIXTURE_NOW.getTime() + hours * 3_600_000);
const page = <T>(items: T[], q: { page?: number | string; pageSize?: number | string }) => {
  const p = Number(q.page ?? 1), s = Number(q.pageSize ?? 25);
  return { items: items.slice((p - 1) * s, p * s), total: items.length, page: p, pageSize: s };
};

export const adminRefFixture = { id: fid(9000), name: 'Fernando V.', email: 'admin@remoa.app' };
const ana = { id: fid(9001), name: 'Ana Paula Lima', email: 'ana.lima@exemplo.com' };
const bruno = { id: fid(9002), name: 'Bruno Costa', email: 'bruno@exemplo.com' };

export const adminMeFixture = { ...adminRefFixture, authenticatedAt: at(-0.2), openTickets: 3 };

const kpi = (value: number, delta: number, n = 30) => ({ value, delta, deltaPct: value - delta ? Math.round((delta / (value - delta)) * 100) : null, spark: Array.from({ length: n }, (_, i) => Math.round((value / n) * (0.6 + ((i * 7) % 5) / 10))) });
export const adminOverviewFixture: AdminOverview = {
  period: 30,
  kpis: {
    accounts: kpi(1284, 212), maps: kpi(3920, 640), proSubscribers: kpi(146, 18),
    revenue: kpi(612_400, 74_900), referralsQualified: kpi(38, 9), openTickets: kpi(3, -2),
  },
  growth: Array.from({ length: 30 }, (_, i) => ({ day: new Date(FIXTURE_NOW.getTime() - (29 - i) * 86_400_000).toISOString().slice(0, 10), accounts: 4 + (i % 6), maps: 15 + ((i * 3) % 11) })),
  attention: { referralsInReview: 2, paymentsFailed24h: 1, ticketsStale: 1, seedsAwaitingReview: 4 },
  latestPayments: [{ id: 'pi_mock_1', user: ana, item: 'pro_monthly', method: 'pix', amountCents: 3990, status: 'paid', createdAt: at(-1) }],
  latestUsers: [{ user: ana, plan: 'pro', origin: 'referral', createdAt: at(-3) }, { user: bruno, plan: 'free', origin: 'direct', createdAt: at(-5) }],
  latestMaps: [{ id: sepseBoard.id, title: sepseBoard.title, area: sepseBoard.area, owner: ana, cards: sepseCards.length, createdAt: at(-2) }],
  generatedAt: FIXTURE_NOW,
};

const userRow = (u: typeof ana, extra: Partial<AdminUserDetail> = {}): AdminUserDetail => ({
  ...u, plan: 'free', maps: 2, cards: 48, status: 'active', origin: 'direct', createdAt: at(-400), role: 'student',
  emailConfirmedAt: at(-399), lastSignInAt: at(-6), suspendedAt: null, suspendedReason: null, deletionAt: null, grantUntil: null, timeline: [], ...extra,
});
export const adminUserFixtures = [userRow(ana, { plan: 'pro', origin: 'referral' }), userRow(bruno)];

export const adminPaymentFixtures: AdminPaymentDetail[] = [{
  id: 'pi_mock_1', user: ana, item: 'pro_monthly', method: 'card', coupon: null, status: 'paid', amountCents: 3990, currency: 'brl', createdAt: at(-1),
  stripeCustomerId: 'cus_mock_1', stripeSubscriptionId: 'sub_mock_1', stripePaymentIntent: 'pi_mock_1', stripeInvoiceId: 'in_mock_1', refundedAt: null,
  timeline: [{ type: 'checkout_created', at: at(-1.1) }, { type: 'card_authorized', at: at(-1.05) }, { type: 'paid', at: at(-1) }, { type: 'plan_released', at: at(-1) }],
  audit: [],
}];

export const adminReferralFixtures: AdminReferralDetail[] = [{
  id: fid(9100), referrer: ana, referee: bruno, invitedEmailMasked: null, channel: 'link', status: 'in_review', fraudSignals: ['velocity_limit'],
  rewardMonths: 0, createdAt: at(-72), signedUpAt: at(-70), qualifiedAt: null, grants: [], audit: [],
}];

export const adminTicketFixtures: AdminTicketDetail[] = [{
  id: fid(7002), number: 1042, user: ana, type: 'bug', subject: 'Mapa não salva a conexão', status: 'open', assignedTo: null,
  lastUserMessageAt: at(-30), createdAt: at(-30), plan: 'pro', context: supportContextFixture,
  messages: [{ id: fid(7102), authorType: 'user', author: ana, body: 'Quando ligo dois cards a conexão some ao recarregar a página.', internal: false, attachments: [], createdAt: at(-30) }],
}];

let audit: AuditEntry[] = [];
let auditSeq = 1050;
export function resetAdminMocks() {
  audit = [];
  auditSeq = 1050;
}
const record = (action: AdminAction, targetType: AuditTargetType, targetId: string, reason: string, before: unknown = null, after: unknown = null): AuditEntry => {
  const e: AuditEntry = {
    id: auditSeq++, createdAt: FIXTURE_NOW, actorType: 'admin', actor: adminRefFixture, action, targetType, targetId, targetLabel: null, reason, result: 'success', denial: null,
    before, after, ipHash: 'mock', userAgent: 'mock', requestId: 'mock',
  };
  audit.unshift(e);
  return e;
};
/** Factory for every `{ reason }` action route: validates the reason, writes a mock audit entry. */
const action = (name: AdminAction, targetType: AuditTargetType): Api.RunAdminAction => async (_a, id, raw) => {
  const p = parseWith(reasonInputSchema, raw);
  return p.ok ? ok({ audit: record(name, targetType, id, p.data.reason) }) : p;
};
const byId = <T extends { id: string }>(list: T[], id: string) => {
  const x = list.find((i) => i.id === id);
  return x ? ok(structuredClone(x)) : err<T>('not_found', 'not found');
};

export const adminMocks = {
  getAdminMe: (async () => ok(adminMeFixture)) satisfies Api.GetAdminMe,
  getAdminOverview: (async (_a, period) => ok({ ...adminOverviewFixture, period })) satisfies Api.GetAdminOverview,
  listAdminUsers: (async (_a, q) => ok({ ...page(adminUserFixtures, q), summary: { total: 2, active: 2, pending: 0, suspended: 0 } })) satisfies Api.ListAdminUsers,
  getAdminUser: (async (_a, id) => byId(adminUserFixtures, id)) satisfies Api.GetAdminUser,
  listAdminMaps: (async (_a, q) => ok({ ...page([{ id: sepseBoard.id, title: sepseBoard.title, area: sepseBoard.area, owner: ana, cards: sepseCards.length, edges: sepseEdges.length, status: 'private' as const, origin: 'manual' as const, createdAt: at(-2) }], q), summary: { total: 1, private: 1, seedDraft: 0, seedApproved: 0 } })) satisfies Api.ListAdminMaps,
  listAdminPayments: (async (_a, q) => ok({ ...page(adminPaymentFixtures, q), summary: { receivedCents: 3990, paid: 1, pending: 0, failed: 0, refunded: 0 } })) satisfies Api.ListAdminPayments,
  getAdminPayment: (async (_a, id) => byId(adminPaymentFixtures, id)) satisfies Api.GetAdminPayment,
  listAdminReferrals: (async (_a, q) => ok({ ...page(adminReferralFixtures, q), summary: { qualified: 0, inProgress: 0, inReview: 1, rejected: 0, monthsGranted: 0 } })) satisfies Api.ListAdminReferrals,
  getAdminReferral: (async (_a, id) => byId(adminReferralFixtures, id)) satisfies Api.GetAdminReferral,
  listAdminTickets: (async (_a, q) => ok({ ...page(adminTicketFixtures.map((t) => ({ id: t.id, number: t.number, user: t.user, type: t.type, subject: t.subject, status: t.status, assignedTo: t.assignedTo,
    preview: t.messages.filter((m) => !m.internal).at(-1)?.body.slice(0, 140) ?? '', lastUserMessageAt: t.lastUserMessageAt, createdAt: t.createdAt })), q), counts: { all: 1, open: 1, in_review: 0, answered: 0, resolved: 0, unassigned: 1 } })) satisfies Api.ListAdminTickets,
  getAdminTicket: (async (_a, id) => byId(adminTicketFixtures, id)) satisfies Api.GetAdminTicket,
  listAudit: (async (_a, q) => ok({ ...page(audit, q), summary: { total: audit.length, admin: audit.filter((e) => e.actorType === 'admin').length, system: audit.filter((e) => e.actorType === 'system' || e.actorType === 'stripe').length, denied: audit.filter((e) => e.result === 'denied').length } })) satisfies Api.ListAudit,
  grantProMonth: action('user.grant_pro_month', 'user'),
  sendPasswordReset: action('user.password_reset', 'user'),
  suspendUser: action('user.suspend', 'user'),
  reactivateUser: action('user.reactivate', 'user'),
  scheduleDeletion: action('user.schedule_deletion', 'user'),
  archiveMap: action('map.archive', 'board'),
  approveSeed: action('seed.approve', 'board'),
  unpublishSeed: action('seed.unpublish', 'board'),
  refundPayment: action('payment.refund', 'payment'),
  resendReceipt: action('payment.resend_receipt', 'payment'),
  approveReferral: action('referral.approve', 'referral'),
  rejectReferral: action('referral.reject', 'referral'),
  openMapReadOnly: (async (_a, id, raw) => {
    const p = parseWith(reasonInputSchema, raw);
    if (!p.ok) return p;
    if (id !== sepseBoard.id) return err('not_found', 'not found');
    return ok({ audit: record('map.open_readonly', 'board', id, p.data.reason), graph: { board: structuredClone(sepseBoard), cards: structuredClone(sepseCards), edges: structuredClone(sepseEdges) } });
  }) satisfies Api.OpenMapReadOnly,
  markPaymentPaid: (async (_a, id, raw) => {
    const p = parseWith(markPaidInputSchema, raw);
    return p.ok ? ok({ audit: record('payment.mark_paid', 'payment', id, p.data.reason, { status: 'pending' }, { status: 'paid' }) }) : p;
  }) satisfies Api.MarkPaymentPaid,
  revokeGrant: (async (_a, _id, raw) => {
    const p = parseWith(revokeGrantInputSchema, raw);
    return p.ok ? ok({ audit: record('grant.revoke', 'grant', p.data.grantId, p.data.reason) }) : p;
  }) satisfies Api.RevokeGrant,
  replyAsAdmin: (async (_a, id, raw) => {
    const p = parseWith(adminTicketReplyInputSchema, raw);
    if (!p.ok) return p;
    const t = adminTicketFixtures.find((x) => x.id === id);
    if (!t) return err('not_found', 'not found');
    return ok({ audit: record(p.data.internal ? 'ticket.internal_note' : 'ticket.reply', 'ticket', id, `Atendimento do chamado #${t.number}`) });
  }) satisfies Api.ReplyAsAdmin,
  exportCsv: (async (_a, raw) => {
    const p = parseWith(adminExportInputSchema, raw);
    return p.ok ? ok({ csv: 'id\n', audit: record('export.csv', 'export', p.data.resource, p.data.reason) }) : p;
  }) satisfies Api.ExportAdminCsv,
  reset: resetAdminMocks,
};
