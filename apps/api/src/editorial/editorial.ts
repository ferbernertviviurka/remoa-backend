import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { err, ok, parseWith, reviewDecisionSchema, resolveDisputeInputSchema, publishVersionInputSchema } from '@remoa/contracts';
import { assertQuota, limitFor, overTotal } from '../billing/quota';
import { dbm } from '../db';
import { sendEmail } from '../account/mailer';

async function reviewer(userId: string) {
  const { db, profiles } = await dbm();
  const [p] = await db.select().from(profiles).where(eq(profiles.userId, userId));
  if (!p || (p.role !== 'reviewer' && p.role !== 'admin')) return null;
  return p;
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
  }>(sql`
    select q.id, q.card_id, c.board_id, b.title as board_title, c.title, c.front, c.back, c.source, c.rubric,
      q.status, q.reviewer_id, q.note, q.flag_source, q.attempt_id, q.created_at
    from review_queue q
    join cards c on c.id = q.card_id
    join boards b on b.id = c.board_id
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
    })),
  });
}

export async function decideReview(userId: string, body: unknown) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const input = parseWith(reviewDecisionSchema, body);
  if (!input.ok) return input;
  const { db, reviewQueue, cards, boards } = await dbm();
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, input.data.reviewItemId));
  if (!item) return err('not_found', 'not found');
  const [card] = await db.select().from(cards).where(eq(cards.id, item.cardId));
  if (input.data.decision === 'approved' && who.role !== 'admin' && card) {
    const [board] = await db.select({ userId: boards.userId }).from(boards).where(eq(boards.id, card.boardId));
    const own = card.reviewerId === userId || board?.userId === userId;
    if (own) {
      const [others] = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from profiles where user_id <> ${userId} and role::text in ('reviewer', 'admin')
      `);
      if ((others?.n ?? 0) > 0) return err('forbidden', 'own card');
    }
  }
  await db.update(reviewQueue).set({ status: input.data.decision, reviewerId: userId, note: input.data.note, updatedAt: new Date() }).where(eq(reviewQueue.id, item.id));
  if (input.data.decision === 'approved' && card) {
    const edited = input.data.rubricPoints;
    const rubric = card.rubric && typeof card.rubric === 'object'
      ? { ...(card.rubric as object), ...(edited ? { points: edited } : {}), status: 'approved', reviewerId: userId, reviewerName: who.name, reviewerCrm: who.crm }
      : card.rubric;
    await db.update(cards).set({ status: 'approved', reviewerId: userId, rubric, updatedAt: new Date() }).where(eq(cards.id, card.id));
  }
  return ok({ id: item.id });
}

export async function setReviewerCrm(userId: string, crm: string) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const trimmed = crm.trim();
  if (trimmed.length > 20) return err('validation', 'crm');
  const { db, profiles } = await dbm();
  await db.update(profiles).set({ crm: trimmed || null, updatedAt: new Date() }).where(eq(profiles.userId, userId));
  return ok({ crm: trimmed || null });
}

export async function resolveDispute(userId: string, body: unknown) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const input = parseWith(resolveDisputeInputSchema, body);
  if (!input.ok) return input;
  const { db, reviewQueue, cards, attempts } = await dbm();
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, input.data.reviewItemId));
  if (!item) return err('not_found', 'not found');
  await db.update(reviewQueue).set({ status: 'approved', reviewerId: userId, note: input.data.note, updatedAt: new Date() }).where(eq(reviewQueue.id, item.id));
  if (input.data.outcome === 'rubric_adjusted') {
    const [card] = await db.select().from(cards).where(eq(cards.id, item.cardId));
    if (card?.rubric && typeof card.rubric === 'object') {
      const prev = card.rubric as { version?: number; points?: { text: string; essential: boolean }[]; source?: string };
      const points = input.data.rubricPoints ?? prev.points ?? [];
      await db.update(cards).set({
        rubric: { points, previousPoints: prev.points ?? [], source: prev.source ?? '', version: (prev.version ?? 1) + 1, status: 'draft', reviewerId: null },
        status: 'draft',
        updatedAt: new Date(),
      }).where(eq(cards.id, card.id));
      await db.insert(reviewQueue).values({ cardId: card.id, status: 'pending' });
    }
  }
  if (item.attemptId) {
    const [attempt] = await db.select().from(attempts).where(eq(attempts.id, item.attemptId));
    if (attempt) {
      const [owner] = await db.execute<{ email: string }>(sql`select email from auth.users where id = ${attempt.userId}`);
      if (owner?.email) await sendEmail({ to: owner.email, subject: 'Sua discordância foi revista', text: 'Um revisor registrou a decisão sobre a rubrica deste card.' });
    }
  }
  return ok({ outcome: input.data.outcome });
}

