// G25 (F32) T5: "Resumo com IA" (FR-46–FR-52). One generateJson call for a normal map; a large map (more than SUMMARY_MAX_CARDS cards
// or more than SUMMARY_MAX_MODULES modules) is summarized per module and the sections are joined in code (no join call).
// Every kept item cites a card of the board (FR-49) and every number or dose of it is written in the cited cards. The result is saved
// per board version, the last SUMMARY_HISTORY rows stay, and it reads as `stale` once the map changes (FR-50). One `ai_summaries` unit is
// taken before the first call and goes back on any failure; the model answer is never cached.
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  err, mapSummaryPublicSchema, ok,
  type AppError, type MapSummaryPublic, type Result, type SummarySection, summarySectionKinds,
} from '@remoa/contracts';
import { AiError, generateJson, loadChallengePrompt, numbersGrounded, renderChallengePrompt, type ChallengePrompt } from '@remoa/ai';
import { createLogger } from '@remoa/log';
import { reserveAi } from '../billing/quota';
import { asServer, run } from '../db';
import { cardText, dbStore as mapStore, serializeMap, type MapContext, type ScopeCard } from './generate';

const SUMMARY_KINDS = summarySectionKinds;
type Kind = (typeof SUMMARY_KINDS)[number];
type Size = 'quick' | 'standard' | 'full';
type Focus = 'overview' | 'high_yield' | 'exam_eve';

/** FR-47: above either number the map is summarized module by module. */
export const SUMMARY_MAX_CARDS = 40;
export const SUMMARY_MAX_MODULES = 4;
/** FR-50. */
export const SUMMARY_HISTORY = 5;
/** Module calls in flight at once. */
export const SUMMARY_CONCURRENCY = 3;
/** mapSummaryPublicSchema: at most 12 sections; summarySectionSchema: at most 40 items, 20 rows; FR-48: checklist of 5 to 10. */
const MAX_SECTIONS = 12;
const MAX_ITEMS = 40;
const MAX_ROWS = 20;
const MAX_CHECKLIST = 10;
const MAX_CITED = 12;

const PUBLICO = 'estudantes de medicina do 5º e 6º ano e recém-formados que estudam para o ENAMED e a residência';
const AREA_LABEL: Record<string, string> = {
  CM: 'Clínica Médica', CIR: 'Cirurgia', GO: 'Ginecologia e Obstetrícia', PED: 'Pediatria', MP: 'Medicina Preventiva', OUTRO: 'Outra',
};
const TAMANHO: Record<Size, string> = { quick: 'rápido', standard: 'padrão', full: 'completo' };
const FOCO: Record<Focus, string> = { overview: 'visão geral', high_yield: 'o que costuma cair', exam_eve: 'véspera de prova' };
/** Only the schema needs a title; the screen labels sections by `kind` (strings live in the frontend). */
const FALLBACK_TITLE: Record<Kind, string> = {
  overview: 'Visão geral', module_points: 'Pontos-chave', flows: 'Fluxos', comparisons: 'Comparações', mnemonics: 'Macetes', pitfalls: 'Pegadinhas',
  checklist: 'Checklist',
};

// --- Model output (the prompt's own shape, pt-BR keys) ---------------------------------------------------------------

const refs = z.array(z.string().min(1).max(80)).max(40).nullish();
/** `resumir-mapa` v1 output. `tipo` is mapped in code, so an unknown one drops one section instead of the whole reply. */
export const summaryReplySchema = z.object({
  titulo: z.string().max(300).nullish(),
  secoes: z.array(z.object({
    tipo: z.string().min(1).max(40),
    titulo: z.string().max(300).nullish(),
    modulo: z.string().max(200).nullish(),
    itens: z.array(z.object({ texto: z.string().min(1).max(4000), cards: refs })).max(80).nullish(),
    colunas: z.array(z.string().max(300)).max(12).nullish(),
    linhas: z.array(z.array(z.string().max(1000)).max(12)).max(60).nullish(),
    cards: refs,
  })).max(30),
});
type ReplySection = z.infer<typeof summaryReplySchema>['secoes'][number];

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/[\s-]+/g, '_');
const KIND_OF: Record<string, Kind> = {
  visao_geral: 'overview', pontos_chave: 'module_points', fluxo: 'flows', fluxos: 'flows', comparacao: 'comparisons', comparacoes: 'comparisons',
  macetes: 'mnemonics', macete: 'mnemonics', pegadinhas: 'pitfalls', pegadinha: 'pitfalls', checklist: 'checklist',
};

