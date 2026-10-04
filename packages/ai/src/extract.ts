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
import { completeJSON, EXTRACT_PROMPT_VERSION, extractModel } from './openrouter';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export type Extracted = { cards: CardDraft[]; edges: EdgeDraft[] };

/** Whole map generation, including every chunk, must finish inside this budget (F05). */
export const GENERATE_BUDGET_MS = 10 * 60 * 1000;

/** Split long text into sections of about 1 500 characters, breaking on blank lines. */
export function chunkText(text: string, size = 1500): string[] {
  const parts: string[] = [];
  let buf = '';
  for (const block of text.split(/\n\s*\n/)) {
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
  const cards: CardDraft[] = [];
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

const extractPrompt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../prompts/extract/v1.md'), 'utf8');

export type ExtractMeta = { model: string; promptVersion: string; tokensIn: number; tokensOut: number };

function parseExtract(text: string, source: string): Extracted | null {
  const raw = JSON.parse(text) as { cards?: unknown; edges?: unknown };
  if (!Array.isArray(raw.cards)) return null;
  const cards: CardDraft[] = [];
  for (const item of raw.cards) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const type = row.type === 'flow' || row.type === 'case' ? row.type : 'concept';
    const parsed = cardDraftSchema.safeParse({
      ref: row.ref,
      type,
      title: row.title,
      front: row.front ?? null,
      back: row.back ?? null,
      source: typeof row.source === 'string' ? row.source : source,
      payload: type === 'concept' ? {} : row.payload,
    });
    if (parsed.success) cards.push(parsed.data);
  }
  const edges: EdgeDraft[] = Array.isArray(raw.edges)
    ? raw.edges.flatMap((edge) => {
        const parsed = edgeDraftSchema.safeParse(edge);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return cards.length ? { cards, edges } : null;
}

/** OpenRouter when the key exists; paragraph extraction otherwise, or if the model reply is invalid. */
export async function extractWithMeta(text: string, source: string, fetchImpl?: typeof fetch, deadlineAt = Date.now() + GENERATE_BUDGET_MS): Promise<{ extracted: Extracted; meta: ExtractMeta }> {
  const offline = (): { extracted: Extracted; meta: ExtractMeta } => ({
    extracted: extractOffline(text, source),
    meta: { model: 'offline-extract', promptVersion: EXTRACT_PROMPT_VERSION, tokensIn: 0, tokensOut: 0 },
  });
  if (!process.env.OPENROUTER_API_KEY) return offline();
  try {
    const parts: Extracted[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let model = extractModel();
    for (const chunk of chunkText(text)) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error('generate_timeout');
      const done = await completeJSON({ model: extractModel(), system: extractPrompt, user: chunk, timeoutMs: Math.min(20_000, remaining), fetchImpl });
      tokensIn += done.tokensIn;
      tokensOut += done.tokensOut;
      model = done.model;
      const parsed = parseExtract(done.text, source);
      if (parsed) parts.push(parsed);
    }
    const extracted = mergeDrafts(parts);
    if (!extracted.cards.length) return offline();
    return { extracted, meta: { model, promptVersion: EXTRACT_PROMPT_VERSION, tokensIn, tokensOut } };
  } catch (e) {
    if (e instanceof Error && e.message === 'generate_timeout') throw e;
    return offline();
  }
}
