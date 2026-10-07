// G25 (F32) T4: layered grading of one answer (FR-24–FR-34, FR-39–FR-41). Prefilter -> deterministic -> repeated answer -> AI.
// Pure apart from the injected quota and model: the caller stores the returned attempt as a NEW row (D-1605) and never UPDATEs one.
// The rating is derived here only; nothing the client sends can set it (FR-31, FR-39).
import { createHash } from 'node:crypto';
import {
  AiError, challengeLimits, finalVerdict, generateJson, LEAK_FALLBACK_FEEDBACK, LEAK_FALLBACK_HINT, loadChallengePrompt, prefilterAnswer,
  renderChallengePrompt, scrubLeak, stemSimilarity, type ChallengeLimits, type ChallengeVerdict, type PrefilterReason,
} from '@remoa/ai';
import {
  aiAnswerInputSchema, CHALLENGE_MAX_ATTEMPTS, vereditoSchema,
  type AiAnswerInput, type AiAnswerResult, type AiChallengeItemServer, type AppError, type Grade, type GradedBy, type Verdict,
} from '@remoa/contracts';
import { reserveAi, type Reservation } from '../billing/quota';

export const GRADE_PROMPT_ID = 'corrigir-resposta' as const;
/** FR-41 "só repete a pergunta": the answer is (almost) the stem. */
const REPEATS_STEM = 0.9;

export type ChallengeMode = 'train' | 'mock';
/** FR-32: only a due or new card takes the FSRS update; `null` = no card behind the item (bank question). */
export type CardDue = 'due' | 'new' | 'not_due' | null;

/** A row already stored for this item (graded or pending), as the caller read it. */
export type PriorAttempt = {
  attemptNo: number;
  answerHash: string;
  gradedBy: GradedBy;
  verdict: Verdict | null;
  feedback: string | null;
  hint: string | null;
  manipulation: boolean;
  covered: string[];
  missing: string[];
  criticalError: boolean;
  confidence: number | null;
  model: string | null;
  promptVersion: string | null;
};

/** No `rating` field: a client-supplied rating has nowhere to go. */
export type GradeInput = {
  userId: string;
  mode: ChallengeMode;
  item: AiChallengeItemServer;
  /** Parsed again here with the strict contract schema. */
  answer: unknown;
  card: CardDue;
  /** Every row of this item, oldest first. */
  history: readonly PriorAttempt[];
  /** Prompt context. `assunto`/`publico` are short; the map context and evidence are data. */
  context: { assunto: string; publico: string; neighbors: string; evidence: string };
  elapsedMs?: number;
  targetMs?: number;
  /** FR-40: AI gradings of this card in the last hour (the caller counts them). */
  gradingsLastHour?: number;
  /** Grading a stored pending attempt (FR-35): its number is reused and the verdict goes in a new row. */
  pending?: { attemptNo: number };
};

export type Schedule = { apply: boolean; anticipate: boolean; delay: false };

/** One row to append to `challenge_attempts`, plus what the route returns. Reference material never appears here. */
export type GradedAttempt = {
  attemptNo: number;
  answer: AiAnswerInput;
  answerHash: string;
  gradedBy: GradedBy;
  verdict: Verdict | null;
  rating: Grade | null;
  feedback: string | null;
  hint: string | null;
  usedHint: boolean;
  canRetry: boolean;
  manipulation: boolean;
  covered: string[];
  missing: string[];
  criticalError: boolean;
  confidence: number | null;
  model: string | null;
  promptId: typeof GRADE_PROMPT_ID | null;
  promptVersion: string | null;
  latencyMs: number | null;
  prefilter: PrefilterReason | 'repete' | null;
  /** Same answer as a graded attempt of this item: its verdict, no model call, no quota. */
  reused: boolean;
  leaked: boolean;
  /** Units of `ai_grades` this attempt kept (0 or 1). */
  aiUnits: 0 | 1;
  /** null until the item is final (Treino with a retry left, or pending). */
  schedule: Schedule | null;
};

