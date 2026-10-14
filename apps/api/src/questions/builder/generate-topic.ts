/**
 * D-1882 (F34): exam-builder questions written by the model for taxonomy topics and/or a free theme, without a map.
 * Same budget as the map path (generate.ts): batches of EXAM_GENERATE_CHUNK, one `ai_question_batches` unit per GEN_BATCH_SIZE new
 * questions, one retry per batch, a few short batches tolerated. No map means no literal evidence: the guards are format (4 distinct
 * options, no catch-all), duplicate stem and a topic from the closed list. Every row is private, `draft` (rule 6), area + topic set.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { EXAM_GENERATE_CHUNK, err, ok, type AppError, type QuestionDifficulty, type Result } from '@remoa/contracts';
import {
  AiError, LETTERS, aiMode, challengeLimits, generateJson, keepDistinctStems, loadChallengePrompt, remapLetters, renderChallengePrompt, shuffleAlternatives, type Letter,
} from '@remoa/ai';
import { createLogger } from '@remoa/log';
import { reserveAi } from '../../billing/quota';
import { invalidate } from '../../cache';
import { NIVEL, PUBLICO, objectiveReplySchema } from '../../challenge-ai/generate';
import { matchClosedTopic } from '../../challenge-ai/rubric';
import { asServer, dbm, pgArray, run } from '../../db';

export type TopicRef = { id: string; code: string; name: string; areaId: string | null; areaName: string | null; domainId: string | null; competencyId: string | null };
export type TopicRow = {
  id: string; userId: string; boardId: null; type: 'objective'; difficulty: QuestionDifficulty; stem: string;
  alternatives: { key: Letter; text: string }[]; correctKey: Letter; expectedAnswer: string; keyPoints: string[]; explanation: string | null;
  distractorNotes: Partial<Record<Letter, string>> | null; enamedAreaId: string | null; enamedDomainId: string | null; enamedCompetencyId: string | null;
  enamedTopicId: string; enamedConfirmed: boolean; source: 'ai'; promptId: string; promptVersion: string; model: string; status: 'draft'; createdAt: Date;
};
export type TopicStore = {
  /** Closed list: the topics under topicIds (a topic is under itself); else under areaIds; else every topic. */
  topics(areaIds: readonly string[], topicIds: readonly string[]): Promise<TopicRef[]>;
  /** The user's own stems on these topics, newest first (FR-12 duplicate check). */
  stems(userId: string, topicIds: readonly string[]): Promise<string[]>;
  save(userId: string, rows: readonly TopicRow[]): Promise<void>;
};
export type TopicGenerateInput = {
  userId: string; areaIds: readonly string[]; topicIds: readonly string[]; theme: string | null; n: number;
  difficulty: QuestionDifficulty | 'mixed'; requestId?: string; onProgress?: (delivered: number) => void | Promise<void>;
};
export type TopicGenerateOutput = {
  questions: TopicRow[]; requested: number; reused: 0; generated: number; shortfall: number; calls: number;
  discarded: { format: number; duplicate: number; untagged: number }; stoppedBy: null | 'quota' | 'ai_error';
};
export type TopicDeps = { store: TopicStore; now: () => Date; newId: () => string };

/** Short batches tolerated before giving up (each re-asks only what is missing, never charged again). */
export const EXTRA_BATCHES = 2;
const STEM_SCAN = 500;
const CATCH_ALL = /\b(?:todas|nenhuma)\s+(?:as|das)\s+(?:anteriores|acima|alternativas)\b|\b(?:todas|nenhuma)\s+(?:acima|anteriores)\b/;
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const DIFFICULTY = { facil: 'easy', medio: 'medium', dificil: 'hard' } as const;
export const topicReplySchema = z.object({
  questoes: z.array(objectiveReplySchema.shape.questoes.element.omit({ cards: true, evidencias: true, tema_enamed_sugerido: true }).extend({ tema: z.string().max(200).nullish() })).max(10),
  aviso: z.string().max(1000).nullish(),
});
type Item = z.infer<typeof topicReplySchema>['questoes'][number];
type Kept = { item: Item; topic: TopicRef };