// --- Plan: what goes in each call ------------------------------------------------------------------------------------

export type SummaryGroup = { module: string | null; cards: ScopeCard[] };

const moduleOf = (c: ScopeCard): string | null => {
  const d = c.didactics;
  const m = d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>).modulo : null;
  return typeof m === 'string' && m.trim() ? m.trim() : null;
};

/** One group for a normal map; for a large one, a group per module in map order (a module over SUMMARY_MAX_CARDS is cut in runs of that size). */
export function planSummary(cards: readonly ScopeCard[]): { large: boolean; groups: SummaryGroup[] } {
  const modules = new Set(cards.map(moduleOf).filter((m) => m !== null));
  if (cards.length <= SUMMARY_MAX_CARDS && modules.size <= SUMMARY_MAX_MODULES) return { large: false, groups: [{ module: null, cards: [...cards] }] };
  const byModule = new Map<string | null, ScopeCard[]>();
  for (const c of cards) byModule.set(moduleOf(c), [...(byModule.get(moduleOf(c)) ?? []), c]);
  const groups: SummaryGroup[] = [];
  for (const [module, list] of byModule) {
    for (let i = 0; i < list.length; i += SUMMARY_MAX_CARDS) groups.push({ module, cards: list.slice(i, i + SUMMARY_MAX_CARDS) });
  }
  return { large: true, groups };
}

// --- Guards ----------------------------------------------------------------------------------------------------------

export type SummaryDiscards = { citation: number; numbers: number; format: number };

/** Short ids (c1..) of this call's map, or the id of any card of the board. Unknown ids simply do not count. */
function cited(raw: readonly string[] | null | undefined, local: Map<string, ScopeCard>, board: Map<string, ScopeCard>): ScopeCard[] {
  const out = new Map<string, ScopeCard>();
  for (const r of raw ?? []) {
    const key = r.trim().replace(/^\[|\]$/g, '').toLowerCase();
    const c = local.get(key) ?? board.get(key);
    if (c) out.set(c.id, c);
  }
  return [...out.values()].slice(0, MAX_CITED);
}

const cleanText = (s: string) => s.replace(/\s+/g, ' ').trim();

type Screen = { local: Map<string, ScopeCard>; board: Map<string, ScopeCard>; discards: SummaryDiscards };

function screenItems(items: NonNullable<ReplySection['itens']>, s: Screen): { text: string; cardIds: string[] }[] {
  const out: { text: string; cardIds: string[] }[] = [];
  for (const it of items) {
    const text = cleanText(it.texto);
    const cards = cited(it.cards, s.local, s.board);
    if (!text || text.length > 1200) s.discards.format++;
    else if (!cards.length) s.discards.citation++;
    else if (!numbersGrounded([text], cards.map(cardText))) s.discards.numbers++;
    else out.push({ text, cardIds: cards.map((c) => c.id) });
  }
  return out;
}

function screenTable(sec: ReplySection, s: Screen): SummarySection['table'] {
  const header = (sec.colunas ?? []).map(cleanText);
  if (header.length < 2 || header.length > 6 || header.some((h) => !h || h.length > 120)) {
    if (sec.linhas?.length) s.discards.format += sec.linhas.length;
    return undefined;
  }
  const cards = cited(sec.cards, s.local, s.board);
  const rows: NonNullable<SummarySection['table']>['rows'] = [];
  for (const line of sec.linhas ?? []) {
    const cells = line.map(cleanText);
    if (cells.length !== header.length || cells.some((c) => !c || c.length > 400)) s.discards.format++;
    else if (!cards.length) s.discards.citation++;
    else if (!numbersGrounded(cells, cards.map(cardText))) s.discards.numbers++;
    else rows.push({ cells, cardIds: cards.map((c) => c.id) });
  }
  return rows.length ? { header, rows: rows.slice(0, MAX_ROWS) } : undefined;
}

