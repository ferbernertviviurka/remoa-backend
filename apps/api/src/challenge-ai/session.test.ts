import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { aiChallengeItemPublicSchema, type AiChallengeItemPublic, type ChallengeConfig } from '@remoa/contracts';
import {
  acceptAnswer, advance, appendBankItem, cardsInScope, endEarly, getSession, recordAttempt, sessionStore, startSession, toPublic,
  type AttemptRow, type BankRow, type CardRow, type EdgeRow, type ItemRow, type NewAttempt, type SessionRow, type SessionStore,
} from './session';

// Synthetic text only. The fake store keeps rows in memory; every public value still goes through the strict zod parse.

const SECRET = 'SEGREDO-GABARITO-7f3a';
const FORBIDDEN_KEYS = /"(correct_?key|expected_?answer|reference_?ref|referenceRef|shuffle_?map|shuffleMap|rubric|key_?points|keyPoints)"/i;
const T0 = new Date('2026-10-07T12:00:00.000Z');

type Mem = { sessions: (SessionRow & { finishedAt: Date | null })[]; items: ItemRow[]; attempts: (NewAttempt & AttemptRow)[] };

function fakeStore(cards: CardRow[] = [], edges: EdgeRow[] = [], bank: BankRow[] = []) {
  const mem: Mem = { sessions: [], items: [], attempts: [] };
  const counts = (id: string) => {
    const its = mem.items.filter((i) => i.sessionId === id);
    const s = mem.sessions.find((x) => x.id === id)!;
    const total = Math.max(its.length, s.format === 'generated' && s.status === 'active' ? s.params.n : 0);
    return { total, aiUnits: its.filter((i) => ['discursive', 'hidden_card', 'edge', 'case'].includes(i.type)).length };
  };
  const store: SessionStore = {
    boardCards: async () => ({ cards, edges }),
    bankQuestions: async (_u, ids) => bank.filter((b) => ids.includes(b.id)),
    createSession: async (s, items) => {
      mem.sessions.push({ ...s, status: 'active', position: 0, total: 0, aiUnits: 0, finishedAt: null });
      for (const i of items) mem.items.push({ ...i, sessionId: s.id });
    },
    appendItem: async (_u, sessionId, i) => {
      if (!mem.items.some((x) => x.sessionId === sessionId && (x.position === i.position || x.bankId === i.bankId))) mem.items.push({ ...i, sessionId });
    },
    session: async (userId, id) => {
      const s = mem.sessions.find((x) => x.id === id && x.userId === userId);
      return s ? { ...s, ...counts(id) } : null;
    },
    publicItemAt: async (id, position) => mem.items.find((i) => i.sessionId === id && i.position === position)?.payloadPublic ?? null,
    itemAt: async (userId, id, position) =>
      mem.sessions.some((s) => s.id === id && s.userId === userId) ? (mem.items.find((i) => i.sessionId === id && i.position === position) ?? null) : null,
    expire: async (_u, id) => {
      const s = mem.sessions.find((x) => x.id === id && x.status === 'active');
      if (s) s.status = 'expired';
    },
    moveTo: async (_u, id, position, finishedAt) => {
      const s = mem.sessions.find((x) => x.id === id && x.status === 'active')!;
      s.position = position;
      if (finishedAt) Object.assign(s, { status: 'finished', finishedAt });
    },
    lastAttempt: async (_u, itemId) => mem.attempts.filter((a) => a.itemId === itemId).sort((a, b) => b.attemptNo - a.attemptNo)[0] ?? null,
    appendAttempt: async (a) => {
      if (mem.attempts.some((x) => x.itemId === a.itemId && x.attemptNo === a.attemptNo)) return null;
      const id = randomUUID();
      mem.attempts.push({ ...a, id });
      return { id };
    },
  };
  return { store, mem };
}

const userId = randomUUID();
const boardId = randomUUID();
const card = (p: Partial<CardRow> & Pick<CardRow, 'type' | 'title'>): CardRow =>
  ({ id: randomUUID(), boardId, front: null, back: null, payload: {}, didactics: null, order: 0, ...p });

