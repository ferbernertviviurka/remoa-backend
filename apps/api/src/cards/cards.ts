import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { pick } from '../pick';
import {
  type CardDetail, type CardPreview, type GetCard, type SaveCard,
  caseStages, err, idSchema, ok,
} from '@remoa/contracts';
import { Abort, guard, run, uuids } from '../db';
import { invalidate } from '../cache';

const isUuid = (v: string) => idSchema.safeParse(v).success;
/** D-201: `{w,h}` or null from the two nullable columns (the CHECK keeps them together). */
export const sizeOf = (r: { width: number | null; height: number | null }) => (r.width !== null && r.height !== null ? { w: r.width, h: r.height } : null);

/** D-201: every image a card references (front, back, image-card asset, flow steps, case stages). */
function assetIdsOf(input: { frontAssetId: string | null; backAssetId: string | null; type: string; payload: unknown }) {
  const p = input.payload as { assetId?: string; steps?: { assetId?: string }[]; caseSteps?: { assetId?: string }[] };
  const ids = [input.frontAssetId, input.backAssetId, p.assetId, ...(p.steps ?? []).map((x) => x.assetId), ...(p.caseSteps ?? []).map((x) => x.assetId)];
  return [...new Set(ids.filter((x): x is string => !!x))];
}

const notFound = () => err<never>('not_found', 'card not found');

/** What the map card shows without the payload. Tolerates empty/legacy payloads (cards born from map ops have `{}`). */
export function cardPreview(type: string, payload: unknown): CardPreview | undefined {
  const p = (payload ?? {}) as { steps?: unknown[]; caseSteps?: { stage: (typeof caseStages)[number] }[]; masks?: unknown[]; assetId?: string };
  switch (type) {
    case 'flow':
      return { steps: Array.isArray(p.steps) ? p.steps.length : 0 };
    case 'case':
      return { stages: Array.isArray(p.caseSteps) ? p.caseSteps.map((s) => s.stage) : [] };
    case 'image':
      return { masks: Array.isArray(p.masks) ? p.masks.length : 0, ...(p.assetId ? { assetId: p.assetId } : {}) };
    default:
      return undefined;
  }
}

type CardRow = Omit<typeof import('@remoa/db').cards.$inferSelect, 'sourceCardId' | 'createdAt' | 'deletedAt' | 'didactics' | 'sources' | 'pathOrder'>; // F31 fields: wired by T3/T4
// payload is returned as stored: an unedited card may still hold `{}` for its type.
const toDetail = (r: CardRow) => ({
  id: r.id, boardId: r.boardId, type: r.type, shape: r.shape, title: r.title, front: r.front, frontAssetId: r.frontAssetId, back: r.back, backAssetId: r.backAssetId, size: sizeOf(r), tags: r.tags, source: r.source,
  position: { x: r.x, y: r.y }, status: r.status, order: r.order, reviewerId: r.reviewerId, updatedAt: r.updatedAt,
  rubric: r.rubric, payload: r.payload, suspendedAt: r.suspendedAt, preview: cardPreview(r.type, r.payload),
} as unknown as CardDetail);

export const getCard: GetCard = async (userId, cardId) => {
  if (!isUuid(cardId)) return notFound();
  return run(userId, async (tx, s) => {
    const [r] = await tx.select(pick(s.cards, 'id', 'boardId', 'type', 'shape', 'title', 'front', 'frontAssetId', 'back', 'backAssetId', 'width', 'height', 'tags', 'source', 'sourceExcerpt', 'x', 'y', 'status', 'order', 'reviewerId', 'updatedAt', 'rubric', 'payload', 'suspendedAt')).from(s.cards).where(and(eq(s.cards.id, cardId), isNull(s.cards.deletedAt)));
    if (!r) return notFound();
    return ok(toDetail(r));
  });
};

export const saveCard: SaveCard = async (userId, cardId, input) => {
  if (!isUuid(cardId)) return notFound();
  const r = await guard(() =>
    run(userId, async (tx, s) => {
      // RLS on UPDATE silently matches 0 rows and cards are readable by non-owners (seeds): owner check is explicit.
      const [row] = await tx
        .select({ id: s.cards.id, boardId: s.cards.boardId })
        .from(s.cards)
        .innerJoin(s.boards, eq(s.boards.id, s.cards.boardId))
        .where(and(eq(s.cards.id, cardId), isNull(s.cards.deletedAt), eq(s.boards.userId, userId)));
      if (!row) throw new Abort({ code: 'not_found', message: 'card not found' });

      if (input.shape !== 'rect' && input.type !== 'concept') throw new Abort({ code: 'validation', message: 'shape other than rect is only for concept cards' });
      // D-200: a "Conteúdo" card has no back; any back/backAssetId sent is dropped (not an error: the editor may carry stale state when switching type).
      const note = input.type === 'note';
      const back = note ? null : input.back;
      const backAssetId = note ? null : input.backAssetId;
      const assetIds = assetIdsOf({ ...input, backAssetId });
      if (assetIds.length) {
        const found = await tx.select({ id: s.assets.id }).from(s.assets).where(sql`${s.assets.id} = any(${uuids(assetIds)})`);
        if (found.length !== assetIds.length) throw new Abort({ code: 'validation', message: 'an asset of this card is not one you can read' });
      }

      const maskRows: (typeof s.masks.$inferInsert)[] = [];
      if (input.type === 'image') {
        const { assetId, masks } = input.payload;
        // assetId is already in assetIdsOf(), so the batch read above proved it readable (was a second select)
        if (!masks.every((m) => isUuid(m.id))) throw new Abort({ code: 'validation', message: 'mask ids must be uuids' });
        for (const m of masks) maskRows.push({ id: m.id, cardId, assetId, polygon: m.polygon, label: m.label });
      }

      // G21 FR-21 (D-1036): `returning` replaces the old getCard (a second transaction); masks go in one statement
      const [saved] = await tx
        .update(s.cards)
        .set({ type: input.type, shape: input.shape, title: input.title, front: input.front, frontAssetId: input.frontAssetId, back, backAssetId, source: input.source, payload: input.payload, updatedAt: new Date() })
        .where(eq(s.cards.id, cardId))
        .returning();

      // mirror inline masks into `masks`: drop removed, upsert the rest
      const keep = maskRows.map((m) => m.id!);
      await tx.delete(s.masks).where(and(eq(s.masks.cardId, cardId), keep.length ? notInArray(s.masks.id, keep) : undefined));
      if (maskRows.length) {
        // A mask id owned by another card (only a crafted client) fails on the PK/RLS, or the guarded update skips it: 422, not 500. The batch rolls back.
        const done = await tx
          .insert(s.masks)
          .values(maskRows)
          .onConflictDoUpdate({
            target: s.masks.id,
            set: { assetId: sql`excluded.asset_id`, polygon: sql`excluded.polygon`, label: sql`excluded.label`, updatedAt: new Date() },
            setWhere: eq(s.masks.cardId, cardId),
          })
          .returning({ id: s.masks.id })
          .catch(() => []);
        if (done.length !== maskRows.length) throw new Abort({ code: 'validation', message: 'mask id already in use' });
      }
      await tx.update(s.boards).set({ updatedAt: new Date() }).where(eq(s.boards.id, row.boardId));
      return { boardId: row.boardId, card: toDetail(saved!) };
    }),
  );
  if (!r.ok) return r;
  await invalidate('card.changed', { userId, mapId: r.data.boardId }); // after COMMIT
  return ok(r.data.card);
};
