import { notInArray } from 'drizzle-orm';
import { db } from './client';
import { enamedTaxonomy, matrixItems } from './schema';
import { ENAMED_ITEMS, ENAMED_TEMPORAL_MARK } from './seed/enamed';
import { parentsFirst, taxonomyFromMatrix } from './seed/enamed-taxonomy';

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

// F30 (D-1604): taxonomy from every matrix row in the database, parents first; upsert by code, never deletes (questions point at it).
const matrix = await db.select({ id: matrixItems.id, area: matrixItems.area, code: matrixItems.code, title: matrixItems.title, parentId: matrixItems.parentId }).from(matrixItems);
const taxIds = new Map<string, string>();
for (const t of parentsFirst(taxonomyFromMatrix(matrix))) {
  const row = { code: t.code, kind: t.kind, area: t.area, name: t.name, matrixRef: t.matrixRef, parentId: t.parentCode ? taxIds.get(t.parentCode) ?? null : null };
  const [r] = await db.insert(enamedTaxonomy).values(row).onConflictDoUpdate({
    target: enamedTaxonomy.code, set: { kind: row.kind, name: row.name, matrixRef: row.matrixRef, parentId: row.parentId },
  }).returning({ id: enamedTaxonomy.id });
  taxIds.set(t.code, r!.id);
}
process.stdout.write(`seed ok: ${ENAMED_ITEMS.length} matrix_items, ${taxIds.size} enamed_taxonomy; stale in db: ${stale.map((s) => s.code).join(',') || 'none'}\n`);
process.exit(0);
