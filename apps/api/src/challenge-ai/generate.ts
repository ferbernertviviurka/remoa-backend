// G25 (F32) T2: format-1 questions (FR-6–FR-14, FR-17, FR-19). Saved unseen questions first; the model only for what is missing,
// one generateJson call per batch (GEN_BATCH_SIZE), one retry per batch at most. Every kept question passed the server guards
// (literal evidence, grounded numbers, no duplicate) and is saved as `draft` (rule 6) through the server connection.
import { createGenerationReceipts, type GenerationReceipts } from '../questions/generation/receipts';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  err, generatedQuestionSchema, ok, questionBankServerSchema, EMPTY_QUESTION_STATS,
  type AppError, type ChallengeScope, type GeneratedQuestion, type QuestionBankServer, type QuestionDifficulty, type QuestionType, type Result,
} from '@remoa/contracts';
import {
  AiError, LETTERS, aiMode, challengeLimits, generateJson, keepDistinctStems, literalEvidence, loadChallengePrompt, numbersGrounded, remapLetters,
  renderChallengePrompt, shuffleAlternatives, type ChallengePrompt, type Evidence, type Letter,
} from '@remoa/ai';
import { createLogger } from '@remoa/log';
import { refundAt, reserveAi } from '../billing/quota';
import { invalidate } from '../cache';
import { shuffle } from '../challenge/build';
import { asServer, dbm, pgArray, run, uuids } from '../db';
import { matchClosedTopic } from './rubric';

// --- Map context ---------------------------------------------------------------------------------------------------

export type ScopeCard = {
  id: string;
  type: string;
  title: string;
  front: string | null;
  back: string | null;
  payload: unknown;
  didactics: unknown;
};
export type EnamedTags = { areaId: string | null; domainId: string | null; competencyId: string | null; topicId: string | null };
export const NO_TAGS: EnamedTags = { areaId: null, domainId: null, competencyId: null, topicId: null };
export type MapContext = {
  boardId: string;
  boardVersion: number;
  title: string;
  area: string;
  /** The scope's cards, in map order. */
  cards: ScopeCard[];
  edges: { fromCardId: string; toCardId: string; label: string | null }[];
  /** Inherited from the board's matrix item (FR-17); never invented here. */
  tags: EnamedTags;
  topicName: string | null;
  /** Closed list for a suggested topic. Absent in fixtures that do not classify. */
  topics?: readonly { id: string; code: string; name: string }[];
};

const TYPE_LABEL: Record<string, string> = { concept: 'conceito', flow: 'fluxograma', image: 'imagem', case: 'caso', note: 'conteúdo' };
const AREA_LABEL: Record<string, string> = {
  CM: 'Clínica Médica', CIR: 'Cirurgia', GO: 'Ginecologia e Obstetrícia', PED: 'Pediatria', MP: 'Medicina Preventiva', OUTRO: 'Outra',
};
const STAGE_LABEL: Record<string, string> = { presentation: 'apresentação', workup: 'investigação', diagnosis: 'diagnóstico', management: 'conduta' };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** What the card shows, as `label: text` lines. The evidence check and the prompt read the same text. */
export function cardFields(c: ScopeCard): [string, string][] {
  const p = rec(c.payload);
  const d = rec(c.didactics);
  const out: [string, string | null][] = [
    ['titulo', str(c.title)],
    ['frente', str(c.front)],
    ['verso', str(c.back)],
    ['porQue', str(d.porQue)],
    ['macete', str(rec(d.macete).texto)],
    ['pegadinha', str(d.pegadinha)],
    ['naProva', str(d.naProva)],
    ['naDiretriz', str(rec(d.naDiretriz).texto)],
  ];
  const steps = arr(p.steps).map((s) => str(rec(s).text)).filter((s): s is string => s !== null);
  if (steps.length) out.push(['passos', steps.map((s, i) => `${i + 1}) ${s}`).join(' ')]);
  const stages = arr(p.caseSteps).map((s) => {
    const t = str(rec(s).text);
    return t ? `${STAGE_LABEL[String(rec(s).stage)] ?? 'etapa'}: ${t}` : null;
  }).filter((s): s is string => s !== null);
  if (stages.length) out.push(['caso', stages.join(' | ')]);
  const labels = arr(p.masks).map((m) => str(rec(m).label)).filter((s): s is string => s !== null);
  if (labels.length) out.push(['imagem', `rótulos: ${labels.join(', ')}`]);
  return out.filter((f): f is [string, string] => f[1] !== null);
}

export const cardText = (c: ScopeCard) => cardFields(c).map(([, v]) => v).join('\n');