/** AI=mock: distinct synthetic stems (a random id dominates the text, so the duplicate guard keeps them), round-robin over the topics. */
function offlineItems(topics: readonly TopicRef[], size: number, from: number): Item[] {
  return Array.from({ length: size }, (_, i) => {
    const t = topics[(from + i) % topics.length]!;
    return {
      enunciado: `Questão simulada (AI=mock) ${randomUUID()} ${randomUUID()}: qual é a matéria?`, dificuldade: 'facil' as const,
      alternativas: { A: t.name, B: 'Outra matéria simulada', C: 'Nenhuma matéria listada', D: 'Matéria fora da lista' }, correta: 'A' as const,
      explicacao_correta: t.name, explicacao_distratores: null, tema: t.code, // code: names may repeat in a list
    };
  });
}

/** Format, topic and duplicate guards. A topic outside the list is kept only when the list has a single topic. */
export function screenTopicItems(items: readonly Item[], topics: readonly TopicRef[], existing: readonly string[], threshold = challengeLimits().dupThreshold) {
  const discarded = { format: 0, duplicate: 0, untagged: 0 };
  const passed: Kept[] = [];
  for (const item of items) {
    const options = LETTERS.map((l) => item.alternativas[l]);
    if (new Set(options.map(fold)).size !== 4 || options.some((o) => CATCH_ALL.test(fold(o)))) { discarded.format++; continue; }
    const id = matchClosedTopic(item.tema, topics) ?? (topics.length === 1 ? topics[0]!.id : null);
    const topic = topics.find((t) => t.id === id);
    if (!topic) { discarded.untagged++; continue; }
    passed.push({ item, topic });
  }
  const keep = new Set(keepDistinctStems(passed.map((p) => p.item.enunciado), existing, threshold));
  discarded.duplicate += passed.length - keep.size;
  return { kept: passed.filter((_, i) => keep.has(i)), discarded };
}

export function topicRow(k: Kept, meta: { id: string; userId: string; difficulty: QuestionDifficulty | 'mixed'; promptId: string; promptVersion: string; model: string; now: Date; confirmed: boolean }): TopicRow {
  const { item, topic } = k;
  const s = shuffleAlternatives(item.alternativas, item.correta, meta.id);
  const notes = Object.fromEntries(Object.entries(item.explicacao_distratores ?? {}).map(([l, v]) => [l.trim().toUpperCase(), v.trim()] as const)
    .filter(([l, v]) => (LETTERS as readonly string[]).includes(l) && l !== item.correta && v));
  const answer = item.alternativas[item.correta].trim();
  return {
    id: meta.id, userId: meta.userId, boardId: null, type: 'objective',
    // the model was asked this level; a "mixed" request keeps the level it reports
    difficulty: meta.difficulty === 'mixed' ? DIFFICULTY[item.dificuldade] : meta.difficulty,
    stem: item.enunciado.trim(), alternatives: LETTERS.map((l) => ({ key: l, text: s.alternativas[l].trim() })), correctKey: s.correta,
    expectedAnswer: answer, keyPoints: [answer], explanation: item.explicacao_correta.trim() || null,
    distractorNotes: Object.keys(notes).length ? remapLetters(notes as Partial<Record<Letter, string>>, s.from) : null,
    enamedAreaId: topic.areaId, enamedDomainId: topic.domainId, enamedCompetencyId: topic.competencyId, enamedTopicId: topic.id,
    // D-1882 / rule 6: confirmed only when the student chose the topics (topicIds) and the model picked one of them; by area or
    // theme only, the topic is inferred by the model and stays unconfirmed
    enamedConfirmed: meta.confirmed, source: 'ai', promptId: meta.promptId, promptVersion: meta.promptVersion, model: meta.model, status: 'draft', createdAt: meta.now,
  };
}

