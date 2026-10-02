import { beforeEach, describe, expect, it } from 'vitest';
import {
  boardGraphSchema,
  boardMatrixItemIds,
  boardSchema,
  coverageRowSchema,
  createBoardInputSchema,
  eventSchemas,
  importBoardInputSchema,
  normalizeBoardTitle,
  shareStateSchema,
  sharedBoardResponseSchema,
  sharedLockedSchema,
  startImportInputSchema,
  updateShareInputSchema,
  type SharedBoardResponse,
  entitlementsSchema,
  intervalPreviewSchema,
  progressSummarySchema,
  sessionSummarySchema,
  startSessionOutputSchema,
  type FsrsMemory,
  type Result,
} from '../index';
import {
  FIXTURE_NOW as now,
  apkgSummaryFixture,
  fid,
  fixtureUserId as user,
  mocks as m,
  resetMocks,
  sepseBoardId,
  sepseCardIds,
  sepseCards,
  sepseRubric,
  setCardStatusMock,
  setUsage,
  shareStateFixture,
  sharedBoardFixture,
  sharedLockedFixture,
  sharedSepseBoard,
  startImportInputFixture,
} from './index';

const data = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
};
const code = (r: Result<unknown>) => (r.ok ? null : r.error.code);
const DAY = 86_400_000;

beforeEach(resetMocks);

describe('fsrs mocks', () => {
  const mem = (over: Partial<FsrsMemory> = {}): FsrsMemory => ({
    stability: 10, difficulty: 5, due: new Date(now.getTime() + DAY), reps: 3, lapses: 0, lastReview: now, state: 'review', learningSteps: 0, scheduledDays: 1, ...over,
  });

  it('retrievability follows the forgetting curve', () => {
    expect(m.retrievability(null, now)).toBe(0);
    expect(m.retrievability(mem(), now)).toBe(1);
    expect(m.retrievability(mem({ stability: 1 }), new Date(now.getTime() + DAY))).toBeCloseTo(0.9, 2);
  });

  it('mapState thresholds (FR-5)', () => {
    expect(m.mapState(null, now)).toBe('unknown');
    expect(m.mapState(mem({ reps: 0 }), now)).toBe('unknown');
    expect(m.mapState(mem({ due: now }), now)).toBe('review');
    expect(m.mapState(mem(), now)).toBe('steady');
    const later = (days: number) => new Date(now.getTime() + days * DAY);
    expect(m.mapState(mem({ stability: 1, due: later(30) }), later(4))).toBe('watch'); // r ≈ 0.72
    expect(m.mapState(mem({ stability: 1, due: later(30) }), later(10))).toBe('review');
  });

  it('schedule + preview', () => {
    const first = m.schedule(null, 'good', now);
    expect(first).toMatchObject({ reps: 1, lapses: 0, state: 'review' });
    expect(m.schedule(null, 'again', now).state).toBe('learning');
    const lapse = m.schedule(mem(), 'again', now);
    expect(lapse).toMatchObject({ lapses: 1, state: 'relearning', difficulty: 6 });
    expect(m.schedule(mem(), 'easy', now).difficulty).toBe(4);
    const p = intervalPreviewSchema.parse(m.preview(mem(), now));
    expect(p.again.intervalDays).toBeLessThan(p.hard.intervalDays);
    expect(p.good.intervalDays).toBeLessThan(p.easy.intervalDays);
  });

  it('verdictToGrade (FR-3)', () => {
    const t = { durationMs: 1000, medianMs: 4000 };
    expect(m.verdictToGrade({ verdict: 'incorrect', criticalError: false }, t)).toBe('again');
    expect(m.verdictToGrade({ verdict: 'partial', criticalError: false }, t)).toBe('hard');
    expect(m.verdictToGrade({ verdict: 'correct', criticalError: false }, t)).toBe('easy');
    expect(m.verdictToGrade({ verdict: 'correct', criticalError: false }, { durationMs: 3000, medianMs: 4000 })).toBe('good');
    expect(m.verdictToGrade({ verdict: 'correct', criticalError: false }, { durationMs: 1, medianMs: null })).toBe('good');
    expect(m.verdictToGrade({ verdict: 'correct', criticalError: true }, t)).toBe('again');
  });

  it('recordAttempt is idempotent and chains state', async () => {
    const a = { id: fid(1), userId: user, cardId: sepseCardIds.sepse, subId: null, sessionId: null, mode: 'hidden_card' as const, inputKind: 'self' as const, answerText: null, verdict: null, grade: 'good' as const, gradeOverridden: false, durationMs: 1, createdAt: now };
    const r1 = data(await m.recordAttempt(a));
    expect(data(await m.recordAttempt(a))).toEqual(r1);
    expect(data(await m.recordAttempt({ ...a, id: fid(2) })).state.reps).toBe(2);
  });

  it('queues and retrievability map', async () => {
    expect(data(await m.getDailyQueue(user, { now, limit: 3 }))).toHaveLength(3);
    expect(data(await m.getDailyQueue(user, { now })).length).toBeGreaterThan(3);
    expect(data(await m.getBoardQueue(user, sepseBoardId, { now })).length).toBeGreaterThan(0);
    expect(code(await m.getBoardQueue(user, fid(9), { now }))).toBe('not_found');
    expect(Object.keys(data(await m.getRetrievability(user, sepseBoardId, now)))).toHaveLength(6);
    expect(code(await m.getRetrievability(user, fid(9), now))).toBe('not_found');
  });
});

