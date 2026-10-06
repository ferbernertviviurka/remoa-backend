import { and, asc, eq, sql } from 'drizzle-orm';
import { err, ok, parseWith, reviewDecisionSchema, resolveDisputeInputSchema, publishVersionInputSchema } from '@remoa/contracts';
import { pick } from '../pick';
import { assertQuota, limitFor, overTotal } from '../billing/quota';
import { dbm, uuids } from '../db';
import { firstNameOf } from '../notifications/names';
import { notify } from '../notifications/notify';
import { maybeQualifyReferral } from '../referral/qualify';
import { invalidate } from '../cache';

async function reviewer(userId: string) {
  const { db, profiles } = await dbm();
  const [p] = await db.select(pick(profiles, 'role', 'name', 'crm')).from(profiles).where(eq(profiles.userId, userId));
  if (!p || (p.role !== 'reviewer' && p.role !== 'admin')) return null;
  return p;
}

const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));

/** D-496: CRM = registration number (1–7 digits) + UF. Accepts "CRM-SP 123.456", "123456/sp"…; returns "123456-SP" or null. */
export function normalizeCrm(raw: string | null | undefined): string | null {
  const parts = (raw ?? '').toUpperCase().replace(/(\d)\.(?=\d)/g, '$1').replace(/CRM/g, ' ').split(/[^A-Z0-9]+/).filter(Boolean);
  const num = parts.filter((x) => /^\d{1,7}$/.test(x));
  const uf = parts.filter((x) => UFS.has(x));
  return parts.length === 2 && num.length === 1 && uf.length === 1 ? `${num[0]}-${uf[0]}` : null;
}

// Edition snapshot (publishBoard) stores every column of the live cards and edges, so these lists stay complete (FR-17 exception, D-1066).
const CARD_COLS = ['id', 'boardId', 'type', 'shape', 'title', 'front', 'frontAssetId', 'back', 'backAssetId', 'width', 'height', 'tags', 'payload', 'rubric', 'source', 'x', 'y', 'status', 'order', 'reviewerId', 'deletedAt', 'suspendedAt', 'sourceCardId', 'createdAt', 'updatedAt'] as const;
const EDGE_COLS = ['id', 'boardId', 'fromCardId', 'toCardId', 'label', 'question', 'createdAt', 'updatedAt'] as const;

type Signer = { userId: string; name: string; crm: string };

/**
 * Rule 6 (D-495): only the `reviewer` role writes an editorial decision, and only with a name and a valid CRM, both stamped on
 * the record. Students get 404 (the area does not exist for them), admins 403, a reviewer without CRM 422 so the screen asks for it.
 */
async function signer(userId: string) {
  const p = await reviewer(userId);
  if (!p) return err('not_found', 'not found');
  if (p.role !== 'reviewer') return err('forbidden', 'reviewer only');
  const crm = normalizeCrm(p.crm);
  const name = p.name?.trim();
  if (!crm || !name) return err('validation', 'reviewer_crm_required');
  return ok<Signer>({ userId, name, crm });
}

function pointsOf(rubric: unknown): { text: string; essential: boolean }[] {
  if (!rubric || typeof rubric !== 'object' || !('points' in rubric)) return [];
  const points = (rubric as { points?: unknown }).points;
  if (!Array.isArray(points)) return [];
  return points.flatMap((p) => {
    if (!p || typeof p !== 'object' || !('text' in p) || typeof (p as { text: unknown }).text !== 'string') return [];
    const text = (p as { text: string }).text.trim();
    if (!text) return [];
    return [{ text, essential: (p as { essential?: unknown }).essential === true }];
  });
}

function previousOf(rubric: unknown): { text: string; essential: boolean }[] {
  if (!rubric || typeof rubric !== 'object' || !('previousPoints' in rubric)) return [];
  return pointsOf({ points: (rubric as { previousPoints?: unknown }).previousPoints });
}

const verdictNames = ['correct', 'partial', 'incorrect'] as const;