export type GradeErrorCode =
  | 'invalid_answer' | 'answer_kind_mismatch' | 'no_attempts_left' | 'pending_grade' | 'missing_reference' | 'rate_limited' | 'quota_exceeded'
  | 'ai_failed' | 'batch_too_large';
export type GradeError = { code: GradeErrorCode; message: string; aiCode?: AiError['code'] };
export type GradeOutcome = { ok: true; data: GradedAttempt } | { ok: false; error: GradeError };

export type GradeDeps = {
  reserve?: (userId: string, key: 'ai_grades') => Promise<Reservation | { ok: false; error: AppError }>;
  generateJson?: typeof generateJson;
  limits?: ChallengeLimits;
  requestId?: string;
};

const fail = (code: GradeErrorCode, extra: Partial<GradeError> = {}): { ok: false; error: GradeError } => ({ ok: false, error: { code, message: code, ...extra } });
const VERDICT: Record<ChallengeVerdict, Verdict> = { correta: 'correct', parcial: 'partial', incorreta: 'incorrect' };
const TIPO: Record<AiChallengeItemServer['type'], string> = {
  discursive: 'discursiva', objective: 'objetiva', hidden_card: 'card oculto', edge: 'conexão', next_step: 'próximo passo',
  occlusion: 'rótulo de imagem', case: 'caso clínico por estágio',
};

const norm = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Stable per answer: case, outer and repeated spaces do not make a "new" answer (FR-40). */
export function answerHash(a: AiAnswerInput): string {
  const body = a.kind === 'text' || a.kind === 'label' ? norm(a.text) : a.kind === 'order' ? a.stepIds.join('\u0000') : a.kind === 'choice' ? a.key : '';
  return createHash('sha256').update(`${a.kind}\u0001${body}`).digest('hex');
}

/** FR-31 / FR-30: correta -> good (easy only on the first try, no hint, within the target time); used hint caps at hard. */
export function ratingFor(verdict: Verdict, o: { usedHint: boolean; elapsedMs?: number; targetMs?: number }): Grade {
  if (verdict === 'incorrect') return 'again';
  if (verdict === 'partial' || o.usedHint) return 'hard';
  const inTime = o.elapsedMs !== undefined && o.targetMs !== undefined && o.elapsedMs <= o.targetMs;
  return inTime ? 'easy' : 'good';
}

/** FR-32: due or new -> FSRS update; otherwise a miss brings the review forward and a hit never pushes it back. */
export function scheduleFor(verdict: Verdict, card: CardDue): Schedule {
  if (card === 'due' || card === 'new') return { apply: true, anticipate: false, delay: false };
  return { apply: false, anticipate: card !== null && verdict !== 'correct', delay: false };
}

/** What the route sends back (FR-31). Parsed by the strict public schema, so no reference field can slip through. */
export function publicResult(attemptId: string, a: GradedAttempt): AiAnswerResult {
  return {
    attemptId, attemptNo: a.attemptNo, verdict: a.verdict, gradedBy: a.gradedBy, rating: a.rating, feedback: a.feedback, hint: a.hint,
    canRetry: a.canRetry, manipulation: a.manipulation,
  };
}

// ── Planning (no quota, no model) ────────────────────────────────────────────

type Base = Pick<GradedAttempt, 'attemptNo' | 'answer' | 'answerHash' | 'usedHint'>;
type Ctx = { input: GradeInput; base: Base; maxAttempts: number; allowRetry: boolean };
type AiJob = { ctx: Ctx; text: string; hidden: string[] };
type Plan = { kind: 'done'; outcome: GradeOutcome } | { kind: 'ai'; job: AiJob };

const empty = (): Pick<GradedAttempt, 'covered' | 'missing' | 'criticalError' | 'confidence' | 'model' | 'promptId' | 'promptVersion' | 'latencyMs' | 'leaked'> => ({
  covered: [], missing: [], criticalError: false, confidence: null, model: null, promptId: null, promptVersion: null, latencyMs: null, leaked: false,
});

