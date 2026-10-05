// Integration (P-009, P-018): needs local Supabase + storage; skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)('cleanup: soft-deleted cards and orphan assets', () => {
  let db: typeof import('@remoa/db').db;
  let storage: typeof import('../storage/storage');
  let job: typeof import('./assets');
  let user: string;
  let board: string;

  const asset = async (age = '48 hours') => {
    const id = uuid();
    const key = `assets/${user}/${id}`;
    await storage.putBytes(`${key}/w800.webp`, Buffer.from('x'), 'image/webp');
    await db.execute(sql`insert into assets (id, user_id, key, mime, created_at) values (${id}, ${user}, ${key}, 'image/webp', now() - ${age}::interval)`);
    return { id, key };
  };
  const exists = async (id: string) => (await db.execute(sql`select 1 from assets where id = ${id}`)).length === 1;
  const card = async (o: { front?: string; payload?: unknown; deletedAgo?: string } = {}) => {
    const id = uuid();
    await db.execute(sql`insert into cards (id, board_id, title, front_asset_id, payload, deleted_at)
      values (${id}, ${board}, 't', ${o.front ?? null}, ${JSON.stringify(o.payload ?? {})}::jsonb, ${o.deletedAgo ? sql`now() - ${o.deletedAgo}::interval` : null})`);
    return id;
  };

  beforeAll(async () => {
    ({ db } = await import('@remoa/db'));
    storage = await import('../storage/storage');
    job = await import('./assets');
    await storage.ensureBucket();
    user = uuid();
    await db.execute(sql`insert into auth.users (id, email, instance_id, aud, role) values (${user}, ${user + '@test.local'}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    board = uuid();
    await db.execute(sql`insert into boards (id, user_id, title) values (${board}, ${user}, 'b')`);
  });
  afterAll(async () => {
    await db.execute(sql`delete from auth.users where id = ${user}`);
  });

  it('P-018: removes unreferenced assets older than 24 h (row + objects); keeps fresh and referenced ones', async () => {
    const orphan = await asset();
    const fresh = await asset('1 hour');
    const front = await asset();
    const nested = await asset();
    await card({ front: front.id });
    await card({ payload: { steps: [{ assetId: nested.id }] } });
    expect(await job.cleanOrphanAssets()).toBeGreaterThanOrEqual(1);
    expect(await exists(orphan.id)).toBe(false);
    expect(await storage.headObject(`${orphan.key}/w800.webp`)).toBeNull();
    for (const a of [fresh, front, nested]) expect(await exists(a.id)).toBe(true);
    expect(await storage.headObject(`${front.key}/w800.webp`)).not.toBeNull();
  });

  it('P-009: purges cards soft-deleted > 30 d (edges cascade, its assets are freed); keeps recent deletes and live cards', async () => {
    const mine = await asset('1 hour');
    const shared = await asset('1 hour');
    const old = await card({ front: mine.id, payload: { assetId: shared.id }, deletedAgo: '31 days' });
    const live = await card({ payload: { assetId: shared.id } });
    const recent = await card({ deletedAgo: '5 days' });
    const edge = uuid();
    await db.execute(sql`insert into edges (id, board_id, from_card_id, to_card_id) values (${edge}, ${board}, ${old}, ${live})`);
    expect(await job.purgeDeletedCards()).toBeGreaterThanOrEqual(1);
    const has = async (id: string) => (await db.execute(sql`select 1 from cards where id = ${id}`)).length === 1;
    expect(await has(old)).toBe(false);
    expect(await has(live)).toBe(true);
    expect(await has(recent)).toBe(true);
    expect((await db.execute(sql`select 1 from edges where id = ${edge}`)).length).toBe(0);
    // assets are freed by the orphan sweep once old enough; the one a live card still uses stays
    const later = new Date(Date.now() + 2 * 86_400_000);
    await job.cleanOrphanAssets(later);
    expect(await exists(mine.id)).toBe(false);
    expect(await storage.headObject(`${mine.key}/w800.webp`)).toBeNull();
    expect(await exists(shared.id)).toBe(true);
  });

  it('is idempotent', async () => {
    const a = await job.purgeDeletedCards();
    const b = await job.purgeDeletedCards();
    expect(b).toBe(0);
    expect(a).toBe(0);
  });
});
