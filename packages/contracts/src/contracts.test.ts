import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  answerInputSchema,
  boardSchema,
  mobileMapPrefsSchema,
  cardDetailSchema,
  saveCardInputSchema,
  cardDraftSchema,
  edgeSchema,
  err,
  errorCodes,
  errorHttpStatus,
  eventNames,
  eventSchemas,
  generateBoardInputSchema,
  graderVerdictSchema,
  httpErrorBodySchema,
  mapOpSchema,
  ok,
  parseWith,
  queueItemSchema,
  retrievabilityMapSchema,
  rubricSchema,
  type EventProps,
  type Result,
  type Track,
} from './index';
import {
  graderVerdictFixture,
  retrievabilityFixture,
  reviewQueueFixture,
  sepseBoard,
  sepseCards,
  sepseEdges,
  sepseRubric,
} from './mocks';

describe('fixtures parse with their schemas', () => {
  it('Sepse board: 6 cards (concept/flow/case mix), 6 labelled edges between its cards', () => {
    expect(boardSchema.parse(sepseBoard).title).toBe('Sepse');
    expect(sepseCards).toHaveLength(6);
    sepseCards.forEach((c) => expect(cardDetailSchema.parse(c)).toEqual(c));
    expect(new Set(sepseCards.map((c) => c.type))).toEqual(new Set(['concept', 'flow', 'case']));
    expect(sepseCards.every((c) => c.status === 'draft')).toBe(true);
    const ids = new Set(sepseCards.map((c) => c.id));
    expect(sepseEdges).toHaveLength(6);
    sepseEdges.forEach((e) => {
      edgeSchema.parse(e);
      expect(e.label).toBeTruthy();
      expect(ids.has(e.fromCardId) && ids.has(e.toCardId)).toBe(true);
    });
  });

  it('queue, retrievability, verdict and rubric fixtures', () => {
    reviewQueueFixture.forEach((q) => queueItemSchema.parse(q));
    expect(Object.keys(retrievabilityMapSchema.parse(retrievabilityFixture))).toHaveLength(6);
    expect(graderVerdictSchema.parse(graderVerdictFixture)).toEqual(graderVerdictFixture);
    rubricSchema.parse(sepseRubric);
  });
});

describe('schemas reject bad input', () => {
  const concept = sepseCards[0]!;
  it('card payload is validated per type', () => {
    expect(cardDetailSchema.safeParse({ ...concept, type: 'flow' }).success).toBe(false);
    expect(cardDetailSchema.safeParse({ ...concept, type: 'flow', payload: { steps: [{ id: 'a', text: 'x' }] } }).success).toBe(false);
    expect(cardDetailSchema.safeParse({ ...concept, payload: { steps: [] } }).success).toBe(false);
    const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const mask = { id: concept.id, polygon: square, label: 'l' };
    expect(cardDetailSchema.safeParse({ ...concept, type: 'image', payload: { assetId: concept.id, masks: [mask] } }).success).toBe(true);
    expect(cardDetailSchema.safeParse({ ...concept, type: 'image', payload: { assetId: concept.id, masks: [mask, mask] } }).success).toBe(false);
    expect(cardDetailSchema.safeParse({ ...concept, type: 'image', payload: { assetId: concept.id, masks: Array.from({ length: 31 }, (_, i) => ({ ...mask, id: `m${i}` })) } }).success).toBe(false);
    const steps = [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }];
    expect(cardDetailSchema.safeParse({ ...concept, type: 'flow', payload: { steps } }).success).toBe(false);
  });
  it('save input: the 4 types validate their payload; status is not editable', () => {
    const base = { title: 't', front: null, back: null, source: null };
    expect(saveCardInputSchema.safeParse({ ...base, type: 'concept', payload: {} }).success).toBe(true);
    expect(saveCardInputSchema.safeParse({ ...base, type: 'concept', payload: { steps: [] } }).success).toBe(false);
    expect(saveCardInputSchema.safeParse({ ...base, type: 'flow', payload: { steps: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] } }).success).toBe(true);
    expect(saveCardInputSchema.safeParse({ ...base, type: 'case', payload: { caseSteps: [{ stage: 'presentation', text: 'x' }] } }).success).toBe(true);
    expect(saveCardInputSchema.safeParse({ ...base, type: 'case', payload: { caseSteps: [] } }).success).toBe(false);
    expect(saveCardInputSchema.safeParse({ ...base, type: 'image', payload: { assetId: concept.id, masks: [] } }).success).toBe(true);
    const parsed = saveCardInputSchema.parse({ ...base, type: 'concept', payload: {}, status: 'approved' });
    expect(parsed).not.toHaveProperty('status');
  });
  it('drafts, map ops, answers, generation input', () => {
    expect(cardDraftSchema.safeParse({ ref: 'a', type: 'image', title: 't', front: null, back: null, source: null, payload: { media: 'x.png', masks: [{ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], label: 'l' }] } }).success).toBe(true);
    expect(mapOpSchema.safeParse({ op: 'deleteCards', opId: concept.id, boardId: concept.boardId, cardIds: [] }).success).toBe(false);
    expect(answerInputSchema.safeParse({ inputKind: 'mcq', optionIndex: 4, sessionId: concept.id, itemId: 'i', durationMs: 1 }).success).toBe(false);
    expect(generateBoardInputSchema.safeParse({ kind: 'text', text: 'x', area: 'CM', title: 'Sepse' }).success).toBe(true);
    expect(generateBoardInputSchema.safeParse({ kind: 'pdf', area: 'CM', title: 'Sepse' }).success).toBe(false);
  });
});