describe('ai mocks', () => {
  it('grade: correct / partial / incorrect', async () => {
    const input = { prompt: 'p', canonical: 'c', rubric: sepseRubric, neighbors: [] };
    expect(data(await m.grade({ ...input, answer: 'Disfunção orgânica por resposta desregulada à infecção' })).verdict).toBe('correct');
    expect(data(await m.grade({ ...input, answer: 'disfunção orgânica' })).verdict).toBe('partial');
    expect(data(await m.grade({ ...input, answer: 'não sei' })).verdict).toBe('incorrect');
  });
  it('rubric and board generation', async () => {
    const rubric = data(await m.generateRubric(sepseCards[0]!, 'fonte'));
    expect(rubric).toMatchObject({ status: 'draft', version: 1 });
    const { jobId } = data(await m.generateBoard(user, { kind: 'text', text: 'x', area: 'CM', title: 'T' }));
    expect(data(await m.getGenerationProgress(user, jobId))).toMatchObject({ status: 'done', boardId: sepseBoardId });
    expect(code(await m.getGenerationProgress(user, fid(9)))).toBe('not_found');
  });
});

describe('board + card mocks', () => {
  it('list, get, create', async () => {
    expect(data(await m.listBoards(user))[0]).toMatchObject({ title: 'Sepse', cardCount: 6, edgeCount: 6 });
    const graph = boardGraphSchema.parse(data(await m.getBoard(user, sepseBoardId)));
    expect(graph.cards[0]).not.toHaveProperty('payload');
    expect(code(await m.getBoard(fid(2), sepseBoardId))).toBe('not_found');
    const b = data(await m.createBoard(user, { title: 'Pneumonia', area: 'CM' }));
    expect(b.status).toBe('private');
  });

  it('applyMapOps applies each op once', async () => {
    const op = (n: number) => ({ opId: fid(n), boardId: sepseBoardId });
    const c = sepseCardIds;
    const move = { ...op(1), op: 'moveCards' as const, moves: [{ cardId: c.sepse, position: { x: 1, y: 2 } }] };
    const ops = [
      move,
      { ...op(2), op: 'createCard' as const, card: { id: fid(50), type: 'concept' as const, title: 'Novo', position: { x: 0, y: 0 } } },
      { ...op(3), op: 'createEdge' as const, edge: { id: fid(51), fromCardId: fid(50), toCardId: c.sepse, label: null } },
      { ...op(4), op: 'updateEdgeLabel' as const, edgeId: fid(51), label: 'relaciona' },
      { ...op(5), op: 'deleteEdges' as const, edgeIds: [fid(301)] },
      { ...op(6), op: 'deleteCards' as const, cardIds: [c.caso] },
    ];
    expect(data(await m.applyMapOps(user, ops)).applied).toHaveLength(6);
    expect(data(await m.applyMapOps(user, ops)).applied).toHaveLength(6); // replay is a no-op
    const g = data(await m.getBoard(user, sepseBoardId));
    expect(g.cards.find((x) => x.id === c.sepse)!.position).toEqual({ x: 1, y: 2 });
    expect(g.cards).toHaveLength(6); // +1 created, -1 deleted
    expect(g.edges.find((e) => e.id === fid(51))!.label).toBe('relaciona');
    expect(g.edges).toHaveLength(5); // +1, -301, -306 (case)
    expect(code(await m.applyMapOps(user, [{ ...move, boardId: fid(9) }]))).toBe('not_found');
    expect(code(await m.applyMapOps(user, [{ ...move, moves: [] }]))).toBe('validation');
  });

  it('cards and uploads', async () => {
    const card = data(await m.getCard(user, sepseCardIds.pacote));
    expect(card.type).toBe('flow');
    expect(code(await m.getCard(user, fid(9)))).toBe('not_found');
    const { title, front, back, source } = sepseCards[0]!;
    const input = { type: 'concept' as const, shape: 'rect' as const, frontAssetId: null, backAssetId: null, title, front, back, source, payload: {} };
    expect(data(await m.saveCard(user, sepseCardIds.sepse, { ...input, title: 'Sepse (def.)' })).title).toBe('Sepse (def.)');
    expect(code(await m.saveCard(user, sepseCardIds.sepse, { ...input, title: ' ' }))).toBe('validation');
    expect(code(await m.saveCard(user, fid(9), input))).toBe('not_found');
    const { key } = data(await m.signUpload(user, { mime: 'image/png', sizeBytes: 1000 }));
    expect(data(await m.completeUpload(user, { key })).key).toMatch(/\.webp$/);
    expect(data(await m.getAsset(user, fid(9))).urls.w800).toMatch(/^https:/);
  });
});

