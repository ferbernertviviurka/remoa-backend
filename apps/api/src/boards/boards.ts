import { createHash } from 'node:crypto';
import { pick } from '../pick';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  type Board, type BoardGraph, type BoardSummary, type CardMask, type MapOp,
  type ListBoards, type DeleteBoard, type GetBoard, type CreateBoard, type UpdateBoard, type DuplicateBoard, type ApplyMapOps,
  MAX_CARDS_PER_BOARD, PLAN_LIMITS, boardListQuerySchema, err, idSchema, ok, parseWith, type Result,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { Abort, guard, run, uuids } from '../db';
import { assertQuota, overTotal } from '../billing/quota';
import { planOf } from '../billing/plan';
import { cardPreview, sizeOf } from '../cards/cards';
import { boardListExtras, W, withWindow } from '../review/queue';
import { mapStatsFrom, mapStatsSql, type MapStatsData } from '../review/stats';
import { initialShareColumns } from '../share/crypto';
import { shareUrlOf } from '../share/url';
import { turnOffShare } from './share';
import { maybeQualifyReferral } from '../referral/qualify';
import { invalidate } from '../cache';

const notFound = () => err<never>('not_found', 'board not found');
const isUuid = (v: string) => idSchema.safeParse(v).success;

/**
 * F17 (D-288): explicit columns, so the share hash, version and counters never leave the server. Only owners and seed
 * readers get here (RLS), and seeds never have a token, so `shareUrl` is owner-only. A copy from a link hides the
 * original's id (FR-16): `source_board_id` stays in the database only.
 */
type BoardCols = Pick<typeof import('@remoa/db').boards.$inferSelect, 'id' | 'userId' | 'title' | 'area' | 'matrixItemId' | 'status' | 'version' | 'temporalMark' | 'reviewerId' | 'sourceBoardId' | 'copiedFromLinkAt' | 'archivedAt' | 'access' | 'shareToken' | 'createdAt' | 'updatedAt'>;
export const toBoard = (r: BoardCols): Board => ({
  id: r.id, userId: r.userId, title: r.title, area: r.area, matrixItemId: r.matrixItemId, status: r.status, version: r.version,
  temporalMark: r.temporalMark, reviewerId: r.reviewerId, sourceBoardId: r.copiedFromLinkAt ? null : r.sourceBoardId, archivedAt: r.archivedAt, access: r.access,
  shareUrl: shareUrlOf(r.shareToken), copiedFrom: r.copiedFromLinkAt ? { at: r.copiedFromLinkAt } : null, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

/** G14 D-574: permanent, owner-only, own maps only (seed = 404). One row; FKs cascade (cards/edges/fsrs/attempts/queue) or set null (sessions, copies). */
export const deleteBoard: DeleteBoard = async (userId, boardId) => {
  if (!isUuid(boardId)) return notFound();
  const r = await run(userId, async (tx, s) => {
    const [row] = await tx.delete(s.boards).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId), eq(s.boards.status, 'private'))).returning({ id: s.boards.id });
    return row ? ok({ id: row.id }) : notFound();
  });
  if (r.ok) await invalidate('map.changed', { userId, mapId: boardId });
  return r;
};

/**
 * G21 FR-18/FR-20 (D-1033): the list asks for everything today (no `limit`), so the default page is the max (200) and the
 * cursor is optional; a client that sends `limit` gets `X-Next-Cursor` when there is more. `include=preview` is the legacy
 * thumbnail (loads the user's cards): off by default, the web asks for it only where it draws it (P-477).
 */
export const BOARD_LIST_MAX = 200;
export const boardListPageSchema = boardListQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(BOARD_LIST_MAX).default(BOARD_LIST_MAX),
  cursor: z.string().min(1).max(120).optional(),
  include: z.enum(['preview']).optional(),
});
export type BoardListPageQuery = z.input<typeof boardListPageSchema>;

