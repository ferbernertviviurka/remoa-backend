import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  type CardMask, type MapOp,
  type ListBoards, type GetBoard, type CreateBoard, type UpdateBoard, type DuplicateBoard, type ApplyMapOps,
  MAX_CARDS_PER_BOARD, PLAN_LIMITS, err, idSchema, ok,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { Abort, guard, run } from '../db';
import { assertQuota, overTotal } from '../billing/quota';
import { planOf } from '../billing/plan';
import { isLinkableItem } from '../matrix/matrix';
import { cardPreview } from '../cards/cards';
import { boardListExtras } from '../review/queue';

const notFound = () => err<never>('not_found', 'board not found');
const isUuid = (v: string) => idSchema.safeParse(v).success;

const liveCardEnds = sql`join cards f on f.id = e.from_card_id and f.deleted_at is null join cards t on t.id = e.to_card_id and t.deleted_at is null`;

export const listBoards: ListBoards = async (userId) =>
  ok(
    await run(userId, async (tx, s) => {
      const rows = await tx
        .select({
          id: s.boards.id, title: s.boards.title, area: s.boards.area, matrixItemId: s.boards.matrixItemId, status: s.boards.status, updatedAt: s.boards.updatedAt,
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
        back: s.cards.back, source: s.cards.source, x: s.cards.x, y: s.cards.y, status: s.cards.status,
        order: s.cards.order, reviewerId: s.cards.reviewerId, updatedAt: s.cards.updatedAt, payload: s.cards.payload,
      })
      .from(s.cards)
      .where(and(eq(s.cards.boardId, boardId), isNull(s.cards.deletedAt)))
      .orderBy(asc(s.cards.order), asc(s.cards.createdAt));
    const cards = cardRows.map(({ x, y, payload, ...c }) => ({ ...c, position: { x, y }, preview: cardPreview(c.type, payload) }));
    const edgeRows = await tx.execute<{ id: string; board_id: string; from_card_id: string; to_card_id: string; label: string | null; question: string | null }>(
      sql`select e.id, e.board_id, e.from_card_id, e.to_card_id, e.label, e.question from edges e ${liveCardEnds} where e.board_id = ${boardId} order by e.created_at, e.id`,
    );
    const edges = edgeRows.map((e) => ({ id: e.id, boardId: e.board_id, fromCardId: e.from_card_id, toCardId: e.to_card_id, label: e.label, question: e.question }));
    return ok({ board, cards, edges });
  });
};

const cardLimitOf = async (userId: string) => PLAN_LIMITS[(await planOf(userId)).plan].limits.cards;

export const createBoard: CreateBoard = async (userId, input) => {
  const q = await assertQuota(userId, 'boards');
  if (!q.ok) return q;
  return guard(() =>
    run(userId, async (tx, s) => {
      if (input.matrixItemId && !(await isLinkableItem(tx, input.matrixItemId))) throw invalid('unknown or group matrixItemId');
      const [row] = await tx.insert(s.boards).values({ userId, title: input.title, area: input.area, matrixItemId: input.matrixItemId ?? null }).returning();
      if (input.matrixItemId) await tx.insert(s.boardMatrixItems).values({ boardId: row!.id, matrixItemId: input.matrixItemId });
      return row!;
    }),
  );
};

export const updateBoard: UpdateBoard = async (userId, boardId, input) => {
  if (!isUuid(boardId)) return notFound();
  const boardLimit = input.archived === false ? PLAN_LIMITS[(await planOf(userId)).plan].limits.boards : null;
  return run(userId, async (tx, s) => {
    // F08: unarchiving is a new live board for the quota (archive -> create -> unarchive would bypass it).
    if (boardLimit !== null) {
      const [b] = await tx.select({ a: s.boards.archivedAt }).from(s.boards).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId)));
      if (b?.a && (await overTotal(tx, userId, 'boards', boardLimit))) return err<never>('quota_exceeded', 'boards');
    }
    const set: Partial<typeof s.boards.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) set.title = input.title;
    if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;
    const [row] = await tx.update(s.boards).set(set).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId))).returning();
    return row ? ok(row) : notFound();
  });
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
    const ids = new Map<string, string>();
    if (cards.length) {
      const maskRows: (typeof s.masks.$inferInsert)[] = [];
      const rows = cards.map((c) => {
        const nid = crypto.randomUUID();
        ids.set(c.id, nid);
        const payload = copyImagePayload(c, nid, maskRows);
        return {
          id: nid, boardId: copy!.id, type: c.type, shape: c.shape, title: c.title, front: c.front, frontAssetId: c.frontAssetId, back: c.back, payload,
          // copies of seed content restart as draft: approval belongs to the reviewed original (rule 6)
          rubric: c.rubric, source: c.source, x: c.x, y: c.y, status: src.status === 'private' ? c.status : 'draft', order: c.order,
        };
      });
      await tx.insert(s.cards).values(rows);
      if (maskRows.length) await tx.insert(s.masks).values(maskRows);
    }
    const edges = await tx.select().from(s.edges).where(eq(s.edges.boardId, boardId));
    const edgeRows = edges.flatMap((e) => {
      const from = ids.get(e.fromCardId);
      const to = ids.get(e.toCardId);
      return from && to ? [{ boardId: copy!.id, fromCardId: from, toCardId: to, label: e.label, question: e.question }] : [];
    });
    if (edgeRows.length) await tx.insert(s.edges).values(edgeRows);
    return ok(copy!);
  });
};

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