describe('challenge mocks', () => {
  it('runs a full session without leaking canonical', async () => {
    const s = startSessionOutputSchema.parse(data(await m.startSession(user, { kind: 'daily' })));
    s.items.forEach((i) => expect(i).not.toHaveProperty('canonical'));
    const ref = (i: number) => ({ sessionId: s.sessionId, itemId: s.items[i]!.id });

    const flow = s.items.find((i) => i.options)!;
    const self = data(await m.answer(user, { ...ref(1), inputKind: 'self', durationMs: 5 }));
    expect(self.verdict).toBeNull();
    const mcq = await Promise.all(
      [0, 1, 2, 3].map((k) => m.answer(user, { sessionId: s.sessionId, itemId: flow.id, inputKind: 'mcq', optionIndex: k, durationMs: 5 })),
    );
    expect(mcq.map((r) => data(r).suggestedGrade).filter((g) => g === 'good')).toHaveLength(1);

    const sepseItem = s.items.find((i) => i.cardId === sepseCardIds.sepse)!;
    const txt = data(await m.answer(user, { sessionId: s.sessionId, itemId: sepseItem.id, inputKind: 'text', text: 'disfunção orgânica', durationMs: 5 }));
    expect(txt).toMatchObject({ suggestedGrade: 'hard', gradeLocked: false });
    const noRubric = data(await m.answer(user, { ...ref(1), inputKind: 'voice', text: 'x', durationMs: 5 }));
    expect(noRubric.verdict).toBeNull();

    setUsage('ai_grades', 20);
    expect(code(await m.answer(user, { sessionId: s.sessionId, itemId: sepseItem.id, inputKind: 'text', text: 'x', durationMs: 5 }))).toBe('quota_exceeded');

    expect(data(await m.rate(user, { ...ref(0), grade: 'again', overridden: false })).due).toBeInstanceOf(Date);
    await m.rate(user, { ...ref(1), grade: 'good', overridden: true });
    expect(data(await m.dispute(user, ref(0))).reviewItemId).toBeTruthy();
    expect(data(await m.listReviewQueue(fid(3)))).toHaveLength(2);
    expect(data(await m.skip(user, ref(2))).remaining).toBe(s.items.length - 2);
    await m.skip(user, ref(3));
    expect(code(await m.skip(user, ref(4)))).toBe('conflict');
    const sum = sessionSummarySchema.parse(data(await m.finishSession(user, s.sessionId)));
    expect(sum).toMatchObject({ correct: 1, wrong: 1, toReview: [s.items[0]!.cardId] });

    for (const r of [
      await m.answer(user, { sessionId: fid(9), itemId: 'x', inputKind: 'self', durationMs: 1 }),
      await m.rate(user, { sessionId: fid(9), itemId: 'x', grade: 'good', overridden: false }),
      await m.dispute(user, { sessionId: fid(9), itemId: 'x' }),
      await m.skip(user, { sessionId: fid(9), itemId: 'x' }),
      await m.finishSession(user, fid(9)),
    ])
      expect(code(r)).toBe('not_found');
  });
});