/** One reply section after the guards; null when nothing of it survived. */
function screenSection(sec: ReplySection, group: SummaryGroup, s: Screen): SummarySection | null {
  const kind = KIND_OF[fold(sec.tipo)];
  if (!kind) {
    s.discards.format++;
    return null;
  }
  const items = kind === 'comparisons' ? [] : screenItems(sec.itens ?? [], s).slice(0, kind === 'checklist' ? MAX_CHECKLIST : MAX_ITEMS);
  const table = kind === 'comparisons' ? screenTable(sec, s) : undefined;
  if (!items.length && !table) return null;
  const module = kind === 'module_points' ? (cleanText(sec.modulo ?? '') || group.module || undefined)?.slice(0, 40) : undefined;
  const title = cleanText(sec.titulo ?? '') || module || FALLBACK_TITLE[kind];
  const out: SummarySection = { kind, title: title.slice(0, 200), items };
  if (module) out.module = module;
  if (table) out.table = table;
  return out;
}

// --- Join (code, no model call) --------------------------------------------------------------------------------------

/** Cut from the end of this list first when more than MAX_SECTIONS remain; overview and checklist are never cut. */
const DROP_ORDER: Kind[] = ['comparisons', 'flows', 'mnemonics', 'pitfalls', 'module_points'];

/**
 * Concatenates the sections of every call in map order: one section per kind (per module for `module_points`, per header for
 * `comparisons`), kinds in FR-48 order, checklist at most 10, at most 12 sections.
 */
export function joinSections(parts: readonly SummarySection[][]): SummarySection[] {
  const merged = new Map<string, SummarySection>();
  for (const sec of parts.flat()) {
    const key = sec.kind === 'module_points' ? `${sec.kind}:${fold(sec.module ?? '')}` : sec.kind === 'comparisons' ? `${sec.kind}:${(sec.table?.header ?? []).map(fold).join('|')}` : sec.kind;
    const at = merged.get(key);
    if (!at) {
      merged.set(key, { ...sec, items: [...sec.items], ...(sec.table ? { table: { header: sec.table.header, rows: [...sec.table.rows] } } : {}) });
      continue;
    }
    at.items.push(...sec.items);
    if (at.table && sec.table) at.table.rows.push(...sec.table.rows);
  }
  const all = [...merged.values()].map((sec) => ({
    ...sec,
    items: sec.items.slice(0, sec.kind === 'checklist' ? MAX_CHECKLIST : MAX_ITEMS),
    ...(sec.table ? { table: { header: sec.table.header, rows: sec.table.rows.slice(0, MAX_ROWS) } } : {}),
  }));
  all.sort((a, b) => SUMMARY_KINDS.indexOf(a.kind) - SUMMARY_KINDS.indexOf(b.kind)); // stable: modules keep the map order
  for (const kind of DROP_ORDER) {
    for (let i = all.length - 1; i >= 0 && all.length > MAX_SECTIONS; i--) if (all[i]!.kind === kind) all.splice(i, 1);
  }
  return all;
}

// --- Store -----------------------------------------------------------------------------------------------------------

export type SummaryRow = {
  id: string;
  userId: string;
  boardId: string;
  boardVersion: number;
  size: Size;
  focus: Focus;
  content: SummarySection[];
  cardsCited: string[];
  model: string | null;
  /** `desafios/resumir-mapa@v1`: the prompt id and its version in one column (there is no separate prompt_id column). */
  promptVersion: string | null;
  stale: boolean;
  createdAt: Date;
};

export type SummaryStore = {
  /** The user's board with every live card, in map order; null = not the user's board. */
  context(userId: string, boardId: string): Promise<MapContext | null>;
  /** Current `boards.version`; null = not the user's board. */
  version(userId: string, boardId: string): Promise<number | null>;
  /** Newest first. */
  list(userId: string, boardId: string, limit: number): Promise<SummaryRow[]>;
  insert(userId: string, row: SummaryRow): Promise<void>;
  remove(userId: string, boardId: string, ids: readonly string[]): Promise<void>;
};

