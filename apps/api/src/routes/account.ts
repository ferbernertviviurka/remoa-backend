import { Hono } from 'hono';
import { ACCOUNT_LIMITS, errorHttpStatus, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { deleteAccount, exportAccount } from '../account/account';
import { releaseSlot, requestMeta, takeSlot } from '../account/events';
import type { StripePort } from '../billing/stripe';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

// The body stays the usual { ok, data }; content-disposition makes the browser save it as a file.
export const accountRoutes = ({ stripe }: { stripe?: StripePort }) => new Hono<Env>()
  .post('/export', async (c) => {
    // D-125: 1 per hour, counted in account_events; a failed export gives the slot back.
    const slot = await takeSlot(c.get('userId'), 'export_requested', ACCOUNT_LIMITS.exportsPerHour, 3_600_000, requestMeta(c));
    if (!slot) return send({ ok: false, error: { code: 'rate_limited', message: 'one export per hour' } });
    const r = await exportAccount(c.get('userId')).catch(async (e: unknown) => { await releaseSlot(slot); throw e; });
    if (!r.ok) await releaseSlot(slot);
    const res = send(r);
    if (r.ok) res.headers.set('content-disposition', `attachment; filename="remoa-export-${r.data.exportedAt.toISOString().slice(0, 10)}.json"`);
    return res;
  })
  .delete('/', async (c) => {
    c.get('log').info('account deleted (soft)');
    return send(await deleteAccount(c.get('userId'), stripe));
  });