/** Verdict, rating, hint and schedule from a verdict, with the attempt rules of FR-30. */
function finish(ctx: Ctx, v: Verdict, rest: Omit<GradedAttempt, keyof Base | 'verdict' | 'rating' | 'canRetry' | 'schedule' | 'hint'> & { hint: string | null }): GradedAttempt {
  const canRetry = ctx.allowRetry && v !== 'correct' && !rest.manipulation && ctx.base.attemptNo < ctx.maxAttempts;
  return {
    ...ctx.base, ...rest,
    verdict: v,
    rating: ratingFor(v, { usedHint: ctx.base.usedHint, elapsedMs: ctx.input.elapsedMs, targetMs: ctx.input.targetMs }),
    hint: canRetry ? (rest.hint ?? LEAK_FALLBACK_HINT) : null,
    canRetry,
    schedule: canRetry ? null : scheduleFor(v, ctx.input.card),
  };
}

const local = (ctx: Ctx, v: Verdict, gradedBy: 'prefilter' | 'deterministic', prefilter: GradedAttempt['prefilter'] = null, manipulation = false): Plan => ({
  kind: 'done',
  outcome: { ok: true, data: finish(ctx, v, { ...empty(), gradedBy, feedback: null, hint: null, manipulation, prefilter, reused: false, aiUnits: 0 }) },
});

const hiddenOf = (item: AiChallengeItemServer) =>
  [item.expectedAnswer, ...(item.keyPoints ?? []), ...(item.rubric?.essentialPoints ?? []), ...(item.rubric?.acceptedVariants ?? [])].filter((s): s is string => !!s?.trim());

