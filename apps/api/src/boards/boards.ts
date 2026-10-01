import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  type AppError, type MapOp, type Result,
  type ListBoards, type GetBoard, type CreateBoard, type UpdateBoard, type DuplicateBoard, type ApplyMapOps,
  MAX_CARDS_PER_BOARD, err, idSchema, ok,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';

// Lazy: importing @remoa/db throws without DATABASE_URL, and app.test.ts must load the app without a database.
const dbm = () => import('@remoa/db');
const run = async <T>(userId: string, fn: (tx: Tx, s: typeof import('@remoa/db')) => Promise<T>) => {
  const m = await dbm();
  return m.withUser(userId, (tx) => fn(tx, m));
};

const notFound = () => err<never>('not_found', 'board not found');
const isUuid = (v: string) => idSchema.safeParse(v).success;

/** Thrown inside a transaction to roll it back with a domain error. */
class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}
const guard = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof Abort) return { ok: false, error: e.error };
    throw e;
  }
};

const liveCardEnds = sql`join cards f on f.id = e.from_card_id and f.deleted_at is null join cards t on t.id = e.to_card_id and t.deleted_at is null`;

export const listBoards: ListBoards = async (userId) =>
  ok(
    await run(userId, async (tx, s) =>
      tx
        .select({
          id: s.boards.id, title: s.boards.title, area: s.boards.area, status: s.boards.status, updatedAt: s.boards.updatedAt,
          cardCount: sql<number>`(select count(*)::int from cards c where c.board_id = boards.id and c.deleted_at is null)`,
          edgeCount: sql<number>`(select count(*)::int from edges e ${liveCardEnds} where e.board_id = boards.id)`,
        })
        .from(s.boards)
        .where(and(eq(s.boards.userId, userId), isNull(s.boards.archivedAt)))
        .orderBy(desc(s.boards.updatedAt)),
    ),
  );

export const getBoard: GetBoard = async (userId, boardId) => {
  if (!isUuid(boardId)) return notFound();
  return run(userId, async (tx, s) => {
    const [board] = await tx.select().from(s.boards).where(eq(s.boards.id, boardId));
    if (!board) return notFound();
    const cardRows = await tx
      .select({
        id: s.cards.id, boardId: s.cards.boardId, type: s.cards.type, title: s.cards.title, front: s.cards.front,
        back: s.cards.back, source: s.cards.source, x: s.cards.x, y: s.cards.y, status: s.cards.status,
        order: s.cards.order, reviewerId: s.cards.reviewerId, updatedAt: s.cards.updatedAt,
      })
      .from(s.cards)
      .where(and(eq(s.cards.boardId, boardId), isNull(s.cards.deletedAt)))
      .orderBy(asc(s.cards.order), asc(s.cards.createdAt));
    const cards = cardRows.map(({ x, y, ...c }) => ({ ...c, position: { x, y } }));
    const edgeRows = await tx.execute<{ id: string; board_id: string; from_card_id: string; to_card_id: string; label: string | null; question: string | null }>(
      sql`select e.id, e.board_id, e.from_card_id, e.to_card_id, e.label, e.question from edges e ${liveCardEnds} where e.board_id = ${boardId} order by e.created_at, e.id`,
    );
    const edges = edgeRows.map((e) => ({ id: e.id, boardId: e.board_id, fromCardId: e.from_card_id, toCardId: e.to_card_id, label: e.label, question: e.question }));
    return ok({ board, cards, edges });
  });
};

export const createBoard: CreateBoard = async (userId, input) =>
  ok(
    await run(userId, async (tx, s) => {
      const [row] = await tx.insert(s.boards).values({ userId, title: input.title, area: input.area }).returning();
      return row!;
    }),
  );

export const updateBoard: UpdateBoard = async (userId, boardId, input) => {
  if (!isUuid(boardId)) return notFound();
  return run(userId, async (tx, s) => {
    const set: Partial<typeof s.boards.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) set.title = input.title;
    if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;
    const [row] = await tx.update(s.boards).set(set).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId))).returning();
    return row ? ok(row) : notFound();
  });
};

export const duplicateBoard: DuplicateBoard = async (userId, boardId, title) => {
  if (!isUuid(boardId)) return notFound();
  return run(userId, async (tx, s) => {
    const [src] = await tx.select().from(s.boards).where(eq(s.boards.id, boardId));
    if (!src) return notFound();
    const [copy] = await tx.insert(s.boards).values({ userId, title, area: src.area, sourceBoardId: src.id }).returning();
    const cards = await tx.select().from(s.cards).where(and(eq(s.cards.boardId, boardId), isNull(s.cards.deletedAt)));
    const ids = new Map<string, string>();
    if (cards.length) {
      const rows = cards.map((c) => {
        const nid = crypto.randomUUID();
        ids.set(c.id, nid);
        return {
          id: nid, boardId: copy!.id, type: c.type, title: c.title, front: c.front, back: c.back, payload: c.payload,
          // copies of seed content restart as draft: approval belongs to the reviewed original (rule 6)
          rubric: c.rubric, source: c.source, x: c.x, y: c.y, status: src.status === 'private' ? c.status : 'draft', order: c.order,
        };
      });
      await tx.insert(s.cards).values(rows);
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

const invalid = (message: string) => new Abort({ code: 'validation', message });
/** Integer px columns; positionSchema bounds keep it in range. */
const coord = Math.round;
const cleanLabel = (l: string | null) => l?.trim() || null;

async function applyOp(tx: Tx, s: typeof import('@remoa/db'), o: MapOp) {
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

export const applyMapOps: ApplyMapOps = async (userId, ops) =>
  guard(() =>
    run(userId, async (tx, s) => {
      const boardIds = [...new Set(ops.map((o) => o.boardId))];
      // RLS on UPDATE silently matches 0 rows, so ownership is checked explicitly.
      const owned = await tx.select({ id: s.boards.id }).from(s.boards).where(and(inArray(s.boards.id, boardIds), eq(s.boards.userId, userId)));
      if (owned.length !== boardIds.length) throw new Abort({ code: 'not_found', message: 'board not found' });
      for (const o of ops) await applyOp(tx, s, o);
      await tx.update(s.boards).set({ updatedAt: new Date() }).where(inArray(s.boards.id, boardIds));
      return { applied: ops.map((o) => o.opId) };
    }),
  );

