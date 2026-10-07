import { and, asc, eq, sql } from 'drizzle-orm';
import { pick } from '../pick';
import { ok, type CoverageRow, type GetCoverage, type LinkBoardMatrix, type ListMatrixItems, type SuggestMatrixItems, type UnlinkBoardMatrix } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { mapStatsFor } from '../review/stats';
import { Abort, dbm, guard, run } from '../db';
import { invalidate } from '../cache';

export const listMatrixItems: ListMatrixItems = async (area) =>
  ok(
    await dbm().then(async (s) => {
      const rows = await s.db.select(pick(s.matrixItems, 'id', 'area', 'code', 'title', 'parentId', 'targetCards')).from(s.matrixItems).where(eq(s.matrixItems.area, area)).orderBy(asc(s.matrixItems.code));
      return rows.map((r) => ({ id: r.id, area: r.area, code: r.code, title: r.title, parentId: r.parentId, targetCards: r.targetCards }));
    }),
  );

/** F07: items linked (board_matrix_items) to the user's own live boards; items without a map are left out. */
export const getCoverage: GetCoverage = async (userId) =>
  ok(
    await run(userId, async (tx, s) => {
      const links = await tx.execute<{ board_id: string; item_id: string }>(
        sql`select l.board_id, l.matrix_item_id as item_id from board_matrix_items l join boards b on b.id = l.board_id where b.user_id = ${userId} and b.archived_at is null`,
      );
      if (!links.length) return [];
      // G21 FR-23: per-board totals from map_stats (was every card and state of the user); avg recall = sum of r / reviewed cards
      const [items, stats] = await Promise.all([tx.select(pick(s.matrixItems, 'id', 'area', 'code', 'title', 'targetCards')).from(s.matrixItems), mapStatsFor(tx, userId, links.map((l) => l.board_id), new Date())]);
      const byItem = new Map<string, { board_id: string; item_id: string }[]>();
      for (const l of links) byItem.set(l.item_id, [...(byItem.get(l.item_id) ?? []), l]);
      return items
        .filter((i) => byItem.has(i.id))
        .sort((a, b) => (a.code < b.code ? -1 : 1))
        .map((i): CoverageRow => {
          const boards = byItem.get(i.id)!;
          const st = boards.map((l) => stats.get(l.board_id));
          const cards = st.reduce((n, x) => n + (x?.cards ?? 0), 0);
          const reviewed = st.reduce((n, x) => n + (x?.reviewed ?? 0), 0);
          const target = i.targetCards;
          return {
            matrixItemId: i.id, area: i.area, code: i.code, title: i.title, boards: boards.length, cards, targetCards: target,
            coverage: Math.min(100, (cards / target) * 100),
            avgRetrievability: reviewed ? st.reduce((n, x) => n + (x?.rSum ?? 0), 0) / reviewed : null,
          };
        });
    }),
  );

/** Title in -> up to 3 matrix items by trigram word_similarity (public data, service connection). 0.4 keeps junk out; groups (items with children) are never suggested. */
export const suggestMatrixItems: SuggestMatrixItems = async (title) =>
  ok(
    await dbm().then(async (s) => {
      const rows = await s.db.execute<{ id: string; area: 'CM'; code: string; title: string; parent_id: string | null; target_cards: number }>(
        sql`select id, area, code, title, parent_id, target_cards from matrix_items m where word_similarity(lower(${title}), lower(title)) >= 0.4 and not exists (select 1 from matrix_items c where c.parent_id = m.id) order by word_similarity(lower(${title}), lower(title)) desc, code limit 3`,
      );
      return rows.map((r) => ({ id: r.id, area: r.area, code: r.code, title: r.title, parentId: r.parent_id, targetCards: r.target_cards }));
    }),
  );

/** Own boards only: RLS also exposes seed_approved boards to SELECT, and writing links on those would fail the RLS check with a 500. */
const boardOrNotFound = async (tx: Parameters<Parameters<typeof run>[1]>[0], s: Parameters<Parameters<typeof run>[1]>[1], userId: string, boardId: string) => {
  const [b] = await tx.select({ id: s.boards.id, matrixItemId: s.boards.matrixItemId }).from(s.boards).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId)));
  if (!b) throw new Abort({ code: 'not_found', message: 'board not found' });
  return b;
};