describe('errors', () => {
  it('ok / err / parseWith', () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
    const e: Result<number> = err('not_found', 'nope');
    expect(e).toEqual({ ok: false, error: { code: 'not_found', message: 'nope' } });
    expect(parseWith(rubricSchema, sepseRubric).ok).toBe(true);
    const bad = parseWith(rubricSchema, { points: [] });
    expect(bad.ok === false && bad.error.code).toBe('validation');
    expect(bad.ok === false && bad.error.message).toContain('points');
  });
  it('every code has an HTTP status and fits the error body', () => {
    errorCodes.forEach((code) => {
      expect(errorHttpStatus[code]).toBeGreaterThanOrEqual(400);
      httpErrorBodySchema.parse({ error: { code, message: 'x' } });
    });
  });
});

describe('events', () => {
  it('includes the F00/F11 required events', () => {
    for (const e of ['signup', 'login', 'theme_toggled', 'board_created', 'board_generated_from_pdf', 'card_created', 'anki_imported', 'challenge_started', 'answer_submitted', 'grade_overridden', 'review_completed', 'paywall_viewed', 'subscription_started', 'subscription_canceled'])
      expect(eventNames).toContain(e);
  });
  it('rejects extra props (no free answer text)', () => {
    expect(eventSchemas.signup.safeParse({ method: 'google' }).success).toBe(true);
    expect(eventSchemas.answer_submitted.safeParse({ mode: 'hidden_card', inputKind: 'text', verdict: 'correct', latencyMs: 10, answerText: 'x' }).success).toBe(false);
    expect(eventSchemas.grade_overridden.safeParse({ text: 'x' }).success).toBe(false);
  });
  it('landing_cta_clicked: location + cta only, no extras', () => {
    const s = eventSchemas.landing_cta_clicked;
    expect(s.safeParse({ location: 'plans_pro', cta: 'waitlist' }).success).toBe(true);
    expect(s.safeParse({ location: 'plans_founder', cta: 'create' }).success).toBe(true);
    expect(s.safeParse({ location: 'hero', cta: 'create' }).success).toBe(false);
    expect(s.safeParse({ location: 'final', cta: 'create', email: 'a@b.c' }).success).toBe(false);
  });
  it('track() is typed per event', () => {
    const calls: unknown[] = [];
    const track: Track = (e, p) => calls.push([e, p]);
    track('signup', { method: 'password' });
    track('board_created', {});
    // @ts-expect-error wrong prop value
    track('signup', { method: 'sms' });
    expectTypeOf<EventProps['queue_opened']>().toEqualTypeOf<{ due: number; new: number; weak: number }>();
    expect(calls).toHaveLength(3);
  });
});

describe('mobileMapPrefsSchema (F23)', () => {
  it('fills defaults and rejects out-of-range zoom', () => {
    expect(mobileMapPrefsSchema.parse({})).toEqual({ version: 1, heat: true, labels: true, view: 'canvas', viewports: {}, favorites: [] });
    const at = (zoom: number) => mobileMapPrefsSchema.safeParse({ viewports: { [crypto.randomUUID()]: { x: 0, y: 0, zoom } } }).success;
    expect([at(0.05), at(0.1), at(3), at(3.5)]).toEqual([false, true, true, false]); // D-1572: 10–300%
  });
});