export const dbTopicStore: TopicStore = {
  async topics(areaIds, topicIds) {
    const { db } = await dbm();
    const rows = await db.execute<{ id: string; code: string; name: string; area_id: string | null; area_name: string | null; domain_id: string | null; competency_id: string | null }>(sql`
      WITH RECURSIVE sel AS (SELECT id FROM enamed_taxonomy WHERE id = ANY(${pgArray(topicIds.length ? topicIds : areaIds, 'uuid')})
        UNION SELECT c.id FROM enamed_taxonomy c JOIN sel ON c.parent_id = sel.id),
      t AS (SELECT * FROM enamed_taxonomy WHERE kind = 'topic' AND (${topicIds.length + areaIds.length === 0}::boolean OR id IN (SELECT id FROM sel))),
      up AS (SELECT t.id topic, p.id, p.kind, p.parent_id FROM t JOIN enamed_taxonomy p ON p.id = t.parent_id
        UNION ALL SELECT up.topic, p.id, p.kind, p.parent_id FROM up JOIN enamed_taxonomy p ON p.id = up.parent_id)
      SELECT t.id, t.code, t.name,
        coalesce((SELECT id FROM up WHERE up.topic = t.id AND kind = 'area' LIMIT 1), (SELECT a.id FROM enamed_taxonomy a WHERE a.kind = 'area' AND a.area = t.area ORDER BY a.code LIMIT 1)) area_id,
        (SELECT a.name FROM enamed_taxonomy a WHERE a.kind = 'area' AND a.area = t.area ORDER BY a.code LIMIT 1) area_name,
        (SELECT id FROM up WHERE up.topic = t.id AND kind = 'domain' LIMIT 1) domain_id,
        (SELECT id FROM up WHERE up.topic = t.id AND kind = 'competency' LIMIT 1) competency_id
      FROM t ORDER BY t.code LIMIT 200`);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, areaId: r.area_id, areaName: r.area_name, domainId: r.domain_id, competencyId: r.competency_id }));
  },
  async stems(userId, topicIds) {
    if (!topicIds.length) return [];
    const { db } = await dbm();
    const rows = await db.execute<{ stem: string }>(sql`SELECT stem FROM question_bank WHERE user_id = ${userId} AND enamed_topic_id = ANY(${pgArray(topicIds, 'uuid')})
      ORDER BY created_at DESC LIMIT ${STEM_SCAN}`);
    return rows.map((r) => r.stem);
  },
  async save(userId, rows) {
    if (!rows.length) return;
    // `authenticated` has no grant on the answer columns: the insert runs as the server role inside the user's transaction (as generate.ts)
    await run(userId, async (tx, s) => { await asServer(tx, tx.insert(s.questionBank).values(rows.map((r) => ({ ...r, userId }))).getSQL()); });
    await invalidate('question.changed', { userId });
  },
};
const defaultDeps: TopicDeps = { store: dbTopicStore, now: () => new Date(), newId: randomUUID };