/** The disputed attempt, when the queue row points at one. Rubric points stay on the card. */
function disputeOf(answer: string | null, raw: unknown) {
  const body = raw && typeof raw === 'object' ? raw as { verdict?: unknown; feedback?: unknown; criticalError?: unknown } : null;
  const name = body && verdictNames.find((v) => v === body.verdict);
  if (!answer && !name) return { answerText: null, verdict: null, feedback: null, criticalError: false };
  return {
    answerText: answer,
    verdict: name ?? null,
    feedback: body && typeof body.feedback === 'string' && body.feedback ? body.feedback : null,
    criticalError: body?.criticalError === true,
  };
}

export async function editorialQueue(userId: string, query: { boardId?: string; flag?: string } = {}) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const boardId = query.boardId && /^[0-9a-f-]{36}$/i.test(query.boardId) ? query.boardId : null;
  const flag = query.flag === 'ai' || query.flag === 'user_disagree' || query.flag === 'draft' ? query.flag : null;
  const filters = [sql`q.status = 'pending'`];
  if (boardId) filters.push(sql`c.board_id = ${boardId}::uuid`);
  if (flag === 'draft') filters.push(sql`q.flag_source is null`);
  else if (flag) filters.push(sql`q.flag_source = ${flag}::flag_source`);
  const where = sql.join(filters, sql` and `);
  const { db } = await dbm();
  const rows = await db.execute<{
    id: string; card_id: string; board_id: string; board_title: string; title: string; front: string | null; back: string | null;
    source: string | null; rubric: unknown; status: string; reviewer_id: string | null;
    note: string | null; flag_source: string | null; attempt_id: string | null; created_at: string;
    answer_text: string | null; attempt_verdict: unknown;
  }>(sql`
    select q.id, q.card_id, c.board_id, b.title as board_title, c.title, c.front, c.back, c.source, c.rubric,
      q.status, q.reviewer_id, q.note, q.flag_source, q.attempt_id, q.created_at,
      a.answer_text, a.verdict as attempt_verdict
    from review_queue q
    join cards c on c.id = q.card_id
    join boards b on b.id = c.board_id
    left join attempts a on a.id = q.attempt_id
    where ${where}
    order by q.created_at asc
    limit 40
  `);
  const [count] = await db.execute<{ n: number }>(sql`select count(*)::int as n from review_queue q join cards c on c.id = q.card_id where ${where}`);
  const boards = await db.execute<{ id: string; title: string }>(sql`
    select distinct b.id, b.title
    from review_queue q
    join cards c on c.id = q.card_id
    join boards b on b.id = c.board_id
    where q.status = 'pending'
    order by b.title
  `);
  return ok({
    total: count?.n ?? rows.length,
    reviewer: { name: who.name, crm: who.crm },
    boards: boards.map((b) => ({ id: b.id, title: b.title })),
    items: rows.map((r) => ({
      id: r.id, cardId: r.card_id, boardId: r.board_id, boardTitle: r.board_title, title: r.title,
      front: r.front, back: r.back, source: r.source, points: pointsOf(r.rubric), previousPoints: previousOf(r.rubric),
      status: r.status, reviewerId: r.reviewer_id,
      note: r.note, flagSource: r.flag_source, attemptId: r.attempt_id, createdAt: r.created_at,
      ...disputeOf(r.answer_text, r.attempt_verdict),
    })),
  });
}

/** Approval always leaves a rubric the inspector can read: name and CRM, even when the card had none. */
function stampedRubric(
  card: { title: string; back: string | null; source: string | null; rubric: unknown },
  who: Signer,
  userId: string,
  edited?: { text: string; essential: boolean }[],
) {
  const prev = card.rubric && typeof card.rubric === 'object' ? card.rubric as { source?: unknown; version?: unknown } : null;
  const kept = pointsOf(card.rubric);
  const points = edited?.length ? edited : kept.length ? kept : [{ text: (card.back?.trim() || card.title).trim() || card.title, essential: true }];
  const source = (typeof prev?.source === 'string' && prev.source.trim()) || card.source?.trim() || card.title;
  const version = typeof prev?.version === 'number' && prev.version > 0 ? prev.version : 1;
  return { ...(prev ?? {}), points, source, version, status: 'approved' as const, reviewerId: userId, reviewerName: who.name, reviewerCrm: who.crm };
}

