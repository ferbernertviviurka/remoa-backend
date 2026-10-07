import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AiError, type generateJson } from '@remoa/ai';
import { adviceMaterial, scorePercent, writeAdvice, type AdviceCandidates } from './advice';

const C1 = randomUUID();
const C2 = randomUUID();
const M1 = randomUUID();
const cands = (): AdviceCandidates => ({
  subject: 'Sepse',
  missed: [{ stem: 'Qual o prazo do antimicrobiano?', cardIds: [C2, C1] }],
  cards: [{ id: C1, title: 'Lactato' }, { id: C2, title: 'Prazo do antimicrobiano' }],
  maps: [{ id: M1, title: 'Sepse e choque séptico', ready: true }],
});
const asks = (data: unknown) => vi.fn(async () => ({ data, model: 'test/model', latencyMs: 5 })) as unknown as typeof generateJson;

describe('D-1567 study advice', () => {
  it('percent counts a partial as half, over the graded questions', () => {
    expect(scorePercent({ correct: 3, partial: 1 }, 5)).toBe(70);
    expect(scorePercent({ correct: 0, partial: 0 }, 0)).toBe(0);
  });

  it('the material lists the missed cards in order and the maps with short ids', () => {
    const { text, cardRef, mapRef } = adviceMaterial(cands());
    expect(text).toContain('[c1] Prazo do antimicrobiano');
    expect(text).toContain('[m1] Sepse e choque séptico (pronto)');
    expect(cardRef.get('c2')?.id).toBe(C1);
    expect(mapRef.get('m1')?.id).toBe(M1);
  });

  it('keeps only ids from the list and maps them back', async () => {
    const ask = asks({ mensagem: 'Erros no tempo.', cards: [{ id: 'c1', motivo: 'prazo' }, { id: 'c9', motivo: 'inventado' }], mapas: [{ id: 'm1', motivo: 'pacote' }] });
    const a = await writeAdvice(cands(), 40, 'r', { ask });
    expect(a).toEqual({
      message: 'Erros no tempo.',
      cards: [{ cardId: C2, title: 'Prazo do antimicrobiano', reason: 'prazo' }],
      maps: [{ boardId: M1, title: 'Sepse e choque séptico', ready: true, reason: 'pacote' }],
    });
  });

  it('without the model (error or nothing usable) it points to the missed cards, no text', async () => {
    const fail = vi.fn(async () => { throw new AiError('invalid_output'); }) as unknown as typeof generateJson;
    const fallback = { message: null, cards: [{ cardId: C2, title: 'Prazo do antimicrobiano', reason: null }, { cardId: C1, title: 'Lactato', reason: null }], maps: [] };
    expect(await writeAdvice(cands(), 40, 'r', { ask: fail })).toEqual(fallback);
    expect(await writeAdvice(cands(), 40, 'r', { ask: asks({ mensagem: 'x', cards: [{ id: 'c7', motivo: 'y' }], mapas: [] }) })).toEqual(fallback);
  });
});