describe('other lanes', () => {
  it('anki', async () => {
    expect(data(await m.inspect(new Uint8Array([1])))).toEqual(apkgSummaryFixture);
    expect(code(await m.inspect(new Uint8Array()))).toBe('validation');
    const mapping = [{ noteTypeId: '10', cardType: 'concept' as const, title: null, front: 'Front', back: 'Back' }];
    const plan = data(m.planImport(apkgSummaryFixture, mapping, ['1']));
    expect(plan.estimatedCards).toBe(2);
    expect(code(m.planImport(apkgSummaryFixture, mapping, ['nope']))).toBe('validation');
    expect(data(await m.toDrafts(new Uint8Array([1]), plan))).toHaveLength(2);
    expect(data(await m.getImportProgress(user, fid(7))).status).toBe('done');
    expect(data(await m.getImportReport(user, fid(7))).importId).toBe(fid(7));
  });

  it('coverage, billing, reports, onboarding', async () => {
    coverageRowSchema.parse(data(await m.getCoverage(user))[0]);
    entitlementsSchema.parse(data(await m.getEntitlements(user)));
    expect(code(await m.assertQuota(user, 'boards'))).toBeNull();
    setUsage('boards', 3);
    expect(code(await m.assertQuota(user, 'boards'))).toBe('quota_exceeded');
    expect(data(await m.createCheckout(user, { period: 'annual', method: 'pix' })).url).toContain('annual/pix');
    expect(data(await m.openPortal(user, {})).url).toBeTruthy();
    expect(data(await m.exportAccount(user)).userId).toBe(user);
    expect(data(await m.deleteAccount(user)).hardDeleteAt.getTime()).toBeGreaterThan(Date.now());
    progressSummarySchema.parse(data(await m.getProgress(user, now)));
    expect(data(await m.joinWaitlist({ email: 'a@b.co', segment: 'y5_6', variant: '29', origin: null }))).toBeNull();
    expect(code(await m.joinWaitlist({ email: 'nope', segment: 'y5_6', variant: null, origin: null }))).toBe('validation');
    expect(data(await m.saveOnboarding(user, { segment: 'graduated', goal: 'enamed_2027_1', area: 'CM', startPath: 'seed' }))).toBeNull();
    expect(code(await m.saveOnboarding(user, { segment: 'graduated', goal: 'Enamed!', area: 'CM', startPath: 'seed' }))).toBe('validation');
  });

  it('editorial: approve all, publish, copy seed', async () => {
    const reviewer = fid(3);
    const [item] = data(await m.listReviewQueue(reviewer));
    expect(data(await m.decideReviewItem(reviewer, { reviewItemId: item!.id, decision: 'approved', note: null })).status).toBe('approved');
    expect(code(await m.publishVersion(reviewer, { boardId: sepseBoardId, changelog: 'v2', temporalMark: '2026.2' }))).toBe('conflict');
    for (const c of sepseCards) setCardStatusMock(c.id, 'approved');
    const v = data(await m.publishVersion(reviewer, { boardId: sepseBoardId, changelog: 'v2', temporalMark: '2026.2' }));
    expect(v).toMatchObject({ version: 2 });
    expect(v.snapshot.cards).toHaveLength(6);
    expect(code(await m.publishVersion(reviewer, { boardId: fid(9), changelog: 'x', temporalMark: 'x' }))).toBe('not_found');
    expect(data(await m.resolveDispute(reviewer, { reviewItemId: item!.id, outcome: 'rubric_correct', note: null })).status).toBe('approved');
    expect(code(await m.resolveDispute(reviewer, { reviewItemId: fid(9), outcome: 'rubric_correct', note: null }))).toBe('not_found');
    expect(code(await m.decideReviewItem(reviewer, { reviewItemId: fid(9), decision: 'rejected', note: null }))).toBe('not_found');
    const { boardId } = data(await m.copySeedBoard(user, sepseBoardId));
    expect(data(await m.getBoard(user, boardId)).board.sourceBoardId).toBe(sepseBoardId);
    expect(code(await m.copySeedBoard(user, fid(9)))).toBe('not_found');
  });
});

