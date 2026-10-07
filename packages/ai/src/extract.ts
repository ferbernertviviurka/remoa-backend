import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { graphlib } from '@dagrejs/dagre';
import { cardDraftSchema, edgeDraftSchema, type CardDraft, type EdgeDraft } from '@remoa/contracts';

// CJS package: Node ESM does not see the named `layout` export (tsx watch crashed on it).
const require = createRequire(import.meta.url);
const dagre = require('@dagrejs/dagre') as {
  graphlib: typeof graphlib;
  layout: (graph: InstanceType<typeof graphlib.Graph>) => void;
};
import { z } from 'zod';
import { AiError, generateJson } from './client';
import { aiMode } from './config';
import { EXTRACT_PROMPT_VERSION, extractUser, LIMITS, redact } from './openrouter';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** `sourceExcerpt`: the literal passage of the input that backs an AI card (D-1422). Offline cards have none. */
export type ExtractedCard = CardDraft & { sourceExcerpt?: string };
export type Extracted = { cards: ExtractedCard[]; edges: EdgeDraft[] };

/** Whole map generation, including every chunk, must finish inside this budget (F05). */
export const GENERATE_BUDGET_MS = 10 * 60 * 1000;

/**
 * Split long text into sections of about 1 500 characters, breaking on blank lines. A block longer than `size` breaks on its
 * lines (D-1568: PDF text has almost no blank lines; one 27k block was cut to the model's 8k and the rest never sent).
 */
export function chunkText(text: string, size = 1500): string[] {
  const parts: string[] = [];
  let buf = '';
  for (const block of text.split(/\n\s*\n/).flatMap((b) => (b.length > size ? b.split('\n') : [b]))) {
    if ((buf + block).length > size && buf) {
      parts.push(buf.trim());
      buf = '';
    }
    buf = `${buf}\n\n${block}`;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length ? parts : [text];
}

/** Merge drafts that share a normalized title. Edges are rewritten onto the kept ref. */
export function mergeDrafts(chunks: Extracted[]): Extracted {
  const cards: ExtractedCard[] = [];
  const refOf = new Map<string, string>();
  for (const chunk of chunks) {
    for (const card of chunk.cards) {
      const key = fold(card.title);
      const prev = cards.find((c) => fold(c.title) === key);
      if (prev) {
        refOf.set(card.ref, prev.ref);
        const longer = (card.back?.trim().length ?? 0) > (prev.back?.trim().length ?? 0);
        const front = prev.front?.trim() ? prev.front : card.front;
        const source = prev.source?.trim() ? prev.source : card.source;
        const back = longer ? card.back : prev.back;
        if (back !== prev.back || front !== prev.front || source !== prev.source) {
          cards[cards.indexOf(prev)] = { ...prev, back, front, source };
        }
      } else {
        cards.push(card);
        refOf.set(card.ref, card.ref);
      }
    }
  }
  const edges: EdgeDraft[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    for (const edge of chunk.edges) {
      const fromRef = refOf.get(edge.fromRef) ?? edge.fromRef;
      const toRef = refOf.get(edge.toRef) ?? edge.toRef;
      if (fromRef === toRef || !cards.some((c) => c.ref === fromRef) || !cards.some((c) => c.ref === toRef)) continue;
      const key = `${fromRef}>${toRef}`;
      if (seen.has(key)) {
        if (edge.label?.trim()) {
          const at = edges.findIndex((e) => e.fromRef === fromRef && e.toRef === toRef);
          if (at >= 0 && !edges[at]?.label?.trim()) edges[at] = { fromRef, toRef, label: edge.label };
        }
        continue;
      }
      seen.add(key);
      edges.push({ fromRef, toRef, label: edge.label });
    }
  }
  return { cards, edges };
}

const CARD_W = 240;
const CARD_H = 140;

/** Dagre places each card from its edges. Coordinates are the card's top-left. */
export function layout(cards: CardDraft[], edges: EdgeDraft[]): { ref: string; x: number; y: number }[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 80, marginx: 80, marginy: 80 });
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.ref)) continue;
    seen.add(card.ref);
    g.setNode(card.ref, { width: CARD_W, height: CARD_H });
  }
  for (const edge of edges) {
    if (seen.has(edge.fromRef) && seen.has(edge.toRef) && edge.fromRef !== edge.toRef) g.setEdge(edge.fromRef, edge.toRef, {});
  }
  dagre.layout(g);
  return cards.map((card) => {
    const node = g.node(card.ref) as { x?: number; y?: number } | undefined;
    const x = typeof node?.x === 'number' ? node.x : 80;
    const y = typeof node?.y === 'number' ? node.y : 80;
    return { ref: card.ref, x: Math.round(x - CARD_W / 2), y: Math.round(y - CARD_H / 2) };
  });
}

