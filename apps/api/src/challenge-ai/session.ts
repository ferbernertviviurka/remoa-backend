import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  ALTERNATIVE_KEYS, CHALLENGE_MAX_ATTEMPTS, aiAnswerItemInputSchema, aiChallengeItemPublicSchema, aiChallengeItemServerSchema,
  aiChallengeSessionPublicSchema, casePayloadSchema, challengeConfigSchema, err, flowPayloadSchema, imagePayloadSchema, ok, parseWith,
  type AiAnswerInput, type AiChallengeItemPublic, type AiChallengeItemServer, type AiChallengeSessionPublic, type AiItemType, type AlternativeKey,
  type CardType, type ChallengeConfig, type ChallengeFormat, type ChallengeScope, type QuestionType, type ReferenceRef, type Result, type ShuffleMap,
} from '@remoa/contracts';
import { challengeLimits, shuffleAlternatives } from '@remoa/ai';
import type { Tx } from '@remoa/db';
import { invalidate } from '../cache';
import { asServer, pgArray, uuids } from '../db';
import { shuffle } from '../challenge/build';

// G25 F32 T3 (FR-36/FR-37, D-1605, D-1611): server-side AI challenge session. One open item (`position`), fixed order, TTL.
// What leaves this module for a client is only `toPublic()` (aiChallengeSessionPublicSchema, .strict() at every level).
// reference_ref and shuffle_map hold pointers and orders, never the expected text: the grader (T4) resolves the reference on the server.
// Writes and reads of reference columns go through asServer (no grant for `authenticated`), always filtered by user_id.

/** Item types whose grading calls the model (FR-4 `aiUnits`); objective, order and mask labels are graded in code. */
export const AI_GRADED_TYPES = ['discursive', 'hidden_card', 'edge', 'case'] as const satisfies readonly AiItemType[];

export type CardRow = {
  id: string; boardId: string; type: CardType; title: string; front: string | null; back: string | null; payload: unknown;
  didactics: { modulo?: string } | null; order: number;
};
export type EdgeRow = { id: string; from: string; to: string; label: string | null; question: string | null };
export type BankRow = {
  id: string; type: QuestionType; stem: string; alternatives: { key: AlternativeKey; text: string }[] | null; correctKey: AlternativeKey | null;
  status: string;
  /** Cards the question cites. The first one is the card whose schedule the grade can move (FR-32). */
  cardIds?: string[];
};
export type SessionRow = {
  id: string; userId: string; boardId: string | null; format: ChallengeFormat; status: 'active' | 'finished' | 'expired'; position: number;
  expiresAt: Date; params: ChallengeConfig; total: number; aiUnits: number;
};
export type ItemRow = {
  id: string; sessionId: string; position: number; kind: 'card' | 'bank'; cardId: string | null; subId: string; bankId: string | null;
  type: AiItemType; payloadPublic: unknown; referenceRef: unknown; shuffleMap: unknown;
};
export type NewItem = Omit<ItemRow, 'sessionId' | 'payloadPublic' | 'referenceRef' | 'shuffleMap'> & {
  payloadPublic: AiChallengeItemPublic; referenceRef: ReferenceRef; shuffleMap: ShuffleMap | null;
};
export type NewSession = { id: string; userId: string; boardId: string; scope: ChallengeScope; format: ChallengeFormat; params: ChallengeConfig; startedAt: Date; expiresAt: Date };
export type AttemptRow = { id: string; attemptNo: number; answerHash: string };
export type NewAttempt = { itemId: string; userId: string; attemptNo: number; answer: AiAnswerInput; answerHash: string };