/** FORMATO-DO-MAPA-NO-PROMPT: short ids c1.. / e1.., text only. `refs` maps the short id back to the card id. */
export function serializeMap(ctx: MapContext): { text: string; refs: Map<string, ScopeCard> } {
  const refs = new Map<string, ScopeCard>();
  const short = new Map<string, string>();
  const lines = [`titulo: ${ctx.title}`, `area: ${AREA_LABEL[ctx.area] ?? ctx.area}`, 'cards:'];
  ctx.cards.forEach((c, i) => {
    const ref = `c${i + 1}`;
    refs.set(ref, c);
    short.set(c.id, ref);
    const d = rec(c.didactics);
    const tags = [`tipo=${TYPE_LABEL[c.type] ?? c.type}`, str(d.modulo) && `modulo=${String(d.modulo)}`, typeof d.nivel === 'number' && `nivel=${d.nivel}`].filter(Boolean);
    lines.push(`[${ref}] ${tags.join(' ')}`, ...cardFields(c).map(([k, v]) => `${k}: ${v.replace(/\s*\n\s*/g, ' ')}`));
  });
  const edges = ctx.edges.flatMap((e) => {
    const [a, b] = [short.get(e.fromCardId), short.get(e.toCardId)];
    return a && b ? [`${a} --${e.label?.trim() || 'conecta com'}--> ${b}`] : [];
  });
  if (edges.length) lines.push('conexoes:', ...edges.map((e, i) => `[e${i + 1}] ${e}`));
  return { text: lines.join('\n'), refs };
}

/** Card ids of a scope; `branch` follows the arrows from the root (the root included). */
export function scopeCardIds(scope: ChallengeScope, cards: readonly ScopeCard[], edges: MapContext['edges']): string[] {
  const live = new Set(cards.map((c) => c.id));
  if(scope.kind==='bankQuestion')return [];
  if (scope.kind === 'board') return cards.map((c) => c.id);
  if (scope.kind === 'card') return live.has(scope.cardId) ? [scope.cardId] : [];
  if (scope.kind === 'module') return cards.filter((c) => rec(c.didactics).modulo === scope.module).map((c) => c.id);
  if (!live.has(scope.rootCardId)) return [];
  const seen = new Set([scope.rootCardId]);
  for (let frontier = [scope.rootCardId]; frontier.length; ) {
    frontier = edges.filter((e) => frontier.includes(e.fromCardId) && live.has(e.toCardId) && !seen.has(e.toCardId)).map((e) => e.toCardId);
    for (const id of frontier) seen.add(id);
  }
  return cards.filter((c) => seen.has(c.id)).map((c) => c.id);
}

// --- Model output (the prompts' own shape) -------------------------------------------------------------------------

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const level = z.preprocess((v) => (typeof v === 'string' ? fold(v) : v), z.enum(['facil', 'medio', 'dificil']));
const evidence = z.object({ card: z.string().min(1).max(40), trecho: z.string().min(1).max(600) });
const common = {
  enunciado: z.string().min(1).max(4000),
  dificuldade: level,
  cards: z.array(z.string().min(1).max(40)).max(12).default([]),
  evidencias: z.array(evidence).min(1).max(6),
  tema_enamed_sugerido: z.string().max(200).nullish(),
};
const aviso = z.string().max(1000).nullish();
/** `gerar-perguntas-discursivas` v1 output. */
export const discursiveReplySchema = z.object({
  perguntas: z.array(z.object({
    ...common,
    resposta_esperada: z.string().min(1).max(4000),
    pontos_essenciais: z.array(z.string().min(1).max(400)).min(1).max(12),
    explicacao: z.string().max(4000).default(''),
  })).max(10),
  aviso,
});
/** `gerar-questoes-objetivas` v1 output. */
export const objectiveReplySchema = z.object({
  questoes: z.array(z.object({
    ...common,
    alternativas: z.object({ A: z.string().min(1).max(1000), B: z.string().min(1).max(1000), C: z.string().min(1).max(1000), D: z.string().min(1).max(1000) }),
    correta: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(LETTERS)),
    explicacao_correta: z.string().max(4000).default(''),
    explicacao_distratores: z.record(z.string(), z.string().max(600)).nullish(),
  })).max(10),
  aviso,
});
type DiscursiveItem = z.infer<typeof discursiveReplySchema>['perguntas'][number];
type ObjectiveItem = z.infer<typeof objectiveReplySchema>['questoes'][number];

/** AI=mock: one grounded question from the card title, no provider call. The title is already in the card text, so the guards pass. */
function offlineItems(type: QuestionType, refs: ReadonlyMap<string, ScopeCard>, size: number, focus: { ref: string; card: ScopeCard } | null): (DiscursiveItem | ObjectiveItem)[] {
  const pool = focus ? [[focus.ref, focus.card] as const] : [...refs];
  const items: (DiscursiveItem | ObjectiveItem)[] = [];
  for (const [ref, card] of pool) {
    if (items.length >= size) break;
    const trecho = card.title.replace(/\s+/g, ' ').trim().slice(0, 180);
    if (trecho.length < 4) continue;
    const base = { dificuldade: 'facil' as const, cards: [ref], evidencias: [{ card: ref, trecho }], tema_enamed_sugerido: null };
    items.push(type === 'objective'
      ? { ...base, enunciado: 'Qual registro o card traz?', alternativas: { A: 'Registro ausente neste card', B: trecho, C: 'Outro registro ausente', D: 'Nada foi escrito no card' }, correta: 'B' as const, explicacao_correta: trecho, explicacao_distratores: { A: 'Não aparece.', C: 'Não aparece.', D: 'Há registro.' } }
      : { ...base, enunciado: 'O que o card registra?', resposta_esperada: trecho, pontos_essenciais: [trecho], explicacao: trecho });
  }
  return items;
}

// --- Server guards -------------------------------------------------------------------------------------------------