export async function generateFromTopics(input: TopicGenerateInput, deps: TopicDeps = defaultDeps): Promise<Result<TopicGenerateOutput>> {
  const topics = await deps.store.topics(input.areaIds, input.topicIds);
  if (!topics.length) return err('validation', 'no_topics');
  const { genBatchSize, dupThreshold } = challengeLimits();
  // every kept topic comes from this list, so with topicIds the topic is one the student chose
  const restricted = input.topicIds.length > 0;
  const existing = await deps.store.stems(input.userId, topics.map((t) => t.id));
  const prompt = loadChallengePrompt('gerar-questoes-por-tema');
  const requestId = input.requestId ?? 'exam-generate';
  const log = createLogger({ requestId });
  const areas = [...new Set(topics.map((t) => t.areaName).filter((a): a is string => Boolean(a)))];
  const out: TopicGenerateOutput = { questions: [], requested: input.n, reused: 0, generated: 0, shortfall: 0, calls: 0, discarded: { format: 0, duplicate: 0, untagged: 0 }, stoppedBy: null };
  let failure: AppError | null = null;
  let paidFor = 0;
  let short = 0;
  let missing = input.n;
  await input.onProgress?.(0);

  while (missing > 0 && !out.stoppedBy) {
    const size = Math.min(EXAM_GENERATE_CHUNK, missing);
    const held = out.questions.length + size <= paidFor ? null : await reserveAi(input.userId, 'ai_question_batches', deps.now());
    if (held && !held.ok) { out.stoppedBy = 'quota'; failure = held.error; break; }
    if (held) paidFor += genBatchSize;
    const kept: Kept[] = [];
    let model = '';
    for (let attempt = 0; attempt < 2 && kept.length < size; attempt++) {
      const want = size - kept.length;
      let items: Item[];
      if (aiMode() !== 'live') {
        items = offlineItems(topics, want, out.questions.length + kept.length);
        model = 'offline';
      } else {
        const rendered = renderChallengePrompt(prompt, {
          assunto: areas.join(', ') || 'medicina', publico: PUBLICO, dificuldade: NIVEL[input.difficulty], n: want,
          temas: topics.map((t) => t.name).join('\n'), tema_livre: input.theme ?? '(nenhum)',
          perguntas_existentes: [...kept.map((k) => k.item.enunciado).reverse(), ...existing].slice(0, 30).map((s) => `- ${s.replace(/\s+/g, ' ')}`).join('\n') || '(nenhuma)',
        });
        if (!rendered.ok) throw new Error(`prompt_variable:${rendered.variable}`);
        try {
          out.calls++;
          const r = await generateJson(topicReplySchema, { fn: 'generate', system: rendered.data, user: 'Responda agora apenas com o JSON pedido.', temperature: prompt.meta.temperatura ?? undefined, requestId });
          items = r.data.questoes;
          model ||= r.model;
          log.info('ai_call', { event: 'ai_call', fn: 'exam_generate_topic', model: r.model.slice(0, 80), latencyMs: Math.round(r.latencyMs), status: 'ok', attempt });
        } catch (e) {
          log.warn('ai_error', { event: 'ai_error', fn: 'exam_generate_topic', type: e instanceof AiError ? e.code : 'failed', attempt });
          if (attempt === 0 && held) { await held.refund().catch(() => undefined); paidFor -= genBatchSize; } // the batch produced nothing
          if (!(e instanceof AiError)) throw e;
          if (attempt === 0) {
            out.stoppedBy = 'ai_error';
            failure = { code: e.code === 'rate_limited' || e.code === 'quota_exceeded' ? 'rate_limited' : 'ai_unavailable', message: e.userMessage };
          }
          break;
        }
      }
      const screened = screenTopicItems(items, topics, [...existing, ...kept.map((k) => k.item.enunciado)], dupThreshold);
      for (const k of Object.keys(out.discarded) as (keyof typeof out.discarded)[]) out.discarded[k] += screened.discarded[k];
      kept.push(...screened.kept.slice(0, want));
    }
    const now = deps.now();
    const rows = kept.map((k) => topicRow(k, { id: deps.newId(), userId: input.userId, difficulty: input.difficulty, promptId: prompt.meta.id, promptVersion: prompt.promptVersion, model, now, confirmed: restricted }));
    try {
      await deps.store.save(input.userId, rows);
    } catch (e) {
      if (held) await held.refund().catch(() => undefined);
      throw e;
    }
    out.questions.push(...rows);
    existing.unshift(...rows.map((r) => r.stem));
    await input.onProgress?.(out.questions.length);
    missing -= rows.length;
    if (rows.length < size && ++short > EXTRA_BATCHES) break;
  }
  out.generated = out.questions.length;
  out.shortfall = Math.max(0, input.n - out.generated);
  if (!out.questions.length && failure) return { ok: false, error: failure };
  return ok(out);
}