const caseStageOf: Record<string, 'presentation' | 'workup' | 'diagnosis' | 'management'> = {
  apresentacao: 'presentation',
  exames: 'workup',
  diagnostico: 'diagnosis',
  conduta: 'management',
};

function conceptOf(block: string, ref: string, source: string): CardDraft | null {
  const title = (block.split(/[.\n]/)[0] ?? '').trim().slice(0, 120);
  if (!title) return null;
  const draft = { ref, type: 'concept' as const, title, front: null, back: block.slice(0, 2000), source, payload: {} };
  return cardDraftSchema.safeParse(draft).success ? draft : null;
}

/** Offline extraction. Plain prose becomes one concept per chunk. A block marked Fluxo, Caso or Relação becomes a flowchart, a case or a labeled edge. */
export function extractOffline(text: string, source: string): Extracted {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const marked = blocks.some((b) => /^(fluxo|caso|relação|relacao)\s*:/i.test(b));
  if (!marked) {
    const cards = chunkText(text, 400).flatMap((block, i) => {
      const card = conceptOf(block, `c${i + 1}`, source);
      return card ? [card] : [];
    });
    const edges: EdgeDraft[] = cards.slice(1).map((c, i) => ({ fromRef: cards[i]!.ref, toRef: c.ref, label: 'leva a' }));
    return mergeDrafts([{ cards, edges }]);
  }
  const cards: CardDraft[] = [];
  const pending: { from: string; to: string; label: string }[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const head = lines[0] ?? '';
    if (/^(relação|relacao)\s*:/i.test(head)) {
      const rel = head.includes('->') ? lines.map((l) => l.replace(/^(relação|relacao)\s*:\s*/i, '')) : lines.slice(1);
      for (const line of rel) {
        const m = /^(.+?)\s*->\s*(.+?)\s*:\s*(.+)$/.exec(line);
        if (m?.[1] && m[2] && m[3]) pending.push({ from: m[1].trim(), to: m[2].trim(), label: m[3].trim().slice(0, 80) });
      }
      continue;
    }
    if (/^fluxo\s*:/i.test(head)) {
      const title = head.replace(/^fluxo\s*:\s*/i, '').trim().slice(0, 120);
      const steps = lines.slice(1).map((l) => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean).slice(0, 12);
      const draft = {
        ref: `c${cards.length + 1}`, type: 'flow' as const, title, front: null, back: steps.join(' ').slice(0, 2000), source,
        payload: { steps: steps.map((step, i) => ({ id: `s${i + 1}`, text: step.slice(0, 500) })) },
      };
      if (cardDraftSchema.safeParse(draft).success) cards.push(draft);
      else {
        const concept = conceptOf(block, `c${cards.length + 1}`, source);
        if (concept) cards.push(concept);
      }
      continue;
    }
    if (/^caso\s*:/i.test(head)) {
      const title = head.replace(/^caso\s*:\s*/i, '').trim().slice(0, 120);
      const seen = new Set<string>();
      const caseSteps = lines.slice(1).flatMap((line) => {
        const m = /^([^:]+):\s*(.+)$/.exec(line);
        if (!m?.[1] || !m[2]) return [];
        const stage = caseStageOf[fold(m[1])];
        if (!stage || seen.has(stage)) return [];
        seen.add(stage);
        return [{ stage, text: m[2].trim().slice(0, 2000) }];
      });
      const draft = {
        ref: `c${cards.length + 1}`, type: 'case' as const, title, front: null, back: caseSteps.map((s) => s.text).join(' ').slice(0, 2000), source,
        payload: { caseSteps },
      };
      if (cardDraftSchema.safeParse(draft).success) cards.push(draft);
      continue;
    }
    const concept = conceptOf(block, `c${cards.length + 1}`, source);
    if (concept) cards.push(concept);
  }
  const edges: EdgeDraft[] = pending.flatMap((p) => {
    const from = cards.find((c) => fold(c.title) === fold(p.from));
    const to = cards.find((c) => fold(c.title) === fold(p.to));
    if (!from || !to) return [];
    const draft = { fromRef: from.ref, toRef: to.ref, label: p.label };
    return edgeDraftSchema.safeParse(draft).success ? [draft] : [];
  });
  return mergeDrafts([{ cards, edges }]);
}