export type DiscardReason = 'evidence' | 'numbers' | 'format' | 'duplicate';
export type Discarded = Record<DiscardReason, number>;
const noDiscards = (): Discarded => ({ evidence: 0, numbers: 0, format: 0, duplicate: 0 });
const addDiscards = (a: Discarded, b: Discarded) => {
  for (const k of Object.keys(a) as DiscardReason[]) a[k] += b[k];
};

const DIFFICULTY: Record<'facil' | 'medio' | 'dificil', QuestionDifficulty> = { facil: 'easy', medio: 'medium', dificil: 'hard' };
const DIFICULDADE: Record<QuestionDifficulty, GeneratedQuestion['dificuldade']> = { easy: 'facil', medium: 'medio', hard: 'dificil' };

/** FR-11: easy cites 1 card, medium 1 or 2, hard 2 or more; otherwise the level follows the number of cards cited. */
export function checkedDifficulty(claimed: QuestionDifficulty, cited: number): QuestionDifficulty {
  const fits = claimed === 'easy' ? cited === 1 : claimed === 'medium' ? cited >= 1 && cited <= 2 : cited >= 2;
  if (fits) return claimed;
  return cited <= 2 ? 'medium' : 'hard';
}

/** FR-10: no "todas/nenhuma das anteriores" (nor "todas as acima", "todas as alternativas"). */
const CATCH_ALL = /\b(?:todas|nenhuma)\s+(?:as|das)\s+(?:anteriores|acima|alternativas)\b|\b(?:todas|nenhuma)\s+(?:acima|anteriores)\b/;

export type Candidate = { question: GeneratedQuestion; cardIds: string[]; difficulty: QuestionDifficulty; suggestedTopic?: string | null };

/**
 * One reply through FR-8 (each `trecho` literal in the cited card), FR-9 (every number of the question, answer and explanation in
 * the cited cards; for objectives the correct option, not the distractors, which are wrong on purpose), FR-10 (4 distinct options,
 * no catch-all) and FR-12 (similarity < GEN_DUP_THRESHOLD against `existing` and the items kept before it).
 */
export function screenReply(
  type: QuestionType,
  items: readonly (DiscursiveItem | ObjectiveItem)[],
  refs: ReadonlyMap<string, ScopeCard>,
  existing: readonly string[],
  threshold = challengeLimits().dupThreshold,
): { kept: Candidate[]; discarded: Discarded } {
  const discarded = noDiscards();
  const texts = Object.fromEntries([...refs].map(([ref, c]) => [ref, cardText(c)]));
  const passed: Candidate[] = [];
  for (const item of items) {
    const evidencias: Evidence[] = item.evidencias.map((e) => ({ card: e.card.trim(), trecho: e.trecho }));
    const cited = [...new Set([...evidencias.map((e) => e.card), ...item.cards.map((c) => c.trim())])];
    if (!cited.every((r) => refs.has(r)) || !literalEvidence(evidencias, texts)) {
      discarded.evidence++;
      continue;
    }
    const citedTexts = cited.map((r) => texts[r] ?? '');
    const objective = type === 'objective' && 'alternativas' in item ? item : null;
    const discursive = type === 'discursive' && 'resposta_esperada' in item ? item : null;
    if (!objective && !discursive) {
      discarded.format++;
      continue;
    }
    const checked = objective
      ? [objective.enunciado, objective.alternativas[objective.correta], objective.explicacao_correta]
      : [discursive!.enunciado, discursive!.resposta_esperada, discursive!.explicacao, ...discursive!.pontos_essenciais];
    if (!numbersGrounded(checked, citedTexts)) {
      discarded.numbers++;
      continue;
    }
    if (objective) {
      const options = LETTERS.map((l) => objective.alternativas[l]);
      if (new Set(options.map(fold)).size !== 4 || options.some((o) => CATCH_ALL.test(fold(o)))) {
        discarded.format++;
        continue;
      }
    }
    const difficulty = checkedDifficulty(DIFFICULTY[item.dificuldade], cited.length);
    const cardIds = cited.map((r) => refs.get(r)!.id);
    const evid = evidencias.map((e) => ({ card: refs.get(e.card)!.id, trecho: e.trecho.trim() }));
    const draft: GeneratedQuestion = objective
      ? {
          tipo: 'objetiva', dificuldade: DIFICULDADE[difficulty], enunciado: objective.enunciado.trim(),
          alternativas: LETTERS.map((l) => ({ letra: l, texto: objective.alternativas[l].trim() })), correta: objective.correta,
          resposta_esperada: objective.alternativas[objective.correta].trim(), pontos_essenciais: [objective.alternativas[objective.correta].trim()],
          explicacao: objective.explicacao_correta, notas_distratores: distractorNotes(objective), evidencias: evid, tema: null,
        }
      : {
          tipo: 'discursiva', dificuldade: DIFICULDADE[difficulty], enunciado: discursive!.enunciado.trim(), alternativas: null, correta: null,
          resposta_esperada: discursive!.resposta_esperada.trim(), pontos_essenciais: discursive!.pontos_essenciais, explicacao: discursive!.explicacao,
          notas_distratores: null, evidencias: evid, tema: null,
        };
    const parsed = generatedQuestionSchema.safeParse(draft);
    if (!parsed.success) {
      discarded.format++;
      continue;
    }
    passed.push({ question: parsed.data, cardIds, difficulty, suggestedTopic: item.tema_enamed_sugerido?.trim() || null });
  }
  const keep = new Set(keepDistinctStems(passed.map((p) => p.question.enunciado), existing, threshold));
  discarded.duplicate += passed.length - keep.size;
  return { kept: passed.filter((_, i) => keep.has(i)), discarded };
}