export const dbStore: SummaryStore = {
  context: (userId, boardId) => mapStore.context(userId, boardId, { kind: 'board' }),
  async version(userId, boardId) {
    return run(userId, async (tx, s) => {
      const [b] = await tx.select({ version: s.boards.version }).from(s.boards).where(and(eq(s.boards.id, boardId), eq(s.boards.userId, userId)));
      return b?.version ?? null;
    });
  },
  async list(userId, boardId, limit) {
    return run(userId, async (tx, s) => {
      const rows = await tx.select().from(s.mapSummaries).where(and(eq(s.mapSummaries.userId, userId), eq(s.mapSummaries.boardId, boardId)))
        .orderBy(desc(s.mapSummaries.createdAt), desc(s.mapSummaries.id)).limit(limit);
      return rows.map((r): SummaryRow => ({
        id: r.id, userId: r.userId, boardId: r.boardId, boardVersion: r.boardVersion, size: r.size, focus: r.focus, content: r.content,
        cardsCited: r.cardsCited, model: r.model, promptVersion: r.promptVersion, stale: r.stale, createdAt: r.createdAt,
      }));
    });
  },
  async insert(userId, row) {
    await run(userId, async (tx, s) => {
      const [own] = await tx.select({ id: s.boards.id }).from(s.boards).where(and(eq(s.boards.id, row.boardId), eq(s.boards.userId, userId)));
      if (!own) throw new Error('board_not_found');
      // `authenticated` can only read map_summaries: the insert runs as the server role inside this transaction
      await asServer(tx, tx.insert(s.mapSummaries).values({ ...row, userId }).getSQL());
    });
  },
  async remove(userId, boardId, ids) {
    if (!ids.length) return;
    await run(userId, async (tx, s) => {
      await asServer(tx, tx.delete(s.mapSummaries).where(and(eq(s.mapSummaries.userId, userId), eq(s.mapSummaries.boardId, boardId), inArray(s.mapSummaries.id, [...ids]))).getSQL());
    });
  },
};

export type SummaryDeps = { store: SummaryStore; now: () => Date; newId: () => string };
const defaultDeps: SummaryDeps = { store: dbStore, now: () => new Date(), newId: randomUUID };

// --- Public shape ----------------------------------------------------------------------------------------------------

/** FR-50: `stale` once the board is past the version this summary was made from. Parsed strictly: nothing but the public fields leaves. */
export const toPublicSummary = (row: SummaryRow, currentVersion: number): MapSummaryPublic =>
  mapSummaryPublicSchema.parse({
    id: row.id, boardId: row.boardId, boardVersion: row.boardVersion, size: row.size, focus: row.focus, sections: row.content,
    stale: row.stale || row.boardVersion !== currentVersion, createdAt: row.createdAt,
  });

/** Saved summaries of a map, newest first (at most SUMMARY_HISTORY). */
export async function listSummaries(userId: string, boardId: string, deps: SummaryDeps = defaultDeps): Promise<Result<MapSummaryPublic[]>> {
  const version = await deps.store.version(userId, boardId);
  if (version === null) return err('not_found', 'board not found');
  const rows = await deps.store.list(userId, boardId, SUMMARY_HISTORY);
  return ok(rows.map((r) => toPublicSummary(r, version)));
}

export async function latestSummary(userId: string, boardId: string, deps: SummaryDeps = defaultDeps): Promise<Result<MapSummaryPublic | null>> {
  const r = await listSummaries(userId, boardId, deps);
  return r.ok ? ok(r.data[0] ?? null) : r;
}

// --- Service ---------------------------------------------------------------------------------------------------------

export type GenerateSummaryInput = { boardId: string; userId: string; size: Size; focus: Focus; requestId?: string };

type Call = { group: SummaryGroup; system: string; local: Map<string, ScopeCard> };

const aiFailure = (e: AiError): AppError => ({ code: e.code === 'rate_limited' || e.code === 'quota_exceeded' ? 'rate_limited' : 'ai_unavailable', message: e.userMessage });

function buildCalls(ctx: MapContext, groups: readonly SummaryGroup[], large: boolean, input: GenerateSummaryInput, prompt: ChallengePrompt): Call[] {
  return groups.map((group) => {
    const sub: MapContext = large
      ? { ...ctx, cards: group.cards, edges: ctx.edges.filter((e) => group.cards.some((c) => c.id === e.fromCardId) && group.cards.some((c) => c.id === e.toCardId)) }
      : ctx;
    const { text, refs: local } = serializeMap(sub);
    const rendered = renderChallengePrompt(prompt, {
      assunto: group.module ? `${ctx.title} (módulo ${group.module})` : ctx.title,
      area: AREA_LABEL[ctx.area] ?? ctx.area,
      publico: PUBLICO,
      tamanho: large ? `${TAMANHO[input.size]}, para esta parte do mapa` : TAMANHO[input.size],
      foco: FOCO[input.focus],
      mapa: text,
    });
    if (!rendered.ok) throw new Error(`prompt_variable:${rendered.variable}`);
    return { group, system: rendered.data, local };
  });
}

