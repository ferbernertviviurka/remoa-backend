import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  type Board, type CardMask, type MapOp,
  type ListBoards, type GetBoard, type CreateBoard, type UpdateBoard, type DuplicateBoard, type ApplyMapOps,
  MAX_CARDS_PER_BOARD, PLAN_LIMITS, err, idSchema, ok,
  boardMatrixItemIds,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { Abort, guard, run } from '../db';
import { assertQuota, overTotal } from '../billing/quota';
import { planOf } from '../billing/plan';
import { cardPreview, sizeOf } from '../cards/cards';
import { boardListExtras } from '../review/queue';
import { initialShareColumns } from '../share/crypto';
import { shareUrlOf } from '../share/url';
import { turnOffShare } from './share';

const notFound = () => err<never>('not_found', 'board not found');
const isUuid = (v: string) => idSchema.safeParse(v).success;

/**
 * F17 (D-288): explicit columns, so the share hash, version and counters never leave the server. Only owners and seed
 * readers get here (RLS), and seeds never have a token, so `shareUrl` is owner-only. A copy from a link hides the
 * original's id (FR-16): `source_board_id` stays in the database only.
 */
export const toBoard = (r: typeof import('@remoa/db').boards.$inferSelect): Board => ({
  id: r.id, userId: r.userId, title: r.title, area: r.area, matrixItemId: r.matrixItemId, status: r.status, version: r.version,
  temporalMark: r.temporalMark, reviewerId: r.reviewerId, sourceBoardId: r.copiedFromLinkAt ? null : r.sourceBoardId, archivedAt: r.archivedAt, access: r.access,
  shareUrl: shareUrlOf(r.shareToken), copiedFrom: r.copiedFromLinkAt ? { at: r.copiedFromLinkAt } : null, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

const liveCardEnds = sql`join cards f on f.id = e.from_card_id and f.deleted_at is null join cards t on t.id = e.to_card_id and t.deleted_at is null`;

export const listBoards: ListBoards = async (userId) =>
  ok(
    await run(userId, async (tx, s) => {
      const rows = await tx
        .select({
          id: s.boards.id, title: s.boards.title, area: s.boards.area, matrixItemId: s.boards.matrixItemId, status: s.boards.status, updatedAt: s.boards.updatedAt,
          access: s.boards.access,
          cardCount: sql<number>`(select count(*)::int from cards c where c.board_id = boards.id and c.deleted_at is null)`,
          edgeCount: sql<number>`(select count(*)::int from edges e ${liveCardEnds} where e.board_id = boards.id)`,
        })
        .from(s.boards)
        .where(and(eq(s.boards.userId, userId), isNull(s.boards.archivedAt)))
        .orderBy(desc(s.boards.updatedAt));
      const extra = await boardListExtras(tx, userId, new Date(), rows.map((r) => r.id)); // F03 FR-8 badge + G01 state bar/preview
      return rows.map((r) => ({ ...r, ...(extra.get(r.id) ?? { dueCount: 0, stateCounts: { review: 0, watch: 0, steady: 0, unknown: 0 }, preview: { nodes: [], edges: [] } }) }));
    }),
  );

export const getBoard: GetBoard = async (userId, boardId) => {
  if (!isUuid(boardId)) return notFound();
  return run(userId, async (tx, s) => {
    const [board] = await tx.select().from(s.boards).where(eq(s.boards.id, boardId));
    if (!board) return notFound();
    const cardRows = await tx
      .select({
        id: s.cards.id, boardId: s.cards.boardId, type: s.cards.type, shape: s.cards.shape, title: s.cards.title, front: s.cards.front,
        frontAssetId: s.cards.frontAssetId,
        back: s.cards.back, backAssetId: s.cards.backAssetId, width: s.cards.width, height: s.cards.height, tags: s.cards.tags, source: s.cards.source, x: s.cards.x, y: s.cards.y, status: s.cards.status,
        order: s.cards.order, reviewerId: s.cards.reviewerId, updatedAt: s.cards.updatedAt, payload: s.cards.payload,
      })
      .from(s.cards)
      .where(and(eq(s.cards.boardId, boardId), isNull(s.cards.deletedAt)))
      .orderBy(asc(s.cards.order), asc(s.cards.createdAt));
    const cards = cardRows.map(({ x, y, payload, width, height, ...c }) => ({ ...c, position: { x, y }, size: sizeOf({ width, height }), preview: cardPreview(c.type, payload) }));
    const edgeRows = await tx.execute<{ id: string; board_id: string; from_card_id: string; to_card_id: string; label: string | null; question: string | null }>(
      sql`select e.id, e.board_id, e.from_card_id, e.to_card_id, e.label, e.question from edges e ${liveCardEnds} where e.board_id = ${boardId} order by e.created_at, e.id`,
    );
    const edges = edgeRows.map((e) => ({ id: e.id, boardId: e.board_id, fromCardId: e.from_card_id, toCardId: e.to_card_id, label: e.label, question: e.question }));
    return ok({ board: toBoard(board), cards, edges });
  });
};

const cardLimitOf = async (userId: string) => PLAN_LIMITS[(await planOf(userId)).plan].limits.cards;

/** F17: leaf (no children) AND belongs to the given area — one query for both checks. */
const isLinkableItemInArea = (tx: Tx, id: string, area: string) =>
  tx.execute(sql`select 1 from matrix_items m where m.id = ${id} and m.area = ${area} and not exists (select 1 from matrix_items c where c.parent_id = m.id)`)
    .then((r) => r.length > 0);

export const createBoard: CreateBoard = async (userId, input) => {
  const q = await assertQuota(userId, 'boards');
  if (!q.ok) return q;
  const itemIds = boardMatrixItemIds(input); // handles deprecated matrixItemId too
  const area = input.area ?? 'CM';
  // Sharing: generates token + hash before the transaction (scrypt is async and cpu-heavy).
  const share = await initialShareColumns({ access: input.access ?? 'owner', password: input.password });
  return guard(() =>
    run(userId, async (tx, s) => {
      // F17: validate every item — must be a leaf of the board's area.
      for (const itemId of itemIds) {
        if (!(await isLinkableItemInArea(tx, itemId, area)))
          throw invalid('matrixItemId is unknown, a group, or does not belong to the board area');
      }
      const [row] = await tx.insert(s.boards).values({
        userId, title: input.title, area, matrixItemId: itemIds[0] ?? null, ...share,
      }).returning();
      if (itemIds.length) {
        await tx.insert(s.boardMatrixItems).values(itemIds.map((id) => ({ boardId: row!.id, matrixItemId: id })));
      }
      return toBoard(row!);
    }),
  );
};

export const updateBoard: UpdateBoard = async (userId, boardId, input) => {
  if (!isUuid(boardId)) return notFound();
  const boardLimit = input.archived === false ? PLAN_LIMITS[(await planOf(userId)).plan].limits.boards : null;
  const r = await run(userId, async (tx, s) => {
    // F08: unarchiving is a new live board for the quota (archive -> create -> unarchive would bypass it).
    if (boardLimit !== null) {
      const [b] = await tx.select({ a: s.boards.archivedAt }).from(s.boards).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId)));
      if (b?.a && (await overTotal(tx, userId, 'boards', boardLimit))) return err<never>('quota_exceeded', 'boards');
    }
    const set: Partial<typeof s.boards.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) set.title = input.title;
    if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;
    const [row] = await tx.update(s.boards).set(set).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId))).returning();
    return row ? ok(toBoard(row)) : notFound();
  });
  // F17: archiving turns the link off (server connection, after the tx above has released the row; D-288).
  if (!r.ok || input.archived !== true || r.data.access === 'owner') return r;
  const off = await turnOffShare(userId, boardId);
  return off ? ok(toBoard(off)) : r;
};