function distractorNotes(item: ObjectiveItem): GeneratedQuestion['notas_distratores'] {
  const notes = Object.fromEntries(
    Object.entries(item.explicacao_distratores ?? {})
      .map(([k, v]) => [k.trim().toUpperCase(), v.trim()] as const)
      .filter(([k, v]) => (LETTERS as readonly string[]).includes(k) && k !== item.correta && v),
  );
  return Object.keys(notes).length ? notes : null;
}

const classificationSchema = z.object({
  classificacoes: z.array(z.object({ tema: z.string().max(200), confianca: z.number().min(0).max(1) })).max(10),
}).strict();

/**
 * FR-17: one short call when the map has no topic and the model's suggestion is not an exact closed-list name.
 * A name outside the list is dropped. Failure leaves the question untagged so the student can still confirm it.
 */
async function classifyTopics(items: readonly Candidate[], ctx: MapContext, requestId: string): Promise<Map<number, { id: string; confidence: number }>> {
  const topics = ctx.topics ?? [];
  const out = new Map<number, { id: string; confidence: number }>();
  if (aiMode() !== 'live' || !topics.length || ctx.tags.topicId) return out;
  const pending = items.map((c, i) => ({ c, i })).filter(({ c }) => !matchClosedTopic(c.suggestedTopic, topics));
  if (!pending.length) return out;
  const prompt = loadChallengePrompt('classificar-tema');
  const rendered = renderChallengePrompt(prompt, {
    assunto: ctx.title,
    lista: topics.map((t) => t.name).join('\n'),
    perguntas: pending.map(({ c }, n) => `${n + 1}. ${c.question.enunciado.replace(/\s+/g, ' ')}`).join('\n'),
  });
  if (!rendered.ok) return out;
  try {
    const r = await generateJson(classificationSchema, {
      fn: 'classify-topic', system: rendered.data, user: 'Responda agora apenas com o JSON pedido.', temperature: 0, requestId,
    });
    pending.forEach(({ i }, n) => {
      const row = r.data.classificacoes[n];
      if (!row || row.confianca <= 0) return;
      const id = matchClosedTopic(row.tema, topics);
      if (id) out.set(i, { id, confidence: row.confianca });
    });
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
  }
  return out;
}

/** The bank row. A–D shuffled here with `seed` (the model tends to put the answer in B); distractor notes follow their letters. */
export function toRow(
  c: Candidate,
  meta: { id: string; userId: string; ctx: MapContext; prompt: ChallengePrompt; model: string; seed: string; now: Date; classified?: { id: string; confidence: number } | null },
): QuestionBankServer {
  const q = c.question;
  let alternatives: QuestionBankServer['alternatives'] = null;
  let correctKey: QuestionBankServer['correctKey'] = null;
  let notes: QuestionBankServer['distractorNotes'] = null;
  if (q.alternativas && q.correta) {
    const byLetter = Object.fromEntries(q.alternativas.map((a) => [a.letra, a.texto])) as Record<Letter, string>;
    const s = shuffleAlternatives(byLetter, q.correta, meta.seed);
    alternatives = LETTERS.map((l) => ({ key: l, text: s.alternativas[l] }));
    correctKey = s.correta;
    notes = q.notas_distratores ? remapLetters(q.notas_distratores, s.from) : null;
  }
  const { tags } = meta.ctx;
  const topicId = tags.topicId ?? matchClosedTopic(c.suggestedTopic, meta.ctx.topics ?? []) ?? meta.classified?.id ?? null;
  const confidence = meta.classified && topicId === meta.classified.id ? meta.classified.confidence : null;
  return questionBankServerSchema.parse({
    id: meta.id, userId: meta.userId, boardId: meta.ctx.boardId, boardVersion: meta.ctx.boardVersion, cardIds: c.cardIds,
    type: alternatives ? 'objective' : 'discursive', difficulty: c.difficulty, stem: q.enunciado, alternatives, correctKey,
    expectedAnswer: q.resposta_esperada, keyPoints: q.pontos_essenciais, explanation: q.explicacao || null, distractorNotes: notes,
    evidences: q.evidencias.map((e) => ({ cardId: e.card, excerpt: e.trecho })),
    enamedAreaId: tags.areaId, enamedDomainId: tags.domainId, enamedCompetencyId: tags.competencyId, enamedTopicId: topicId,
    // Confirmed only when the map already had the topic. A closed-list match or a classifier proposal stays unconfirmed.
    enamedConfidence: confidence, enamedConfirmed: tags.topicId !== null && topicId === tags.topicId,
    source: 'ai', promptId: meta.prompt.meta.id, promptVersion: meta.prompt.promptVersion, model: meta.model, status: 'draft',
    stats: EMPTY_QUESTION_STATS, version: 1, supersedesId: null, createdAt: meta.now,
  });
}

