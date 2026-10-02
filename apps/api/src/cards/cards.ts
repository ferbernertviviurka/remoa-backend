import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import {
  type CardDetail, type CardPreview, type GetCard, type SaveCard,
  caseStages, err, idSchema, ok,
} from '@remoa/contracts';
import { Abort, guard, run } from '../db';

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

export const getCard: GetCard = async (userId, cardId) => {
  if (!isUuid(cardId)) return notFound();
  return run(userId, async (tx, s) => {
    const [r] = await tx.select().from(s.cards).where(and(eq(s.cards.id, cardId), isNull(s.cards.deletedAt)));
    if (!r) return notFound();
    // payload is returned as stored: an unedited card may still hold `{}` for its type.
    return ok({
      id: r.id, boardId: r.boardId, type: r.type, shape: r.shape, title: r.title, front: r.front, frontAssetId: r.frontAssetId, back: r.back, backAssetId: r.backAssetId, size: sizeOf(r), tags: r.tags, source: r.source,
      position: { x: r.x, y: r.y }, status: r.status, order: r.order, reviewerId: r.reviewerId, updatedAt: r.updatedAt,
      rubric: r.rubric, payload: r.payload, preview: cardPreview(r.type, r.payload),
    } as unknown as CardDetail);
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
        const found = await tx.select({ id: s.assets.id }).from(s.assets).where(inArray(s.assets.id, assetIds));
        if (found.length !== assetIds.length) throw new Abort({ code: 'validation', message: 'an asset of this card is not one you can read' });
      }

      const maskRows: (typeof s.masks.$inferInsert)[] = [];
      if (input.type === 'image') {
        const { assetId, masks } = input.payload;
        const [asset] = await tx.select({ id: s.assets.id }).from(s.assets).where(eq(s.assets.id, assetId));
        if (!asset) throw new Abort({ code: 'validation', message: 'assetId is not an asset you can read' });
        if (!masks.every((m) => isUuid(m.id))) throw new Abort({ code: 'validation', message: 'mask ids must be uuids' });
        for (const m of masks) maskRows.push({ id: m.id, cardId, assetId, polygon: m.polygon, label: m.label });
      }

      await tx
        .update(s.cards)
        .set({ type: input.type, shape: input.shape, title: input.title, front: input.front, frontAssetId: input.frontAssetId, back, backAssetId, source: input.source, payload: input.payload, updatedAt: new Date() })
        .where(eq(s.cards.id, cardId));

      // mirror inline masks into `masks`: drop removed, upsert the rest
      const keep = maskRows.map((m) => m.id!);
      await tx.delete(s.masks).where(and(eq(s.masks.cardId, cardId), keep.length ? notInArray(s.masks.id, keep) : undefined));
      for (const m of maskRows) {
        // A mask id owned by another card (only a crafted client) fails on the PK/RLS: 422, not 500. The batch rolls back.
        const saved = await tx
          .insert(s.masks)
          .values(m)
          .onConflictDoUpdate({
            target: s.masks.id,
            set: { assetId: m.assetId, polygon: m.polygon, label: m.label, updatedAt: new Date() },
            setWhere: eq(s.masks.cardId, cardId),
          })
          .returning({ id: s.masks.id })
          .catch(() => []);
        if (!saved.length) throw new Abort({ code: 'validation', message: 'mask id already in use' });
      }
      await tx.update(s.boards).set({ updatedAt: new Date() }).where(eq(s.boards.id, row.boardId));
      return null;
    }),
  );
  return r.ok ? getCard(userId, cardId) : r;
};