/** The data access of a session. `sessionStore(tx)` is the SQL one; tests pass an in-memory one. */
export type SessionStore = {
  /** RLS (authenticated): only cards the user can read. Live, not suspended, not `note`. */
  boardCards(boardId: string): Promise<{ cards: CardRow[]; edges: EdgeRow[] }>;
  /** asServer: reads correct_key, filtered by user_id. */
  bankQuestions(userId: string, ids: string[]): Promise<BankRow[]>;
  createSession(s: NewSession, items: NewItem[]): Promise<void>;
  /** `lock`: FOR UPDATE, so answers and advances of one session are serialised. */
  session(userId: string, sessionId: string, lock: boolean): Promise<SessionRow | null>;
  /** RLS: payload_public only (no reference column is selected). */
  publicItemAt(sessionId: string, position: number): Promise<unknown>;
  /** asServer: the full row, reference included. Never returned to a caller as is. */
  itemAt(userId: string, sessionId: string, position: number): Promise<ItemRow | null>;
  expire(userId: string, sessionId: string): Promise<void>;
  moveTo(userId: string, sessionId: string, position: number, finishedAt: Date | null): Promise<void>;
  lastAttempt(userId: string, itemId: string): Promise<AttemptRow | null>;
  /** Append-only (D-1605); null when the (item, attempt_no) pending row already exists. */
  appendAttempt(a: NewAttempt): Promise<{ id: string } | null>;
};

// --- public view -------------------------------------------------------------------------------------------------------

/** The only shape a caller gets. Parses (strict): a stored payload carrying any reference field throws instead of leaking. */
export function toPublic(s: SessionRow, current: unknown): AiChallengeSessionPublic {
  return aiChallengeSessionPublicSchema.parse({
    id: s.id, boardId: s.boardId, format: s.format, status: s.status, total: s.total, position: s.position, expiresAt: s.expiresAt,
    current: s.status === 'active' && current != null ? current : null, aiUnits: s.aiUnits,
  });
}

const publicOf = async (store: SessionStore, s: SessionRow) =>
  toPublic(s, s.status === 'active' ? await store.publicItemAt(s.id, s.position) : null);

// --- building items ----------------------------------------------------------------------------------------------------

type Body = AiChallengeItemPublic extends infer U ? (U extends AiChallengeItemPublic ? Omit<U, 'id' | 'position'> : never) : never;
type Candidate = { cardId: string | null; subId: string | null; body: Body; shuffleMap: ShuffleMap | null };

const STEM_MAX = 4000;
const clip = (s: string) => s.slice(0, STEM_MAX);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const has = (text: string, part: string) => text.toLowerCase().includes(part.trim().toLowerCase());

/** Cards of the scope (FR-2). `branch`: the root and every card reachable by outgoing edges. */
export function cardsInScope(cards: CardRow[], edges: EdgeRow[], scope: ChallengeScope): CardRow[] {
  if (scope.kind === 'board') return cards;
  if (scope.kind === 'card') return cards.filter((c) => c.id === scope.cardId);
  if (scope.kind === 'module') return cards.filter((c) => c.didactics?.modulo === scope.module);
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const todo = [scope.rootCardId];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    todo.push(...(out.get(id) ?? []));
  }
  return cards.filter((c) => seen.has(c.id));
}