/** FR-17: a saved question always has an ENAMED area and topic. Anything else counts as shortfall. */
function keepTagged(rows: QuestionBankServer[]): QuestionBankServer[] {
  return rows.filter((r) => Boolean(r.enamedAreaId) && Boolean(r.enamedTopicId));
}

// --- Store (server connection) -------------------------------------------------------------------------------------

export type QuestionStore = {
  /** The board (owner only) and the scope's live cards; null = not the user's board. */
  context(userId: string, boardId: string, scope: ChallengeScope): Promise<MapContext | null>;
  /** FR-19: saved, tagged, not archived, latest version, never put in a session, every cited card inside the scope. Oldest first. */
  unseen(userId: string, boardId: string, cardIds: readonly string[], type: QuestionType, difficulty: QuestionDifficulty | null, limit: number): Promise<QuestionBankServer[]>;
  /** Every stem saved on the map (FR-12), newest first. */
  stems(userId: string, boardId: string): Promise<string[]>;
  /** FR-7: the last stems saved for this scope, newest first. */
  recentStems(userId: string, boardId: string, cardIds: readonly string[], limit: number): Promise<string[]>;
  save(userId: string, rows: readonly QuestionBankServer[]): Promise<void>;
};

/** FR-12 compares against this many of the map's stems (newest first). */
const STEM_SCAN = 500;

const bankRow = (r: typeof import('@remoa/db').questionBank.$inferSelect): QuestionBankServer =>
  questionBankServerSchema.parse(Object.fromEntries(Object.keys(questionBankServerSchema.innerType().shape).map((k) => [k, r[k as keyof typeof r]])));

export const dbStore: QuestionStore = {
  async context(userId, boardId, scope) {
    return run(userId, async (tx, s) => {
      const [board] = await tx.select({ id: s.boards.id, title: s.boards.title, area: s.boards.area, version: s.boards.version, matrixItemId: s.boards.matrixItemId })
        .from(s.boards).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId)));
      if (!board) return null;
      const all = await tx.select({ id: s.cards.id, type: s.cards.type, title: s.cards.title, front: s.cards.front, back: s.cards.back, payload: s.cards.payload, didactics: s.cards.didactics })
        .from(s.cards).where(and(eq(s.cards.boardId, boardId), isNull(s.cards.deletedAt), isNull(s.cards.suspendedAt)))
        .orderBy(asc(s.cards.order), asc(s.cards.createdAt));
      const edges = await tx.select({ fromCardId: s.edges.fromCardId, toCardId: s.edges.toCardId, label: s.edges.label }).from(s.edges).where(eq(s.edges.boardId, boardId));
      const ids = new Set(scopeCardIds(scope, all, edges));
      const [item] = board.matrixItemId ? [{ id: board.matrixItemId }] : await tx.select({ id: s.boardMatrixItems.matrixItemId }).from(s.boardMatrixItems)
        .where(eq(s.boardMatrixItems.boardId, boardId)).orderBy(asc(s.boardMatrixItems.createdAt)).limit(1);
      const chain = item ? await tx.execute<{ id: string; kind: string; name: string }>(sql`
        with recursive up as (
          select id, kind, parent_id, name from enamed_taxonomy where matrix_ref = ${item.id}
          union all
          select t.id, t.kind, t.parent_id, t.name from enamed_taxonomy t join up on t.id = up.parent_id
        ) select id, kind, name from up`) : [];
      const of = (kind: string) => chain.find((r) => r.kind === kind);
      const [areaRow] = of('area') ? [] : await tx.execute<{ id: string }>(sql`select id from enamed_taxonomy where kind = 'area' and code = ${board.area} limit 1`);
      const topics = await tx.execute<{ id: string; code: string; name: string }>(sql`select id, code, name from enamed_taxonomy where kind = 'topic' and area = ${board.area}`);
      return {
        boardId, boardVersion: board.version, title: board.title, area: board.area,
        cards: all.filter((c) => ids.has(c.id)), edges: edges.filter((e) => ids.has(e.fromCardId) && ids.has(e.toCardId)),
        tags: { areaId: of('area')?.id ?? areaRow?.id ?? null, domainId: of('domain')?.id ?? null, competencyId: of('competency')?.id ?? null, topicId: of('topic')?.id ?? null },
        topicName: of('topic')?.name ?? null,
        topics,
      };
    });
  },
  async unseen(userId, boardId, cardIds, type, difficulty, limit) {
    if (!cardIds.length || limit <= 0) return [];
    const { db, questionBank: q } = await dbm();
    const rows = await db.select().from(q).where(and(
      eq(q.userId, userId), eq(q.boardId, boardId), eq(q.type, type), ne(q.status, 'archived'),
      eq(q.visibility, 'private'), sql`${q.origin} in ('ai_generated','user_authored')`,
      sql`(${q.type}<>'objective' or (jsonb_array_length(${q.alternatives})=4 and ${q.correctKey} in ('A','B','C','D')))` ,
      isNotNull(q.enamedAreaId), isNotNull(q.enamedTopicId),
      difficulty ? eq(q.difficulty, difficulty) : undefined,
      sql`cardinality(${q.cardIds}) > 0 and ${q.cardIds} <@ ${uuids(cardIds)}`,
      sql`not exists (select 1 from question_bank n where n.supersedes_id = ${q.id})`,
      sql`not exists (select 1 from challenge_items i where i.bank_id = ${q.id} and i.user_id = ${userId})`,
    )).orderBy(asc(q.createdAt)).limit(limit);
    return rows.map(bankRow);
  },
  async stems(userId, boardId) {
    const { db, questionBank: q } = await dbm();
    const rows = await db.select({ stem: q.stem }).from(q).where(and(eq(q.userId, userId), eq(q.boardId, boardId))).orderBy(desc(q.createdAt)).limit(STEM_SCAN);
    return rows.map((r) => r.stem);
  },
  async recentStems(userId, boardId, cardIds, limit) {
    if (!cardIds.length) return [];
    const { db, questionBank: q } = await dbm();
    const rows = await db.select({ stem: q.stem }).from(q)
      .where(and(eq(q.userId, userId), eq(q.boardId, boardId), sql`${q.cardIds} && ${pgArray(cardIds, 'uuid')}`)).orderBy(desc(q.createdAt)).limit(limit);
    return rows.map((r) => r.stem);
  },
  async save(userId, rows) {
    if (!rows.length) return;
    await run(userId, async (tx, s) => {
      const [own] = await tx.select({ id: s.boards.id }).from(s.boards).where(eq(s.boards.id, rows[0]!.boardId!)); // RLS: the user's board
      if (!own) throw new Error('board_not_found');
      // `authenticated` has no grant on the answer columns: the insert runs as the server role inside this transaction
      await asServer(tx, tx.insert(s.questionBank).values(rows.map((r) => ({ ...r, userId }))).getSQL());
    });
    await invalidate('question.changed', { userId, mapId: rows[0]!.boardId ?? undefined });
  },
};