const extractPrompt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../prompts/extract/v2.md'), 'utf8');

/** Ceiling when the caller does not pass the plan's limit; the API passes the plan value (never a fixed quota). */
export const DEFAULT_MAX_CARDS = 40;
/** Characters per model call. ~1.5k tokens: few calls per text, which matters with 50 free calls a day (D-1423). */
export const CHUNK_CHARS = 6_000;
/** Text beyond this is not sent (about 30 pages); `meta.truncated` says so. */
export const MAX_SOURCE_CHARS = 120_000;

/** `dropped`: model cards thrown away because their `sourceExcerpt` is not literally in the text (content from outside). */
/** `error` (G22, D-1414): set when the cards came from `extractOffline` because the model failed; the API fails the job instead of saving them as AI. */
export type ExtractMeta = { model: string; promptVersion: string; tokensIn: number; tokensOut: number; latencyMs: number; dropped?: number; truncated?: boolean; error?: AiError };

const replyCardSchema = z.object({
  ref: z.string().min(1).max(40),
  type: z.enum(['concept', 'flow', 'case']).catch('concept'),
  title: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(2000),
  sourceExcerpt: z.string().trim().min(12).max(1000),
  payload: z.unknown().optional(),
});

const words = (t: string) => fold(t.replace(/[^\p{L}\p{N}]+/gu, ' '));

/**
 * The excerpt is in the text, ignoring accents, case, spaces and punctuation (quotes, dashes, list numbers). An excerpt that
 * joins lines from different places ("Apresentação: …\nDiagnóstico: …", or cut with "…") passes only if EVERY line is
 * literally there and has 3+ words (G22 live round, D-1439): nothing invented gets through, but a faithful splice is not thrown away.
 */
export const literalIn = (haystack: string, excerpt: string) => {
  const hay = words(haystack);
  const parts = excerpt.split(/\n|\.{3}|…/).map(words).filter(Boolean);
  // A splice of tiny pieces ("não" + "dar insulina") could build a new claim: with more than one piece, each needs 3+ words.
  const big = parts.length === 1 || parts.every((p) => p.split(' ').length >= 3);
  return parts.length > 0 && big && parts.every((p) => hay.includes(p));
};

/** Valid items become drafts; an item whose excerpt is not in `chunk` is dropped and counted. Edges need a name. */
export function parseExtract(raw: { cards: unknown[]; edges?: unknown }, source: string, chunk: string): { extracted: Extracted; dropped: number } {
  const cards: ExtractedCard[] = [];
  let dropped = 0;
  for (const item of raw.cards) {
    const row = replyCardSchema.safeParse(item);
    if (!row.success) continue;
    const r = row.data;
    if (!literalIn(chunk, r.sourceExcerpt)) {
      dropped += 1;
      continue;
    }
    const draft = cardDraftSchema.safeParse({ ref: r.ref, type: r.type, title: r.title, front: r.question, back: r.answer, source, payload: r.type === 'concept' ? {} : r.payload });
    if (draft.success) cards.push({ ...draft.data, sourceExcerpt: r.sourceExcerpt });
  }
  const refs = new Set(cards.map((c) => c.ref));
  const edges: EdgeDraft[] = Array.isArray(raw.edges)
    ? raw.edges.flatMap((edge) => {
        const parsed = edgeDraftSchema.safeParse(edge);
        if (!parsed.success || !parsed.data.label?.trim() || !refs.has(parsed.data.fromRef) || !refs.has(parsed.data.toRef)) return [];
        return [{ ...parsed.data, label: parsed.data.label.trim().slice(0, 80) }];
      })
    : [];
  return { extracted: { cards, edges }, dropped };
}

/**
 * A chunk reply. `cards: []` is a valid answer (nothing to study). Items are checked one by one; a non-empty list where no
 * item has the required fields fails validation and triggers the one repair.
 */
const extractReply = (source: string, chunk: string) =>
  z.object({ cards: z.array(z.unknown()), edges: z.unknown().optional() }).passthrough().transform((raw, ctx) => {
    const parsed = parseExtract(raw, source, chunk);
    if (raw.cards.length && !parsed.extracted.cards.length && !parsed.dropped) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cards'], message: 'nenhum card válido (ref, title, question, answer e sourceExcerpt literal obrigatórios)' });
      return z.NEVER;
    }
    return parsed;
  });

/** Every chunk numbers its refs from c1: later chunks get a prefix so mergeDrafts never sees two cards with one ref. */
const retag = (x: Extracted, p: string): Extracted => ({
  cards: x.cards.map((c) => ({ ...c, ref: p + c.ref })),
  edges: x.edges.map((e) => ({ ...e, fromRef: p + e.fromRef, toRef: p + e.toRef })),
});