export async function decideReview(userId: string, body: unknown) {
  const who = await signer(userId);
  if (!who.ok) return who;
  const input = parseWith(reviewDecisionSchema, body);
  if (!input.ok) return input;
  const { db, reviewQueue, cards, boards } = await dbm();
  const [item] = await db.select(pick(reviewQueue, 'id', 'cardId', 'status')).from(reviewQueue).where(eq(reviewQueue.id, input.data.reviewItemId));
  if (!item) return err('not_found', 'not found');
  if (item.status !== 'pending') return err('conflict', 'already decided');
  const [card] = await db.select(pick(cards, 'id', 'boardId', 'reviewerId', 'title', 'back', 'source', 'rubric')).from(cards).where(eq(cards.id, item.cardId));
  const [board] = card ? await db.select({ userId: boards.userId, status: boards.status }).from(boards).where(eq(boards.id, card.boardId)) : [];
  // Approval is for seed content only. A student's private card (a dispute row) is settled by /dispute, never stamped here.
  if (!card || !board || board.status === 'private') return err('conflict', 'not a seed card');
  if (input.data.decision === 'approved' && (card.reviewerId === userId || board.userId === userId)) {
    const [others] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from profiles where user_id <> ${userId} and role = 'reviewer'
    `);
    if ((others?.n ?? 0) > 0) return err('forbidden', 'own card');
  }
  const decided = await db.transaction(async (tx) => {
    const done = await tx.update(reviewQueue).set({ status: input.data.decision, reviewerId: userId, note: input.data.note, updatedAt: new Date() })
      .where(and(eq(reviewQueue.id, item.id), eq(reviewQueue.status, 'pending'))).returning({ id: reviewQueue.id });
    if (!done.length) return err('conflict', 'already decided'); // a concurrent decision won
    if (input.data.decision === 'approved') {
      const rubric = stampedRubric(card, who.data, userId, input.data.rubricPoints);
      await tx.update(cards).set({ status: 'approved', reviewerId: userId, rubric, updatedAt: new Date() }).where(eq(cards.id, card.id));
    }
    return ok({ id: item.id });
  });
  if (decided.ok && input.data.decision === 'approved') {
    await invalidate('catalog.changed', {}); // an approved seed card changes the ready-made maps
    await invalidate('card.changed', { userId: board.userId, mapId: card.boardId });
  }
  return decided;
}

export async function setReviewerCrm(userId: string, crm: string) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const normalized = crm.trim() ? normalizeCrm(crm) : null;
  if (crm.trim() && !normalized) return err('validation', 'crm');
  const { db, profiles } = await dbm();
  await db.update(profiles).set({ crm: normalized, updatedAt: new Date() }).where(eq(profiles.userId, userId));
  await invalidate('profile.changed', { userId });
  return ok({ crm: normalized });
}

/**
 * Which card a rubric adjustment may rewrite (D-497). The queue row points at the card the student studied:
 * - a seed card → that card;
 * - a copy of a seed → its seed card (`source_card_id`, D-531; same title as fallback), never the student's copy;
 * - any other private card → only when the disputing student owns it (their own rubric, at their request).
 */
async function adjustTarget(cardId: string, attemptId: string | null) {
  const { db } = await dbm();
  const [row] = await db.execute<{ id: string; status: string; owner: string; source_board_id: string | null; source_card_id: string | null; title: string; disputer: string | null }>(sql`
    select c.id, b.status::text as status, b.user_id as owner, b.source_board_id, c.source_card_id, c.title,
      (select a.user_id from attempts a where a.id = ${attemptId}) as disputer
    from cards c join boards b on b.id = c.board_id where c.id = ${cardId}`);
  if (!row) return null;
  if (row.status !== 'private') return row.id;
  if (row.source_board_id) {
    const [seed] = await db.execute<{ id: string }>(sql`
      select c.id from cards c join boards b on b.id = c.board_id
      where c.board_id = ${row.source_board_id} and b.status <> 'private' and c.deleted_at is null
        and (c.id = ${row.source_card_id} or (${row.source_card_id}::uuid is null and c.title = ${row.title}))
      order by c.created_at limit 1`);
    if (seed) return seed.id;
  }
  return row.disputer && row.disputer === row.owner ? row.id : null;
}

export async function resolveDispute(userId: string, body: unknown) {
  const who = await signer(userId);
  if (!who.ok) return who;
  const input = parseWith(resolveDisputeInputSchema, body);
  if (!input.ok) return input;
  const { db, reviewQueue, cards, attempts } = await dbm();
  const [item] = await db.select(pick(reviewQueue, 'id', 'cardId', 'status', 'flagSource', 'attemptId')).from(reviewQueue).where(eq(reviewQueue.id, input.data.reviewItemId));
  if (!item || item.flagSource !== 'user_disagree') return err('not_found', 'not found');
  if (item.status !== 'pending') return err('conflict', 'already resolved');
  const targetId = input.data.outcome === 'rubric_adjusted' ? await adjustTarget(item.cardId, item.attemptId) : null;
  if (input.data.outcome === 'rubric_adjusted' && !targetId) return err('conflict', 'dispute target');
  const resolved = await db.transaction(async (tx) => {
    const done = await tx.update(reviewQueue).set({ status: 'approved', reviewerId: userId, note: input.data.note, updatedAt: new Date() })
      .where(and(eq(reviewQueue.id, item.id), eq(reviewQueue.status, 'pending'))).returning({ id: reviewQueue.id });
    if (!done.length) return false;
    if (!targetId) return true;
    const [card] = await tx.select(pick(cards, 'id', 'rubric', 'title', 'back', 'source')).from(cards).where(eq(cards.id, targetId)).for('update');
    if (!card) return true;
    const prev = card.rubric && typeof card.rubric === 'object' ? card.rubric as { version?: number; source?: string } : null;
    const previousPoints = pointsOf(card.rubric);
    const drafted = input.data.rubricPoints?.length ? input.data.rubricPoints : previousPoints;
    const points = drafted.length ? drafted : [{ text: (card.back?.trim() || card.title).trim() || card.title, essential: true }];
    const source = prev?.source?.trim() || card.source?.trim() || card.title;
    await tx.update(cards).set({
      rubric: { points, previousPoints, source, version: (prev?.version ?? 0) + 1, status: 'draft', reviewerId: null },
      status: 'draft',
      updatedAt: new Date(),
    }).where(eq(cards.id, card.id));
    await tx.insert(reviewQueue).values({ cardId: card.id, status: 'pending' });
    return true;
  });
  if (!resolved) return err('conflict', 'already resolved');
  if (targetId) await invalidate('catalog.changed', {}); // a rubric adjusted on a seed card
  if (item.attemptId) {
    const [attempt] = await db.select({ userId: attempts.userId }).from(attempts).where(eq(attempts.id, item.attemptId));
    if (attempt) {
      if (targetId) await invalidate('card.changed', { userId: attempt.userId }); // the reopened card goes back to draft
      await notify(attempt.userId, 'dispute_resolved', { reference: item.id, email: { name: await firstNameOf(attempt.userId) } });
    }
  }
  return ok({ outcome: input.data.outcome });
}

export async function publishBoard(userId: string, body: unknown) {
  const who = await signer(userId);
  if (!who.ok) return who;
  const input = parseWith(publishVersionInputSchema, body);
  if (!input.ok) return input;
  const { db, boards, cards, edges, boardVersions } = await dbm();
  const published = await db.transaction(async (tx) => {
    // D-498: only seed boards publish (seed_draft → first edition, seed_approved → next edition). A student's private board is 404.
    const [board] = await tx.select(pick(boards, 'id', 'version')).from(boards).where(and(eq(boards.id, input.data.boardId), sql`${boards.status} <> 'private'`, sql`${boards.archivedAt} is null`)).for('update');
    if (!board) return err('not_found', 'not found');
    const allCards = await tx.select(pick(cards, ...CARD_COLS)).from(cards).where(and(eq(cards.boardId, board.id), sql`${cards.deletedAt} is null`));
    if (allCards.some((c) => c.status !== 'approved')) return err('validation', 'cards still draft');
    const allEdges = await tx.select(pick(edges, ...EDGE_COLS)).from(edges).where(eq(edges.boardId, board.id));
    const next = board.version + 1;
    const [version] = await tx.insert(boardVersions).values({
      boardId: board.id,
      version: next,
      changelog: `${input.data.temporalMark}: ${input.data.changelog}`,
      snapshot: { cards: allCards, edges: allEdges, temporalMark: input.data.temporalMark, reviewerName: who.data.name, reviewerCrm: who.data.crm },
      reviewerId: userId,
      approvedAt: new Date(),
    }).returning();
    await tx.update(boards).set({ status: 'seed_approved', version: next, temporalMark: input.data.temporalMark, reviewerId: userId, updatedAt: new Date() }).where(eq(boards.id, board.id));
    return ok(version!);
  });
  if (published.ok) await invalidate('catalog.changed', {}); // a new edition of a seed map
  return published;
}

export async function listDrafts(userId: string) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const { db, boards } = await dbm();
  const rows = await db.select(pick(boards, 'id', 'title')).from(boards).where(eq(boards.status, 'seed_draft'));
  return ok(rows.map((b) => ({ id: b.id, title: b.title })));
}

export async function listSeeds() {
  const { db, boards } = await dbm();
  const rows = await db.select(pick(boards, 'id', 'title', 'area', 'temporalMark')).from(boards).where(and(eq(boards.status, 'seed_approved'), sql`${boards.archivedAt} is null`)).orderBy(asc(boards.area), asc(boards.title));
  // Rule 6 provenance: who signed the latest published edition (snapshot written by publishBoard).
  const ids = rows.map((b) => b.id);
  const signed = ids.length
    ? await db.execute<{ board_id: string; reviewer_name: string | null; reviewer_crm: string | null; approved_at: string | null }>(sql`
        select distinct on (board_id) board_id, snapshot->>'reviewerName' as reviewer_name, snapshot->>'reviewerCrm' as reviewer_crm, approved_at
        from board_versions where board_id = any(${uuids(ids)}) order by board_id, version desc`)
    : [];
  const by = new Map([...signed].map((r) => [r.board_id, r]));
  return ok(rows.map((b) => {
    const v = by.get(b.id);
    return { id: b.id, title: b.title, area: b.area, temporalMark: b.temporalMark, reviewerName: v?.reviewer_name ?? null, reviewerCrm: v?.reviewer_crm ?? null, approvedAt: v?.approved_at ? new Date(v.approved_at) : null };
  }));
}

/** Personal uploads stay with the author. Redistributable licenses travel with the copy. */
function shareable(license: string) {
  return license === 'cc_by' || license === 'servier' || license === 'openstax';
}

function copiedImage(card: { type: string; payload: unknown }, cardId: string, allowed: Set<string>) {
  const p = (card.payload ?? {}) as { assetId?: string; masks?: { polygon: unknown; label?: string | null }[] };
  if (card.type !== 'image') return { payload: card.payload, rows: [] as { id: string; cardId: string; assetId: string; polygon: unknown; label: string | null }[] };
  const assetId = p.assetId && allowed.has(p.assetId) ? p.assetId : null;
  if (!assetId || !Array.isArray(p.masks)) return { payload: { ...p, assetId: undefined, masks: [] }, rows: [] };
  const masks = p.masks.map((m) => ({ ...m, id: crypto.randomUUID() }));
  return {
    payload: { ...p, assetId, masks },
    rows: masks.map((m) => ({ id: m.id, cardId, assetId, polygon: m.polygon, label: m.label ?? null })),
  };
}

export async function copySeed(userId: string, boardId: string) {
  const { db, boards, cards, edges, masks, assets } = await dbm();
  const [source] = await db.select(pick(boards, 'id', 'title', 'area', 'temporalMark')).from(boards).where(and(eq(boards.id, boardId), eq(boards.status, 'seed_approved'), sql`${boards.archivedAt} is null`));
  if (!source) return err('not_found', 'not found');
  const srcCards = await db.select(pick(cards, 'id', 'type', 'shape', 'title', 'front', 'back', 'frontAssetId', 'backAssetId', 'width', 'height', 'tags', 'payload', 'rubric', 'source', 'x', 'y', 'status', 'order')).from(cards).where(and(eq(cards.boardId, source.id), sql`${cards.deletedAt} is null`));
  const boardQuota = await assertQuota(userId, 'boards');
  if (!boardQuota.ok) return boardQuota;
  const cardLimit = await limitFor(userId, 'cards');
  if (await overTotal(db, userId, 'cards', cardLimit, srcCards.length)) return err('quota_exceeded', 'cards');
  const assetIds = [...new Set(srcCards.flatMap((c) => {
    const p = c.payload as { assetId?: string } | null;
    return [p?.assetId, c.frontAssetId, c.backAssetId].filter((id): id is string => !!id);
  }))];
  const allowed = new Set<string>();
  if (assetIds.length) {
    const rows = await db.select({ id: assets.id, license: assets.license }).from(assets).where(sql`${assets.id} = any(${uuids(assetIds)})`);
    for (const row of rows) if (shareable(row.license)) allowed.add(row.id);
  }
  const keep = (id: string | null) => (id && allowed.has(id) ? id : null);
  const [copy] = await db.insert(boards).values({
    userId, title: source.title, area: source.area, status: 'private', sourceBoardId: source.id, temporalMark: source.temporalMark,
  }).returning();
  const map = new Map<string, string>();
  const maskRows: { id: string; cardId: string; assetId: string; polygon: unknown; label: string | null }[] = [];
  // G21 FR-21 (D-1036): one batched insert of cards (was one per card)
  const cardRows = srcCards.map((card) => {
    const id = crypto.randomUUID();
    const image = copiedImage(card, id, allowed);
    maskRows.push(...image.rows);
    map.set(card.id, id);
    return {
      id, boardId: copy!.id, type: card.type, shape: card.shape, title: card.title, front: card.front, back: card.back,
      frontAssetId: keep(card.frontAssetId), backAssetId: keep(card.backAssetId),
      width: card.width, height: card.height, tags: card.tags,
      payload: image.payload, rubric: card.rubric, source: card.source, x: card.x, y: card.y, status: card.status, order: card.order, sourceCardId: card.id, // a card reopened by a dispute travels as draft (rule 6)
    };
  });
  if (cardRows.length) await db.insert(cards).values(cardRows);
  if (maskRows.length) await db.insert(masks).values(maskRows);
  const srcEdges = await db.select(pick(edges, 'fromCardId', 'toCardId', 'label', 'question')).from(edges).where(eq(edges.boardId, source.id));
  const edgeRows = srcEdges.flatMap((edge) => {
    const from = map.get(edge.fromCardId);
    const to = map.get(edge.toCardId);
    return from && to ? [{ boardId: copy!.id, fromCardId: from, toCardId: to, label: edge.label, question: edge.question }] : [];
  });
  if (edgeRows.length) await db.insert(edges).values(edgeRows);
  await invalidate('map.changed', { userId, mapId: copy!.id });
  await maybeQualifyReferral(userId); // F18 (D-485): a copied seed can be the first map; never throws
  return ok({ id: copy!.id });
}

export async function graderAgreement(userId: string) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const { db } = await dbm();
  const [row] = await db.execute<{ submitted: number; overridden: number }>(sql`
    select count(*)::int as submitted, count(*) filter (where grade_overridden)::int as overridden
    from attempts
    where verdict is not null
  `);
  const submitted = row?.submitted ?? 0;
  const overridden = row?.overridden ?? 0;
  return ok({ submitted, overridden, agreement: submitted ? 1 - overridden / submitted : null });
}
