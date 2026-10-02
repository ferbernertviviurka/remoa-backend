import { asc, eq, sql } from 'drizzle-orm';
import { ok, type CoverageRow, type GetCoverage, type ListMatrixItems } from '@remoa/contracts';
import { boardCardStats } from '../review/queue';
import { dbm, run } from '../db';

/** Seed leaves target_cards null until the F07 content pass; contract needs > 0. */
export const DEFAULT_TARGET_CARDS = 20;

export const listMatrixItems: ListMatrixItems = async (area) =>
  ok(
    await dbm().then(async (s) => {
      const rows = await s.db.select().from(s.matrixItems).where(eq(s.matrixItems.area, area)).orderBy(asc(s.matrixItems.code));
      return rows.map((r) => ({ id: r.id, area: r.area, code: r.code, title: r.title, parentId: r.parentId, targetCards: r.targetCards ?? DEFAULT_TARGET_CARDS }));
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
      const [items, stats] = await Promise.all([tx.select().from(s.matrixItems), boardCardStats(tx, userId, new Date())]);
      const byItem = new Map<string, { board_id: string; item_id: string }[]>();
      for (const l of links) byItem.set(l.item_id, [...(byItem.get(l.item_id) ?? []), l]);
      return items
        .filter((i) => byItem.has(i.id))
        .sort((a, b) => (a.code < b.code ? -1 : 1))
        .map((i): CoverageRow => {
          const boards = byItem.get(i.id)!;
          const st = boards.map((l) => stats.get(l.board_id));
          const cards = st.reduce((n, x) => n + (x?.cards ?? 0), 0);
          const recalls = st.flatMap((x) => x?.recalls ?? []);
          const target = i.targetCards ?? DEFAULT_TARGET_CARDS;
          return {
            matrixItemId: i.id, area: i.area, code: i.code, title: i.title, boards: boards.length, cards, targetCards: target,
            coverage: Math.min(100, (cards / target) * 100),
            avgRetrievability: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
          };
        });
    }),
  );
