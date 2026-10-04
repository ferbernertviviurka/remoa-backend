import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  challengeItemSchema, ok, type CardType, type CaseStage, type ChallengeItem, type ChallengeMode, type FsrsMemory, type QueueItem, type Result,
} from '@remoa/contracts';
import { retrievability } from '@remoa/fsrs';
import type { Tx } from '@remoa/db';
import { getBoardQueue, getDailyQueue } from '../review/queue';
import { run } from '../db';

// --- stored shape ---------------------------------------------------------------------------------------------------

export type Answered = {
  inputKind: 'self' | 'mcq' | 'text' | 'voice';
  durationMs: number;
  answerText: string | null;
  verdict: import('@remoa/contracts').GraderVerdict | null;
  suggestedGrade: import('@remoa/contracts').Grade | null;
  gradeLocked: boolean;
  fallback: 'no_rubric' | 'quota' | 'grader_error' | null;
};
/** Server-only per-item state, kept in `sessions.items` next to the public item (never serialised to the client). */
export type Internal = {
  nb: string[]; // "A —label→ B" strings for the grader
  skips: number;
  /** Set while a streamed grade is in flight, so a second request does not charge again. */
  grading?: boolean;
  answered?: Answered;
  rated?: { grade: import('@remoa/contracts').Grade; due: string; overridden: boolean };
  disputed?: boolean;
  reviewItemId?: string;
};
export type StoredItem = ChallengeItem & { x: Internal };

// --- deterministic shuffle -------------------------------------------------------------------------------------------