function demoMap() {
  const concept = card({ type: 'concept', title: 'Insuficiência cardíaca', front: 'Qual a definição sintética?', back: `${SECRET} resposta do verso`, order: 1 });
  const other = card({ type: 'concept', title: 'Diurético de alça', front: 'Para que serve?', back: 'Texto sintético B', order: 2 });
  const flow = card({
    type: 'flow', title: 'Fluxo sintético', order: 3,
    payload: { steps: [{ id: 's1', text: 'Passo um' }, { id: 's2', text: 'Passo dois' }, { id: 's3', text: 'Passo três' }] },
  });
  const image = card({
    type: 'image', title: 'Imagem sintética', order: 4,
    payload: { assetId: randomUUID(), masks: [{ id: randomUUID(), label: `${SECRET}-mascara`, polygon: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }] }] },
  });
  const caso = card({
    type: 'case', title: 'Caso sintético', order: 5,
    payload: { caseSteps: [{ stage: 'presentation', text: 'Apresentação sintética' }, { stage: 'diagnosis', text: `${SECRET} diagnóstico` }] },
  });
  const edges: EdgeRow[] = [{ id: randomUUID(), from: concept.id, to: other.id, label: `${SECRET}-rotulo`, question: null }];
  return { cards: [concept, other, flow, image, caso], edges, concept, other, flow, image, caso };
}

const mapCfg = (over: Partial<ChallengeConfig> = {}): ChallengeConfig => ({
  boardId, scope: { kind: 'board' }, format: 'map', n: 10, difficulty: 'mixed', grading: 'immediate', timerSec: null, preset: 'practice', ...over,
});
const genCfg = (over: Partial<ChallengeConfig> = {}): ChallengeConfig => ({ ...mapCfg(), format: 'generated', n: 5, questionType: 'mixed', ...over });

const bankRow = (p: Partial<BankRow> = {}): BankRow => ({
  id: randomUUID(), type: 'objective', stem: 'Enunciado sintético objetivo', status: 'draft', correctKey: 'B',
  alternatives: [{ key: 'A', text: 'Alt A' }, { key: 'B', text: 'Alt B' }, { key: 'C', text: 'Alt C' }, { key: 'D', text: 'Alt D' }], ...p,
});

