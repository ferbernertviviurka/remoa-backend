// F17 T3: the page behind `/m/<token>` (no login). Every query lists its columns; the response goes through the
// contracts' allowlist (`sharedBoardSchema.parse` strips unknown keys). Unknown, rotated, owner-only and archived links
// are the same 404.
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  SHARE_LIMITS, assetVariants, err, idSchema, ok, sharedBoardSchema, sharedCardSchema, shareTokenSchema,
  type GetSharedBoard, type Result, type SharedAsset, type SharedCard, type UnlockShared,
} from '@remoa/contracts';
import { dbm } from '../db';
import { getBytes } from '../storage/storage';
import { assetSig, limiterHash, signGrant, verifyAssetSig, verifyGrant, verifySharePassword } from '../share/crypto';
import { sharedAssetUrl } from '../share/url';

const notFound = () => err<never>('not_found', 'not found');
/** Image URLs on the public page live this long; a rotated link or new password stops them at once (version in the MAC). */
export const SHARED_ASSET_TTL_SECONDS = 600;

async function boardByToken(token: string) {
  if (!shareTokenSchema.safeParse(token).success) return null;
  const { db, boards: b } = await dbm();
  const [row] = await db
    .select({
      id: b.id, userId: b.userId, title: b.title, area: b.area, access: b.access, sharePasswordHash: b.sharePasswordHash,
      version: b.shareSecretVersion, updatedAt: b.updatedAt,
    })
    .from(b)
    .where(and(eq(b.shareToken, token), isNull(b.archivedAt), ne(b.access, 'owner')));
  return row ?? null;
}

/** Same source of truth for read, unlock and copy: `{ board }` when the caller may see the content. */
export async function resolveShared(token: string, ctx: { grant: string | null; viewerId: string | null }) {
  const board = await boardByToken(token);
  if (!board) return { status: 'missing' as const };
  const isOwner = ctx.viewerId === board.userId;
  if (board.access === 'password' && !isOwner && !verifyGrant(ctx.grant, token, board.version)) return { status: 'locked' as const, board };
  return { status: 'open' as const, board, isOwner };
}

/** D-201: every image a card references (front, back, image card, flow steps, case stages). */
export function cardAssetIds(c: { frontAssetId: string | null; backAssetId: string | null; payload: unknown }) {
  const p = (c.payload ?? {}) as { assetId?: string; steps?: { assetId?: string }[]; caseSteps?: { assetId?: string }[] };
  const ids = [c.frontAssetId, c.backAssetId, p.assetId, ...(Array.isArray(p.steps) ? p.steps : []).map((x) => x?.assetId), ...(Array.isArray(p.caseSteps) ? p.caseSteps : []).map((x) => x?.assetId)];
  return ids.filter((x): x is string => typeof x === 'string' && idSchema.safeParse(x).success);
}

export const getSharedBoard: GetSharedBoard = async (token, ctx) => {
  const r = await resolveShared(token, ctx);
  if (r.status === 'missing') return notFound();
  if (r.status === 'locked') return ok({ locked: true });
  const { board } = r;
  const { db, cards: c, edges: e, assets: a, boardMatrixItems: bm, matrixItems: mi } = await dbm();

  const rows = await db
    .select({
      id: c.id, type: c.type, shape: c.shape, title: c.title, front: c.front, frontAssetId: c.frontAssetId, back: c.back, backAssetId: c.backAssetId,
      width: c.width, height: c.height, source: c.source, x: c.x, y: c.y, order: c.order, payload: c.payload,
    })
    .from(c)
    .where(and(eq(c.boardId, board.id), isNull(c.deletedAt)))
    .orderBy(asc(c.order), asc(c.createdAt));
  const cards = rows.map(({ x, y, width, height, ...card }) => toSharedCard({ ...card, position: { x, y }, size: width !== null && height !== null ? { w: width, h: height } : null }));
  const live = new Set(cards.map((x) => x.id));

  const edgeRows = await db
    .select({ id: e.id, fromCardId: e.fromCardId, toCardId: e.toCardId, label: e.label, question: e.question })
    .from(e)
    .where(eq(e.boardId, board.id))
    .orderBy(asc(e.createdAt), asc(e.id));
  const edges = edgeRows.filter((x) => live.has(x.fromCardId) && live.has(x.toCardId));

  const matrixItems = await db
    .select({ code: mi.code, title: mi.title })
    .from(bm)
    .innerJoin(mi, eq(mi.id, bm.matrixItemId))
    .where(eq(bm.boardId, board.id))
    .orderBy(asc(bm.createdAt), asc(mi.code));

  const assetIds = [...new Set(rows.flatMap(cardAssetIds))];
  const assetRows = assetIds.length
    ? await db.select({ id: a.id, width: a.width, height: a.height, attribution: a.attribution }).from(a).where(inArray(a.id, assetIds))
    : [];
  const exp = Math.floor(Date.now() / 1000) + SHARED_ASSET_TTL_SECONDS;
  const url = (id: string, v: (typeof assetVariants)[number]) => sharedAssetUrl(token, id, v, exp, assetSig(token, board.version, id, v, exp));
  const assets: Record<string, SharedAsset> = Object.fromEntries(
    assetRows.map((x) => [x.id, { width: x.width ?? 1, height: x.height ?? 1, attribution: x.attribution, urls: { w800: url(x.id, 'w800'), w1600: url(x.id, 'w1600') } }]),
  );

  return ok(
    sharedBoardSchema.parse({
      locked: false, access: board.access, title: board.title, area: board.area, matrixItems, cards, edges, assets,
      cardCount: cards.length, updatedAt: board.updatedAt, ownBoardId: r.isOwner ? board.id : null,
    }),
  );
};

