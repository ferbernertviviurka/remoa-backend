import { beforeEach, describe, expect, it } from 'vitest';
import {
  adminActionResultSchema,
  adminListQuerySchema,
  adminMapPageSchema,
  adminOverviewSchema,
  adminTicketListQuerySchema,
  adminTicketPageSchema,
  auditPageSchema,
  eventSchemas,
  formatAuditId,
  formatTicketNumber,
  overviewQuerySchema,
  reasonInputSchema,
  supportContextSchema,
  supportTicketDetailSchema,
  supportTicketInputSchema,
  type SupportTicketInput,
} from './index';
import { adminMocks, adminOverviewFixture, resetSupportMocks, supportContextFixture, supportMocks as s } from './mocks';

const valid: SupportTicketInput = { type: 'bug', subject: 'Não salva', description: 'A conexão some quando recarrego a página.', context: supportContextFixture };
const user = '00000000-0000-4000-8000-000000000001';

describe('support input (FR-3, FR-4)', () => {
  it('accepts a valid ticket and defaults attachments', () => {
    expect(supportTicketInputSchema.parse(valid).attachments).toEqual([]);
  });
  it('enforces subject 5..120, description 20..2000, ≤ 3 attachments', () => {
    expect(supportTicketInputSchema.safeParse({ ...valid, subject: 'abc' }).success).toBe(false);
    expect(supportTicketInputSchema.safeParse({ ...valid, description: 'curta' }).success).toBe(false);
    expect(supportTicketInputSchema.safeParse({ ...valid, description: 'x'.repeat(2001) }).success).toBe(false);
    expect(supportTicketInputSchema.safeParse({ ...valid, attachments: ['a', 'b', 'c', 'd'] }).success).toBe(false);
  });
  it('context is a strict whitelist: map content or tokens never pass', () => {
    expect(supportContextSchema.safeParse({ ...supportContextFixture, boardContent: 'Sepse' }).success).toBe(false);
    expect(supportContextSchema.safeParse({ ...supportContextFixture, token: 'eyJ' }).success).toBe(false);
    expect(supportContextSchema.safeParse({ ...supportContextFixture, screen: '/m/abc?token=x' }).success).toBe(false);
    expect(Object.keys(supportContextSchema.shape).sort()).toEqual(['appVersion', 'browser', 'os', 'plan', 'screen', 'timezone']);
    expect(supportTicketInputSchema.parse({ ...valid, context: null }).context).toBeNull();
  });
});

describe('admin contracts', () => {
  it('every action reason has at least 8 characters (trimmed)', () => {
    expect(reasonInputSchema.safeParse({ reason: '   curto   ' }).success).toBe(false);
    expect(reasonInputSchema.safeParse({ reason: 'Pedido do aluno por e-mail' }).success).toBe(true);
  });
  it('list query coerces strings and defaults to 25 per page', () => {
    expect(adminListQuerySchema.parse({ page: '2' })).toEqual({ page: 2, pageSize: 25 });
    expect(adminListQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });
  it('overview period is 7, 30 or 90', () => {
    expect(overviewQuerySchema.parse({ period: '90' }).period).toBe(90);
    expect(overviewQuerySchema.safeParse({ period: '14' }).success).toBe(false);
    expect(adminOverviewSchema.parse(adminOverviewFixture).kpis.accounts.value).toBe(1284);
  });
  it('formats ids for display', () => {
    expect(formatAuditId(1050)).toBe('a_1050');
    expect(formatTicketNumber(1042)).toBe('#1042');
  });
  it('CCR-014: query booleans, ticket preview cap, mocks carry the new chips', async () => {
    expect(adminTicketListQuerySchema.parse({ assignedToMe: 'false' }).assignedToMe).toBe(false);
    expect(adminTicketListQuerySchema.parse({ assignedToMe: 'true' }).assignedToMe).toBe(true);
    const t = await adminMocks.listAdminTickets(user, {});
    expect(t.ok && adminTicketPageSchema.parse(t.data).counts.unassigned).toBe(1);
    expect(t.ok && adminTicketPageSchema.safeParse({ ...t.data, items: [{ ...t.data.items[0], preview: 'x'.repeat(141) }] }).success).toBe(false);
    const m = await adminMocks.listAdminMaps(user, {});
    expect(m.ok && adminMapPageSchema.parse(m.data).items[0]!.area).toBe('CM');
    const a = await adminMocks.listAudit(user, {});
    expect(a.ok && auditPageSchema.parse(a.data).summary.total).toBeGreaterThanOrEqual(0);
  });
});

describe('F19 events carry no text', () => {
  it('support_submitted is strict', () => {
    expect(eventSchemas.support_submitted.safeParse({ type: 'bug', hasAttachment: false, context: true }).success).toBe(true);
    expect(eventSchemas.support_submitted.safeParse({ type: 'bug', hasAttachment: false, context: true, subject: 'x' }).success).toBe(false);
    expect(eventSchemas.support_replied.safeParse({ body: 'x' }).success).toBe(false);
  });
});

describe('mocks', () => {
  beforeEach(() => resetSupportMocks());
  it('submit → list → duplicate is refused', async () => {
    const r = await s.submitSupportTicket(user, valid);
    expect(r.ok && r.data.number).toBe(1043);
    const again = await s.submitSupportTicket(user, valid);
    expect(!again.ok && again.error.message).toBe('support_duplicate');
    const list = await s.listMyTickets(user);
    expect(list.ok && list.data).toHaveLength(4);
  });
  it('unread drops after reading; details match the schema', async () => {
    const u = await s.getSupportUnread(user);
    expect(u.ok && u.data.count).toBe(1);
    const list = await s.listMyTickets(user);
    const id = list.ok ? list.data.find((t) => t.unread)!.id : '';
    const d = await s.getMyTicket(user, id);
    expect(d.ok && supportTicketDetailSchema.safeParse(d.data).success).toBe(true);
    await s.markTicketRead(user, id);
    const after = await s.getSupportUnread(user);
    expect(after.ok && after.data.count).toBe(0);
  });
  it('admin action without reason fails; with reason returns an audit entry', async () => {
    expect((await adminMocks.suspendUser(user, user, { reason: 'x' })).ok).toBe(false);
    const r = await adminMocks.suspendUser(user, user, { reason: 'Suspeita de fraude' });
    expect(r.ok && adminActionResultSchema.parse(r.data).audit.action).toBe('user.suspend');
  });
});