// --- Service -------------------------------------------------------------------------------------------------------

export type GenerateInput = {
  userId: string;
  boardId: string;
  scope: ChallengeScope;
  n: number;
  questionType: QuestionType | 'mixed';
  difficulty: QuestionDifficulty | 'mixed';
  /** Shuffle seed; default the row id. Same seed and same question = same A–D order. */
  seed?: string;
  requestId?: string;
  /**
   * D-1566 / D-1637: default one `ai_question_batches` unit per model batch. `once`: one unit up front, back when nothing is delivered or
   * when every question was a reuse (no model call). `none`: this session already paid on an earlier call.
   */
  charge?: 'once' | 'none';
  /** D-1566: the question must cite this card: the scope's card, else the `index`-th of the scope in a `seed` order (one card per step). */
  focus?: { seed: string; index: number };
};

export type GenerateOutput = {
  /** Reused first (FR-19), then the new ones. Server rows: never send as they are (FR-36). */
  questions: QuestionBankServer[];
  requested: number;
  reused: number;
  generated: number;
  /** Requested minus delivered (FR-8: "entrega o que há e avisa"). */
  shortfall: number;
  calls: number;
  discarded: Discarded;
  /** Why generation stopped before the end, if it did. */
  stoppedBy: null | 'quota' | 'ai_error';
};

export type GenerateDeps = { store: QuestionStore; now: () => Date; newId: () => string; receipts?: typeof createGenerationReceipts };
const defaultDeps: GenerateDeps = { store: dbStore, now: () => new Date(), newId: randomUUID, receipts:createGenerationReceipts };

export const PROMPT_FOR: Record<QuestionType, 'gerar-perguntas-discursivas' | 'gerar-questoes-objetivas'> = {
  discursive: 'gerar-perguntas-discursivas',
  objective: 'gerar-questoes-objetivas',
};
/** FR-7. */
export const RECENT_STEMS = 30;
const PUBLICO = 'estudantes de medicina do 5º e 6º ano e recém-formados que estudam para o ENAMED e a residência';
const NIVEL: Record<QuestionDifficulty | 'mixed', string> = { easy: 'fácil', medium: 'médio', hard: 'difícil', mixed: 'misto (fácil, médio e difícil)' };

function scopeLabel(scope: ChallengeScope, ctx: MapContext): string {
  const title = (id: string) => ctx.cards.find((c) => c.id === id)?.title ?? 'card';
  if (scope.kind === 'card') return `um card: ${title(scope.cardId)}`;
  if (scope.kind === 'module') return `módulo ${scope.module} do mapa`;
  if (scope.kind === 'branch') return `ramo do mapa a partir de: ${title(scope.rootCardId)}`;
  return 'o mapa inteiro';
}

function focusRef(scope: ChallengeScope, refs: ReadonlyMap<string, ScopeCard>, f: { seed: string; index: number }) {
  const all = [...refs].sort(([, a], [, b]) => (a.id < b.id ? -1 : 1));
  const order = shuffle(all, f.seed);
  const [ref, card] = (scope.kind === 'card' && all.find(([, c]) => c.id === scope.cardId)) || order[f.index % order.length]!;
  return { ref, card };
}

/** FR-2 mixed: half discursive (rounded down), the rest objective. */
const plan = (n: number, t: GenerateInput['questionType']): [QuestionType, number][] =>
  t === 'mixed' ? ([['discursive', Math.floor(n / 2)], ['objective', n - Math.floor(n / 2)]] as [QuestionType, number][]).filter(([, k]) => k > 0) : [[t, n]];