/** A payload that does not match its type (e.g. a flow card created on the map and never edited) is shown as a plain concept. */
function toSharedCard(card: Record<string, unknown> & { id: string; type: string }): SharedCard {
  const typed = sharedCardSchema.safeParse(card.type === 'concept' || card.type === 'note' ? { ...card, payload: {} } : card);
  return typed.success ? typed.data : sharedCardSchema.parse({ ...card, type: 'concept', payload: {} });
}

/**
 * FR-14. Wrong passwords are counted per (link, IP) in share_attempts; an advisory lock on that pair serializes
 * concurrent guesses, so a burst cannot slip past the limit. Blocked = 429 even with the right password.
 */
export const unlockShared: UnlockShared = async (token, input, { ip }) => {
  const board = await boardByToken(token);
  if (!board) return notFound();
  if (board.access !== 'password' || !board.sharePasswordHash) return err('validation', 'board is not password protected');
  const hash = board.sharePasswordHash;
  const tokenHash = limiterHash('token', token);
  const ipHash = limiterHash('ip', ip);
  const { db, shareAttempts: t } = await dbm();
  const window = sql`now() - make_interval(mins => ${SHARE_LIMITS.unlockWindowMinutes})`;
  return db.transaction(async (tx): Promise<Result<{ value: string; expiresAt: Date }>> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tokenHash}:${ipHash}`}, 0))`);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(and(eq(t.tokenHash, tokenHash), eq(t.ipHash, ipHash), sql`${t.createdAt} > ${window}`));
    if ((row?.n ?? 0) >= SHARE_LIMITS.unlockAttempts) return err('rate_limited', 'too many attempts');
    if (await verifySharePassword(input.password, hash)) return ok(signGrant(token, board.version));
    await tx.delete(t).where(and(eq(t.tokenHash, tokenHash), eq(t.ipHash, ipHash), sql`${t.createdAt} <= ${window}`));
    await tx.insert(t).values({ tokenHash, ipHash });
    return err('unauthorized', 'invalid password');
  });
};

/** Bytes of one image variant of a shared board; any mismatch is the same 404. */
export async function sharedAssetBytes(token: string, assetId: string, variant: string, e: string | undefined, s: string | undefined): Promise<Result<Buffer>> {
  const exp = Number(e);
  if (!idSchema.safeParse(assetId).success || !(assetVariants as readonly string[]).includes(variant) || !/^\d{1,12}$/.test(e ?? '') || !s) return notFound();
  const board = await boardByToken(token);
  if (!board || !verifyAssetSig(s, token, board.version, assetId, variant, exp)) return notFound();
  const { db, assets: a } = await dbm();
  const [row] = await db.select({ key: a.key }).from(a).where(eq(a.id, assetId));
  if (!row) return notFound();
  try {
    return ok(await getBytes(`${row.key}/${variant}.webp`));
  } catch {
    return notFound();
  }
}

// GET /v1/public/shared/:token: 60 per minute per IP, in memory (D-290; one process is enough at this scale).
const views = new Map<string, number[]>();
export function takeViewSlot(ip: string, now = Date.now()): boolean {
  const windowMs = 60_000;
  if (views.size > 10_000) for (const [k, v] of views) if (v.every((x) => now - x >= windowMs)) views.delete(k);
  const list = (views.get(ip) ?? []).filter((x) => now - x < windowMs);
  const allowed = list.length < SHARE_LIMITS.viewsPerMinute;
  if (allowed) list.push(now);
  views.set(ip, list);
  return allowed;
}