export const encodeCursor = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString('base64url');
export const decodeCursor = (c: string): { ts: string; id: string } | null => {
  const [ts, id] = Buffer.from(c, 'base64url').toString().split('|');
  // the timestamp goes into a bound parameter cast to timestamptz; the shape check keeps garbage a 422, not a 500
  return ts && id && /^\d{4}-\d\d-\d\d[ T][\d:.]+([+-]\d\d(:?\d\d)?|Z)?$/.test(ts) && idSchema.safeParse(id).success ? { ts, id } : null;
};

export async function listBoardsPage(userId: string, query: BoardListPageQuery = {}): Promise<Result<{ items: BoardSummary[]; nextCursor: string | null }>> {
  const parsed = parseWith(boardListPageSchema, query);
  if (!parsed.ok) return parsed;
  const { status, limit, include } = parsed.data;
  const cur = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !cur) return err('validation', 'cursor: invalid');
  return ok(
    await run(userId, async (tx, s) => {
      const where = and(
        eq(s.boards.userId, userId),
        status === 'active' ? isNull(s.boards.archivedAt) : status === 'archived' ? isNotNull(s.boards.archivedAt) : undefined,
        cur ? sql`(${s.boards.updatedAt}, ${s.boards.id}) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : undefined,
      );
      const order = [desc(s.boards.updatedAt), desc(s.boards.id)] as const;
      const now = new Date();
      // G21 D-1094: one flight; the map_stats statement takes the page's ids as the same query (subquery), not from the rows
      const pageIds = tx.select({ id: s.boards.id }).from(s.boards).where(where).orderBy(...order).limit(limit + 1);
      const [rows, [st]] = await Promise.all([
        tx
          .select({
            id: s.boards.id, title: s.boards.title, area: s.boards.area, matrixItemId: s.boards.matrixItemId, status: s.boards.status, updatedAt: s.boards.updatedAt,
            access: s.boards.access, archivedAt: s.boards.archivedAt, ts: sql<string>`${s.boards.updatedAt}::text`,
            matrixItemIds: sql<string[]>`coalesce((select array_agg(bm.matrix_item_id order by bm.created_at, bm.matrix_item_id) from board_matrix_items bm where bm.board_id = boards.id), '{}')`,
          })
          .from(s.boards)
          .where(where)
          .orderBy(...order)
          .limit(limit + 1),
        tx.execute<{ m: MapStatsData }>(withWindow(userId, now, sql`select ${mapStatsSql(userId, sql`array(${pageIds})`, now.getTime(), W.endMs)} as m`)),
      ]);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const ids = page.map((r) => r.id);
      const stats = await mapStatsFrom(tx, userId, ids, st!.m, now); // G21 P-474 (D-1038): map_stats rollup, 0 per-board scans (+1 upsert when one is stale)
      const extra = include === 'preview' ? await boardListExtras(tx, userId, new Date(), ids) : null; // legacy path (F03 FR-8 badge + G01 state bar/preview)
      const last = page[page.length - 1];
      const items = page.map((r) => {
        const m = stats.get(r.id);
        return {
        id: r.id, title: r.title, area: r.area, matrixItemId: r.matrixItemId, status: r.status, updatedAt: r.updatedAt, access: r.access, archivedAt: r.archivedAt, matrixItemIds: r.matrixItemIds,
        cardCount: (m?.cards ?? 0) + (m?.notes ?? 0), edgeCount: m?.edges ?? 0, dueCount: m?.due ?? 0,
        stateCounts: m?.states ?? { review: 0, watch: 0, steady: 0, unknown: 0 }, preview: { nodes: [], edges: [] as [number, number][] },
        ...(extra?.get(r.id) ?? {}),
        };
      });
      return { items, nextCursor: more && last ? encodeCursor(last.ts, last.id) : null };
    }),
  );
}

/** Same contract as before (`BoardSummary[]`): the first page, up to 200 maps. */
export const listBoards: ListBoards = async (userId, query = {}) => {
  const r = await listBoardsPage(userId, query);
  return r.ok ? ok(r.data.items) : r;
};

/**
 * G21 FR-20 (D-1034): open a map in two steps. `view=structure` = step 1 (id, position, size, title, type, shape, order, preview chips;
 * front/back cut to a 280-character summary, no tags/source); the card's whole text comes from GET /v1/cards/:id when it is selected.
 * `view=full` (default, what the editor uses today) keeps every field. Both are cheap on a repeat visit: the ETag is derived from the
 * board row (+ newest card edit) before the cards are read, so a revalidation costs 2 queries and no payload.
 */
export const boardViews = ['full', 'structure'] as const;
export const boardViewQuerySchema = z.object({ view: z.enum(boardViews).default('full') });
export type BoardView = (typeof boardViews)[number];
export const SUMMARY_CHARS = 280;

const boardEtag = (view: BoardView, b: { updatedAt: Date; version: number; access: string; archivedAt: Date | null; shareToken: string | null; matrix: string[]; cardsAt: string | null }) =>
  `W/"${createHash('sha1').update([view, b.updatedAt.toISOString(), b.version, b.access, b.archivedAt?.toISOString() ?? '', b.shareToken ?? '', b.matrix.join(','), b.cardsAt ?? ''].join('|')).digest('base64url').slice(0, 22)}"`;
export const etagMatches = (header: string | null | undefined, etag: string) => !!header && header.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));

export async function getBoardView(
  userId: string, boardId: string, o: { view?: BoardView; ifNoneMatch?: string | null } = {},
): Promise<Result<{ etag: string; notModified: true } | { etag: string; notModified: false; data: BoardGraph }>> {
  if (!isUuid(boardId)) return notFound();
  const view = o.view ?? 'full';
  return run(userId, async (tx, s) => {
    const boardQ = tx
      .select({
        id: s.boards.id, userId: s.boards.userId, title: s.boards.title, area: s.boards.area, matrixItemId: s.boards.matrixItemId, status: s.boards.status, version: s.boards.version,
        temporalMark: s.boards.temporalMark, reviewerId: s.boards.reviewerId, sourceBoardId: s.boards.sourceBoardId, copiedFromLinkAt: s.boards.copiedFromLinkAt,
        archivedAt: s.boards.archivedAt, access: s.boards.access, shareToken: s.boards.shareToken, createdAt: s.boards.createdAt, updatedAt: s.boards.updatedAt,
        matrixItemIds: sql<string[]>`coalesce((select array_agg(bm.matrix_item_id order by bm.created_at, bm.matrix_item_id) from board_matrix_items bm where bm.board_id = boards.id), '{}')`,
        cardsAt: sql<string | null>`(select max(c.updated_at)::text from cards c where c.board_id = boards.id)`,
      })
      .from(s.boards)
      .where(eq(s.boards.id, boardId));
    const text = (col: typeof s.cards.front | typeof s.cards.back) => (view === 'structure' ? sql<string | null>`left(${col}, ${SUMMARY_CHARS})` : sql<string | null>`${col}`);
    const graph = () => Promise.all([
      tx
        .select({
          id: s.cards.id, boardId: s.cards.boardId, type: s.cards.type, shape: s.cards.shape, title: s.cards.title, front: text(s.cards.front),
          frontAssetId: s.cards.frontAssetId,
          back: text(s.cards.back), backAssetId: s.cards.backAssetId, width: s.cards.width, height: s.cards.height,
          tags: view === 'structure' ? sql<string[]>`'{}'::text[]` : s.cards.tags, source: view === 'structure' ? sql<string | null>`null` : s.cards.source,
          sourceExcerpt: view === 'structure' ? sql<string | null>`null` : s.cards.sourceExcerpt,
          x: s.cards.x, y: s.cards.y, status: s.cards.status,
          order: s.cards.order, reviewerId: s.cards.reviewerId, updatedAt: s.cards.updatedAt, payload: s.cards.payload, suspendedAt: s.cards.suspendedAt,
        })
        .from(s.cards)
        .where(and(eq(s.cards.boardId, boardId), isNull(s.cards.deletedAt)))
        .orderBy(asc(s.cards.order), asc(s.cards.createdAt)),
      // the live-ends filter runs in memory with the card ids (was two joins on cards: 94 ms x 24 in pg_stat_statements)
      tx
        .select({ id: s.edges.id, boardId: s.edges.boardId, fromCardId: s.edges.fromCardId, toCardId: s.edges.toCardId, label: s.edges.label, question: s.edges.question })
        .from(s.edges)
        .where(eq(s.edges.boardId, boardId))
        .orderBy(asc(s.edges.createdAt), asc(s.edges.id)),
      // only seeds and copies of seeds have published versions (own private maps never do): the board row decides, in SQL
      tx.execute<{ changelog: string | null }>(sql`select changelog from board_versions where board_id = (
        select coalesce(b.source_board_id, b.id) from boards b where b.id = ${boardId} and (b.source_board_id is not null or b.status <> 'private'))
        order by version desc limit 1`),
    ]);
    // G21 D-1095: one flight. With If-None-Match the board row goes first (a match answers 304 without reading the cards).
    const pending = o.ifNoneMatch ? null : graph();
    pending?.catch(() => undefined);
    const [board] = await boardQ;
    if (!board) return (await pending?.catch(() => undefined), notFound());
    const etag = boardEtag(view, { ...board, matrix: board.matrixItemIds });
    if (etagMatches(o.ifNoneMatch, etag)) return ok({ etag, notModified: true as const });
    const [cardRows, edgeRows, [published]] = await (pending ?? graph());
    const live = new Set(cardRows.map((c) => c.id));
    const cards = cardRows.map(({ x, y, payload, width, height, ...c }) => ({ ...c, position: { x, y }, size: sizeOf({ width, height }), preview: cardPreview(c.type, payload) }));
    const edges = edgeRows.filter((e) => live.has(e.fromCardId) && live.has(e.toCardId));
    const changelog = published?.changelog ?? null;
    return ok({ etag, notModified: false as const, data: { board: { ...toBoard(board), changelog, matrixItemIds: board.matrixItemIds }, cards, edges } as unknown as BoardGraph });
  });
}

export const getBoard: GetBoard = async (userId, boardId) => {
  const r = await getBoardView(userId, boardId, { view: 'full' });
  return r.ok ? ok((r.data as { data: BoardGraph }).data) : r;
};

/** F17 FR-21 (D-532): the map's matrix links, oldest first. */
const linkedItems = async (tx: Tx, s: typeof import('@remoa/db'), boardId: string) =>
  (await tx.select({ id: s.boardMatrixItems.matrixItemId }).from(s.boardMatrixItems).where(eq(s.boardMatrixItems.boardId, boardId))
    .orderBy(asc(s.boardMatrixItems.createdAt), asc(s.boardMatrixItems.matrixItemId))).map((r) => r.id);

const cardLimitOf = async (userId: string) => PLAN_LIMITS[(await planOf(userId)).plan].limits.cards;

/** F17: leaf (no children) AND belongs to the given area — one query for both checks. */
const isLinkableItemInArea = (tx: Tx, id: string, area: string) =>
  tx.execute(sql`select 1 from matrix_items m where m.id = ${id} and m.area = ${area} and not exists (select 1 from matrix_items c where c.parent_id = m.id)`)
    .then((r) => r.length > 0);

export const createBoard: CreateBoard = async (userId, input) => {
  const q = await assertQuota(userId, 'boards');
  if (!q.ok) return q;
  const itemIds = input.matrixItemIds ?? [];
  const area = input.area ?? 'CM';
  // Sharing: generates token + hash before the transaction (scrypt is async and cpu-heavy).
  const share = await initialShareColumns({ access: input.access ?? 'owner', password: input.password });
  const r = await guard(() =>
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
  if (r.ok) await invalidate('map.changed', { userId, mapId: r.data.id });
  return r;
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
    if (input.area !== undefined) set.area = input.area;
    const [row] = await tx.update(s.boards).set(set).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId))).returning();
    if (!row) return notFound();
    if (input.area !== undefined) {
      // D-532: links to items of another area go with the area change (same tx); the primary item follows the oldest survivor.
      await tx.execute(sql`delete from board_matrix_items bm using matrix_items m where bm.board_id = ${boardId} and m.id = bm.matrix_item_id and m.area <> ${input.area}`);
      const items = await linkedItems(tx, s, boardId);
      if (row.matrixItemId && !items.includes(row.matrixItemId)) {
        const [fixed] = await tx.update(s.boards).set({ matrixItemId: items[0] ?? null }).where(eq(s.boards.id, boardId)).returning();
        return ok({ ...toBoard(fixed!), matrixItemIds: items });
      }
      return ok({ ...toBoard(row), matrixItemIds: items });
    }
    return ok({ ...toBoard(row), matrixItemIds: await linkedItems(tx, s, boardId) });
  });
  if (r.ok) await invalidate('map.changed', { userId, mapId: boardId });
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
  const r = await run(userId, async (tx, s) => {
    const [src] = await tx.select(pick(s.boards, 'id', 'area', 'status')).from(s.boards).where(eq(s.boards.id, boardId));
    if (!src) return notFound();
    const cards = await tx.select(pick(s.cards, ...CLONE_CARD_COLS)).from(s.cards).where(and(eq(s.cards.boardId, boardId), isNull(s.cards.deletedAt)));
    if (await overTotal(tx, userId, 'cards', limit, cards.length)) return err<never>('quota_exceeded', 'cards'); // before any insert
    const [copy] = await tx.insert(s.boards).values({ userId, title, area: src.area, sourceBoardId: src.id }).returning();
    const edges = await tx.select(pick(s.edges, 'fromCardId', 'toCardId', 'label', 'question')).from(s.edges).where(eq(s.edges.boardId, boardId));
    // copies of seed content restart as draft: approval belongs to the reviewed original (rule 6)
    await cloneBoardContent(tx, s, copy!.id, cards, edges, { status: (c) => (src.status === 'private' ? c.status : 'draft'), tags: (c) => c.tags });
    return ok(toBoard(copy!));
  });
  if (r.ok) {
    await invalidate('map.changed', { userId, mapId: r.data.id });
    await maybeQualifyReferral(userId); // F18 (D-384): a copied seed/own board can be the first map; never throws
  }
  return r;
};

/** FR-17 (D-1066): what a copy of a card reads (no deleted/suspended/reviewer/source ids). */
export const CLONE_CARD_COLS = ['id', 'type', 'shape', 'title', 'front', 'frontAssetId', 'back', 'backAssetId', 'width', 'height', 'tags', 'payload', 'rubric', 'source', 'sourceExcerpt', 'x', 'y', 'status', 'order', 'createdAt'] as const;
type CardRow = Pick<typeof import('@remoa/db').cards.$inferSelect, (typeof CLONE_CARD_COLS)[number]>;
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
        rubric: c.rubric, source: c.source, sourceExcerpt: c.sourceExcerpt, x: c.x, y: c.y, status: o.status(c), order: c.order,
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
/** Postgres array literal for `unnest(...)`: ids are uuids and numbers (validated by zod), `null` becomes NULL. */
export const arr = (xs: (string | number | null)[]) => `{${xs.map((x) => (x === null ? 'NULL' : String(x))).join(',')}}`;
const cleanLabel = (l: string | null) => l?.trim() || null;
/** Same condition as the edges_write WITH CHECK: both ends are live cards of the edge's board. */
const liveEnds = (e: typeof import('@remoa/db').edges) =>
  sql`exists (select 1 from cards c where c.id = ${e.fromCardId} and c.board_id = ${e.boardId} and c.deleted_at is null)
    and exists (select 1 from cards c where c.id = ${e.toCardId} and c.board_id = ${e.boardId} and c.deleted_at is null)`;

export async function applyOp(tx: Tx, s: typeof import('@remoa/db'), o: MapOp, q: { userId: string; cardLimit: number | null }) {
  const { cards, edges } = s;
  switch (o.op) {
    case 'moveCards': {
      // G21 FR-21 (D-1036): one UPDATE ... FROM unnest(...) for the whole drag (was one UPDATE per card). Cards of other boards match nothing.
      if (!o.moves.length) return;
      await tx.execute(sql`update cards set x = v.x, y = v.y, updated_at = now() from unnest(${arr(o.moves.map((m) => m.cardId))}::uuid[], ${arr(o.moves.map((m) => coord(m.position.x)))}::int[], ${arr(o.moves.map((m) => coord(m.position.y)))}::int[]) as v(id, x, y)
        where cards.id = v.id and cards.board_id = ${o.boardId}`);
      return;
    }
    case 'resizeCards': {
      // idempotent by nature (sets absolute sizes); the contract bounds are re-checked by the DB CHECK. Cards of other boards match nothing.
      if (!o.sizes.length) return;
      await tx.execute(sql`update cards set width = v.w, height = v.h, updated_at = now() from unnest(${arr(o.sizes.map((r) => r.cardId))}::uuid[], ${arr(o.sizes.map((r) => r.size?.w ?? null))}::int[], ${arr(o.sizes.map((r) => r.size?.h ?? null))}::int[]) as v(id, w, h)
        where cards.id = v.id and cards.board_id = ${o.boardId} and cards.deleted_at is null`);
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
      // An edge with a soft-deleted end is hidden; updating it would fail edges_write WITH CHECK (live ends), so it matches 0 rows instead.
      await tx
        .update(edges)
        .set({ label: cleanLabel(o.label), updatedAt: new Date() })
        .where(and(eq(edges.id, o.edgeId), eq(edges.boardId, o.boardId), liveEnds(edges)));
      return;
    case 'deleteCards': // soft delete; edges stay and are hidden because an end is dead (undo = createCard again)
      await tx.update(cards).set({ deletedAt: new Date() }).where(and(sql`${cards.id} = any(${uuids(o.cardIds)})`, eq(cards.boardId, o.boardId), isNull(cards.deletedAt)));
      return;
    case 'deleteEdges':
      await tx.delete(edges).where(and(sql`${edges.id} = any(${uuids(o.edgeIds)})`, eq(edges.boardId, o.boardId)));
      return;
  }
}

export const applyMapOps: ApplyMapOps = async (userId, ops) => {
  const cardLimit = ops.some((o) => o.op === 'createCard') ? await cardLimitOf(userId) : null;
  const r = await guard(() =>
    run(userId, async (tx, s) => {
      const boardIds = [...new Set(ops.map((o) => o.boardId))];
      // INSERT ops would hit the RLS WITH CHECK (a 500) on a foreign board, so they keep the explicit 404 up front; UPDATE/DELETE-only batches (drag, resize, label) rely on the touch below.
      if (ops.some((o) => o.op === 'createCard' || o.op === 'createEdge')) {
        const owned = await tx.select({ id: s.boards.id }).from(s.boards).where(and(sql`${s.boards.id} = any(${uuids(boardIds)})`, eq(s.boards.userId, userId)));
        if (owned.length !== boardIds.length) throw new Abort({ code: 'not_found', message: 'board not found' });
      }
      for (const o of ops) await applyOp(tx, s, o, { userId, cardLimit });
      // G21 FR-21: ownership rides on the touch (RLS on UPDATE silently matches 0 rows, so the count is the check; a mismatch rolls the batch back).
      const touched = await tx.update(s.boards).set({ updatedAt: new Date() }).where(and(sql`${s.boards.id} = any(${uuids(boardIds)})`, eq(s.boards.userId, userId))).returning({ id: s.boards.id });
      if (touched.length !== boardIds.length) throw new Abort({ code: 'not_found', message: 'board not found' });
      return { applied: ops.map((o) => o.opId) };
    }),
  );
  if (r.ok) for (const mapId of new Set(ops.map((o) => o.boardId))) await invalidate('card.changed', { userId, mapId }); // after COMMIT
  // F18 (D-384): qualify after any batch that created a card. Not `cardLimit !== null`: that is null for Pro (and the F30 trial), so referees never qualified.
  if (r.ok && ops.some((o) => o.op === 'createCard')) await maybeQualifyReferral(userId); // after the commit; never throws
  return r;
};
