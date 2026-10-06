// F17 T4: "Copiar para os meus mapas". The original is read by the server connection (it belongs to someone else);
// the copy is written through withUser, so RLS applies to every row the copier gets.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { err, ok, type CopySharedBoard } from '@remoa/contracts';
import { Abort, dbm, guard, run } from '../db';
import { assertQuota, limitFor, overTotal } from '../billing/quota';
import { copyObject, deletePrefix } from '../storage/storage';
import { resolveShared, cardAssetIds } from '../public/shared';
import { cloneBoardContent, duplicateBoard, toBoard } from './boards';
import { maybeQualifyReferral } from '../referral/qualify';
import { invalidate } from '../cache';

const log = createLogger({ requestId: 'boards-copy' });
const VARIANTS = ['w800', 'w1600'] as const;

export const copySharedBoard: CopySharedBoard = async (userId, input, { grant }) => {
  const r = await resolveShared(input.token, { grant, viewerId: userId });
  if (r.status === 'missing') return err('not_found', 'not found');
  if (r.status === 'locked') return err('forbidden', 'share access required');
  const src = r.board;
  if (r.isOwner) return duplicateBoard(userId, src.id, src.title); // FR: copying your own board is a plain duplicate

  const q = await assertQuota(userId, 'boards');
  if (!q.ok) return q;
  const cardLimit = await limitFor(userId, 'cards');
  const { db, boards: b, cards: c, edges: e, assets: a, boardMatrixItems: bm } = await dbm();
  const [meta] = await db.select({ matrixItemId: b.matrixItemId }).from(b).where(eq(b.id, src.id));
  const cards = await db.select().from(c).where(and(eq(c.boardId, src.id), isNull(c.deletedAt))).orderBy(asc(c.order), asc(c.createdAt));
  if (await overTotal(db, userId, 'cards', cardLimit, cards.length)) return err('quota_exceeded', 'cards'); // before any object is copied
  const edges = await db.select({ fromCardId: e.fromCardId, toCardId: e.toCardId, label: e.label, question: e.question }).from(e).where(eq(e.boardId, src.id));
  const items = await db.select({ matrixItemId: bm.matrixItemId }).from(bm).where(eq(bm.boardId, src.id)).orderBy(asc(bm.createdAt));

  // LGPD: the copy owns independent objects, so deleting the original or the owner's account does not break it.
  const srcAssetIds = [...new Set(cards.flatMap(cardAssetIds))];
  const srcAssets = srcAssetIds.length
    ? await db.select({ id: a.id, key: a.key, mime: a.mime, width: a.width, height: a.height, license: a.license, attribution: a.attribution }).from(a).where(inArray(a.id, srcAssetIds))
    : [];
  const newId = new Map(srcAssets.map((x) => [x.id, crypto.randomUUID()]));
  const keyOf = (id: string) => `assets/${userId}/${id}`;
  const cleanup = () => Promise.all([...newId.values()].map((id) => deletePrefix(`${keyOf(id)}/`).catch(() => 0)));
  // allSettled, not all: cleanup must run after every in-flight copy has landed, or late ones are left orphaned
  const copied = await Promise.allSettled(srcAssets.flatMap((x) => VARIANTS.map((v) => copyObject(`${x.key}/${v}.webp`, `${keyOf(newId.get(x.id)!)}/${v}.webp`))));
  const failed = copied.find((x): x is PromiseRejectedResult => x.status === 'rejected');
  if (failed) {
    await cleanup();
    log.error('copy: storage failed', { error: failed.reason instanceof Error ? failed.reason.name : 'unknown' });
    return err('internal', 'could not copy images');
  }
  const remap = (id: string | null | undefined) => (id ? (newId.get(id) ?? null) : null);

  const res = await guard(() =>
    run(userId, async (tx, s) => {
      // re-checked inside the tx: the pre-checks above ran before the (slow) storage copy
      if (await overTotal(tx, userId, 'boards', await limitFor(userId, 'boards'))) throw new Abort({ code: 'quota_exceeded', message: 'boards' });
      if (await overTotal(tx, userId, 'cards', cardLimit, cards.length)) throw new Abort({ code: 'quota_exceeded', message: 'cards' });
      if (srcAssets.length)
        await tx.insert(s.assets).values(srcAssets.map((x) => ({ id: newId.get(x.id)!, userId, key: keyOf(newId.get(x.id)!), mime: x.mime, width: x.width, height: x.height, license: x.license, attribution: x.attribution })));
      const firstItem = items[0]?.matrixItemId ?? meta?.matrixItemId ?? null;
      const [copy] = await tx
        .insert(s.boards)
        .values({ userId, title: src.title, area: src.area, matrixItemId: firstItem, sourceBoardId: src.id, copiedFromLinkAt: new Date() })
        .returning();
      if (items.length) await tx.insert(s.boardMatrixItems).values(items.map((i) => ({ boardId: copy!.id, matrixItemId: i.matrixItemId })));
      await cloneBoardContent(tx, s, copy!.id, cards, edges, {
        // student content, not Remoa's: no approval travels with it (rule 6); tags are personal
        status: () => 'draft',
        tags: () => [],
        override: (card) => ({
          frontAssetId: remap(card.frontAssetId), backAssetId: remap(card.backAssetId), payload: remapPayload(card.payload, remap),
          rubric: card.rubric && typeof card.rubric === 'object' ? { ...card.rubric, status: 'draft', reviewerId: null } : card.rubric,
        }),
      });
      return copy!;
    }),
  ).catch(async (cause: unknown) => {
    await cleanup();
    throw cause;
  });
  if (!res.ok) {
    await cleanup();
    return res;
  }
  await invalidate('map.changed', { userId, mapId: res.data.id });
  await db.update(b).set({ copyCount: sql`${b.copyCount} + 1` }).where(eq(b.id, src.id));
  await maybeQualifyReferral(userId); // F18 (D-384); never throws
  return ok(toBoard(res.data));
};

/**
 * Asset ids inside the payload point at the copier's new assets. An image card whose asset is gone keeps the dangling
 * id (renders as missing) without masks, since masks.asset_id must reference an existing asset.
 */
function remapPayload(payload: unknown, remap: (id: string | null | undefined) => string | null): unknown {
  const p = (payload ?? {}) as { assetId?: string; masks?: unknown[]; steps?: { assetId?: string }[]; caseSteps?: { assetId?: string }[] };
  const one = <T extends { assetId?: string }>(x: T): T => {
    if (!x?.assetId) return x;
    return { ...x, assetId: remap(x.assetId) ?? undefined }; // undefined is dropped when stored as jsonb
  };
  return {
    ...p,
    ...(p.assetId ? (remap(p.assetId) ? { assetId: remap(p.assetId) } : { masks: [] }) : {}),
    ...(Array.isArray(p.steps) ? { steps: p.steps.map(one) } : {}),
    ...(Array.isArray(p.caseSteps) ? { caseSteps: p.caseSteps.map(one) } : {}),
  };
}
