import { Hono } from 'hono';
import { errorHttpStatus, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { copySeed, decideReview, editorialQueue, graderAgreement, listDrafts, listSeeds, publishBoard, reportCard, resolveDispute, seedDetail, setReviewerCrm } from '../editorial/editorial';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

export const editorialRoutes = new Hono<Env>()
  .get('/queue', async (c) => send(await editorialQueue(c.get('userId'), { boardId: c.req.query('board'), flag: c.req.query('flag') })))
  .post('/decide', async (c) => send(await decideReview(c.get('userId'), await c.req.json().catch(() => null))))
  .post('/crm', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { crm?: unknown } | null;
    if (!body || typeof body.crm !== 'string') return send({ ok: false, error: { code: 'validation', message: 'crm' } });
    return send(await setReviewerCrm(c.get('userId'), body.crm));
  })
  .post('/dispute', async (c) => send(await resolveDispute(c.get('userId'), await c.req.json().catch(() => null))))
  .get('/drafts', async (c) => send(await listDrafts(c.get('userId'))))
  .post('/publish', async (c) => send(await publishBoard(c.get('userId'), await c.req.json().catch(() => null))))
  .get('/seeds', async () => send(await listSeeds()))
  .get('/seeds/:id', async (c) => send(/^[0-9a-f-]{36}$/i.test(c.req.param('id')) ? await seedDetail(c.req.param('id')) : { ok: false, error: { code: 'not_found', message: 'not found' } }))
  .post('/report', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { cardId?: unknown; note?: unknown } | null;
    return send(await reportCard(c.get('userId'), body?.cardId, body?.note));
  })
  .post('/copy', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { boardId?: string } | null;
    if (!body?.boardId) return send({ ok: false, error: { code: 'validation', message: 'boardId' } });
    return send(await copySeed(c.get('userId'), body.boardId));
  })
  .get('/metrics', async (c) => send(await graderAgreement(c.get('userId'))));