/** Questions a card can produce (format 2). Labels, step order and expected text stay out of `body`. */
function candidatesOf(c: CardRow, edges: EdgeRow[], titleOf: Map<string, string>, seed: string): Candidate[] {
  const out: Candidate[] = [];
  if (c.type === 'flow') {
    const p = flowPayloadSchema.safeParse(c.payload);
    if (!p.success) return out;
    const correct = p.data.steps.map((s) => s.id);
    let shown = shuffle(p.data.steps, `${seed}:${c.id}`);
    if (shown.every((s, i) => s.id === correct[i])) shown = [...shown.slice(1), shown[0]!];
    out.push({
      cardId: c.id, subId: null, shuffleMap: { kind: 'steps', correctOrder: correct },
      body: { type: 'next_step', stem: clip(`${c.title}: coloque os passos na ordem certa.`), steps: shown.map((s) => ({ id: s.id, text: s.text })) },
    });
    return out;
  }
  if (c.type === 'image') {
    const p = imagePayloadSchema.safeParse(c.payload);
    if (!p.success || !p.data.masks.length) return out;
    const masks = p.data.masks.map((m) => ({ id: m.id, polygon: m.polygon.map(({ x, y }) => ({ x, y })) }));
    for (const m of p.data.masks) {
      const stem = p.data.masks.some((x) => same(x.label, c.title)) ? 'O que está na região coberta?' : `${c.title}: o que está na região coberta?`;
      out.push({ cardId: c.id, subId: m.id, shuffleMap: null, body: { type: 'occlusion', stem: clip(stem), assetId: p.data.assetId, maskId: m.id, masks } });
    }
    return out;
  }
  if (c.type === 'case') {
    const p = casePayloadSchema.safeParse(c.payload);
    if (!p.success) return out;
    const st = p.data.caseSteps;
    // stage 1 alone has nothing to reveal; with more, ask each later stage, the last first
    const asked = st.length === 1 ? [0] : st.map((_, k) => k).slice(1).reverse();
    for (const k of asked) {
      out.push({
        cardId: c.id, subId: st[k]!.stage, shuffleMap: null,
        body: { type: 'case', stem: clip(`${c.title}: qual é a próxima etapa?`), stage: st[k]!.stage, revealed: st.slice(0, k).map((x) => x.text) },
      });
    }
    return out;
  }
  // concept
  const front = c.front?.trim();
  const back = c.back?.trim();
  if (front || back) {
    // without a front the title is what the student explains; a front that quotes the back would give it away
    const stem = front && !(back && has(front, back)) ? front : back ? `O que você sabe sobre ${c.title}?` : null;
    if (stem) out.push({ cardId: c.id, subId: null, shuffleMap: null, body: { type: 'hidden_card', stem: clip(stem) } });
  }
  for (const e of edges) {
    const label = e.label?.trim();
    const from = titleOf.get(e.from);
    const to = titleOf.get(e.to);
    if (!label || !from || !to || e.from !== c.id) continue;
    const q = e.question?.trim();
    const stem = q && !has(q, label) ? q : `O que liga ${from} a ${to}?`;
    if (has(stem, label)) continue;
    out.push({ cardId: c.id, subId: `edge:${e.id}`, shuffleMap: null, body: { type: 'edge', stem: clip(stem), fromTitle: from, toTitle: to } });
  }
  return out;
}

/** Up to `n` questions, one card at a time in a seeded order, so a large card does not fill the session. */
export function pickMapCandidates(cards: CardRow[], edges: EdgeRow[], scope: ChallengeScope, n: number, seed: string): Candidate[] {
  const all = new Map(cards.map((c) => [c.id, c.title]));
  const scoped = cardsInScope(cards, edges, scope);
  const ids = new Set(scoped.map((c) => c.id));
  // card scope: its edges to any card of the board; otherwise both ends in the scope
  const usable = edges.filter((e) => all.has(e.from) && all.has(e.to) && (scope.kind === 'card' ? ids.has(e.from) || ids.has(e.to) : ids.has(e.from) && ids.has(e.to)));
  const ordered = shuffle([...scoped].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)), seed);
  const lanes = ordered.map((c) => [...candidatesOf(c, usable, all, seed), ...(scope.kind === 'card' ? incomingEdges(c, usable, all) : [])]);
  const picked: Candidate[] = [];
  for (let round = 0; picked.length < n && lanes.some((l) => l.length > round); round++) {
    for (const l of lanes) if (round < l.length && picked.length < n) picked.push(l[round]!);
  }
  return picked;
}

/** Card scope: edges that end at the card are asked too (the card is still the one being studied). */
function incomingEdges(c: CardRow, edges: EdgeRow[], titleOf: Map<string, string>): Candidate[] {
  return edges.filter((e) => e.to === c.id && e.from !== c.id).flatMap((e) => {
    const label = e.label?.trim();
    const from = titleOf.get(e.from)!;
    if (!label) return [];
    const q = e.question?.trim();
    const stem = q && !has(q, label) ? q : `O que liga ${from} a ${c.title}?`;
    if (has(stem, label)) return [];
    return [{ cardId: c.id, subId: `edge:${e.id}`, shuffleMap: null, body: { type: 'edge', stem: clip(stem), fromTitle: from, toTitle: c.title } } satisfies Candidate];
  });
}

