import { notInArray } from 'drizzle-orm';
import { db } from './client';
import { matrixItems } from './schema';
import { ENAMED_ITEMS, ENAMED_TEMPORAL_MARK } from './seed/enamed';

// Groups first (no parentCode) so parent_id resolves; idempotent upsert on code.
const ids = new Map<string, string>();
const ordered = [...ENAMED_ITEMS.filter((i) => !i.parentCode), ...ENAMED_ITEMS.filter((i) => i.parentCode)];
for (const i of ordered) {
  const row = {
    area: 'CM' as const, code: i.code, title: i.title, targetCards: i.targetCards,
    parentId: i.parentCode ? ids.get(i.parentCode) ?? null : null, temporalMark: ENAMED_TEMPORAL_MARK,
  };
  const [r] = await db.insert(matrixItems).values(row).onConflictDoUpdate({
    target: matrixItems.code,
    set: { title: row.title, parentId: row.parentId, targetCards: row.targetCards, temporalMark: row.temporalMark },
  }).returning({ id: matrixItems.id });
  ids.set(i.code, r!.id);
}
// Never delete: board links may point at stale rows. Report them.
const stale = await db.select({ code: matrixItems.code }).from(matrixItems)
  .where(notInArray(matrixItems.code, ENAMED_ITEMS.map((i) => i.code)));
process.stdout.write(`seed ok: ${ENAMED_ITEMS.length} matrix_items; stale in db: ${stale.map((s) => s.code).join(',') || 'none'}\n`);
process.exit(0);