function plan(input: GradeInput, limits: ChallengeLimits, allowRetry: boolean): Plan {
  const parsed = aiAnswerInputSchema.safeParse(input.answer);
  if (!parsed.success) return { kind: 'done', outcome: fail('invalid_answer') };
  const answer = parsed.data;
  const { item, history } = input;

  const graded = history.filter((h) => h.gradedBy !== 'pending');
  const maxAttempts = input.mode === 'train' ? CHALLENGE_MAX_ATTEMPTS : 1;
  let attemptNo: number;
  if (input.pending) {
    if (graded.some((h) => h.attemptNo === input.pending?.attemptNo)) return { kind: 'done', outcome: fail('no_attempts_left') };
    attemptNo = input.pending.attemptNo;
  } else {
    if (history.some((h) => h.gradedBy === 'pending' && !graded.some((g) => g.attemptNo === h.attemptNo))) return { kind: 'done', outcome: fail('pending_grade') };
    const last = graded.at(-1);
    const closed = last && (last.verdict === 'correct' || last.manipulation);
    attemptNo = graded.length + 1;
    if (closed || attemptNo > maxAttempts) return { kind: 'done', outcome: fail('no_attempts_left') };
  }
  const ctx: Ctx = { input, maxAttempts, allowRetry, base: { attemptNo, answer, answerHash: answerHash(answer), usedHint: allowRetry && attemptNo > 1 } };

  // Layer 0: "não sei" is an answer (FR-24), incorreta without the model.
  if (answer.kind === 'dont_know') return local(ctx, 'incorrect', 'prefilter', 'nao_sei');

  // Layer 1: deterministic (FR-25).
  if (item.type === 'next_step') {
    if (answer.kind !== 'order') return { kind: 'done', outcome: fail('answer_kind_mismatch') };
    const correct = item.shuffleMap?.kind === 'steps' ? item.shuffleMap.correctOrder : null;
    if (!correct) return { kind: 'done', outcome: fail('missing_reference') };
    const same = correct.length === answer.stepIds.length && correct.every((id, i) => answer.stepIds[i] === id);
    return local(ctx, same ? 'correct' : 'incorrect', 'deterministic');
  }
  if (item.type === 'objective') {
    if (answer.kind !== 'choice') return { kind: 'done', outcome: fail('answer_kind_mismatch') };
    const stored = item.shuffleMap?.kind === 'alternatives' ? item.shuffleMap.shown[answer.key] : answer.key;
    if (!item.correctKey) return { kind: 'done', outcome: fail('missing_reference') };
    return local(ctx, stored === item.correctKey ? 'correct' : 'incorrect', 'deterministic');
  }
  const isLabel = item.type === 'occlusion';
  if (isLabel ? answer.kind !== 'label' && answer.kind !== 'text' : answer.kind !== 'text') return { kind: 'done', outcome: fail('answer_kind_mismatch') };
  const text = (answer as { text: string }).text;

  // Layer 0 for text: prefilter (FR-41). A label is one or two words, so "curta" does not apply to it.
  const pre = prefilterAnswer(text, limits.answerMaxChars);
  if (pre && !(isLabel && pre.reason === 'curta')) return local(ctx, 'incorrect', 'prefilter', pre.reason, pre.manipulation);
  if (!isLabel && stemSimilarity(text, item.public.stem) >= REPEATS_STEM) return local(ctx, 'incorrect', 'prefilter', 'repete');

  if (isLabel) {
    const labels = [item.expectedAnswer, ...(item.rubric?.acceptedVariants ?? [])].filter((s): s is string => !!s?.trim()).map(norm);
    if (labels.includes(norm(text))) return local(ctx, 'correct', 'deterministic');
    // Not equal: an ambiguous label goes to the AI (FR-25).
  }

  const hidden = hiddenOf(item);
  if (!hidden.length) return { kind: 'done', outcome: fail('missing_reference') };

  // Layer 2: the same answer for this item never calls the model again (FR-40).
  const prev = graded.find((h) => h.answerHash === ctx.base.answerHash && h.verdict);
  if (prev?.verdict) {
    return {
      kind: 'done',
      outcome: {
        ok: true,
        data: finish(ctx, prev.verdict, {
          gradedBy: prev.gradedBy, feedback: prev.feedback, hint: prev.hint, manipulation: prev.manipulation, covered: prev.covered, missing: prev.missing,
          criticalError: prev.criticalError, confidence: prev.confidence, model: prev.model, promptId: prev.gradedBy === 'ai' ? GRADE_PROMPT_ID : null,
          promptVersion: prev.promptVersion, latencyMs: null, prefilter: null, reused: true, leaked: false, aiUnits: 0,
        }),
      },
    };
  }
  if (input.gradingsLastHour !== undefined && input.gradingsLastHour >= limits.maxGradingsPerCardHour) return { kind: 'done', outcome: fail('rate_limited') };
  return { kind: 'ai', job: { ctx, text, hidden } };
}

// ── AI layer ─────────────────────────────────────────────────────────────────

/** FR-35: no quota -> a pending row, verdict null, no retry, no schedule. A stored pending attempt stays as it is. */
function pendingOf(ctx: Ctx): GradeOutcome {
  if (ctx.input.pending) return fail('quota_exceeded');
  return {
    ok: true,
    data: {
      ...ctx.base, ...empty(), gradedBy: 'pending', verdict: null, rating: null, feedback: null, hint: null, canRetry: false, manipulation: false,
      prefilter: null, reused: false, aiUnits: 0, schedule: null,
    },
  };
}

const list = (xs: readonly string[] | undefined) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '(nenhum)');