describe('F17 contracts + mocks', () => {
  const pick = (r: SharedBoardResponse) => (r.locked ? null : r);

  it('fixtures parse against their schemas; the public card has no FSRS/tags/status/rubric/owner keys', () => {
    expect(boardSchema.parse(sharedSepseBoard)).toMatchObject({ access: 'public', shareUrl: shareStateFixture.url });
    shareStateSchema.parse(shareStateFixture);
    expect(sharedBoardResponseSchema.parse(sharedLockedFixture)).toEqual({ locked: true });
    expect(() => sharedLockedSchema.parse({ locked: true, title: 'x' })).toThrow(); // nothing else, ever
    const pub = sharedBoardResponseSchema.parse(sharedBoardFixture);
    for (const c of pick(pub)!.cards) for (const k of ['boardId', 'tags', 'status', 'reviewerId', 'rubric', 'preview', 'userId']) expect(c).not.toHaveProperty(k);
    expect(startImportInputSchema.parse(startImportInputFixture).board).toMatchObject({ access: 'password', target: 'new' });
  });

  it('password rule: required with password, rejected with the others; ≤ 10 matrix items, deduped', () => {
    const ok_ = (v: unknown) => createBoardInputSchema.safeParse(v).success;
    expect(ok_({ title: 'T', access: 'password' })).toBe(false);
    expect(ok_({ title: 'T', access: 'password', password: '12345' })).toBe(false);
    expect(ok_({ title: 'T', access: 'password', password: '123456' })).toBe(true);
    expect(ok_({ title: 'T', access: 'public', password: '123456' })).toBe(false);
    expect(ok_({ title: 'T', matrixItemIds: Array.from({ length: 11 }, (_, i) => fid(i + 1)) })).toBe(false);
    const parsed = createBoardInputSchema.parse({ title: 'T', matrixItemIds: [fid(1), fid(1), fid(2)] });
    expect(parsed).toMatchObject({ access: 'owner', area: 'CM', matrixItemIds: [fid(1), fid(2)] });
    expect(boardMatrixItemIds({ matrixItemIds: [], matrixItemId: fid(3) })).toEqual([fid(3)]); // deprecated alias
    expect(boardMatrixItemIds(parsed)).toEqual([fid(1), fid(2)]);
    const board = { title: 'T', area: 'PED', matrixItemIds: [], access: 'password' };
    expect(importBoardInputSchema.safeParse(board).success).toBe(false);
    expect(importBoardInputSchema.safeParse({ ...board, target: { boardId: fid(1) } }).success).toBe(true); // existing: access unchanged
    expect(updateShareInputSchema.safeParse({ access: 'password' }).success).toBe(true); // keep current password
    expect(updateShareInputSchema.safeParse({ access: 'owner', rotate: true }).success).toBe(false);
    expect(normalizeBoardTitle('  Sépse ')).toBe(normalizeBoardTitle('SEPSE'));
  });

  it('events: new shapes are strict', () => {
    expect(eventSchemas.board_linked_to_matrix.safeParse({ suggested: true }).success).toBe(false);
    expect(eventSchemas.board_linked_to_matrix.safeParse({ count: 2, suggestedCount: 1 }).success).toBe(true);
    expect(eventSchemas.anki_imported.safeParse({ decks: 1, cards: 2, media: 0, durationMs: 1, skipped: 0, area: 'GO', matrixItems: 0, access: 'public', adjusted: false, target: 'new' }).success).toBe(true);
    expect(eventSchemas.shared_board_viewed.safeParse({ access: 'public', cards: 3, title: 'x' }).success).toBe(false);
    expect(eventSchemas.board_copied_from_link.safeParse({ access: 'password', cards: 3, blockedByQuota: true }).success).toBe(true);
  });

  it('share lifecycle: public → private (grant) → rotate → owner, copy and existing title', async () => {
    const b = data(await m.createBoard(user, { title: 'Pneumonia', access: 'public' }));
    expect(b.shareUrl).toMatch(/\/m\/[A-Za-z0-9_-]{43}$/);
    const tokenOf = async () => data(await m.getShare(user, b.id)).url!.split('/m/')[1]!;
    const t1 = await tokenOf();
    expect(pick(data(await m.getSharedBoard(t1, { grant: null, viewerId: null })))!.ownBoardId).toBeNull();
    expect(pick(data(await m.getSharedBoard(t1, { grant: null, viewerId: user })))!.ownBoardId).toBe(b.id);

    expect(code(await m.updateShare(user, b.id, { access: 'password' }))).toBe('validation'); // entering private needs a password
    data(await m.updateShare(user, b.id, { access: 'password', password: 'turma-2026' }));
    expect(data(await m.getSharedBoard(t1, { grant: null, viewerId: null }))).toEqual({ locked: true }); // same link, now locked
    for (let i = 0; i < 5; i++) expect(code(await m.unlockShared(t1, { password: 'errada' }, { ip: '1.1.1.1' }))).toBe('unauthorized');
    expect(code(await m.unlockShared(t1, { password: 'turma-2026' }, { ip: '1.1.1.1' }))).toBe('rate_limited');
    const grant = data(await m.unlockShared(t1, { password: 'turma-2026' }, { ip: '2.2.2.2' })).value;
    expect(data(await m.getSharedBoard(t1, { grant, viewerId: null })).locked).toBe(false);

    const other = fid(2);
    expect(code(await m.copySharedBoard(other, { token: t1 }, { grant: null }))).toBe('forbidden');
    const copy = data(await m.copySharedBoard(other, { token: t1 }, { grant }));
    expect(copy).toMatchObject({ userId: other, access: 'owner', sourceBoardId: b.id, copiedFrom: { at: expect.any(Date) } });
    expect(data(await m.getShare(user, b.id)).copies).toBe(1);

    data(await m.updateShare(user, b.id, { access: 'password', rotate: true }));
    expect(code(await m.getSharedBoard(t1, { grant, viewerId: null }))).toBe('not_found'); // old link dead
    const t2 = await tokenOf();
    expect(data(await m.getSharedBoard(t2, { grant, viewerId: null }))).toEqual({ locked: true }); // old grant dead
    expect(data(await m.updateShare(user, b.id, { access: 'owner' }))).toMatchObject({ access: 'owner', url: null });
    expect(code(await m.getSharedBoard(t2, { grant: null, viewerId: null }))).toBe('not_found');
    expect(code(await m.getShare(other, b.id))).toBe('not_found');

    expect(data(await m.findExistingBoard(user, ' pneumônia '))).toEqual({ board: { id: b.id, title: 'Pneumonia' } });
    expect(data(await m.findExistingBoard(user, 'Asma')).board).toBeNull();
    expect(data(await m.startImport(user, startImportInputFixture)).importId).toBeTruthy();
    expect(code(await m.startImport(user, { ...startImportInputFixture, board: { ...startImportInputFixture.board!, password: undefined } }))).toBe('validation');
  });
});

describe('board mocks (F01)', () => {
  it('rename, archive hides from list, duplicate copies cards and edges', async () => {
    const renamed = data(await m.updateBoard(user, sepseBoardId, { title: 'Sepse 2' }));
    expect(renamed.title).toBe('Sepse 2');
    const copy = data(await m.duplicateBoard(user, sepseBoardId, 'Sepse (cópia)'));
    const graph = data(await m.getBoard(user, copy.id));
    expect(graph.cards).toHaveLength(sepseCards.length);
    expect(graph.edges.every((e) => graph.cards.some((c) => c.id === e.fromCardId))).toBe(true);
    data(await m.updateBoard(user, sepseBoardId, { archived: true }));
    expect(data(await m.listBoards(user)).map((b) => b.id)).toEqual([copy.id]);
    expect(code(await m.updateBoard(fid(2), copy.id, { title: 'x' }))).toBe('not_found');
  });
});