async function ask(type: QuestionType, prompt: ChallengePrompt, vars: Record<string, string | number>, requestId: string) {
  const rendered = renderChallengePrompt(prompt, vars);
  if (!rendered.ok) throw new Error(`prompt_variable:${rendered.variable}`);
  const call = { fn: 'generate', system: rendered.data, user: 'Responda agora apenas com o JSON pedido.', temperature: prompt.meta.temperatura ?? undefined, requestId };
  if (type === 'objective') {
    const r = await generateJson(objectiveReplySchema, call);
    return { items: r.data.questoes, model: r.model, latencyMs: r.latencyMs };
  }
  const r = await generateJson(discursiveReplySchema, call);
  return { items: r.data.perguntas, model: r.model, latencyMs: r.latencyMs };
}

/**
 * FR-6–FR-14, FR-19. Per type: unseen saved questions first, then batches of at most GEN_BATCH_SIZE for the rest. Each batch takes one
 * `ai_question_batches` unit before its call (reuse alone takes none) and makes one call, plus one retry if guards left it short.
 * The unit goes back when the first call fails or the rows fail validation or the insert; a call that answered keeps it even if every
 * question was discarded. A failed retry keeps what the first call gave.
 */
export async function generateQuestions(input: GenerateInput, deps: GenerateDeps = defaultDeps): Promise<Result<GenerateOutput>> {
  if(input.scope.kind==='bankQuestion')return err('validation','saved_question_requires_start_endpoint');
  if (input.charge !== 'once') return generateBatches(input, deps);
  const held = await reserveAi(input.userId, 'ai_question_batches', deps.now());
  if (!held.ok) return held;
  try {
    const r = await generateBatches({ ...input, charge: 'none' }, deps);
    // D-1637: a reuse delivers questions with zero model calls, and that must not keep the unit (FR-19, FR-60).
    if (!r.ok || !r.data.questions.length || r.data.calls === 0) await held.refund().catch(() => undefined);
    return r;
  } catch (e) {
    await held.refund().catch(() => undefined);
    throw e;
  }
}