export const duplicateBoard: DuplicateBoard = async (userId, boardId, title) => {
  if (!isUuid(boardId)) return notFound();
  const q = await assertQuota(userId, 'boards');
  if (!q.ok) return q;
  const limit = await cardLimitOf(userId);
  return run(userId, async (tx, s) => {
    const [src] = await tx.select().from(s.boards).where(eq(s.boards.id, boardId));
    if (!src) return notFound();
    const cards = await tx.select().from(s.cards).where(and(eq(s.cards.boardId, boardId), isNull(s.cards.deletedAt)));
    if (await overTotal(tx, userId, 'cards', limit, cards.length)) return err<never>('quota_exceeded', 'cards'); // before any insert
    const [copy] = await tx.insert(s.boards).values({ userId, title, area: src.area, sourceBoardId: src.id }).returning();
    const edges = await tx.select().from(s.edges).where(eq(s.edges.boardId, boardId));
    // copies of seed content restart as draft: approval belongs to the reviewed original (rule 6)
    await cloneBoardContent(tx, s, copy!.id, cards, edges, { status: (c) => (src.status === 'private' ? c.status : 'draft'), tags: (c) => c.tags });
    return ok(toBoard(copy!));
  });
};

type CardRow = typeof import('@remoa/db').cards.$inferSelect;
/** Inserts copies of `cards` (fresh ids, image masks included) and the edges between them into `boardId`. Never FSRS state. */
export async function cloneBoardContent(
  tx: Tx, s: typeof import('@remoa/db'), boardId: string, cards: CardRow[],
  edges: { fromCardId: string; toCardId: string; label: string | null; question: string | null }[],
  o: { status: (c: CardRow) => CardRow['status']; tags: (c: CardRow) => string[]; override?: (c: CardRow) => Partial<Pick<CardRow, 'frontAssetId' | 'backAssetId' | 'payload' | 'rubric'>> },
) {
  const ids = new Map<string, string>();
  if (cards.length) {
    const maskRows: (typeof s.masks.$inferInsert)[] = [];
    const rows = cards.map((src) => {
      const c = o.override ? { ...src, ...o.override(src) } : src;
      const nid = crypto.randomUUID();
      ids.set(c.id, nid);
      const payload = copyImagePayload(c, nid, maskRows);
      return {
        id: nid, boardId, type: c.type, shape: c.shape, title: c.title, front: c.front, frontAssetId: c.frontAssetId, back: c.back, backAssetId: c.backAssetId, width: c.width, height: c.height, tags: o.tags(c), payload,
        rubric: c.rubric, source: c.source, x: c.x, y: c.y, status: o.status(c), order: c.order,
      };
    });
    await tx.insert(s.cards).values(rows);
    if (maskRows.length) await tx.insert(s.masks).values(maskRows);
  }
  const edgeRows = edges.flatMap((e) => {
    const from = ids.get(e.fromCardId);
    const to = ids.get(e.toCardId);
    return from && to ? [{ boardId, fromCardId: from, toCardId: to, label: e.label, question: e.question }] : [];
  });
  if (edgeRows.length) await tx.insert(s.edges).values(edgeRows);
}