async function runAi(job: AiJob, held: Reservation, deps: GradeDeps): Promise<GradeOutcome> {
  const { ctx, text, hidden } = job;
  const { item, context } = ctx.input;
  const prompt = loadChallengePrompt(GRADE_PROMPT_ID);
  const refund = () => held.refund().catch(() => undefined);
  const rendered = renderChallengePrompt(prompt, {
    assunto: context.assunto, publico: context.publico, tipo: TIPO[item.type], revelar: false,
    enunciado: item.public.stem,
    resposta_referencia: item.expectedAnswer ?? '(sem resposta de referência)',
    pontos_essenciais: list(item.rubric?.essentialPoints ?? item.keyPoints),
    variantes_aceitas: list(item.rubric?.acceptedVariants),
    erros_criticos: list(item.rubric?.criticalErrors),
    contexto_vizinhos: context.neighbors || '(sem contexto)',
    evidencia: context.evidence || '(sem trecho)',
    resposta_aluno: text,
  });
  if (!rendered.ok) {
    await refund();
    return fail('ai_failed', { aiCode: 'invalid_output' });
  }
  try {
    const r = await (deps.generateJson ?? generateJson)(vereditoSchema, {
      fn: 'grade', system: rendered.data, user: 'Corrija a resposta do aluno. Responda só com o JSON.', json: true, temperature: 0, reasoning: false,
      requestId: deps.requestId,
    });
    const out = r.data;
    const { veredito, manipulation } = finalVerdict(out);
    const v = VERDICT[veredito];
    // The student already wrote a correct answer, so echoing it is not a leak; anything else must not quote the reference.
    const fb = v === 'correct' ? { text: out.feedback, leaked: false } : scrubLeak(out.feedback, hidden, LEAK_FALLBACK_FEEDBACK);
    const hint = out.dica?.trim() ? scrubLeak(out.dica, hidden, LEAK_FALLBACK_HINT) : { text: null, leaked: false };
    return {
      ok: true,
      data: finish(ctx, v, {
        gradedBy: 'ai', feedback: fb.text || null, hint: hint.text, manipulation, covered: out.pontos_cobertos, missing: out.pontos_faltantes,
        criticalError: out.erro_critico, confidence: out.confianca, model: r.model, promptId: GRADE_PROMPT_ID, promptVersion: prompt.promptVersion,
        latencyMs: r.latencyMs, prefilter: null, reused: false, leaked: fb.leaked || hint.leaked, aiUnits: 1,
      }),
    };
  } catch (e) {
    await refund();
    return fail('ai_failed', { aiCode: e instanceof AiError ? e.code : 'provider_error' });
  }
}

const reserveOf = (deps: GradeDeps) => deps.reserve ?? ((userId: string, key: 'ai_grades') => reserveAi(userId, key));

/** Immediate grading of one answer (FR-25–FR-32). */
export async function gradeAnswer(input: GradeInput, deps: GradeDeps = {}): Promise<GradeOutcome> {
  const p = plan(input, deps.limits ?? challengeLimits(), true);
  if (p.kind === 'done') return p.outcome;
  const held = await reserveOf(deps)(input.userId, 'ai_grades');
  if (!held.ok) return held.error.code === 'quota_exceeded' ? pendingOf(p.job.ctx) : fail('ai_failed', { message: held.error.code });
  return runAi(p.job, held, deps);
}

/**
 * FR-34, end-of-session grading: up to CHALLENGE_BATCH_GRADE_MAX answers, results in input order, no hint and no retry.
 * `corrigir-resposta@v1` grades ONE answer, so each answer that reaches the model is its own call and its own `ai_grades` unit;
 * prefilter, deterministic and repeated answers use none. Units are reserved in input order (the first answers get the last
 * units; the rest become pending), then the calls run in parallel and each failure refunds its own unit.
 */
export async function gradeBatch(inputs: readonly GradeInput[], deps: GradeDeps = {}): Promise<GradeOutcome[]> {
  const limits = deps.limits ?? challengeLimits();
  if (inputs.length > limits.batchGradeMax) return inputs.map(() => fail('batch_too_large'));
  const plans = inputs.map((i) => plan(i, limits, false));
  const reserve = reserveOf(deps);
  const held: (Reservation | null)[] = [];
  let spent = false;
  for (const [i, p] of plans.entries()) {
    if (p.kind === 'done' || spent) {
      held.push(null);
      continue;
    }
    const r = await reserve(inputs[i]!.userId, 'ai_grades');
    if (!r.ok) spent = true;
    held.push(r.ok ? r : null);
  }
  return Promise.all(plans.map((p, i) => {
    if (p.kind === 'done') return p.outcome;
    const h = held[i];
    return h ? runAi(p.job, h, deps) : pendingOf(p.job.ctx);
  }));
}
