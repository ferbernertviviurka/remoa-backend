/**
 * F30 (D-1604): `enamed_taxonomy` derived from `matrix_items` (seed/enamed.ts). Nothing here invents a name: every row is a matrix
 * row with its own title, plus one root per area whose name is the area code (the label shown to the student comes from @remoa/strings).
 *
 * Depth mapping (depth 0 = matrix item without parent):
 *   (no matrix row)            -> kind `area`        code = area enum value ('CM'), parent = null
 *   depth 0                    -> kind `domain`      parent = the area row             (today: CM.01..CM.09, the specialty groups)
 *   depth >= 1 with children   -> kind `competency`  parent = its matrix parent        (today: none; the matrix has 2 levels)
 *   depth >= 1 without children-> kind `topic`       parent = its matrix parent        (today: CM.0X.YY items)
 * Migration 0041 backfills the same rows in SQL; `pnpm db:seed` keeps them in sync (upsert by code, never deletes).
 */
import type { Area, EnamedTaxonomyKind } from '@remoa/contracts';

export type MatrixRow = { id: string; area: Area; code: string; title: string; parentId: string | null };
/** `parentCode` = the taxonomy parent (area code for domains). */
export type TaxonomyRow = { code: string; kind: EnamedTaxonomyKind; area: Area; name: string; matrixRef: string | null; parentCode: string | null };

export function taxonomyFromMatrix(items: readonly MatrixRow[]): TaxonomyRow[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const hasChildren = new Set(items.flatMap((i) => (i.parentId ? [i.parentId] : [])));
  const areas = [...new Set(items.map((i) => i.area))];
  const rows: TaxonomyRow[] = areas.map((a) => ({ code: a, kind: 'area', area: a, name: a, matrixRef: null, parentCode: null }));
  for (const i of items) {
    const parent = i.parentId ? byId.get(i.parentId) : undefined;
    if (i.parentId && !parent) throw new Error(`matrix item ${i.code}: parent ${i.parentId} not found`);
    const kind: EnamedTaxonomyKind = !parent ? 'domain' : hasChildren.has(i.id) ? 'competency' : 'topic';
    rows.push({ code: i.code, kind, area: i.area, name: i.title, matrixRef: i.id, parentCode: parent ? parent.code : i.area });
  }
  return rows;
}

/** Parents before children, so an insert in this order resolves every parent_id. */
export function parentsFirst(rows: readonly TaxonomyRow[]): TaxonomyRow[] {
  const out: TaxonomyRow[] = [];
  const done = new Set<string>();
  let left = [...rows];
  while (left.length) {
    const ready = left.filter((r) => r.parentCode === null || done.has(r.parentCode));
    if (!ready.length) throw new Error(`taxonomy cycle or missing parent: ${left.map((r) => r.code).join(',')}`);
    for (const r of ready) done.add(r.code);
    out.push(...ready);
    left = left.filter((r) => !done.has(r.code));
  }
  return out;
}
