import { Hono } from 'hono';
import { errorHttpStatus, parseWith, supportAttachmentSignInputSchema, supportReplyInputSchema, supportTicketInputSchema, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { takeSupportSlot } from '../support/rate-limit';
import { signSupportAttachment } from '../support/attachments';
import { getMyTicket, getSupportUnread, listMyTickets, markTicketRead, replyToTicket, submitSupportTicket } from '../support/tickets';

const send = <T>(r: Result<T>, status: 200 | 201 = 200) =>
  r.ok ? Response.json({ ok: true, data: r.data }, { status }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
const json = (req: Request) => req.json().catch(() => null);

// requireUser is applied in app.ts. Messages are immutable: no PUT/PATCH/DELETE here (FR-7).
export const supportRoutes = new Hono<Env>()
  .post('/attachments/sign', async (c) => {
    const slot = takeSupportSlot(c.get('userId'), 'sign');
    if (!slot.ok) return send(slot);
    const i = parseWith(supportAttachmentSignInputSchema, await json(c.req.raw));
    return send(i.ok ? await signSupportAttachment(c.get('userId'), i.data) : i);
  })
  .post('/tickets', async (c) => {
    const i = parseWith(supportTicketInputSchema, await json(c.req.raw));
    const r = i.ok ? await submitSupportTicket(c.get('userId'), i.data) : i;
    if (!r.ok) c.get('log').warn('support ticket rejected', { code: r.error.code, reason: r.error.message });
    return send(r, 201);
  })
  .get('/tickets', async (c) => send(await listMyTickets(c.get('userId'))))
  .get('/unread', async (c) => send(await getSupportUnread(c.get('userId'))))
  .get('/tickets/:id', async (c) => send(await getMyTicket(c.get('userId'), c.req.param('id'))))
  .post('/tickets/:id/messages', async (c) => {
    const slot = takeSupportSlot(c.get('userId'), 'reply');
    if (!slot.ok) return send(slot);
    const i = parseWith(supportReplyInputSchema, await json(c.req.raw));
    return send(i.ok ? await replyToTicket(c.get('userId'), c.req.param('id'), i.data) : i, 201);
  })
  .post('/tickets/:id/read', async (c) => send(await markTicketRead(c.get('userId'), c.req.param('id'))));