export async function publishBoard(userId: string, body: unknown) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const input = parseWith(publishVersionInputSchema, body);
  if (!input.ok) return input;
  const { db, boards, cards, edges, boardVersions } = await dbm();
  const [board] = await db.select().from(boards).where(eq(boards.id, input.data.boardId));
  if (!board) return err('not_found', 'not found');
  const draft = await db.select().from(cards).where(and(eq(cards.boardId, board.id), eq(cards.status, 'draft')));
  if (draft.length) return err('validation', 'cards still draft');
  const allCards = await db.select().from(cards).where(eq(cards.boardId, board.id));
  const allEdges = await db.select().from(edges).where(eq(edges.boardId, board.id));
  const next = board.version + 1;
  const [version] = await db.insert(boardVersions).values({
    boardId: board.id,
    version: next,
    changelog: `${input.data.temporalMark}: ${input.data.changelog}`,
    snapshot: { cards: allCards, edges: allEdges, temporalMark: input.data.temporalMark },
    reviewerId: userId,
    approvedAt: new Date(),
  }).returning();
  await db.update(boards).set({ status: 'seed_approved', version: next, temporalMark: input.data.temporalMark, reviewerId: userId, updatedAt: new Date() }).where(eq(boards.id, board.id));
  return ok(version);
}

export async function listDrafts(userId: string) {
  const who = await reviewer(userId);
  if (!who) return err('not_found', 'not found');
  const { db, boards } = await dbm();
  const rows = await db.select().from(boards).where(eq(boards.status, 'seed_draft'));
  return ok(rows.map((b) => ({ id: b.id, title: b.title })));
}

export async function listSeeds() {
  const { db, boards } = await dbm();
  const rows = await db.select().from(boards).where(eq(boards.status, 'seed_approved')).orderBy(asc(boards.title));
  return ok(rows.map((b) => ({ id: b.id, title: b.title, area: b.area, temporalMark: b.temporalMark })));
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
  const [source] = await db.select().from(boards).where(and(eq(boards.id, boardId), eq(boards.status, 'seed_approved')));
  if (!source) return err('not_found', 'not found');
  const srcCards = await db.select().from(cards).where(eq(cards.boardId, source.id));
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
    const rows = await db.select({ id: assets.id, license: assets.license }).from(assets).where(inArray(assets.id, assetIds));
    for (const row of rows) if (shareable(row.license)) allowed.add(row.id);
  }
  const keep = (id: string | null) => (id && allowed.has(id) ? id : null);
  const [copy] = await db.insert(boards).values({
    userId, title: source.title, area: source.area, status: 'private', sourceBoardId: source.id, temporalMark: source.temporalMark,
  }).returning();
  const map = new Map<string, string>();
  const maskRows: { id: string; cardId: string; assetId: string; polygon: unknown; label: string | null }[] = [];
  for (const card of srcCards) {
    const id = crypto.randomUUID();
    const image = copiedImage(card, id, allowed);
    maskRows.push(...image.rows);
    await db.insert(cards).values({
      id, boardId: copy!.id, type: card.type, shape: card.shape, title: card.title, front: card.front, back: card.back,
      frontAssetId: keep(card.frontAssetId), backAssetId: keep(card.backAssetId),
      width: card.width, height: card.height, tags: card.tags,
      payload: image.payload, rubric: card.rubric, source: card.source, x: card.x, y: card.y, status: 'approved', order: card.order,
    });
    map.set(card.id, id);
  }
  if (maskRows.length) await db.insert(masks).values(maskRows);
  const srcEdges = await db.select().from(edges).where(eq(edges.boardId, source.id));
  for (const edge of srcEdges) {
    const from = map.get(edge.fromCardId);
    const to = map.get(edge.toCardId);
    if (from && to) await db.insert(edges).values({ boardId: copy!.id, fromCardId: from, toCardId: to, label: edge.label, question: edge.question });
  }
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