async function generateBatches(input: GenerateInput, deps: GenerateDeps): Promise<Result<GenerateOutput>> {
  const { store } = deps;
  const ctx = await store.context(input.userId, input.boardId, input.scope);
  if (!ctx) return err('not_found', 'board not found');
  if (!ctx.cards.length) return err('validation', 'empty_scope');
  const scopeIds = ctx.cards.map((c) => c.id);
  const difficulty = input.difficulty === 'mixed' ? null : input.difficulty;
  const { genBatchSize, dupThreshold } = challengeLimits();
  const { text: mapa, refs } = serializeMap(ctx);
  const focus = input.focus ? focusRef(input.scope, refs, input.focus) : null;
  const log = createLogger({ requestId: input.requestId ?? 'challenge-generate' });
  const out: GenerateOutput = { questions: [], requested: input.n, reused: 0, generated: 0, shortfall: 0, calls: 0, discarded: noDiscards(), stoppedBy: null };
  let failure: AppError | null = null;

  const types = plan(input.n, input.questionType);
  const fresh: QuestionBankServer[] = [];
  const reusedAll: QuestionBankServer[] = [];
  let mapStems: string[] | null = null;
  let recent: string[] | null = null;
  let batchNo=0;

  for (const [type, count] of types) {
    const reused = await store.unseen(input.userId, ctx.boardId, scopeIds, type, difficulty, count);
    reusedAll.push(...reused);
    let missing = count - reused.length;
    if (missing <= 0 || out.stoppedBy) continue;
    mapStems ??= await store.stems(input.userId, ctx.boardId);
    recent ??= await store.recentStems(input.userId, ctx.boardId, scopeIds, RECENT_STEMS);
    const prompt = loadChallengePrompt(PROMPT_FOR[type]);
    const baseVars = {
      assunto: ctx.title, area: AREA_LABEL[ctx.area] ?? ctx.area, tema: ctx.topicName ?? 'não informado', publico: PUBLICO,
      dificuldade: NIVEL[input.difficulty], mapa,
      escopo: focus
        ? `${scopeLabel(input.scope, ctx)}. Esta pergunta é sobre o card [${focus.ref}] (${focus.card.title}): cite-o nas evidências e use as conexões dele no mapa`
        : scopeLabel(input.scope, ctx),
    };

    while (missing > 0 && !out.stoppedBy) {
      const size = Math.min(genBatchSize, missing);
      const receiptBatch=batchNo++;
      const ledgers:GenerationReceipts[]=[];
      const held = input.charge ? null : await reserveAi(input.userId, 'ai_question_batches', deps.now());
      if (held && !held.ok) {
        out.stoppedBy = 'quota';
        failure = held.error;
        break;
      }
      const period = held?.quota.period;
      let refunded = !period;
      const refund = async () => {
        if (refunded) return;
        refunded = true;
        await refundAt(input.userId, 'ai_question_batches', period!).catch(() => undefined);
      };
      const kept: Candidate[] = [];
      const offFocus: Candidate[] = [];
      let model = '';
      const existingStems = () => [...mapStems!, ...kept.map((k) => k.question.enunciado)];
      const avoid = () => [...kept.map((k) => k.question.enunciado).reverse(), ...recent!].slice(0, RECENT_STEMS);
      const vars = (k: number) => ({ ...baseVars, n: k, perguntas_existentes: avoid().map((s) => `- ${s.replace(/\s+/g, ' ')}`).join('\n') || '(nenhuma)' });

      for (let attempt = 0; attempt < 2 && kept.length < size; attempt++) {
        if (aiMode() !== 'live') {
          const screened = screenReply(type, offlineItems(type, refs, size - kept.length, focus), refs, existingStems(), dupThreshold);
          addDiscards(out.discarded, screened.discarded);
          const onFocus = focus ? screened.kept.filter((k) => k.cardIds.includes(focus.card.id)) : screened.kept;
          offFocus.push(...screened.kept.filter((k) => !onFocus.includes(k)));
          kept.push(...onFocus.slice(0, size - kept.length));
          model = 'offline';
          break;
        }
        let reply: Awaited<ReturnType<typeof ask>>;
        try {
          out.calls++;
          const ledger=deps.receipts?.({ownerId:input.userId,producer:type==='objective'?'challenge_objective':'challenge_discursive',requestKey:`${input.seed??input.requestId??randomUUID()}:${type}:${receiptBatch}:${attempt}`,promptId:prompt.meta.id,promptVersion:prompt.promptVersion,boardId:ctx.boardId,boardVersion:ctx.boardVersion,context:{scope:input.scope,n:input.n,difficulty:input.difficulty,focus:input.focus,refs:[...refs],tags:ctx.tags}});
          if(ledger)ledgers.push(ledger);
          const call=()=>ask(type,prompt,vars(size-kept.length),input.requestId??'challenge-generate');
          reply=ledger?await ledger.wrap(call):await call();
        } catch (e) {
          log.warn('ai_error', { event: 'ai_error', fn: 'generate', type: e instanceof AiError ? e.code : 'failed', attempt });
          if (attempt === 0) await refund(); // the batch produced nothing
          if (!(e instanceof AiError)) throw e;
          if (attempt === 0) {
            out.stoppedBy = 'ai_error';
            failure = { code: e.code === 'rate_limited' || e.code === 'quota_exceeded' ? 'rate_limited' : 'ai_unavailable', message: e.userMessage };
          }
          break;
        }
        model ||= reply.model;
        log.info('ai_call', { event: 'ai_call', fn: 'generate', model: reply.model.slice(0, 80), latencyMs: Math.round(reply.latencyMs), status: 'ok', attempt });
        const screened = screenReply(type, reply.items, refs, existingStems(), dupThreshold);
        const decisions=new Map<string,{state:'rejected'|'duplicate';reason:string}>();
        for(const item of reply.items){const one=screenReply(type,[item],refs,existingStems(),dupThreshold);const reason=Object.entries(one.discarded).find(([,n])=>n>0)?.[0];if(reason)decisions.set(item.enunciado,{state:reason==='duplicate'?'duplicate':'rejected',reason});}
        if(ledgers.at(-1))try{await ledgers.at(-1)!.markScreened(decisions);}catch(error){await refund();throw error;}
        addDiscards(out.discarded, screened.discarded);
        const onFocus = focus ? screened.kept.filter((k) => k.cardIds.includes(focus.card.id)) : screened.kept;
        offFocus.push(...screened.kept.filter((k) => !onFocus.includes(k)));
        log.info('generate_screened', { event: 'generate_screened', attempt, items: reply.items.length, kept: onFocus.length, offFocus: screened.kept.length - onFocus.length, ...screened.discarded });
        kept.push(...onFocus.slice(0, size - kept.length));
      }
      // the focus card is a preference: a grounded question on another card of the map beats an empty step
      kept.push(...offFocus.slice(0, size - kept.length));

      try {
        const now = deps.now();
        const classified = await classifyTopics(kept, ctx, input.requestId ?? 'challenge-generate');
        const rows = kept.map((c, i) => {
          const id = deps.newId();
          return toRow(c, { id, userId: input.userId, ctx, prompt, model, seed: input.seed ? `${input.seed}:${c.question.enunciado}` : id, now, classified: classified.get(i) ?? null });
        });
        const stored = keepTagged(rows);
        if(ledgers.length){const first=ledgers[0]!;first.runs.push(...ledgers.slice(1).flatMap(l=>l.runs));await first.saveRows(stored);}else await store.save(input.userId, stored);
        fresh.push(...stored);
        mapStems.push(...stored.map((r) => r.stem));
        recent.unshift(...stored.map((r) => r.stem).reverse());
      } catch (e) {
        await refund();
        throw e;
      }
      if (out.stoppedBy) break;
      missing -= size;
      // a batch left short after its retry ends this type: another batch would ask the same map again (FR-8, one retry)
      if (kept.length < size) break;
    }
  }

  out.questions = [...reusedAll, ...fresh];
  out.reused = reusedAll.length;
  out.generated = fresh.length;
  out.shortfall = Math.max(0, input.n - out.questions.length);
  if (!out.questions.length && failure) return { ok: false, error: failure };
  return ok(out);
}
