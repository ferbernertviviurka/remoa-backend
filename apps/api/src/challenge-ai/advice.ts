// D-1567: what to study after a challenge scored under ADVICE_BELOW. The model only picks among the cards behind the missed questions and
// the maps the student can open (own + ready library), by short ids; anything else in its reply is dropped. Without the model, the
// advice is those cards with no text, so a failed call still points somewhere.
import { z } from 'zod';
import { AiError, generateJson, loadChallengePrompt, renderChallengePrompt } from '@remoa/ai';
import { createLogger } from '@remoa/log';

export const ADVICE_BELOW = 70;
const MAX_PICKS = 3;

export type AdviceCandidates = {
  subject: string;
  missed: { stem: string; cardIds: string[] }[];
  cards: { id: string; title: string }[];
  maps: { id: string; title: string; ready: boolean }[];
};
export type StudyAdvice = {
  message: string | null;
  cards: { cardId: string; title: string; reason: string | null }[];
  maps: { boardId: string; title: string; ready: boolean; reason: string | null }[];
};

export const studyAdviceSchema = z.object({
  message: z.string().max(600).nullable(),
  cards: z.array(z.object({ cardId: z.string().uuid(), title: z.string(), reason: z.string().max(300).nullable() }).strict()).max(MAX_PICKS),
  maps: z.array(z.object({ boardId: z.string().uuid(), title: z.string(), ready: z.boolean(), reason: z.string().max(300).nullable() }).strict()).max(MAX_PICKS),
}).strict();

const pick = z.object({ id: z.string(), motivo: z.string().max(300) });
const replySchema = z.object({ mensagem: z.string().max(600), cards: z.array(pick).max(10), mapas: z.array(pick).max(10) });

/** Percent of the questions answered right; a partial counts half. */
export const scorePercent = (s: { correct: number; partial: number }, total: number) => (total ? Math.round((100 * (s.correct + s.partial / 2)) / total) : 0);

/** The cards behind the missed questions, in the order they were missed, no repeats. */
export function missedCards(c: AdviceCandidates) {
  const order = [...new Set(c.missed.flatMap((m) => m.cardIds))];
  return order.map((id) => c.cards.find((x) => x.id === id)).filter((x): x is AdviceCandidates['cards'][number] => Boolean(x));
}

export function fallbackAdvice(c: AdviceCandidates): StudyAdvice {
  return { message: null, cards: missedCards(c).slice(0, MAX_PICKS).map((x) => ({ cardId: x.id, title: x.title, reason: null })), maps: [] };
}

export function adviceMaterial(c: AdviceCandidates) {
  const cards = missedCards(c);
  const cardRef = new Map(cards.map((x, i) => [`c${i + 1}`, x]));
  const mapRef = new Map(c.maps.map((x, i) => [`m${i + 1}`, x]));
  const text = [
    'Perguntas com erro:',
    ...c.missed.map((m) => `- ${m.stem.replace(/\s+/g, ' ').slice(0, 400)}`),
    '',
    'Cards do mapa ligados a elas:',
    ...[...cardRef].map(([ref, x]) => `[${ref}] ${x.title}`),
    '',
    'Mapas que ele pode abrir:',
    ...[...mapRef].map(([ref, x]) => `[${ref}] ${x.title}${x.ready ? ' (pronto)' : ''}`),
  ].join('\n');
  return { text, cardRef, mapRef };
}

export type AdviceDeps = { ask: typeof generateJson };

export async function writeAdvice(
  c: AdviceCandidates, percent: number, requestId: string, deps: AdviceDeps = { ask: generateJson },
): Promise<StudyAdvice> {
  if (!c.missed.length) return fallbackAdvice(c);
  const log = createLogger({ requestId });
  const prompt = loadChallengePrompt('recomendar-estudo');
  const { text, cardRef, mapRef } = adviceMaterial(c);
  const rendered = renderChallengePrompt(prompt, { assunto: c.subject, publico: PUBLICO, nota: percent, material: text });
  if (!rendered.ok) return fallbackAdvice(c);
  try {
    const r = await deps.ask(replySchema, {
      fn: 'advice', system: rendered.data, user: 'Responda agora apenas com o JSON pedido.', temperature: prompt.meta.temperatura ?? undefined, requestId,
    });
    log.info('ai_call', { event: 'ai_call', fn: 'advice', model: r.model.slice(0, 80), latencyMs: Math.round(r.latencyMs), status: 'ok' });
    const cards = r.data.cards.flatMap((p) => {
      const x = cardRef.get(p.id.trim());
      return x ? [{ cardId: x.id, title: x.title, reason: p.motivo.trim() || null }] : [];
    });
    const maps = r.data.mapas.flatMap((p) => {
      const x = mapRef.get(p.id.trim());
      return x ? [{ boardId: x.id, title: x.title, ready: x.ready, reason: p.motivo.trim() || null }] : [];
    });
    const uniq = <T>(xs: T[], key: (x: T) => string) => xs.filter((x, i) => xs.findIndex((y) => key(y) === key(x)) === i).slice(0, MAX_PICKS);
    const advice = { message: r.data.mensagem.trim() || null, cards: uniq(cards, (x) => x.cardId), maps: uniq(maps, (x) => x.boardId) };
    return advice.cards.length || advice.maps.length ? advice : fallbackAdvice(c);
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
    log.warn('ai_error', { event: 'ai_error', fn: 'advice', type: e.code });
    return fallbackAdvice(c);
  }
}

const PUBLICO = 'estudantes de medicina do 5º e 6º ano e recém-formados que estudam para o ENAMED e a residência';
