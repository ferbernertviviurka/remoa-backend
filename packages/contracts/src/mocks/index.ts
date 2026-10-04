// In-memory implementations of every signature in ../api. State is module-level; call resetMocks() between tests.
import { err, ok, parseWith } from '../errors';
import type { Board, Edge } from '../board';
import { MAX_CARDS_PER_BOARD, PREVIEW_MAX_NODES, boardMatrixItemIds, createBoardInputSchema, mapOpSchema, normalizeBoardTitle } from '../board';
import { SHARE_LIMITS, sharedBoardSchema, updateShareInputSchema, type ShareState } from '../share';
import { cardDetailSchema, cardSchema, saveCardInputSchema, type Card, type CardDetail } from '../card';
import { challengeItemPublicSchema, type ChallengeItem } from '../challenge';
import type { Grade } from '../enums';
import { PLAN_LIMITS, type Entitlements } from '../billing';
import type { ReviewItem } from '../editorial';
import { startImportInputSchema, type ApkgSummary, type ImportReport } from '../import';
import { onboardingAnswersSchema, waitlistEntrySchema } from '../onboarding';
import type * as Api from '../api';
import { FIXTURE_NOW, MOCK_APP_URL, fid, mockShareToken, retrievabilityFixture, reviewQueueFixture, sepseBoard, sepseCards, sepseEdges } from './fixtures';
import * as review from './review';
import * as ai from './ai';

export * from './fixtures';
export * from './review';
export * from './ai';
export * from './account';
export * from './billing';
export * from './referral';
export * from './support';
export * from './admin';

// --- store -------------------------------------------------------------------
const clone = <T>(v: T): T => structuredClone(v);
let boards: Board[] = [];
let cards: CardDetail[] = [];
let edges: Edge[] = [];
let seenOps = new Set<string>();
let sessions = new Map<string, { items: ChallengeItem[]; grades: Map<string, Grade>; skips: number }>();
let usage: Entitlements['usage'] = { ai_grades: 0, ai_generations: 0, boards: 0, cards: 0 };
let reviewItems: ReviewItem[] = [];
/** F17: server-only share state, keyed by board id (the real columns never reach the client). */
type ShareRow = { token: string | null; password: string | null; version: number; copies: number };
let shares = new Map<string, ShareRow>();
let unlockFails = new Map<string, number>();
let seq = 0;
const nextId = () => fid(10_000 + seq++);

export function resetMocks() {
  boards = [clone(sepseBoard)];
  cards = clone(sepseCards);
  edges = clone(sepseEdges);
  seenOps = new Set();
  sessions = new Map();
  usage = { ai_grades: 0, ai_generations: 0, boards: 0, cards: 0 };
  reviewItems = [
    {
      id: fid(500),
      cardId: sepseCards[0]!.id,
      boardId: sepseBoard.id,
      status: 'pending',
      reviewerId: null,
      note: null,
      flagSource: null,
      attemptId: null,
      createdAt: FIXTURE_NOW,
    },
  ];
  shares = new Map();
  unlockFails = new Map();
  seq = 0;
  review.resetReviewMocks();
  ai.resetAiMocks();
}
resetMocks();

const toCard = (c: CardDetail): Card => cardSchema.parse(c); // strips payload + rubric
const findBoard = (id: string) => boards.find((b) => b.id === id);

// --- F01 board ---------------------------------------------------------------
/** G01 list extras: state counts from the retrievability fixture, graph preview normalised to 0..1. */
function boardOverview(boardId: string) {
  const own = cards.filter((c) => c.boardId === boardId).slice(0, PREVIEW_MAX_NODES);
  const stateCounts = { review: 0, watch: 0, steady: 0, unknown: 0 };
  const states = own.map((c) => retrievabilityFixture[c.id]?.state ?? 'unknown');
  for (const st of states) stateCounts[st]++;
  const xs = own.map((c) => c.position?.x ?? 0);
  const ys = own.map((c) => c.position?.y ?? 0);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const span = Math.max(1, Math.max(...xs) - minX, Math.max(...ys) - minY);
  const index = new Map(own.map((c, i) => [c.id, i]));
  return {
    stateCounts,
    preview: {
      nodes: own.map((c, i) => ({ x: (xs[i]! - minX) / span, y: (ys[i]! - minY) / span, state: states[i]! })),
      edges: edges
        .filter((e) => e.boardId === boardId && index.has(e.fromCardId) && index.has(e.toCardId))
        .map((e) => [index.get(e.fromCardId)!, index.get(e.toCardId)!] as [number, number]),
    },
  };
}