const finalize = (cs: Candidate[], bankIds?: string[]): NewItem[] =>
  cs.map((c, position) => {
    const id = randomUUID();
    const payloadPublic = aiChallengeItemPublicSchema.parse({ ...c.body, id, position });
    const bankId = bankIds?.[position] ?? null;
    const referenceRef: ReferenceRef = bankId ? { kind: 'bank', bankId } : { kind: 'card', cardId: c.cardId!, subId: c.subId, rubricId: null };
    return {
      id, position, kind: bankId ? 'bank' : 'card', cardId: c.cardId, subId: c.subId ?? '', bankId, type: payloadPublic.type, payloadPublic, referenceRef,
      shuffleMap: c.shuffleMap,
    };
  });

/** Format 1: questions already in the bank (T2 wrote them). Alternatives shuffled on the server; the shown -> stored map stays here. */
function bankItems(sessionId: string, cfg: ChallengeConfig, ids: string[], rows: BankRow[]): Result<NewItem[]> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cs: Candidate[] = [];
  for (const id of ids) {
    const q = byId.get(id);
    if (!q || q.status === 'archived') return err('not_found', 'question_not_found');
    if (cfg.questionType && cfg.questionType !== 'mixed' && q.type !== cfg.questionType) return err('validation', 'question_type_mismatch');
    const cardId = q.cardIds?.[0] ?? null;
    if (q.type === 'discursive') {
      cs.push({ cardId, subId: null, shuffleMap: null, body: { type: 'discursive', stem: clip(q.stem) } });
      continue;
    }
    if (!q.alternatives || !q.correctKey) return err('internal', 'objective_without_alternatives');
    const byKey = Object.fromEntries(q.alternatives.map((a) => [a.key, a.text])) as Record<AlternativeKey, string>;
    const s = shuffleAlternatives(byKey, q.correctKey, `${sessionId}:${id}`);
    cs.push({
      cardId, subId: null, shuffleMap: { kind: 'alternatives', shown: s.from },
      body: { type: 'objective', stem: clip(q.stem), alternatives: ALTERNATIVE_KEYS.map((key) => ({ key, text: s.alternativas[key] })) },
    });
  }
  return ok(finalize(cs, ids));
}

// --- session lifecycle -------------------------------------------------------------------------------------------------

export type StartOptions = { bankIds?: string[]; now?: Date; env?: NodeJS.ProcessEnv };

/** FR-37: creates the session and its frozen items. Format 2 from the board's cards; format 1 from `bankIds` (never generates). */
export async function startSession(store: SessionStore, userId: string, config: unknown, opts: StartOptions = {}): Promise<Result<AiChallengeSessionPublic>> {
  const parsed = parseWith(challengeConfigSchema, config);
  if (!parsed.ok) return parsed;
  const cfg = parsed.data;
  const now = opts.now ?? new Date();
  const id = randomUUID();
  let items: NewItem[];
  if (cfg.format === 'map') {
    const { cards, edges } = await store.boardCards(cfg.boardId);
    items = finalize(pickMapCandidates(cards, edges, cfg.scope, cfg.n, id));
    if (!items.length) return err('not_found', 'no_questions_in_scope');
  } else {
    const ids = opts.bankIds ?? [];
    if (!ids.length || ids.length > cfg.n || new Set(ids).size !== ids.length) return err('validation', 'bank_ids');
    const built = bankItems(id, cfg, ids, await store.bankQuestions(userId, ids));
    if (!built.ok) return built;
    items = built.data;
  }
  const expiresAt = new Date(now.getTime() + challengeLimits(opts.env).sessionTtlMin * 60_000);
  await store.createSession({ id, userId, boardId: cfg.boardId, scope: cfg.scope, format: cfg.format, params: cfg, startedAt: now, expiresAt }, items);
  const session: SessionRow = {
    id, userId, boardId: cfg.boardId, format: cfg.format, status: 'active', position: 0, expiresAt, params: cfg, total: items.length,
    aiUnits: items.filter((i) => (AI_GRADED_TYPES as readonly string[]).includes(i.type)).length,
  };
  return ok(toPublic(session, items[0]!.payloadPublic));
}