function ok<T>(r: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

describe('startSession — formato 2 (mapa)', () => {
  it('creates active items from the cards, expires after the TTL, and the public payload has no label, order or expected text', async () => {
    const m = demoMap();
    const { store, mem } = fakeStore(m.cards, m.edges);
    const pub = ok(await startSession(store, userId, mapCfg(), { now: T0 }));
    expect(pub.status).toBe('active');
    expect(pub.position).toBe(0);
    expect(pub.expiresAt.getTime() - T0.getTime()).toBe(120 * 60_000);
    expect(pub.total).toBe(mem.items.length);
    expect(new Set(mem.items.map((i) => i.type))).toEqual(new Set(['hidden_card', 'edge', 'next_step', 'occlusion', 'case']));
    expect(pub.aiUnits).toBe(mem.items.filter((i) => ['hidden_card', 'edge', 'case'].includes(i.type)).length);
    expect(pub.current).toEqual(mem.items[0]!.payloadPublic);

    const everyPublic = JSON.stringify(mem.items.map((i) => i.payloadPublic));
    expect(everyPublic).not.toContain(SECRET);
    expect(everyPublic).not.toMatch(/"label"/);
    for (const i of mem.items) {
      aiChallengeItemPublicSchema.parse(i.payloadPublic);
      expect(JSON.stringify(i.referenceRef)).not.toContain(SECRET); // pointers only; T4 resolves the text on the server
    }
    const flow = mem.items.find((i) => i.type === 'next_step')!;
    const steps = (flow.payloadPublic as Extract<AiChallengeItemPublic, { type: 'next_step' }>).steps.map((s) => s.id);
    expect(flow.shuffleMap).toEqual({ kind: 'steps', correctOrder: ['s1', 's2', 's3'] });
    expect(steps).not.toEqual(['s1', 's2', 's3']);
    expect([...steps].sort()).toEqual(['s1', 's2', 's3']);
    expect(mem.items.find((i) => i.type === 'edge')!.subId).toBe(`edge:${m.edges[0]!.id}`);
    expect(mem.items.find((i) => i.type === 'occlusion')!.subId).toBe((m.image.payload as { masks: { id: string }[] }).masks[0]!.id);
    expect(mem.items.find((i) => i.type === 'case')!.subId).toBe('diagnosis');
  });

  it('a case with three stages asks them in order and does not reveal a later answer', async () => {
    const caso = card({
      type: 'case', title: 'Caso longo', order: 1,
      payload: {
        caseSteps: [
          { stage: 'presentation', text: 'Etapa alfa' },
          { stage: 'diagnosis', text: 'Etapa beta secreta' },
          { stage: 'management', text: 'Etapa gama secreta' },
        ],
      },
    });
    const { store, mem } = fakeStore([caso]);
    ok(await startSession(store, userId, mapCfg({ n: 5 }), { now: T0 }));
    const cases = mem.items.filter((i) => i.type === 'case').sort((a, b) => a.position - b.position);
    expect(cases.map((i) => i.subId)).toEqual(['diagnosis', 'management']);
    const first = JSON.stringify(cases[0]!.payloadPublic);
    const second = JSON.stringify(cases[1]!.payloadPublic);
    expect(first).toContain('Etapa alfa');
    expect(first).not.toContain('beta');
    expect(first).not.toContain('gama');
    expect(second).toContain('Etapa beta secreta');
    expect(second).not.toContain('gama');
  });

  it('respects n, CHALLENGE_SESSION_TTL_MIN and rejects an empty scope', async () => {
    const m = demoMap();
    const { store, mem } = fakeStore(m.cards, m.edges);
    const pub = ok(await startSession(store, userId, mapCfg({ n: 5 }), { now: T0, env: { CHALLENGE_SESSION_TTL_MIN: '30' } }));
    expect(pub.total).toBe(5);
    expect(new Set(mem.items.map((i) => i.cardId)).size).toBe(5); // one per card before a second from the same card
    expect(pub.expiresAt.getTime() - T0.getTime()).toBe(30 * 60_000);
    const empty = await startSession(fakeStore([], []).store, userId, mapCfg(), { now: T0 });
    expect(empty).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('card scope asks the card through its own modes and edges, both directions', async () => {
    const m = demoMap();
    const { store, mem } = fakeStore(m.cards, m.edges);
    ok(await startSession(store, userId, mapCfg({ scope: { kind: 'card', cardId: m.other.id }, n: 5 }), { now: T0 }));
    expect(mem.items.map((i) => i.type).sort()).toEqual(['edge', 'hidden_card']);
    expect(mem.items.every((i) => i.cardId === m.other.id)).toBe(true);
  });

  it('module and branch scopes', () => {
    const a = card({ type: 'concept', title: 'A', didactics: { modulo: 'M1' } });
    const b = card({ type: 'concept', title: 'B', didactics: { modulo: 'M2' } });
    const c = card({ type: 'concept', title: 'C' });
    const edges: EdgeRow[] = [{ id: randomUUID(), from: a.id, to: b.id, label: null, question: null }, { id: randomUUID(), from: c.id, to: a.id, label: null, question: null }];
    expect(cardsInScope([a, b, c], edges, { kind: 'module', module: 'M1' }).map((x) => x.title)).toEqual(['A']);
    expect(cardsInScope([a, b, c], edges, { kind: 'branch', rootCardId: a.id }).map((x) => x.title)).toEqual(['A', 'B']);
  });

  it('rejects an invalid config before touching the store', async () => {
    const { store, mem } = fakeStore();
    expect(await startSession(store, userId, { ...mapCfg(), n: 7 })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await startSession(store, userId, { ...mapCfg(), correctKey: 'A' })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(mem.sessions).toHaveLength(0);
  });
});

describe('startSession — formato 1 (banco)', () => {
  it('points at the bank ids, shuffles A–D on the server and keeps the correct key out of everything public', async () => {
    const objective = { ...bankRow(), expectedAnswer: SECRET, keyPoints: [SECRET], rubric: { essentialPoints: [SECRET] } } as BankRow;
    const discursive = bankRow({ type: 'discursive', stem: 'Enunciado sintético discursivo', alternatives: null, correctKey: null });
    const { store, mem } = fakeStore([], [], [objective, discursive]);
    const pub = ok(await startSession(store, userId, genCfg(), { bankIds: [objective.id, discursive.id], now: T0 }));
    expect(pub).toMatchObject({ format: 'generated', total: 5, aiUnits: 1 });
    expect(mem.items.map((i) => [i.kind, i.bankId, i.cardId])).toEqual([['bank', objective.id, null], ['bank', discursive.id, null]]);
    expect(mem.items[0]!.referenceRef).toEqual({ kind: 'bank', bankId: objective.id });

    const shown = (pub.current as Extract<AiChallengeItemPublic, { type: 'objective' }>).alternatives;
    expect(shown.map((a) => a.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(shown.map((a) => a.text).sort()).toEqual(['Alt A', 'Alt B', 'Alt C', 'Alt D']);
    const map = mem.items[0]!.shuffleMap as { kind: 'alternatives'; shown: Record<string, string> };
    for (const a of shown) expect(`Alt ${map.shown[a.key]}`).toBe(a.text); // shown letter -> stored letter

    const out = JSON.stringify(pub);
    expect(out).not.toContain(SECRET);
    expect(out).not.toMatch(FORBIDDEN_KEYS);
    expect(out).not.toMatch(/"correct"|"isCorrect"/);
  });

  it('requires bank ids within n, owned and not archived, of the chosen type', async () => {
    const q = bankRow();
    const archived = bankRow({ status: 'archived' });
    const { store } = fakeStore([], [], [q, archived]);
    expect(await startSession(store, userId, genCfg(), {})).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await startSession(store, userId, genCfg(), { bankIds: [q.id, q.id] })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await startSession(store, userId, genCfg(), { bankIds: [archived.id] })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await startSession(store, userId, genCfg(), { bankIds: [randomUUID()] })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await startSession(store, userId, genCfg({ questionType: 'discursive' }), { bankIds: [q.id] }))
      .toMatchObject({ ok: false, error: { code: 'validation', message: 'question_type_mismatch' } });
  });

  it('D-1566: one question per step — counts n, takes the next one at its position, ends early when none comes', async () => {
    const [q1, q2] = [bankRow(), bankRow({ stem: 'Segunda pergunta sintética' })];
    const { store, mem } = fakeStore([], [], [q1, q2]);
    const pub = ok(await startSession(store, userId, genCfg(), { bankIds: [q1.id], now: T0 }));
    expect(pub).toMatchObject({ total: 5, position: 0 });
    expect(await appendBankItem(store, userId, pub.id, 5, q2.id)).toMatchObject({ ok: false }); // past n
    ok(await appendBankItem(store, userId, pub.id, 1, q2.id));
    ok(await appendBankItem(store, userId, pub.id, 1, q1.id)); // position taken: left as is
    ok(await appendBankItem(store, userId, pub.id, 2, q1.id)); // already asked in this session: never repeated
    expect(mem.items.map((i) => [i.position, i.bankId])).toEqual([[0, q1.id], [1, q2.id]]);

    for (const item of mem.items) {
      ok(await recordAttempt(store, userId, pub.id, { itemId: item.id, answer: { kind: 'dont_know' } }, T0));
      ok(await advance(store, userId, pub.id, T0));
    }
    expect(ok(await getSession(store, userId, pub.id, T0))).toMatchObject({ status: 'active', position: 2, current: null });
    await endEarly(store, userId, pub.id, T0);
    expect(ok(await getSession(store, userId, pub.id, T0))).toMatchObject({ status: 'finished', total: 2 });
  });
});

describe('toPublic — sem vazamento do gabarito', () => {
  const session = (): SessionRow => ({
    id: randomUUID(), userId, boardId, format: 'generated', status: 'active', position: 0, expiresAt: T0, params: genCfg(), total: 1, aiUnits: 0,
  });
  const payload = { id: randomUUID(), position: 0, type: 'objective', stem: 'Enunciado sintético',
    alternatives: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }] };

  it('ships only the payload even when the stored row carries a planted reference', () => {
    const row: ItemRow = {
      id: payload.id, sessionId: randomUUID(), position: 0, kind: 'bank', cardId: null, subId: '', bankId: randomUUID(), type: 'objective', payloadPublic: payload,
      referenceRef: { kind: 'bank', bankId: randomUUID(), expected_answer: SECRET, correct_key: SECRET, rubric: SECRET },
      shuffleMap: { kind: 'alternatives', shown: { A: 'C', B: 'A', C: 'D', D: 'B' }, secret: SECRET },
    };
    const out = JSON.stringify(toPublic(session(), row.payloadPublic));
    expect(out).not.toContain(SECRET);
    expect(out).not.toMatch(FORBIDDEN_KEYS);
  });

  it.each([
    ['correctKey', { correctKey: 'A' }], ['correct_key', { correct_key: SECRET }], ['expected_answer', { expected_answer: SECRET }],
    ['referenceRef', { referenceRef: { kind: 'bank', bankId: randomUUID() } }], ['shuffleMap', { shuffleMap: SECRET }], ['rubric', { rubric: SECRET }],
  ])('fails closed when a payload carries %s', (_k, extra) => {
    expect(() => toPublic(session(), { ...payload, ...extra })).toThrow();
  });

  it('fails closed on nested reference fields (alternative flag, mask label)', () => {
    const flagged = { ...payload, alternatives: payload.alternatives.map((a, i) => ({ ...a, correct: i === 0 })) };
    expect(() => toPublic(session(), flagged)).toThrow();
    const occlusion = { id: randomUUID(), position: 0, type: 'occlusion', stem: 'x', assetId: randomUUID(), maskId: 'm1',
      masks: [{ id: 'm1', label: SECRET, polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] };
    expect(() => toPublic(session(), occlusion)).toThrow();
    expect(() => toPublic(session(), { ...occlusion, masks: [{ id: 'm1', polygon: [{ x: 0, y: 0, label: SECRET }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] })).toThrow();
  });

  it('shows no current item once the session is not active', () => {
    expect(toPublic({ ...session(), status: 'expired' }, payload).current).toBeNull();
  });
});

describe('acceptAnswer / recordAttempt / advance', () => {
  async function started(preset: ChallengeConfig['preset'] = 'practice') {
    const m = demoMap();
    const f = fakeStore(m.cards, m.edges);
    const pub = ok(await startSession(f.store, userId, mapCfg({ n: 5, preset }), { now: T0 }));
    return { ...f, pub, first: f.mem.items[0]!, second: f.mem.items[1]! };
  }
  const answerFor = (i: ItemRow, text = 'resposta sintética do aluno') => {
    const p = i.payloadPublic as AiChallengeItemPublic;
    if (p.type === 'next_step') return { kind: 'order' as const, stepIds: p.steps.map((s) => s.id) };
    if (p.type === 'occlusion') return { kind: 'label' as const, text };
    if (p.type === 'objective') return { kind: 'choice' as const, key: 'A' as const };
    return { kind: 'text' as const, text };
  };

  it('accepts only the open item and hands the server item (with its pointer) to the grader', async () => {
    const { store, pub, first, second } = await started();
    expect(await acceptAnswer(store, userId, pub.id, second.id, T0)).toMatchObject({ ok: false, error: { code: 'conflict', message: 'item_not_current' } });
    expect(await acceptAnswer(store, randomUUID(), pub.id, first.id, T0)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const okd = ok(await acceptAnswer(store, userId, pub.id, first.id, T0));
    expect(okd.item.referenceRef).toEqual(first.referenceRef);
  });

  it('expires the session past expires_at and rejects the answer', async () => {
    const { store, mem, pub, first } = await started();
    const late = new Date(T0.getTime() + 121 * 60_000);
    expect(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: answerFor(first) }, late))
      .toMatchObject({ ok: false, error: { code: 'conflict', message: 'session_expired' } });
    expect(mem.sessions[0]!.status).toBe('expired');
    expect(mem.attempts).toHaveLength(0);
    expect(ok(await getSession(store, userId, pub.id, late))).toMatchObject({ status: 'expired', current: null });
  });

  it('appends a pending row with the raw answer, is idempotent for the same answer and caps the attempts', async () => {
    const { store, mem, pub, first } = await started();
    const a1 = ok(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: answerFor(first, 'primeira') }, T0));
    expect(a1).toEqual({ attemptId: mem.attempts[0]!.id, attemptNo: 1, itemId: first.id });
    expect(mem.attempts[0]).toMatchObject({ attemptNo: 1, answer: answerFor(first, 'primeira'), userId });
    expect(ok(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: answerFor(first, 'primeira') }, T0))).toEqual(a1);
    expect(mem.attempts).toHaveLength(1);
    const a2 = ok(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: { kind: 'dont_know' } }, T0));
    expect(a2.attemptNo).toBe(2);
    expect(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: answerFor(first, 'terceira') }, T0))
      .toMatchObject({ ok: false, error: { code: 'conflict', message: 'no_attempts_left' } });
    expect(JSON.stringify([a1, a2])).not.toMatch(FORBIDDEN_KEYS);
  });

  it('Simulado allows one attempt', async () => {
    const { store, pub, first } = await started('mock');
    ok(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: answerFor(first, 'uma') }, T0));
    // dont_know differs from every first answer. A second choice or the same step order would be the stored attempt, not a new one.
    expect(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: { kind: 'dont_know' } }, T0))
      .toMatchObject({ ok: false, error: { message: 'no_attempts_left' } });
  });

  it('rejects an answer of the wrong kind, steps that are not the shown ones and malformed input', async () => {
    const { store, mem, pub, first } = await started();
    const wrong = first.type === 'next_step' ? { kind: 'text', text: 'x' } : { kind: 'choice', key: 'A' };
    expect(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: wrong }, T0)).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await recordAttempt(store, userId, pub.id, { itemId: first.id, answer: { kind: 'text', text: 'x' }, correct: true }, T0))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
    const flow = mem.items.find((i) => i.type === 'next_step')!;
    mem.sessions[0]!.position = flow.position;
    expect(await recordAttempt(store, userId, pub.id, { itemId: flow.id, answer: { kind: 'order', stepIds: ['s1', 's2', 'zz'] } }, T0))
      .toMatchObject({ ok: false, error: { code: 'validation', message: 'answer_steps' } });
    expect(mem.attempts).toHaveLength(0);
  });

  it('advances one item at a time only after an attempt, then finishes', async () => {
    const { store, mem, pub } = await started();
    expect(await advance(store, userId, pub.id, T0)).toMatchObject({ ok: false, error: { message: 'item_unanswered' } });
    let view = pub;
    for (let k = 0; k < pub.total; k++) {
      const item = mem.items[k]!;
      expect(view.current?.id).toBe(item.id);
      ok(await recordAttempt(store, userId, pub.id, { itemId: item.id, answer: answerFor(item) }, T0));
      view = ok(await advance(store, userId, pub.id, T0));
      expect(JSON.stringify(view)).not.toMatch(FORBIDDEN_KEYS);
    }
    expect(view).toMatchObject({ status: 'finished', position: pub.total, current: null });
    expect(mem.sessions[0]!.finishedAt).toEqual(T0);
    expect(await advance(store, userId, pub.id, T0)).toMatchObject({ ok: false, error: { message: 'session_finished' } });
  });
});