export const listBoards: Api.ListBoards = async (userId) =>
  ok(
    boards
      .filter((b) => b.userId === userId && !b.archivedAt)
      .map((b) => ({
        id: b.id,
        title: b.title,
        area: b.area,
        status: b.status,
        updatedAt: b.updatedAt,
        matrixItemId: b.matrixItemId,
        access: b.access,
        cardCount: cards.filter((c) => c.boardId === b.id).length,
        edgeCount: edges.filter((e) => e.boardId === b.id).length,
        dueCount: review.reviewQueueDueCount(b.id),
        ...boardOverview(b.id),
      })),
  );

export const getBoard: Api.GetBoard = async (userId, boardId) => {
  const board = findBoard(boardId);
  if (!board || board.userId !== userId) return err('not_found', 'board not found');
  return ok({
    board,
    cards: cards.filter((c) => c.boardId === boardId).map(toCard),
    edges: edges.filter((e) => e.boardId === boardId),
  });
};

export const createBoard: Api.CreateBoard = async (userId, raw) => {
  const parsed = parseWith(createBoardInputSchema, raw);
  if (!parsed.ok) return parsed;
  const { title, area, access, password } = parsed.data;
  const id = nextId();
  const share = access === 'owner' ? null : setShareMock(id, access, password);
  const board: Board = {
    ...clone(sepseBoard),
    id,
    userId,
    title,
    area,
    matrixItemId: boardMatrixItemIds(parsed.data)[0] ?? null,
    access,
    shareUrl: share?.url ?? null,
    status: 'private',
    temporalMark: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  boards.push(board);
  return ok(board);
};

export const updateBoard: Api.UpdateBoard = async (userId, boardId, { title, archived }) => {
  const board = findBoard(boardId);
  if (!board || board.userId !== userId) return err('not_found', 'board not found');
  if (title !== undefined) board.title = title;
  if (archived !== undefined) board.archivedAt = archived ? new Date() : null;
  board.updatedAt = new Date();
  return ok(clone(board));
};

function copyGraph(fromId: string, toId: string, keep: { tags: boolean }) {
  const ids = new Map<string, string>();
  for (const c of cards.filter((x) => x.boardId === fromId)) {
    ids.set(c.id, nextId());
    cards.push({ ...clone(c), id: ids.get(c.id)!, boardId: toId, tags: keep.tags ? c.tags : [] });
  }
  for (const e of edges.filter((x) => x.boardId === fromId))
    edges.push({ ...e, id: nextId(), boardId: toId, fromCardId: ids.get(e.fromCardId)!, toCardId: ids.get(e.toCardId)! });
}

export const duplicateBoard: Api.DuplicateBoard = async (userId, boardId, title) => {
  const src = findBoard(boardId);
  if (!src || src.userId !== userId) return err('not_found', 'board not found');
  const created = await createBoard(userId, { title, area: src.area });
  if (!created.ok) return created;
  copyGraph(boardId, created.data.id, { tags: true });
  return created;
};

export const applyMapOps: Api.ApplyMapOps = async (_userId, rawOps) => {
  const applied: string[] = [];
  for (const raw of rawOps) {
    const parsed = parseWith(mapOpSchema, raw);
    if (!parsed.ok) return parsed;
    const o = parsed.data;
    if (!findBoard(o.boardId)) return err('not_found', 'board not found');
    if (!seenOps.has(o.opId)) {
      seenOps.add(o.opId);
      if (o.op === 'moveCards')
        for (const m of o.moves) {
          const c = cards.find((x) => x.id === m.cardId);
          if (c) c.position = m.position;
        }
      if (o.op === 'resizeCards')
        for (const r of o.sizes) {
          const c = cards.find((x) => x.id === r.cardId && x.boardId === o.boardId);
          if (c) c.size = r.size;
        }
      if (o.op === 'createCard') {
        if (cards.filter((c) => c.boardId === o.boardId).length >= MAX_CARDS_PER_BOARD) return err('validation', 'board card limit');
        cards.push({
          ...clone(sepseCards[0]!),
          ...o.card,
          type: 'concept',
          boardId: o.boardId,
          front: null,
          back: null,
          source: null,
          rubric: null,
          payload: {},
        });
      }
      if (o.op === 'createEdge') edges.push({ ...o.edge, boardId: o.boardId, question: null });
      if (o.op === 'updateEdgeLabel') {
        const e = edges.find((x) => x.id === o.edgeId);
        if (e) e.label = o.label;
      }
      if (o.op === 'deleteCards') {
        const ids = new Set(o.cardIds);
        cards = cards.filter((c) => !ids.has(c.id));
        edges = edges.filter((e) => !ids.has(e.fromCardId) && !ids.has(e.toCardId));
      }
      if (o.op === 'deleteEdges') edges = edges.filter((e) => !o.edgeIds.includes(e.id));
    }
    applied.push(o.opId);
  }
  return ok({ applied });
};

// --- F02 cards ---------------------------------------------------------------
export const getCard: Api.GetCard = async (_userId, cardId) => {
  const card = cards.find((c) => c.id === cardId);
  return card ? ok(card) : err('not_found', 'card not found');
};

export const saveCard: Api.SaveCard = async (_userId, cardId, input) => {
  const parsed = parseWith(saveCardInputSchema, input);
  if (!parsed.ok) return parsed;
  const current = cards.find((c) => c.id === cardId);
  if (!current) return err('not_found', 'card not found');
  const saved = cardDetailSchema.parse({ ...current, ...parsed.data, updatedAt: new Date() });
  cards = cards.map((c) => (c.id === cardId ? saved : c));
  return ok(saved);
};

/** Test helper: the editorial flow (F10) is the only real way to approve a card. */
export function setCardStatusMock(cardId: string, status: CardDetail['status']) {
  const c = cards.find((x) => x.id === cardId);
  if (c) c.status = status;
}

export const getAsset: Api.GetAsset = async (userId, assetId) =>
  ok({ id: assetId, key: `${userId}/${assetId}`, mime: 'image/webp', width: 1600, height: 1200, license: 'own', attribution: null,
    urls: { w800: `https://r2.mock.local/${assetId}-800.webp`, w1600: `https://r2.mock.local/${assetId}-1600.webp` } });

export const signUpload: Api.SignUpload = async (userId, { mime }) => {
  const key = `${userId}/${nextId()}.${mime.split('/')[1]}`;
  return ok({ url: `https://r2.mock.local/upload/${key}`, key });
};

export const completeUpload: Api.CompleteUpload = async (_userId, { key, license = 'own', attribution = null }) =>
  ok({ id: nextId(), key: key.replace(/\.\w+$/, '.webp'), mime: 'image/webp', width: 1600, height: 1200, license, attribution });

// --- F04 challenge -----------------------------------------------------------
function buildItem(q: (typeof reviewQueueFixture)[number], i: number): ChallengeItem | null {
  const card = cards.find((c) => c.id === q.cardId);
  if (!card) return null;
  const base = {
    id: `item-${i}`,
    cardId: card.id,
    boardId: card.boardId,
    cardTitle: card.title,
    subId: q.subId ?? null,
    mode: q.mode ?? 'hidden_card',
    context: { neighbors: [] },
    grading: card.rubric ? ('rubric_own' as const) : ('none' as const),
  };
  if (card.type === 'flow') {
    const steps = card.payload.steps;
    const idx = Math.max(0, steps.findIndex((s) => s.id === q.subId));
    const answer = steps[idx]!.text;
    const distractors = steps.filter((_, j) => j !== idx).map((s) => s.text).slice(0, 3);
    const options = distractors.length === 3 ? [...distractors.slice(0, i % 4), answer, ...distractors.slice(i % 4)] : undefined;
    return { ...base, prompt: `${card.title}: qual é o passo ${idx + 1}?`, options, canonical: answer };
  }
  if (card.type === 'case')
    return { ...base, prompt: card.payload.caseSteps[0]!.text, canonical: card.payload.caseSteps.map((s) => s.text).join(' ') };
  return { ...base, prompt: card.front ?? card.title, canonical: card.back ?? card.title };
}

export const startSession: Api.StartSession = async () => {
  const items = reviewQueueFixture.map(buildItem).filter((x): x is ChallengeItem => x !== null);
  const sessionId = nextId();
  sessions.set(sessionId, { items, grades: new Map(), skips: 0 });
  return ok({ sessionId, items: items.map((x) => challengeItemPublicSchema.parse(x)) });
};

const findItem = (sessionId: string, itemId: string) => {
  const s = sessions.get(sessionId);
  const item = s?.items.find((x) => x.id === itemId);
  return s && item ? { s, item } : null;
};

export const answer: Api.Answer = async (userId, input) => {
  const found = findItem(input.sessionId, input.itemId);
  if (!found) return err('not_found', 'item not found');
  const { item } = found;
  const preview = review.preview(null, new Date());
  if (input.inputKind === 'self')
    return ok({ canonical: item.canonical, verdict: null, suggestedGrade: null, gradeLocked: false, fallback: null, preview });
  if (input.inputKind === 'mcq') {
    const right = item.options?.[input.optionIndex] === item.canonical;
    return ok({ canonical: item.canonical, verdict: null, suggestedGrade: right ? 'good' : 'again', gradeLocked: false, fallback: null, preview });
  }
  const card = cards.find((c) => c.id === item.cardId);
  if (!card?.rubric) return ok({ canonical: item.canonical, verdict: null, suggestedGrade: null, gradeLocked: false, fallback: 'no_rubric', preview });
  const quota = await assertQuota(userId, 'ai_grades');
  if (!quota.ok) return quota;
  usage.ai_grades++;
  const graded = await ai.grade({ prompt: item.prompt, canonical: item.canonical, rubric: card.rubric, neighbors: [], answer: input.text });
  if (!graded.ok) return graded;
  const v = graded.data;
  return ok({
    canonical: item.canonical,
    verdict: v,
    suggestedGrade: review.verdictToGrade(v, { durationMs: input.durationMs, medianMs: null }),
    gradeLocked: v.criticalError,
    fallback: null,
    preview,
  });
};

export const rate: Api.Rate = async (_userId, { sessionId, itemId, grade }) => {
  const found = findItem(sessionId, itemId);
  if (!found) return err('not_found', 'item not found');
  found.s.grades.set(itemId, grade);
  return ok({ due: review.schedule(null, grade, new Date()).due });
};

export const dispute: Api.Dispute = async (_userId, { sessionId, itemId }) => {
  const found = findItem(sessionId, itemId);
  if (!found) return err('not_found', 'item not found');
  const item: ReviewItem = {
    id: nextId(),
    cardId: found.item.cardId,
    boardId: sepseBoard.id,
    status: 'pending',
    reviewerId: null,
    note: null,
    flagSource: 'user_disagree',
    attemptId: null,
    createdAt: new Date(),
  };
  reviewItems.push(item);
  return ok({ reviewItemId: item.id });
};

export const skip: Api.Skip = async (_userId, { sessionId, itemId }) => {
  const found = findItem(sessionId, itemId);
  if (!found) return err('not_found', 'item not found');
  if (found.s.skips >= 2) return err('conflict', 'skip limit reached');
  found.s.skips++;
  found.s.items = [...found.s.items.filter((x) => x !== found.item), found.item];
  return ok({ remaining: found.s.items.length - found.s.grades.size });
};

export const finishSession: Api.FinishSession = async (_userId, sessionId) => {
  const s = sessions.get(sessionId);
  if (!s) return err('not_found', 'session not found');
  const wrong = [...s.grades].filter(([, g]) => g === 'again');
  return ok({
    sessionId,
    correct: s.grades.size - wrong.length,
    wrong: wrong.length,
    toReview: wrong.map(([id]) => s.items.find((x) => x.id === id)!.cardId),
    nextDue: s.grades.size ? review.schedule(null, 'again', new Date()).due : null,
    durationMs: 0,
  });
};

// --- F06 anki ----------------------------------------------------------------
export const apkgSummaryFixture: ApkgSummary = {
  decks: [{ id: '1', name: 'Clínica Médica::Sepse', cardCount: 2, noteCount: 2 }],
  noteTypes: [
    {
      id: '10', name: 'Basic', kind: 'basic', fields: ['Front', 'Back'], noteCount: 2,
      samples: [{ Front: 'Critério de sepse', Back: 'Disfunção orgânica com SOFA ≥ 2' }, { Front: 'Choque séptico', Back: 'Sepse com vasopressor e lactato > 2' }],
    },
  ],
  cardCount: 2,
  mediaCount: 0,
};
export const importReportFixture: ImportReport = {
  importId: fid(700),
  boardIds: [sepseBoard.id],
  imported: 2,
  skippedDuplicate: 0,
  skippedEmpty: 0,
  missingMedia: 0,
  durationMs: 1200,
};

export const inspect: Api.Inspect = async (file) =>
  file.byteLength === 0 ? err('validation', 'empty file') : ok(apkgSummaryFixture);

export const planImport: Api.PlanImport = (summary, mappings, deckIds) => {
  const decks = summary.decks.filter((d) => deckIds.includes(d.id));
  if (decks.length === 0) return err('validation', 'no deck selected');
  return ok({ deckIds, mappings, estimatedCards: decks.reduce((n, d) => n + d.noteCount, 0) });
};

export const toDrafts: Api.ToDrafts = async () =>
  ok(
    sepseCards.slice(0, 2).map((c, i) => ({
      ref: `anki-${i}`,
      type: 'concept' as const,
      title: c.title,
      front: c.front,
      back: c.back,
      source: 'Anki · Clínica Médica › Sepse',
      payload: {},
      deckId: '1',
      deckName: 'Clínica Médica::Sepse',
      media: [],
      backMedia: null,
      tags: ['Sepse'],
      empty: false,
    })),
  );

export const signImportUpload: Api.SignImportUpload = async (userId) =>
  ok({ url: 'https://r2.mock.local/put', key: `imports/${userId}/${fid(701)}.apkg` });
export const inspectImport: Api.InspectImport = async (_userId, { key }) =>
  key.endsWith('.apkg') ? ok(apkgSummaryFixture) : err('validation', 'not an .apkg upload');
export const startImport: Api.StartImport = async (_userId, input) => {
  const parsed = parseWith(startImportInputSchema, input);
  return parsed.ok ? ok({ importId: fid(700) }) : parsed;
};
export const findExistingBoard: Api.FindExistingBoard = async (userId, title) => {
  const b = boards.find((x) => x.userId === userId && !x.archivedAt && normalizeBoardTitle(x.title) === normalizeBoardTitle(title));
  return ok({ board: b ? { id: b.id, title: b.title } : null });
};

// --- F17 sharing ---------------------------------------------------------------
const shareUrlOf = (token: string) => `${MOCK_APP_URL}/m/${token}`;
const grantOf = (boardId: string, version: number) => `mock-grant:${boardId}:${version}`;
const notActive = () => err<never>('not_found', 'link not active');

/** Enters or stays in a link access; a new token on first share or `rotate`. Bumps the version (old grants stop working). */
function setShareMock(boardId: string, access: 'password' | 'public', password?: string, rotate = false) {
  const cur = shares.get(boardId);
  const row: ShareRow = {
    token: cur?.token && !rotate ? cur.token : mockShareToken(1000 + seq++),
    password: access === 'password' ? (password ?? cur?.password ?? null) : null,
    version: (cur?.version ?? 0) + 1,
    copies: cur?.copies ?? 0,
  };
  shares.set(boardId, row);
  return { url: shareUrlOf(row.token!) };
}
const ownBoard = (userId: string, boardId: string) => {
  const b = findBoard(boardId);
  return b && b.userId === userId ? b : null;
};
const shareStateOf = (b: Board): ShareState => {
  const r = shares.get(b.id);
  return { access: b.access, url: b.access !== 'owner' && r?.token ? shareUrlOf(r.token) : null, copies: r?.copies ?? 0 };
};
const byToken = (token: string) => {
  for (const [id, r] of shares) {
    const b = findBoard(id);
    if (r.token === token && b && !b.archivedAt && b.access !== 'owner') return { b, r };
  }
  return null;
};

export const getShare: Api.GetShare = async (userId, boardId) => {
  const b = ownBoard(userId, boardId);
  return b ? ok(shareStateOf(b)) : err('not_found', 'board not found');
};

export const updateShare: Api.UpdateShare = async (userId, boardId, input) => {
  const parsed = parseWith(updateShareInputSchema, input);
  if (!parsed.ok) return parsed;
  const b = ownBoard(userId, boardId);
  if (!b) return err('not_found', 'board not found');
  const { access, password, rotate } = parsed.data;
  if (access === 'password' && password === undefined && b.access !== 'password') return err('validation', 'password: required for access=password');
  if (access === 'owner') {
    const r = shares.get(b.id);
    if (r) shares.set(b.id, { ...r, token: null, password: null, version: r.version + 1 });
    b.shareUrl = null;
  } else b.shareUrl = setShareMock(b.id, access, password, rotate).url;
  b.access = access;
  b.updatedAt = new Date();
  return ok(shareStateOf(b));
};

export const getSharedBoard: Api.GetSharedBoard = async (token, { grant, viewerId }) => {
  const hit = byToken(token);
  if (!hit) return notActive();
  const { b, r } = hit;
  const isOwner = viewerId === b.userId;
  if (b.access === 'password' && !isOwner && grant !== grantOf(b.id, r.version)) return ok({ locked: true });
  const own = cards.filter((c) => c.boardId === b.id);
  const assetIds = [...new Set(own.flatMap((c) => [c.frontAssetId, c.backAssetId, c.type === 'image' ? c.payload.assetId : null]))].filter((x): x is string => !!x);
  const assets = Object.fromEntries(
    assetIds.map((id) => [id, { width: 1600, height: 1200, attribution: null, urls: { w800: `https://r2.mock.local/${id}-800.webp`, w1600: `https://r2.mock.local/${id}-1600.webp` } }]),
  );
  return ok(
    sharedBoardSchema.parse({
      locked: false, access: b.access, title: b.title, area: b.area, matrixItems: [], cards: own, edges: edges.filter((e) => e.boardId === b.id),
      assets, cardCount: own.length, updatedAt: b.updatedAt, ownBoardId: isOwner ? b.id : null,
    }),
  );
};

export const unlockShared: Api.UnlockShared = async (token, { password }, { ip }) => {
  const hit = byToken(token);
  if (!hit || hit.b.access !== 'password') return notActive();
  const key = `${token}|${ip}`;
  const fails = unlockFails.get(key) ?? 0;
  if (fails >= SHARE_LIMITS.unlockAttempts) return err('rate_limited', 'too many attempts');
  if (password !== hit.r.password) {
    unlockFails.set(key, fails + 1);
    return err('unauthorized', 'wrong password');
  }
  unlockFails.delete(key);
  return ok({ value: grantOf(hit.b.id, hit.r.version), expiresAt: new Date(Date.now() + SHARE_LIMITS.accessTtlSeconds * 1000) });
};

/** `forbidden` = private board without a valid grant. Own board = plain duplicate. */
export const copySharedBoard: Api.CopySharedBoard = async (userId, { token }, { grant }) => {
  const view = await getSharedBoard(token, { grant, viewerId: userId });
  if (!view.ok) return view;
  if (view.data.locked) return err('forbidden', 'unlock first');
  const { b, r } = byToken(token)!;
  if (b.userId === userId) return duplicateBoard(userId, b.id, `${b.title} (cópia)`);
  const q = await assertQuota(userId, 'boards');
  if (!q.ok) return q;
  const created = await createBoard(userId, { title: b.title, area: b.area, matrixItemId: b.matrixItemId });
  if (!created.ok) return created;
  const copy = findBoard(created.data.id)!;
  copy.sourceBoardId = b.id;
  copy.copiedFrom = { at: new Date() };
  copyGraph(b.id, copy.id, { tags: false });
  r.copies++;
  return ok(clone(copy));
};

export const getImportProgress: Api.GetImportProgress = async (_userId, importId) =>
  ok({ importId, status: 'done', processed: 2, total: 2, error: null });

export const getImportReport: Api.GetImportReport = async (_userId, importId) => ok({ ...importReportFixture, importId });

// --- F07 matrix --------------------------------------------------------------
export const getCoverage: Api.GetCoverage = async () =>
  ok([
    {
      matrixItemId: fid(800),
      area: 'CM',
      code: 'CM-INF-01',
      title: 'Sepse e choque séptico',
      boards: 1,
      cards: cards.filter((c) => c.boardId === sepseBoard.id).length,
      targetCards: 40,
      coverage: Math.min(100, (cards.filter((c) => c.boardId === sepseBoard.id).length / 40) * 100),
      avgRetrievability: 0.6,
    },
  ]);

export const listMatrixItems: Api.ListMatrixItems = async (area) =>
  ok(
    area === 'CM'
      ? [
          { id: fid(800), area: 'CM', code: 'CM-INF-01', title: 'Sepse e choque séptico', parentId: null, targetCards: 40 },
          { id: fid(801), area: 'CM', code: 'CM-CAR-01', title: 'Insuficiência cardíaca', parentId: null, targetCards: 40 },
          { id: fid(802), area: 'CM', code: 'CM-PNE-01', title: 'Pneumonia', parentId: null, targetCards: 30 },
          { id: fid(803), area: 'CM', code: 'CM-END-01', title: 'Cetoacidose diabética', parentId: null, targetCards: 30 },
        ]
      : [],
  );

export const suggestMatrixItems: Api.SuggestMatrixItems = async (title) => {
  const r = await listMatrixItems('CM');
  const all = r.ok ? r.data : [];
  const q = title.trim().toLowerCase();
  return ok(q ? all.filter((i) => i.title.toLowerCase().split(/\s+/).some((w) => w.length > 3 && q.includes(w.slice(0, 4)))).slice(0, 3) : []);
};

export const linkBoardMatrix: Api.LinkBoardMatrix = async (_userId, link) => ok(link);
export const unlinkBoardMatrix: Api.UnlinkBoardMatrix = async () => ok(null);

// --- G01 v2 home -------------------------------------------------------------
export const getHomeSummary: Api.GetHomeSummary = async (_userId, now) => {
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const monday = -((now.getUTCDay() + 6) % 7);
  const done = [5, 7, 6, 3, 0, 0, 0];
  const planned = [0, 0, 0, 12, 14, 6, 9];
  return ok({
    reviewedToday: 3,
    dueToday: 12,
    week: done.map((d, i) => ({ date: day(monday + i), done: monday + i < 0 ? d : monday + i === 0 ? 3 : 0, planned: monday + i > 0 ? planned[i]! : 0 })),
    streakDays: 4,
    upcoming: [12, 14, 6, 9].map((count, i) => ({ date: day(i), count })),
  });
};

// --- F08 billing -------------------------------------------------------------
const FREE_LIMITS: Entitlements['limits'] = PLAN_LIMITS.free.limits;

export const getEntitlements: Api.GetEntitlements = async () =>
  ok({ plan: 'free', status: null, ...PLAN_LIMITS.free, limits: FREE_LIMITS, usage: { ...usage }, renewsAt: null, cancelAtPeriodEnd: false, graceUntil: null });

export const assertQuota: Api.AssertQuota = async (_userId, key) => {
  const limit = FREE_LIMITS[key];
  return limit !== null && usage[key] >= limit ? err('quota_exceeded', `quota ${key} exceeded`) : ok(null);
};

/** Test helper: set usage for a quota key. */
export const setUsage = (key: keyof Entitlements['usage'], value: number) => {
  usage[key] = value;
};

export const createCheckout: Api.CreateCheckout = async (_userId, { period, method }) =>
  ok({ url: `https://checkout.stripe.mock/${period}/${method}` });
export const openPortal: Api.OpenPortal = async () => ok({ url: 'https://billing.stripe.mock/portal' });
export const exportAccount: Api.ExportAccount = async (userId) =>
  ok({ version: 1, exportedAt: new Date(), userId, profile: null, boards: [], cards: [], edges: [], attempts: [], tickets: [] });
export const deleteAccount: Api.DeleteAccount = async () => ok({ hardDeleteAt: new Date(Date.now() + 7 * 86_400_000) });

// --- F10 editorial -----------------------------------------------------------
export const listReviewQueue: Api.ListReviewQueue = async () => ok([...reviewItems]);

const decide = (id: string, patch: Partial<ReviewItem>) => {
  const item = reviewItems.find((r) => r.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  return item;
};

export const decideReviewItem: Api.DecideReviewItem = async (reviewerId, { reviewItemId, decision, note }) => {
  const item = decide(reviewItemId, { status: decision, reviewerId, note });
  if (!item) return err('not_found', 'review item not found');
  const card = cards.find((c) => c.id === item.cardId);
  if (card && decision === 'approved') Object.assign(card, { status: 'approved', reviewerId });
  return ok(item);
};

export const resolveDispute: Api.ResolveDispute = async (reviewerId, { reviewItemId, note }) => {
  const item = decide(reviewItemId, { status: 'approved', reviewerId, note });
  return item ? ok(item) : err('not_found', 'review item not found');
};

export const publishVersion: Api.PublishVersion = async (reviewerId, { boardId, changelog, temporalMark }) => {
  const board = findBoard(boardId);
  if (!board) return err('not_found', 'board not found');
  const boardCards = cards.filter((c) => c.boardId === boardId);
  if (boardCards.some((c) => c.status !== 'approved')) return err('conflict', 'all cards must be approved');
  board.status = 'seed_approved';
  board.version += 1;
  return ok({
    id: nextId(),
    boardId,
    version: board.version,
    changelog,
    temporalMark,
    snapshot: { cards: clone(boardCards), edges: clone(edges.filter((e) => e.boardId === boardId)) },
    reviewerId,
    approvedAt: new Date(),
  });
};

export const copySeedBoard: Api.CopySeedBoard = async (userId, seedBoardId) => {
  const seed = findBoard(seedBoardId);
  if (!seed) return err('not_found', 'board not found');
  const boardId = nextId();
  boards.push({ ...clone(seed), id: boardId, userId, status: 'private', sourceBoardId: seed.id });
  return ok({ boardId });
};

// --- F11 reports -------------------------------------------------------------
export const getProgress: Api.GetProgress = async () =>
  ok({
    retention7d: 0.72,
    retention30d: 0.68,
    reviewsPerDay: Array.from({ length: 30 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 8, 2 + i)).toISOString().slice(0, 10);
      const count = date === '2026-09-30' ? 18 : date === '2026-10-01' ? 7 : 0;
      return { date, count };
    }),
    streakDays: 2,
    weakCards: [{ cardId: sepseCards[4]!.id, boardId: sepseBoard.id, title: sepseCards[4]!.title, r: 0.55 }],
    accuracy: [{ area: 'CM', matrixItemId: null, attempts: 25, correct: 18, accuracy: 0.72 }],
  });