/** A link target must exist and be a topic: groups (items with children) are headings. */
export const isLinkableItem = async (tx: Tx, id: string) =>
  (await tx.execute(sql`select 1 from matrix_items m where m.id = ${id} and not exists (select 1 from matrix_items c where c.parent_id = m.id)`)).length > 0;

type EnamedBoardMeta = { path?: unknown; temporalMark?: string | null; badges?: string[] | null };

/** F07/F31: trail maps and ENAMED-tagged seeds should move the student's Matriz coverage when copied. */
export function boardHasEnamedCoverage(meta: EnamedBoardMeta): boolean {
  const slug = (meta.path as { slug?: string } | null | undefined)?.slug;
  if (slug) return true;
  if (meta.badges?.includes('top10_enamed')) return true;
  if (meta.temporalMark?.toLowerCase().includes('enamed')) return true;
  return false;
}

/** Links leaf matrix topics by title similarity when the copy has no links yet (seed copy, shared copy without vínculos). */
export async function attachMatrixLinksByTitle(
  tx: Tx,
  s: Parameters<Parameters<typeof run>[1]>[1],
  boardId: string,
  area: 'CM',
  title: string,
) {
  const [has] = await tx.select({ id: s.boardMatrixItems.matrixItemId }).from(s.boardMatrixItems).where(eq(s.boardMatrixItems.boardId, boardId)).limit(1);
  if (has) return;
  const rows = await tx.execute<{ id: string }>(sql`
    select m.id from matrix_items m
    where m.area = ${area}::area
      and not exists (select 1 from matrix_items c where c.parent_id = m.id)
      and word_similarity(lower(${title}), lower(m.title)) >= 0.35
    order by word_similarity(lower(${title}), lower(m.title)) desc, m.code
    limit 3`);
  if (!rows.length) return;
  await tx.insert(s.boardMatrixItems).values(rows.map((r) => ({ boardId, matrixItemId: r.id }))).onConflictDoNothing();
  await tx.update(s.boards).set({ matrixItemId: rows[0]!.id }).where(and(eq(s.boards.id, boardId), sql`${s.boards.matrixItemId} is null`));
}

export const linkBoardMatrix: LinkBoardMatrix = async (userId, link) => {
  const r = await guard(() =>
    run(userId, async (tx, s) => {
      const b = await boardOrNotFound(tx, s, userId, link.boardId);
      if (!(await isLinkableItem(tx, link.matrixItemId))) throw new Abort({ code: 'validation', message: 'unknown or group matrixItemId' });
      await tx.insert(s.boardMatrixItems).values(link).onConflictDoNothing();
      if (!b.matrixItemId) await tx.update(s.boards).set({ matrixItemId: link.matrixItemId }).where(eq(s.boards.id, b.id));
      return link;
    }),
  );
  if (r.ok) await invalidate('map.changed', { userId, mapId: link.boardId }); // after COMMIT: coverage and the map list
  return r;
};

export const unlinkBoardMatrix: UnlinkBoardMatrix = async (userId, link) => {
  const r = await guard(() =>
    run(userId, async (tx, s) => {
      const b = await boardOrNotFound(tx, s, userId, link.boardId);
      await tx.delete(s.boardMatrixItems).where(and(eq(s.boardMatrixItems.boardId, b.id), eq(s.boardMatrixItems.matrixItemId, link.matrixItemId)));
      if (b.matrixItemId === link.matrixItemId) {
        const [next] = await tx.select({ id: s.boardMatrixItems.matrixItemId }).from(s.boardMatrixItems).where(eq(s.boardMatrixItems.boardId, b.id)).limit(1);
        await tx.update(s.boards).set({ matrixItemId: next?.id ?? null }).where(eq(s.boards.id, b.id));
      }
      return null;
    }),
  );
  if (r.ok) await invalidate('map.changed', { userId, mapId: link.boardId });
  return r;
};
