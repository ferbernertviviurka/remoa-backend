// In-memory implementations of every signature in ../api. State is module-level; call resetMocks() between tests.
import { err, ok, parseWith } from '../errors';
import type { Board, Edge } from '../board';
import { MAX_CARDS_PER_BOARD, mapOpSchema } from '../board';
import { cardDetailSchema, cardSchema, saveCardInputSchema, type Card, type CardDetail } from '../card';
import { challengeItemPublicSchema, type ChallengeItem } from '../challenge';
import type { Grade } from '../enums';
import type { Entitlements } from '../billing';
import type { ReviewItem } from '../editorial';
import type { ApkgSummary, ImportReport } from '../import';
import { onboardingAnswersSchema, waitlistEntrySchema } from '../onboarding';
import type * as Api from '../api';
import { FIXTURE_NOW, fid, reviewQueueFixture, sepseBoard, sepseCards, sepseEdges } from './fixtures';
import * as review from './review';
import * as ai from './ai';

export * from './fixtures';
export * from './review';
export * from './ai';

// --- store -------------------------------------------------------------------
const clone = <T>(v: T): T => structuredClone(v);
let boards: Board[] = [];
let cards: CardDetail[] = [];
let edges: Edge[] = [];
let seenOps = new Set<string>();
let sessions = new Map<string, { items: ChallengeItem[]; grades: Map<string, Grade>; skips: number }>();
let usage: Entitlements['usage'] = { ai_grades: 0, ai_generations: 0, boards: 0, cards: 0 };
let reviewItems: ReviewItem[] = [];
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
  seq = 0;
  review.resetReviewMocks();
  ai.resetAiMocks();
}
resetMocks();

const toCard = (c: CardDetail): Card => cardSchema.parse(c); // strips payload + rubric
const findBoard = (id: string) => boards.find((b) => b.id === id);

// --- F01 board ---------------------------------------------------------------
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
        cardCount: cards.filter((c) => c.boardId === b.id).length,
        edgeCount: edges.filter((e) => e.boardId === b.id).length,
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

export const createBoard: Api.CreateBoard = async (userId, { title, area = 'CM' }) => {
  const board: Board = {
    ...clone(sepseBoard),
    id: nextId(),
    userId,
    title,
    area,
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

export const duplicateBoard: Api.DuplicateBoard = async (userId, boardId, title) => {
  const src = findBoard(boardId);
  if (!src || src.userId !== userId) return err('not_found', 'board not found');
  const created = await createBoard(userId, { title, area: src.area });
  if (!created.ok) return created;
  const ids = new Map<string, string>();
  for (const c of cards.filter((x) => x.boardId === boardId)) {
    ids.set(c.id, nextId());
    cards.push({ ...clone(c), id: ids.get(c.id)!, boardId: created.data.id });
  }
  for (const e of edges.filter((x) => x.boardId === boardId))
    edges.push({ ...e, id: nextId(), boardId: created.data.id, fromCardId: ids.get(e.fromCardId)!, toCardId: ids.get(e.toCardId)! });
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
  const base = { id: `item-${i}`, cardId: card.id, subId: q.subId ?? null, mode: q.mode ?? 'hidden_card' };
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
    return ok({ canonical: item.canonical, verdict: null, suggestedGrade: null, gradeLocked: false, preview });
  if (input.inputKind === 'mcq') {
    const right = item.options?.[input.optionIndex] === item.canonical;
    return ok({ canonical: item.canonical, verdict: null, suggestedGrade: right ? 'good' : 'again', gradeLocked: false, preview });
  }
  const card = cards.find((c) => c.id === item.cardId);
  if (!card?.rubric) return ok({ canonical: item.canonical, verdict: null, suggestedGrade: null, gradeLocked: false, preview });
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
  decks: [{ id: '1', name: 'Clínica Médica::Sepse', cardCount: 2 }],
  noteTypes: [{ id: '10', name: 'Basic', kind: 'basic', fields: ['Front', 'Back'], noteCount: 2 }],
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
  return ok({ deckIds, mappings, estimatedCards: decks.reduce((n, d) => n + d.cardCount, 0) });
};

export const toDrafts: Api.ToDrafts = async () =>
  ok(
    sepseCards.slice(0, 2).map((c, i) => ({
      ref: `anki-${i}`,
      type: 'concept' as const,
      title: c.title,
      front: c.front,
      back: c.back,
      source: 'Anki',
      payload: {},
    })),
  );

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

// --- F08 billing -------------------------------------------------------------
const FREE_LIMITS: Entitlements['limits'] = { ai_grades: 20, ai_generations: 1, boards: 3, cards: 300 };

export const getEntitlements: Api.GetEntitlements = async () =>
  ok({ plan: 'free', status: null, limits: FREE_LIMITS, usage: { ...usage }, newCardsPerDay: 10, ankiImportMaxCards: 5000, renewsAt: null });

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
export const exportAccount: Api.ExportAccount = async (userId) => ok({ url: `https://r2.mock.local/exports/${userId}.json` });
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
    reviewsPerDay: [{ date: '2026-09-30', count: 18 }, { date: '2026-10-01', count: 7 }],
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
  toDrafts,
  getImportProgress,
  getImportReport,
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
  toDrafts: Api.ToDrafts;
  getImportProgress: Api.GetImportProgress;
  getImportReport: Api.GetImportReport;
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