// --- F12 onboarding ----------------------------------------------------------
export const joinWaitlist: Api.JoinWaitlist = async (entry) => {
  const parsed = parseWith(waitlistEntrySchema, entry);
  return parsed.ok ? ok(null) : parsed;
};
export const saveOnboarding: Api.SaveOnboarding = async (_userId, answers) => {
  const parsed = parseWith(onboardingAnswersSchema, answers);
  return parsed.ok ? ok(null) : parsed;
};

export const mocks = {
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  duplicateBoard,
  applyMapOps,
  getCard,
  saveCard,
  getAsset,
  signUpload,
  completeUpload,
  schedule: review.schedule,
  preview: review.preview,
  retrievability: review.retrievability,
  mapState: review.mapState,
  verdictToGrade: review.verdictToGrade,
  recordAttempt: review.recordAttempt,
  getDailyQueue: review.getDailyQueue,
  getBoardQueue: review.getBoardQueue,
  getRetrievability: review.getRetrievability,
  startSession,
  answer,
  rate,
  dispute,
  skip,
  finishSession,
  grade: ai.grade,
  generateRubric: ai.generateRubric,
  generateBoard: ai.generateBoard,
  getGenerationProgress: ai.getGenerationProgress,
  inspect,
  planImport,
  signImportUpload,
  inspectImport,
  startImport,
  toDrafts,
  getImportProgress,
  getImportReport,
  findExistingBoard,
  getShare,
  updateShare,
  getSharedBoard,
  unlockShared,
  copySharedBoard,
  getCoverage,
  getEntitlements,
  assertQuota,
  createCheckout,
  openPortal,
  exportAccount,
  deleteAccount,
  listReviewQueue,
  decideReviewItem,
  resolveDispute,
  publishVersion,
  copySeedBoard,
  getProgress,
  joinWaitlist,
  saveOnboarding,
} satisfies {
  listBoards: Api.ListBoards;
  getBoard: Api.GetBoard;
  createBoard: Api.CreateBoard;
  updateBoard: Api.UpdateBoard;
  duplicateBoard: Api.DuplicateBoard;
  applyMapOps: Api.ApplyMapOps;
  getCard: Api.GetCard;
  saveCard: Api.SaveCard;
  getAsset: Api.GetAsset;
  signUpload: Api.SignUpload;
  completeUpload: Api.CompleteUpload;
  schedule: Api.Schedule;
  preview: Api.Preview;
  retrievability: Api.Retrievability;
  mapState: Api.MapStateOf;
  verdictToGrade: Api.VerdictToGrade;
  recordAttempt: Api.RecordAttempt;
  getDailyQueue: Api.GetDailyQueue;
  getBoardQueue: Api.GetBoardQueue;
  getRetrievability: Api.GetRetrievability;
  startSession: Api.StartSession;
  answer: Api.Answer;
  rate: Api.Rate;
  dispute: Api.Dispute;
  skip: Api.Skip;
  finishSession: Api.FinishSession;
  grade: Api.GradeAnswer;
  generateRubric: Api.GenerateRubric;
  generateBoard: Api.GenerateBoard;
  getGenerationProgress: Api.GetGenerationProgress;
  inspect: Api.Inspect;
  planImport: Api.PlanImport;
  signImportUpload: Api.SignImportUpload;
  inspectImport: Api.InspectImport;
  startImport: Api.StartImport;
  toDrafts: Api.ToDrafts;
  getImportProgress: Api.GetImportProgress;
  getImportReport: Api.GetImportReport;
  findExistingBoard: Api.FindExistingBoard;
  getShare: Api.GetShare;
  updateShare: Api.UpdateShare;
  getSharedBoard: Api.GetSharedBoard;
  unlockShared: Api.UnlockShared;
  copySharedBoard: Api.CopySharedBoard;
  getCoverage: Api.GetCoverage;
  getEntitlements: Api.GetEntitlements;
  assertQuota: Api.AssertQuota;
  createCheckout: Api.CreateCheckout;
  openPortal: Api.OpenPortal;
  exportAccount: Api.ExportAccount;
  deleteAccount: Api.DeleteAccount;
  listReviewQueue: Api.ListReviewQueue;
  decideReviewItem: Api.DecideReviewItem;
  resolveDispute: Api.ResolveDispute;
  publishVersion: Api.PublishVersion;
  copySeedBoard: Api.CopySeedBoard;
  getProgress: Api.GetProgress;
  joinWaitlist: Api.JoinWaitlist;
  saveOnboarding: Api.SaveOnboarding;
};

