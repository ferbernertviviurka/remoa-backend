// F01 P-009 / F02 P-018: hard-delete soft-deleted cards after 30 days and assets nothing references any more.
import { sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { deletePrefix } from '../storage/storage';

const log = createLogger({ requestId: 'job-cleanup' });
export const CARD_RETENTION_DAYS = 30;
export const ORPHAN_ASSET_HOURS = 24;
const BATCH = 200;
const MAX_BATCHES = 50; // per run; the rest goes tomorrow

/** Every uuid a card payload (any nesting: steps, cases, masks) or a board snapshot mentions, plus the FK columns (G18: calendar covers too). One linear scan, not one LIKE per asset.
 * Only flat `assets` rows are candidates: avatars and support attachments live in other tables/prefixes and are never touched. */
const referenced = sql`select front_asset_id::text id from cards union select back_asset_id::text from cards union select asset_id::text from masks
  union select cover_asset_id::text from calendar_events
  union select (regexp_matches(payload::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g'))[1] from cards
  union select (regexp_matches(snapshot::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g'))[1] from board_versions`;

/** Storage first, row second: a failed delete keeps the row and the next run retries. Returns rows removed. */
async function dropAssets(rows: { id: string; key: string }[]) {
  const { db } = await dbm();
  let n = 0;
  for (const r of rows) {
    try {
      await deletePrefix(`${r.key}/`);
      await db.execute(sql`delete from assets where id = ${r.id}`);
      n++;
    } catch (e) { log.error('asset cleanup failed', { assetId: r.id, error: String(e) }); }
  }
  return n;
}

/** P-018: assets uploaded but never attached after 24 h (up to BATCH * MAX_BATCHES per run; the rest goes tomorrow). */
export async function cleanOrphanAssets(now = new Date()) {
  const { db } = await dbm();
  const rows = await db.execute<{ id: string; key: string }>(sql`with ref as (${referenced})
    select a.id, a.key from assets a where a.created_at <= ${now.toISOString()}::timestamptz - make_interval(hours => ${ORPHAN_ASSET_HOURS})
      and not exists (select 1 from ref where ref.id = a.id::text) limit ${BATCH * MAX_BATCHES}`);
  return dropAssets([...rows]);
}

/** P-009: cards soft-deleted > 30 days ago; edges, masks and review state cascade, then their now-unreferenced assets go. Run the orphan sweep after it. */
export async function purgeDeletedCards(now = new Date()) {
  const { db } = await dbm();
  const cutoff = now.toISOString();
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const gone = await db.execute<{ id: string }>(sql`delete from cards where id in (
      select id from cards where deleted_at <= ${cutoff}::timestamptz - make_interval(days => ${CARD_RETENTION_DAYS}) limit ${BATCH}) returning id`);
    total += gone.length;
    if (gone.length < BATCH) break;
  }
  return total;
}