/** An active session past its expires_at is written as expired; returns the row with its current status. */
async function expireIfDue(store: SessionStore, s: SessionRow, now: Date): Promise<SessionRow> {
  if (s.status !== 'active' || s.expiresAt.getTime() > now.getTime()) return s;
  await store.expire(s.userId, s.id);
  return { ...s, status: 'expired' };
}

export async function getSession(store: SessionStore, userId: string, sessionId: string, now = new Date()): Promise<Result<AiChallengeSessionPublic>> {
  const s = await store.session(userId, sessionId, false);
  if (!s) return err('not_found', 'session_not_found');
  return ok(await publicOf(store, await expireIfDue(store, s, now)));
}

const json = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as unknown) : v);
const toServerItem = (r: ItemRow): AiChallengeItemServer =>
  aiChallengeItemServerSchema.parse({
    id: r.id, sessionId: r.sessionId, position: r.position, kind: r.kind, cardId: r.cardId, subId: r.subId || null, bankId: r.bankId, type: r.type,
    public: json(r.payloadPublic), referenceRef: json(r.referenceRef), shuffleMap: json(r.shuffleMap) ?? null,
  });

/**
 * FR-37: the item may take an answer only if it is the open one of an active, unexpired session. On expiry the status is written
 * (and the caller must commit: this returns an error Result, it does not throw). SERVER ONLY: `item` carries the reference pointer.
 */
export async function acceptAnswer(
  store: SessionStore, userId: string, sessionId: string, itemId: string, now = new Date(),
): Promise<Result<{ session: SessionRow; item: AiChallengeItemServer }>> {
  const found = await store.session(userId, sessionId, true);
  if (!found) return err('not_found', 'session_not_found');
  const s = await expireIfDue(store, found, now);
  if (s.status === 'expired') return err('conflict', 'session_expired');
  if (s.status !== 'active') return err('conflict', 'session_finished');
  const row = await store.itemAt(userId, sessionId, s.position);
  if (!row || row.id !== itemId) return err('conflict', 'item_not_current');
  return ok({ session: s, item: toServerItem(row) });
}

const ANSWER_KINDS: Record<AiItemType, readonly AiAnswerInput['kind'][]> = {
  objective: ['choice', 'dont_know'], next_step: ['order', 'dont_know'], occlusion: ['label', 'dont_know'],
  discursive: ['text', 'dont_know'], hidden_card: ['text', 'dont_know'], edge: ['text', 'dont_know'], case: ['text', 'dont_know'],
};
export const answerHash = (a: AiAnswerInput) => createHash('sha256').update(JSON.stringify(a)).digest('hex');

export type RecordedAttempt = { attemptId: string; attemptNo: number; itemId: string };

/**
 * FR-38: appends the raw answer as a `pending` attempt (grading is T4's: it appends the graded row with the same attempt_no).
 * The same answer sent again returns the attempt already stored. Simulado (`mock`) allows 1 attempt, otherwise CHALLENGE_MAX_ATTEMPTS.
 */
export async function recordAttempt(
  store: SessionStore, userId: string, sessionId: string, input: unknown, now = new Date(),
): Promise<Result<RecordedAttempt>> {
  const parsed = parseWith(aiAnswerItemInputSchema, input);
  if (!parsed.ok) return parsed;
  const { itemId, answer } = parsed.data;
  const open = await acceptAnswer(store, userId, sessionId, itemId, now);
  if (!open.ok) return open;
  const { session, item } = open.data;
  if (!ANSWER_KINDS[item.type].includes(answer.kind)) return err('validation', 'answer_kind');
  if (answer.kind === 'order' && item.public.type === 'next_step') {
    const shown = item.public.steps.map((s) => s.id).sort();
    const sent = [...answer.stepIds].sort();
    if (shown.length !== sent.length || shown.some((x, i) => x !== sent[i])) return err('validation', 'answer_steps');
  }
  const hash = answerHash(answer);
  const last = await store.lastAttempt(userId, itemId);
  if (last && last.answerHash === hash) return ok({ attemptId: last.id, attemptNo: last.attemptNo, itemId });
  const attemptNo = (last?.attemptNo ?? 0) + 1;
  if (attemptNo > (session.params.preset === 'mock' ? 1 : CHALLENGE_MAX_ATTEMPTS)) return err('conflict', 'no_attempts_left');
  const row = await store.appendAttempt({ itemId, userId, attemptNo, answer, answerHash: hash });
  if (!row) return err('conflict', 'attempt_exists');
  return ok({ attemptId: row.id, attemptNo, itemId });
}