/** Image cards: mask ids are masks.id (PK) and FSRS sub_ids, so the copy gets fresh ones, in the payload and in `masks`. */
function copyImagePayload(c: { type: string; payload: unknown }, cardId: string, maskRows: (typeof import('@remoa/db').masks.$inferInsert)[]) {
  const p = c.payload as { assetId?: string; masks?: CardMask[] };
  if (c.type !== 'image' || !p.assetId || !Array.isArray(p.masks)) return c.payload;
  const masks = p.masks.map((m) => ({ ...m, id: crypto.randomUUID() }));
  for (const m of masks) maskRows.push({ id: m.id, cardId, assetId: p.assetId, polygon: m.polygon, label: m.label });
  return { ...p, masks };
}

const invalid = (message: string) => new Abort({ code: 'validation', message });
/** Integer px columns; positionSchema bounds keep it in range. */
const coord = Math.round;
const cleanLabel = (l: string | null) => l?.trim() || null;

async function applyOp(tx: Tx, s: typeof import('@remoa/db'), o: MapOp, q: { userId: string; cardLimit: number | null }) {
  const { cards, edges } = s;
  switch (o.op) {
    case 'moveCards':
      for (const m of o.moves) {
        await tx
          .update(cards)
          .set({ x: coord(m.position.x), y: coord(m.position.y), updatedAt: new Date() })
          .where(and(eq(cards.id, m.cardId), eq(cards.boardId, o.boardId)));
      }
      return;
    case 'resizeCards': {
      // idempotent by nature (sets absolute sizes); the contract bounds are re-checked by the DB CHECK. Cards of other boards match nothing.
      for (const r of o.sizes) {
        await tx
          .update(cards)
          .set({ width: r.size?.w ?? null, height: r.size?.h ?? null, updatedAt: new Date() })
          .where(and(eq(cards.id, r.cardId), eq(cards.boardId, o.boardId), isNull(cards.deletedAt)));
      }
      return;
    }
    case 'createCard': {
      const c = o.card;
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(cards)
        .where(and(eq(cards.boardId, o.boardId), isNull(cards.deletedAt), ne(cards.id, c.id)));
      if (n >= MAX_CARDS_PER_BOARD) throw invalid('board card limit');
      // F08: replaying an op for an already-live card is not a new card. Over the plan: creation blocked, nothing deleted.
      const [live] = await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.id, c.id), isNull(cards.deletedAt)));
      if (!live && (await overTotal(tx, q.userId, 'cards', q.cardLimit))) throw new Abort({ code: 'quota_exceeded', message: 'cards' });
      const x = coord(c.position.x);
      const y = coord(c.position.y);
      await tx
        .insert(cards)
        .values({ id: c.id, boardId: o.boardId, type: c.type, title: c.title, x, y })
        .onConflictDoUpdate({
          target: cards.id,
          set: { deletedAt: null, title: c.title, type: c.type, x, y, updatedAt: new Date() },
          setWhere: eq(cards.boardId, o.boardId),
        });
      return;
    }
    case 'createEdge': {
      const e = o.edge;
      const [existing] = await tx.select({ id: edges.id }).from(edges).where(eq(edges.id, e.id));
      if (existing) return;
      if (e.fromCardId === e.toCardId) throw invalid('edge needs two distinct cards');
      const live = await tx
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.boardId, o.boardId), isNull(cards.deletedAt), inArray(cards.id, [e.fromCardId, e.toCardId])));
      if (live.length !== 2) throw invalid('edge ends must be live cards of the board');
      await tx.insert(edges).values({ id: e.id, boardId: o.boardId, fromCardId: e.fromCardId, toCardId: e.toCardId, label: cleanLabel(e.label) }).onConflictDoNothing();
      return;
    }
    case 'updateEdgeLabel':
      await tx.update(edges).set({ label: cleanLabel(o.label), updatedAt: new Date() }).where(and(eq(edges.id, o.edgeId), eq(edges.boardId, o.boardId)));
      return;
    case 'deleteCards': // soft delete; edges stay and are hidden because an end is dead (undo = createCard again)
      await tx.update(cards).set({ deletedAt: new Date() }).where(and(inArray(cards.id, o.cardIds), eq(cards.boardId, o.boardId), isNull(cards.deletedAt)));
      return;
    case 'deleteEdges':
      await tx.delete(edges).where(and(inArray(edges.id, o.edgeIds), eq(edges.boardId, o.boardId)));
      return;
  }
}

export const applyMapOps: ApplyMapOps = async (userId, ops) => {
  const cardLimit = ops.some((o) => o.op === 'createCard') ? await cardLimitOf(userId) : null;
  return guard(() =>
    run(userId, async (tx, s) => {
      const boardIds = [...new Set(ops.map((o) => o.boardId))];
      // RLS on UPDATE silently matches 0 rows, so ownership is checked explicitly.
      const owned = await tx.select({ id: s.boards.id }).from(s.boards).where(and(inArray(s.boards.id, boardIds), eq(s.boards.userId, userId)));
      if (owned.length !== boardIds.length) throw new Abort({ code: 'not_found', message: 'board not found' });
      for (const o of ops) await applyOp(tx, s, o, { userId, cardLimit });
      await tx.update(s.boards).set({ updatedAt: new Date() }).where(inArray(s.boards.id, boardIds));
      return { applied: ops.map((o) => o.opId) };
    }),
  );

};
