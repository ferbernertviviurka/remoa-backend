// F31/G19 P1: ready-made maps without login. Only `seed_approved` (listSeeds); the sample is the first PUBLIC_SAMPLE cards of the trail.
import { Hono } from 'hono';
import { errorHttpStatus, type HttpErrorBody, type Result } from '@remoa/contracts';
import { listSeeds, seedDetail } from './editorial';

export const PUBLIC_SAMPLE = 10;
const noId = <T extends { id: string }>(o: T): Omit<T, 'id'> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'id')) as Omit<T, 'id'>;
const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }, { headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' } })
    : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

export const publicSeedRoutes = new Hono()
  .get('/', async () => {
    const r = await listSeeds();
    // no id, no reviewer-only fields beyond the signature (rule 6 provenance); a seed without slug has no public page
    return send(r.ok ? { ok: true as const, data: r.data.filter((s) => s.slug).map(noId) } : r);
  })
  .get('/:slug', async (c) => {
    const list = await listSeeds();
    const seed = list.ok ? list.data.find((s) => s.slug === c.req.param('slug')) : undefined;
    if (!seed) return send({ ok: false, error: { code: 'not_found', message: 'not found' } });
    const full = await seedDetail(seed.id);
    if (!full.ok) return send(full);
    const { cards, ...meta } = full.data;
    return send({ ok: true as const, data: { ...noId(meta), sample: cards.slice(0, PUBLIC_SAMPLE).map(noId) } });
  });