const seedOf = (s: string) => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};
export function shuffle<T>(xs: T[], seed: string): T[] {
  let a = seedOf(seed);
  const rnd = () => ((a = (a + 0x6d2b79f5) | 0), (Math.imul(a ^ (a >>> 15), 1 | a) >>> 0) / 4294967296);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** FR-4: 4 options = canonical + 3 distractors from the graph; fewer than 3 usable distractors -> undefined (UI hides "Opções"). */
export function makeOptions(canonical: string, pool: string[], seed: string): [string, string, string, string] | undefined {
  const norm = (s: string) => s.trim().toLowerCase();
  const seen = new Set([norm(canonical)]);
  const uniq: string[] = [];
  for (const p of pool) {
    const t = p.trim();
    if (t && !seen.has(norm(t))) {
      seen.add(norm(t));
      uniq.push(t);
    }
  }
  if (uniq.length < 3) return undefined;
  return shuffle([canonical, ...shuffle(uniq, `d${seed}`).slice(0, 3)], seed) as [string, string, string, string];
}

// --- pure item construction (D-060) ----------------------------------------------------------------------------------

export type CardData = {
  id: string; boardId: string; type: CardType; title: string; front: string | null; back: string | null; payload: unknown;
  rubric: { status: string; points: unknown[] } | null; order: number;
};
export type EdgeData = { id: string; boardId: string; from: string; to: string; label: string | null };
export type Ctx = {
  userId: string;
  cards: Map<string, CardData>;
  edges: EdgeData[];
  boards: Map<string, { status: string; userId: string }>;
  retr: Map<string, number>; // card -> mean retrievability over its states (absent = never reviewed = 0)
  lastMode: Map<string, ChallengeMode>;
  attempts: Map<string, number>; // card -> attempt count
};

const STAGE_PT: Record<CaseStage, string> = { presentation: 'apresentação', workup: 'investigação', diagnosis: 'diagnóstico', management: 'conduta' };
const payloadOf = (c: CardData) => (c.payload ?? {}) as {
  steps?: { id: string; text: string }[]; masks?: { id: string; label: string; polygon: { x: number; y: number }[] }[]; assetId?: string;
  caseSteps?: { stage: CaseStage; text: string }[];
};

const gradingOf = (c: CardData, ctx: Ctx): ChallengeItem['grading'] => {
  if (c.rubric?.status === 'approved') return 'rubric_approved';
  const b = ctx.boards.get(c.boardId);
  return c.rubric && b?.status === 'private' && b.userId === ctx.userId ? 'rubric_own' : 'none';
};

/** Builds the frozen item, or null when the card cannot produce a question (e.g. a flow whose step vanished). */
export function buildItem(q: QueueItem, ctx: Ctx): StoredItem | null {
  const c = ctx.cards.get(q.cardId);
  if (!c) return null;
  const sub = q.subId ?? null;
  const p = payloadOf(c);
  const id = sub ? `${c.id}:${sub}` : c.id;
  const touching = ctx.edges.filter((e) => e.boardId === c.boardId && (e.from === c.id || e.to === c.id));
  const nameOf = (cardId: string) => ctx.cards.get(cardId)?.title ?? '';
  const other = (e: EdgeData) => (e.from === c.id ? e.to : e.from);
  const neighborsExcept = (skipEdge?: string) => touching.filter((e) => e.id !== skipEdge && ctx.cards.has(other(e)));
  const base = { id, cardId: c.id, boardId: c.boardId, cardTitle: c.title, subId: sub, grading: gradingOf(c, ctx) };
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const finish = (mode: ChallengeMode, prompt: string, canonical: string, context: ChallengeItem['context'], pool: string[], skipEdge?: string, cardTitle = c.title) => {
    const ns = neighborsExcept(skipEdge);
    const item: ChallengeItem = {
      ...base, cardTitle: same(cardTitle, canonical) ? '' : cardTitle, mode, prompt, canonical,
      // a neighbour title/label equal to the answer would give it away (e.g. two edges with the same label)
      context: { ...context, neighbors: ns.map((e) => ({ title: nameOf(other(e)), label: e.label && same(e.label, canonical) ? null : e.label })).filter((n) => !same(n.title, canonical)).slice(0, 12) },
      options: makeOptions(canonical, pool, id),
    };
    const nb = ns.filter((e) => e.label).map((e) => (e.from === c.id ? `${c.title} —${e.label}→ ${nameOf(e.to)}` : `${nameOf(e.from)} —${e.label}→ ${c.title}`));
    return { ...challengeItemSchema.parse(item), x: { nb, skips: 0 } } satisfies StoredItem;
  };

  if (c.type === 'flow') {
    const steps = p.steps ?? [];
    const i = steps.findIndex((s) => s.id === sub);
    if (i < 0) return null;
    return finish(
      'next_step', i === 0 ? `${c.title}: qual é o primeiro passo?` : `${c.title}: qual é o passo ${i + 1}?`,
      steps[i]!.text, { neighbors: [], revealed: steps.slice(0, i).map((s) => s.text) }, steps.filter((_, j) => j !== i).map((s) => s.text),
    );
  }
  if (c.type === 'image') {
    const masks = p.masks ?? [];
    const m = masks.find((x) => x.id === sub);
    if (!m || !p.assetId) return null;
    return finish(
      'occlusion', `${c.title}: o que está na região coberta?`, m.label,
      { neighbors: [], image: { assetId: p.assetId, maskId: m.id, masks: masks.map((x) => ({ id: x.id, polygon: x.polygon })) } },
      masks.filter((x) => x.id !== m.id).map((x) => x.label),
    );
  }
  if (c.type === 'case') {
    const st = p.caseSteps ?? [];
    if (!st.length) return null;
    // ponytail: rotation by attempt count over stages 2..n (stage 1 alone has nothing to reveal); n = last filled stage on first sight.
    const askable = Math.max(1, st.length - 1);
    const k = st.length === 1 ? 0 : st.length - 1 - ((ctx.attempts.get(c.id) ?? 0) % askable);
    const s = st[k]!;
    return finish(
      'case', `${c.title}: qual é a próxima etapa (${STAGE_PT[s.stage]})?`, s.text,
      { neighbors: [], revealed: st.slice(0, k).map((x) => x.text), stage: s.stage }, st.filter((_, j) => j !== k).map((x) => x.text),
    );
  }

  // concept: edge when it has a labelled edge and the last attempt was not an edge question
  const labelled = touching.filter((e) => e.label?.trim() && ctx.cards.has(other(e)));
  if (labelled.length && ctx.lastMode.get(c.id) !== 'edge') {
    const e = [...labelled].sort((a, b) => (ctx.retr.get(other(a)) ?? 0) - (ctx.retr.get(other(b)) ?? 0) || (a.id < b.id ? -1 : 1))[0]!;
    return finish(
      'edge', `O que liga ${nameOf(e.from)} a ${nameOf(e.to)}?`, e.label!.trim(),
      { neighbors: [], edge: { fromTitle: nameOf(e.from), toTitle: nameOf(e.to) } },
      ctx.edges.filter((x) => x.boardId === c.boardId && x.id !== e.id && x.label).map((x) => x.label!), e.id,
    );
  }
  const canonical = (c.back?.trim() || c.title);
  const pool = [...ctx.cards.values()].filter((x) => x.boardId === c.boardId && x.id !== c.id).sort((a, b) => a.order - b.order).map((x) => x.back?.trim() || x.title);
  // without `front` the title is the answer: do not leak it through cardTitle
  return finish('hidden_card', c.front?.trim() || 'Qual é o conceito?', canonical, { neighbors: [] }, pool, undefined, c.front?.trim() ? c.title : '');
}

// --- loading ---------------------------------------------------------------------------------------------------------

export async function loadCtx(tx: Tx, userId: string, queue: QueueItem[]): Promise<Ctx> {
  const boardIds = [...new Set(queue.map((q) => q.boardId))];
  const cardIds = [...new Set(queue.map((q) => q.cardId))];
  const ctx: Ctx = { userId, cards: new Map(), edges: [], boards: new Map(), retr: new Map(), lastMode: new Map(), attempts: new Map() };
  if (!boardIds.length) return ctx;
  const s = await import('@remoa/db');
  const [cards, edges, boards] = await Promise.all([
    tx.select().from(s.cards).where(and(inArray(s.cards.boardId, boardIds), isNull(s.cards.deletedAt), ne(s.cards.type, 'note'))),
    tx.select().from(s.edges).where(inArray(s.edges.boardId, boardIds)),
    tx.select({ id: s.boards.id, status: s.boards.status, userId: s.boards.userId }).from(s.boards).where(inArray(s.boards.id, boardIds)),
  ]);
  for (const c of cards) ctx.cards.set(c.id, { id: c.id, boardId: c.boardId, type: c.type, title: c.title, front: c.front, back: c.back, payload: c.payload, rubric: c.rubric as CardData['rubric'], order: c.order });
  ctx.edges = edges.map((e) => ({ id: e.id, boardId: e.boardId, from: e.fromCardId, to: e.toCardId, label: e.label }));
  for (const b of boards) ctx.boards.set(b.id, { status: b.status, userId: b.userId });

  // retrievability of every card in these boards (edge target choice), last mode and attempt counts of the queued cards
  const allIds = [...ctx.cards.keys()];
  const now = new Date();
  const states = allIds.length ? await tx.select().from(s.fsrsState).where(and(eq(s.fsrsState.userId, userId), inArray(s.fsrsState.cardId, allIds))) : [];
  const acc = new Map<string, number[]>();
  for (const st of states) acc.set(st.cardId, [...(acc.get(st.cardId) ?? []), retrievability(st as FsrsMemory, now)]);
  for (const [k, v] of acc) ctx.retr.set(k, v.reduce((a, b) => a + b, 0) / v.length);
  const last = await tx.execute<{ card_id: string; mode: ChallengeMode; n: number }>(sql`
    select distinct on (card_id) card_id, mode, count(*) over (partition by card_id)::int as n
    from attempts where user_id = ${userId} and card_id in (${sql.join(cardIds.map((i) => sql`${i}`), sql`, `)})
    order by card_id, created_at desc`);
  for (const r of last) {
    ctx.lastMode.set(r.card_id, r.mode);
    ctx.attempts.set(r.card_id, r.n);
  }
  return ctx;
}

/** FR-1: queue (F03) -> frozen items. Board sessions respect the daily new limit (FRD open question, provisional yes). */
export async function buildSession(userId: string, kind: 'daily' | 'board', boardId: string | undefined, limit: number, now: Date): Promise<Result<StoredItem[]>> {
  const opts = { now, limit };
  const q = kind === 'board' ? await getBoardQueue(userId, boardId!, opts) : await getDailyQueue(userId, opts);
  if (!q.ok) return q;
  const ctx = await run(userId, (tx) => loadCtx(tx, userId, q.data));
  return ok(q.data.map((i) => buildItem(i, ctx)).filter((x): x is StoredItem => x !== null));
}
