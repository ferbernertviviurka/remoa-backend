import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardDraftSchema, edgeDraftSchema, type CardDraft, type EdgeDraft } from '@remoa/contracts';
import { completeJSON, EXTRACT_PROMPT_VERSION, extractModel } from './openrouter';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export type Extracted = { cards: CardDraft[]; edges: EdgeDraft[] };

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
      if (prev) refOf.set(card.ref, prev.ref);
      else {
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
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromRef, toRef, label: edge.label });
    }
  }
  return { cards, edges };
}

/** Layered layout: x by depth, y by sibling. No extra graph library. */
export function layout(cards: CardDraft[], edges: EdgeDraft[]): { ref: string; x: number; y: number }[] {
  const depth = new Map(cards.map((c) => [c.ref, 0]));
  for (let i = 0; i < cards.length; i++) {
    for (const e of edges) {
      const d = (depth.get(e.fromRef) ?? 0) + 1;
      if (d > (depth.get(e.toRef) ?? 0)) depth.set(e.toRef, d);
    }
  }
  const rows = new Map<number, number>();
  return cards.map((c) => {
    const x = depth.get(c.ref) ?? 0;
    const y = rows.get(x) ?? 0;
    rows.set(x, y + 1);
    return { ref: c.ref, x: 80 + x * 280, y: 80 + y * 180 };
  });
}

/** Offline extraction: one concept per non-empty paragraph, titled by the first sentence. */
export function extractOffline(text: string, source: string): Extracted {
  const cards: CardDraft[] = chunkText(text, 400)
    .map((block, i) => {
      const title = (block.split(/[.\n]/)[0] ?? `Card ${i + 1}`).trim().slice(0, 120) || `Card ${i + 1}`;
      return {
        ref: `c${i + 1}`,
        type: 'concept' as const,
        title,
        front: null,
        back: block.slice(0, 2000),
        source,
        payload: {},
      };
    })
    .filter((c) => c.title.length > 0);
  const edges: EdgeDraft[] = cards.slice(1).map((c, i) => ({ fromRef: cards[i]!.ref, toRef: c.ref, label: 'leva a' }));
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
export async function extractWithMeta(text: string, source: string, fetchImpl?: typeof fetch): Promise<{ extracted: Extracted; meta: ExtractMeta }> {
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
      const done = await completeJSON({ model: extractModel(), system: extractPrompt, user: chunk, timeoutMs: 20_000, fetchImpl });
      tokensIn += done.tokensIn;
      tokensOut += done.tokensOut;
      model = done.model;
      const parsed = parseExtract(done.text, source);
      if (parsed) parts.push(parsed);
    }
    const extracted = mergeDrafts(parts);
    if (!extracted.cards.length) return offline();
    return { extracted, meta: { model, promptVersion: EXTRACT_PROMPT_VERSION, tokensIn, tokensOut } };
  } catch {
    return offline();
  }
}