/** Opens the next item once the current one has an attempt; after the last one the session is finished. */
export async function advance(store: SessionStore, userId: string, sessionId: string, now = new Date()): Promise<Result<AiChallengeSessionPublic>> {
  const found = await store.session(userId, sessionId, true);
  if (!found) return err('not_found', 'session_not_found');
  const s = await expireIfDue(store, found, now);
  if (s.status === 'expired') return err('conflict', 'session_expired');
  if (s.status !== 'active') return err('conflict', 'session_finished');
  const row = await store.itemAt(userId, sessionId, s.position);
  if (!row || !(await store.lastAttempt(userId, row.id))) return err('conflict', 'item_unanswered');
  const position = s.position + 1;
  const finished = position >= s.total;
  await store.moveTo(userId, sessionId, position, finished ? now : null);
  return ok(await publicOf(store, { ...s, position, status: finished ? 'finished' : 'active' }));
}

// --- SQL store ---------------------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const date = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

export function sessionStore(tx: Tx): SessionStore {
  const exec = async <R extends Raw>(q: ReturnType<typeof sql>) => (await tx.execute<R>(q)) as unknown as R[];
  return {
    async boardCards(boardId) {
      const [cards, edges] = await Promise.all([
        exec(sql`select id, board_id, type, title, front, back, payload, didactics, "order" from cards
          where board_id = ${boardId} and deleted_at is null and suspended_at is null and type <> 'note' order by "order", id`),
        exec(sql`select id, from_card_id, to_card_id, label, question from edges where board_id = ${boardId}`),
      ]);
      return {
        cards: cards.map((c) => ({
          id: String(c.id), boardId: String(c.board_id), type: c.type as CardType, title: String(c.title), front: (c.front as string | null) ?? null,
          back: (c.back as string | null) ?? null, payload: json(c.payload), didactics: (json(c.didactics) as CardRow['didactics']) ?? null, order: Number(c.order),
        })),
        edges: edges.map((e) => ({ id: String(e.id), from: String(e.from_card_id), to: String(e.to_card_id), label: (e.label as string | null) ?? null, question: (e.question as string | null) ?? null })),
      };
    },
    async bankQuestions(userId, ids) {
      const rows = await asServer<Raw>(tx, sql`select id, type, stem, alternatives, correct_key, status, card_ids from question_bank
        where user_id = ${userId} and id = any(${uuids(ids)})`);
      return rows.map((r) => ({
        id: String(r.id), type: r.type as QuestionType, stem: String(r.stem), alternatives: (json(r.alternatives) as BankRow['alternatives']) ?? null,
        correctKey: (r.correct_key as AlternativeKey | null) ?? null, status: String(r.status),
        cardIds: Array.isArray(r.card_ids) ? r.card_ids.map(String) : [],
      }));
    },
    async createSession(s, items) {
      const rows = items.map((i) => ({
        id: i.id, position: i.position, kind: i.kind, card_id: i.cardId, sub_id: i.subId, bank_id: i.bankId, type: i.type,
        payload_public: i.payloadPublic, reference_ref: i.referenceRef, shuffle_map: i.shuffleMap,
      }));
      await asServer(tx, sql`with s as (
          insert into challenge_sessions (id, user_id, board_id, scope, format, params, status, position, started_at, expires_at)
          values (${s.id}, ${s.userId}, ${s.boardId}, ${JSON.stringify(s.scope)}::jsonb, ${s.format}, ${JSON.stringify(s.params)}::jsonb, 'active', 0,
            ${s.startedAt.toISOString()}::timestamptz, ${s.expiresAt.toISOString()}::timestamptz)
          returning id, user_id)
        insert into challenge_items (id, session_id, user_id, position, kind, card_id, sub_id, bank_id, type, payload_public, reference_ref, shuffle_map)
        select x.id, s.id, s.user_id, x.position, x.kind, x.card_id, x.sub_id, x.bank_id, x.type, x.payload_public, x.reference_ref, x.shuffle_map
        from s, jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(id uuid, position int, kind text, card_id uuid, sub_id text, bank_id uuid,
          type text, payload_public jsonb, reference_ref jsonb, shuffle_map jsonb)`);
      await invalidate('challenge.finished', { userId: s.userId });
    },
    async session(userId, sessionId, lock) {
      const [r] = await asServer<Raw>(tx, sql`select s.id, s.user_id, s.board_id, s.format, s.status, s.position, s.expires_at, s.params,
          (select count(*)::int from challenge_items i where i.session_id = s.id) as total,
          (select count(*)::int from challenge_items i where i.session_id = s.id and i.type = any(${pgArray(AI_GRADED_TYPES, 'text')})) as ai_units
        from challenge_sessions s where s.id = ${sessionId} and s.user_id = ${userId}${lock ? sql` for update of s` : sql``}`);
      if (!r) return null;
      return {
        id: String(r.id), userId: String(r.user_id), boardId: (r.board_id as string | null) ?? null, format: r.format as ChallengeFormat,
        status: r.status as SessionRow['status'], position: Number(r.position), expiresAt: date(r.expires_at), params: json(r.params) as ChallengeConfig,
        total: Number(r.total), aiUnits: Number(r.ai_units),
      };
    },
    async publicItemAt(sessionId, position) {
      const [r] = await exec(sql`select payload_public from challenge_items where session_id = ${sessionId} and position = ${position}`);
      return r ? json(r.payload_public) : null;
    },
    async itemAt(userId, sessionId, position) {
      const [r] = await asServer<Raw>(tx, sql`select id, session_id, position, kind, card_id, sub_id, bank_id, type, payload_public, reference_ref, shuffle_map
        from challenge_items where session_id = ${sessionId} and user_id = ${userId} and position = ${position}`);
      if (!r) return null;
      return {
        id: String(r.id), sessionId: String(r.session_id), position: Number(r.position), kind: r.kind as ItemRow['kind'], cardId: (r.card_id as string | null) ?? null,
        subId: String(r.sub_id ?? ''), bankId: (r.bank_id as string | null) ?? null, type: r.type as AiItemType, payloadPublic: r.payload_public,
        referenceRef: r.reference_ref, shuffleMap: r.shuffle_map ?? null,
      };
    },
    async expire(userId, sessionId) {
      await asServer(tx, sql`update challenge_sessions set status = 'expired' where id = ${sessionId} and user_id = ${userId} and status = 'active'`);
      await invalidate('challenge.finished', { userId });
    },
    async moveTo(userId, sessionId, position, finishedAt) {
      const fin = finishedAt?.toISOString() ?? null;
      await asServer(tx, sql`update challenge_sessions set position = ${position},
          status = case when ${fin}::timestamptz is null then status else 'finished' end, finished_at = coalesce(${fin}::timestamptz, finished_at)
        where id = ${sessionId} and user_id = ${userId} and status = 'active'`);
      await invalidate('challenge.finished', { userId });
    },
    async lastAttempt(userId, itemId) {
      const [r] = await exec(sql`select id, attempt_no, answer_hash from challenge_attempts where item_id = ${itemId} and user_id = ${userId}
        order by attempt_no desc, created_at desc limit 1`);
      return r ? { id: String(r.id), attemptNo: Number(r.attempt_no), answerHash: String(r.answer_hash) } : null;
    },
    async appendAttempt(a) {
      const [r] = await asServer<Raw>(tx, sql`insert into challenge_attempts (item_id, user_id, attempt_no, answer, answer_hash, graded_by)
        values (${a.itemId}, ${a.userId}, ${a.attemptNo}, ${JSON.stringify(a.answer)}::jsonb, ${a.answerHash}, 'pending')
        on conflict do nothing returning id`);
      await invalidate('challenge.finished', { userId: a.userId });
      return r ? { id: String(r.id) } : null;
    },
  };
}