/**
 * FR-46–FR-50. Takes one `ai_summaries` unit before the first call; any failure (a call, an empty result, the save) gives it back.
 * A summary missing a module would mislead, so one failed call fails the whole summary. Inserts a new row (never updates the old one)
 * and keeps the SUMMARY_HISTORY newest of the map.
 */
export async function generateSummary(input: GenerateSummaryInput, deps: SummaryDeps = defaultDeps): Promise<Result<MapSummaryPublic>> {
  const { store } = deps;
  const ctx = await store.context(input.userId, input.boardId);
  if (!ctx) return err('not_found', 'board not found');
  if (!ctx.cards.length) return err('validation', 'empty_scope');
  const log = createLogger({ requestId: input.requestId ?? 'challenge-summary' });
  const prompt = loadChallengePrompt('resumir-mapa');
  const { large, groups } = planSummary(ctx.cards);
  const calls = buildCalls(ctx, groups, large, input, prompt);
  const board = new Map(ctx.cards.map((c) => [c.id, c]));

  const held = await reserveAi(input.userId, 'ai_summaries', deps.now());
  if (!held.ok) return { ok: false, error: held.error };

  const giveBack = async () => {
    try {
      await held.refund();
    } catch {
      log.warn('summary_refund_failed', { event: 'summary_refund_failed' });
    }
  };
  const discards: SummaryDiscards = { citation: 0, numbers: 0, format: 0 };
  const models: string[] = [];
  const ask = async (call: Call): Promise<SummarySection[]> => {
    const r = await generateJson(summaryReplySchema, {
      fn: 'summary', system: call.system, user: 'Responda agora apenas com o JSON pedido.', temperature: prompt.meta.temperatura ?? undefined, requestId: input.requestId,
    });
    if (!models.includes(r.model)) models.push(r.model);
    log.info('ai_call', { event: 'ai_call', fn: 'summary', model: r.model.slice(0, 80), latencyMs: Math.round(r.latencyMs), status: 'ok' });
    const screen: Screen = { local: call.local, board, discards };
    // only the parsed fields are read: whatever else the model wrote (reasoning included) never reaches the result
    return r.data.secoes.flatMap((s) => screenSection(s, call.group, screen) ?? []);
  };

  const parts: SummarySection[][] = [];
  try {
    for (let i = 0; i < calls.length; i += SUMMARY_CONCURRENCY) parts.push(...(await Promise.all(calls.slice(i, i + SUMMARY_CONCURRENCY).map(ask))));
  } catch (e) {
    await giveBack();
    if (!(e instanceof AiError)) throw e;
    log.warn('ai_error', { event: 'ai_error', fn: 'summary', type: e.code });
    return { ok: false, error: aiFailure(e) };
  }

  const sections = joinSections(parts);
  log.info('summary_guards', { event: 'summary_guards', calls: calls.length, sections: sections.length, ...discards });
  if (!sections.length) {
    await giveBack();
    return err('ai_unavailable', 'summary_empty');
  }

  const row: SummaryRow = {
    id: deps.newId(), userId: input.userId, boardId: ctx.boardId, boardVersion: ctx.boardVersion, size: input.size, focus: input.focus, content: sections,
    cardsCited: [...new Set(sections.flatMap((s) => [...s.items.flatMap((i) => i.cardIds), ...(s.table?.rows.flatMap((r) => r.cardIds) ?? [])]))],
    model: models.join(', ').slice(0, 200) || null, promptVersion: prompt.promptVersion, stale: false, createdAt: deps.now(),
  };
  try {
    await store.insert(input.userId, row);
  } catch (e) {
    await giveBack();
    throw e;
  }
  try {
    // the new row is never a candidate: it stays and the (SUMMARY_HISTORY - 1) newest others with it
    const others = (await store.list(input.userId, ctx.boardId, SUMMARY_HISTORY + 20)).filter((r) => r.id !== row.id);
    await store.remove(input.userId, ctx.boardId, others.slice(SUMMARY_HISTORY - 1).map((r) => r.id));
  } catch {
    log.warn('summary_prune_failed', { event: 'summary_prune_failed' }); // the summary is saved; the next one prunes again
  }
  return ok(toPublicSummary(row, ctx.boardVersion));
}