const capCards = (x: Extracted, max: number): Extracted => {
  if (x.cards.length <= max) return x;
  const cards = x.cards.slice(0, max);
  const keep = new Set(cards.map((c) => c.ref));
  return { cards, edges: x.edges.filter((e) => keep.has(e.fromRef) && keep.has(e.toRef)) };
};

/**
 * OpenRouter when configured; paragraph extraction otherwise, or if the provider fails. A chunk still invalid after one
 * repair is skipped, and so is a reply whose cards all cite text that is not there (offline then). Stops calling once `maxCards` (the plan's limit) is reached. A model that validly finds nothing in the
 * whole text throws `no_content` (the job fails and the API refunds), instead of inventing cards offline.
 */
export async function extractWithMeta(
  text: string,
  source: string,
  fetchImpl?: typeof fetch,
  deadlineAt = Date.now() + GENERATE_BUDGET_MS,
  maxCards = DEFAULT_MAX_CARDS,
  generic = false,
): Promise<{ extracted: Extracted; meta: ExtractMeta }> {
  // D-1470: area OUTRO (non-medical map) gets the same prompt without the medical framing; the subject comes from the source text.
  const system = generic ? extractPrompt.replace('cards de estudo de medicina', 'cards de estudo') : extractPrompt;
  const offline = (error?: AiError): { extracted: Extracted; meta: ExtractMeta } => ({
    extracted: capCards(extractOffline(text, source), maxCards),
    meta: { model: 'offline-extract', promptVersion: EXTRACT_PROMPT_VERSION, tokensIn: 0, tokensOut: 0, latencyMs: 0, ...(error ? { error } : {}) },
  });
  if (aiMode() !== 'live') return offline();
  let truncated = text.length > MAX_SOURCE_CHARS;
  try {
    let merged: Extracted = { cards: [], edges: [] };
    const parts: Extracted[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let latencyMs = 0;
    let dropped = 0;
    let answered = false;
    let model = '';
    for (const [i, piece] of chunkText(text.slice(0, MAX_SOURCE_CHARS), CHUNK_CHARS).entries()) {
      if (merged.cards.length >= maxCards) break;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error('generate_timeout');
      const chunk = redact(piece).slice(0, LIMITS.chunk);
      try {
        // No reasoning (G22 production model): GPT-6 Luna took 13–16 s per slice thinking, DeepSeek V4.1 Flash hit the 45 s timeout.
        const done = await generateJson(extractReply(source, chunk), {
          fn: 'extract', system, user: extractUser(chunk, maxCards - merged.cards.length), temperature: 0, reasoning: false, signal: AbortSignal.timeout(remaining), fetchImpl,
        });
        tokensIn += done.tokensIn;
        tokensOut += done.tokensOut;
        latencyMs += done.latencyMs;
        model = done.model;
        answered = true;
        dropped += done.data.dropped;
        parts.push(i === 0 ? done.data.extracted : retag(done.data.extracted, `k${i}-`));
        merged = mergeDrafts(parts);
      } catch (e) {
        // D-1568: the app's own minute/day AI limit mid-book keeps the cards already found (rest of the text not read: `truncated`).
        if (e instanceof AiError && e.local && (e.code === 'rate_limited' || e.code === 'quota_exceeded') && merged.cards.length) {
          truncated = true;
          break;
        }
        if (!(e instanceof AiError && e.code === 'invalid_output')) throw e;
        tokensIn += e.usage?.tokensIn ?? 0;
        tokensOut += e.usage?.tokensOut ?? 0;
        latencyMs += e.usage?.latencyMs ?? 0;
      }
    }
    const meta: ExtractMeta = { model, promptVersion: EXTRACT_PROMPT_VERSION, tokensIn, tokensOut, latencyMs, dropped, ...(truncated ? { truncated } : {}) };
    if (!merged.cards.length) {
      if (answered && !dropped) throw new Error('no_content');
      return offline(new AiError('invalid_output', { detail: dropped ? 'every card cited text that is not in the input' : 'no valid chunk' }));
    }
    return { extracted: capCards(merged, maxCards), meta };
  } catch (e) {
    if (e instanceof Error && (e.message === 'generate_timeout' || e.message === 'no_content')) throw e;
    return offline(e instanceof AiError ? e : new AiError('provider_error', { detail: e instanceof Error ? e.message : 'unknown' }));
  }
}
