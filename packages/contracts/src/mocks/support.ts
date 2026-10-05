// F19 support mocks for the frontend (T6) until T2 lands. In-memory; resetSupportMocks() between tests.
import { err, ok, parseWith } from '../errors';
import {
  SUPPORT_LIMITS,
  supportAttachmentSignInputSchema,
  supportReplyInputSchema,
  supportTicketInputSchema,
  supportTicketSummarySchema,
  type SupportTicketDetail,
} from '../support';
import type * as Api from '../api';
import { FIXTURE_NOW, MOCK_APP_URL, fid } from './fixtures';

const at = (hours: number) => new Date(FIXTURE_NOW.getTime() + hours * 3_600_000);
export const supportContextFixture = { screen: '/app/mapas', plan: 'free', browser: 'Chrome 129', os: 'macOS 15', appVersion: '1.0.0', timezone: 'America/Sao_Paulo' } as const;

const ticket = (n: number, extra: Partial<SupportTicketDetail>): SupportTicketDetail => ({
  id: fid(7000 + n), number: 1040 + n, type: 'bug', subject: 'Mapa não salva a conexão', status: 'open', unread: false,
  createdAt: at(-48), updatedAt: at(-48), context: supportContextFixture, reopenableUntil: null,
  messages: [{ id: fid(7100 + n), authorType: 'user', body: 'Quando ligo dois cards a conexão some ao recarregar a página.', attachments: [], createdAt: at(-48) }],
  ...extra,
});

/** suporte-chamados.png: one answered (unread), one open, one resolved. */
export const supportTicketFixtures = [
  ticket(2, {
    status: 'answered', unread: true, updatedAt: at(-2),
    messages: [
      ticket(2, {}).messages[0]!,
      { id: fid(7202), authorType: 'admin', body: 'Obrigado! Corrigimos e a conexão agora fica salva. Pode testar de novo?', attachments: [], createdAt: at(-2) },
    ],
  }),
  ticket(1, { type: 'billing', subject: 'Pix pago e plano ainda Free', status: 'open', updatedAt: at(-30), context: null }),
  ticket(0, { type: 'suggestion', subject: 'Atalho para duplicar card', status: 'resolved', updatedAt: at(-200), reopenableUntil: at(136) }),
] satisfies SupportTicketDetail[];

let tickets: SupportTicketDetail[] = structuredClone(supportTicketFixtures);
let seq = 0;
export function resetSupportMocks(start: SupportTicketDetail[] = supportTicketFixtures) {
  tickets = structuredClone(start);
  seq = 0;
}
const summary = (t: SupportTicketDetail) => supportTicketSummarySchema.parse(t);
const find = (id: string) => tickets.find((t) => t.id === id);

export const signSupportAttachment: Api.SignSupportAttachment = async (userId, raw) => {
  const p = parseWith(supportAttachmentSignInputSchema, raw);
  if (!p.ok) return p;
  const key = `support/${userId}/${fid(7900 + seq++)}`;
  return ok({ url: `${MOCK_APP_URL}/mock-upload/${key}`, key });
};
export const submitSupportTicket: Api.SubmitSupportTicket = async (_u, raw) => {
  const p = parseWith(supportTicketInputSchema, raw);
  if (!p.ok) return p;
  if (tickets.some((t) => t.subject === p.data.subject && t.messages[0]?.body === p.data.description)) return err('conflict', 'support_duplicate');
  const number = Math.max(1040, ...tickets.map((t) => t.number)) + 1;
  const t = ticket(100 + seq++, {
    number, type: p.data.type, subject: p.data.subject, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW, context: p.data.context,
    messages: [{ id: fid(7800 + seq), authorType: 'user', body: p.data.description, attachments: [], createdAt: FIXTURE_NOW }],
  });
  tickets.unshift(t);
  return ok({ id: t.id, number });
};
export const listMyTickets: Api.ListMyTickets = async () => ok(tickets.map(summary));
export const getMyTicket: Api.GetMyTicket = async (_u, id) => {
  const t = find(id);
  return t ? ok(structuredClone(t)) : err('not_found', 'not found');
};
export const replyToTicket: Api.ReplyToTicket = async (_u, id, raw) => {
  const p = parseWith(supportReplyInputSchema, raw);
  if (!p.ok) return p;
  const t = find(id);
  if (!t) return err('not_found', 'not found');
  if (t.status === 'resolved' && t.reopenableUntil && t.reopenableUntil < FIXTURE_NOW) return err('conflict', 'support_ticket_closed');
  t.messages.push({ id: fid(7600 + seq++), authorType: 'user', body: p.data.body, attachments: [], createdAt: FIXTURE_NOW });
  Object.assign(t, { status: 'open', reopenableUntil: null, updatedAt: FIXTURE_NOW });
  return ok(structuredClone(t));
};
export const markTicketRead: Api.MarkTicketRead = async (_u, id) => {
  const t = find(id);
  if (!t) return err('not_found', 'not found');
  t.unread = false;
  return ok(null);
};
export const getSupportUnread: Api.GetSupportUnread = async () => ok({ count: tickets.filter((t) => t.unread).length });

export const supportMocks = {
  signSupportAttachment, submitSupportTicket, listMyTickets, getMyTicket, replyToTicket, markTicketRead, getSupportUnread,
  reset: resetSupportMocks, limits: SUPPORT_LIMITS,
};