describe('sessionStore (SQL)', () => {
  // Records the statements a fake transaction receives: reference columns and writes only between role none / role authenticated.
  function recordingTx(rows: (q: string) => Record<string, unknown>[] = () => []) {
    const dialect = new PgDialect();
    const log: string[] = [];
    const tx = { execute: async (q: SQL) => {
      const text = dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ');
      log.push(text);
      return rows(text);
    } } as unknown as Tx;
    return { tx, log };
  }
  const wrapped = (log: string[], pattern: RegExp) => {
    const i = log.findIndex((q) => pattern.test(q));
    expect(i).toBeGreaterThan(0);
    expect(log[i - 1]).toContain(`set_config('role', 'none'`);
    expect(log[i + 1]).toContain(`set_config('role', 'authenticated'`);
  };

  it('writes and reads reference columns as the server, filtered by user_id; cards and payload_public under RLS', async () => {
    const { tx, log } = recordingTx();
    const s = sessionStore(tx);
    await s.boardCards(boardId);
    await s.publicItemAt(randomUUID(), 0);
    expect(log.every((q) => !q.includes('set_config'))).toBe(true);
    expect(log.some((q) => /reference_ref|shuffle_map/.test(q))).toBe(false);

    await s.bankQuestions(userId, [randomUUID()]);
    wrapped(log, /from question_bank where user_id = \$1/);
    await s.createSession({ id: randomUUID(), userId, boardId, scope: { kind: 'board' }, format: 'map', params: mapCfg(), startedAt: T0, expiresAt: T0 }, []);
    wrapped(log, /insert into challenge_sessions/);
    await s.itemAt(userId, randomUUID(), 0);
    wrapped(log, /reference_ref, shuffle_map from challenge_items where session_id = \$1 and user_id = \$2/);
    await s.appendAttempt({ itemId: randomUUID(), userId, attemptNo: 1, answer: { kind: 'dont_know' }, answerHash: 'h' });
    wrapped(log, /insert into challenge_attempts .* 'pending'\) on conflict do nothing/);
    await s.session(userId, randomUUID(), true);
    wrapped(log, /from challenge_sessions s where s.id = \$\d+ and s.user_id = \$\d+ for update of s/);
    await s.expire(userId, randomUUID());
    wrapped(log, /update challenge_sessions set status = 'expired'/);
  });

  it('maps a session row (timestamps as text, jsonb as text)', async () => {
    const id = randomUUID();
    const { tx } = recordingTx((q) => (q.includes('from challenge_sessions') ? [{
      id, user_id: userId, board_id: boardId, format: 'map', status: 'active', position: 0, expires_at: T0.toISOString(),
      params: JSON.stringify(mapCfg()), total: 3, ai_units: 2,
    }] : []));
    expect(await sessionStore(tx).session(userId, id, false)).toMatchObject({ id, expiresAt: T0, params: mapCfg(), total: 3, aiUnits: 2 });
  });
});
