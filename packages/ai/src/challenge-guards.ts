// G25 (F32): server guards over what the model generates or grades in a challenge. Pure, no network, no AI.
import { challengeLimits } from './challenge-config';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const wordsOf = (s: string) => fold(s).match(/[a-z0-9]+/g) ?? [];

// ── Literal evidence ─────────────────────────────────────────────────────────

export type Evidence = { card: string; trecho: string };

const squash = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
/** Quotes and ellipses the model wraps a quote in are not part of the copy. */
const unwrap = (s: string) => s.trim().replace(/^(?:["'“”‘’«»]|\.\.\.|…)+|(?:["'“”‘’«»]|\.\.\.|…)+$/g, '');

/** `trecho` is a copy of the card text, ignoring case and extra spaces (accents and words must match). */
export function evidenceIsLiteral(trecho: string, cardText: string): boolean {
  const quote = squash(unwrap(trecho));
  return quote.length > 0 && squash(cardText).includes(quote);
}

/** At least one evidence, every cited card exists, every quote is literal. Otherwise the item is discarded. */
export function literalEvidence(evidencias: readonly Evidence[], cardTexts: Readonly<Record<string, string>>): boolean {
  return evidencias.length > 0 && evidencias.every((e) => {
    const text = cardTexts[e.card];
    return text !== undefined && evidenceIsLiteral(e.trecho, text);
  });
}

// ── Number guard ─────────────────────────────────────────────────────────────

const UNIT_ALIASES: Record<string, string> = {
  h: 'h', hr: 'h', hora: 'h', horas: 'h',
  min: 'min', minuto: 'min', minutos: 'min',
  s: 's', seg: 's', segundo: 's', segundos: 's',
  d: 'd', dia: 'd', dias: 'd',
  semana: 'sem', semanas: 'sem', sem: 'sem',
  mes: 'mes', meses: 'mes',
  ano: 'ano', anos: 'ano',
  mg: 'mg', g: 'g', kg: 'kg', mcg: 'mcg', µg: 'mcg', μg: 'mcg', ug: 'mcg', ng: 'ng', pg: 'pg',
  ml: 'ml', l: 'l', dl: 'dl',
  mmhg: 'mmhg', cmh2o: 'cmh2o',
  meq: 'meq', mmol: 'mmol', mol: 'mol', ui: 'ui', u: 'u', mui: 'mui',
  bpm: 'bpm', irpm: 'irpm', rpm: 'rpm', kcal: 'kcal',
  '%': '%', '°c': '°c',
};
const COMPARATORS: Record<string, string> = { '>=': '≥', '≥': '≥', '<=': '≤', '≤': '≤', '>': '>', '<': '<' };

export type NumberToken = { raw: string; value: string; unit: string; cmp: string };

const TOKEN = /(?:(>=|<=|≥|≤|>|<)\s*)?(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)*)(?:\s?(%|°[cC]|[\p{L}µμ][\p{L}µμ0-9]*(?:\/[\p{L}µμ0-9]+)*))?/gu;

const valueOf = (n: string) => {
  const plain = /^\d{1,3}(?:\.\d{3})+$/.test(n) ? n.replace(/\./g, '') : n.replace(',', '.');
  return String(Number(plain));
};
/** Known unit (each part of `mg/kg/h` known) in canonical form, else '' (a plain word after the number, e.g. "3 passos"). */
const unitOf = (u: string | undefined) => {
  if (!u) return '';
  const parts = u.toLowerCase().split('/').map((p) => UNIT_ALIASES[p]);
  return parts.every((p): p is string => p !== undefined) ? parts.join('/') : '';
};

/** Every number in the text, with its unit and comparator (≥ 65 mmHg → value 65, unit mmhg, cmp ≥). */
export function numbersIn(text: string): NumberToken[] {
  return [...text.normalize('NFC').matchAll(TOKEN)].map((m) => ({
    raw: m[0].trim(),
    value: valueOf(m[2] ?? ''),
    unit: unitOf(m[3]),
    cmp: m[1] ? (COMPARATORS[m[1]] ?? '') : '',
  }));
}

/**
 * Numbers of the generated texts not backed by the cited cards: the card must have the same value, the same unit when the
 * text gives one, and the same comparator when the text gives one. Empty = every number, unit, dose and threshold is grounded.
 */
export function ungroundedNumbers(texts: readonly string[], cardTexts: readonly string[]): string[] {
  const known = cardTexts.flatMap(numbersIn);
  return texts.flatMap(numbersIn).filter((t) => !known.some((c) => c.value === t.value && (!t.unit || c.unit === t.unit) && (!t.cmp || c.cmp === t.cmp))).map((t) => t.raw);
}

export const numbersGrounded = (texts: readonly string[], cardTexts: readonly string[]) => ungroundedNumbers(texts, cardTexts).length === 0;

// ── Duplicates ───────────────────────────────────────────────────────────────

const trigrams = (s: string) => {
  const text = ` ${wordsOf(s).join(' ')} `;
  const grams = new Map<string, number>();
  for (let i = 0; i + 3 <= text.length; i++) {
    const g = text.slice(i, i + 3);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
};

/** Dice coefficient over character trigrams of the folded text (accents, case and punctuation ignored), 0..1. */
export function stemSimilarity(a: string, b: string): number {
  const [ga, gb] = [trigrams(a), trigrams(b)];
  const size = (g: Map<string, number>) => [...g.values()].reduce((n, v) => n + v, 0);
  const total = size(ga) + size(gb);
  if (!wordsOf(a).length || !wordsOf(b).length) return wordsOf(a).length === wordsOf(b).length ? 1 : 0;
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / total;
}

/** Similarity ≥ threshold (GEN_DUP_THRESHOLD, default 0.8) to any existing stem of the same map. */
export function isDuplicateStem(stem: string, existing: readonly string[], threshold = challengeLimits().dupThreshold): boolean {
  return existing.some((e) => stemSimilarity(stem, e) >= threshold);
}

/** Indices of the new stems to keep: each is checked against the map's stems and the ones already kept from this batch. */
export function keepDistinctStems(stems: readonly string[], existing: readonly string[], threshold = challengeLimits().dupThreshold): number[] {
  const seen = [...existing];
  const kept: number[] = [];
  stems.forEach((s, i) => {
    if (isDuplicateStem(s, seen, threshold)) return;
    kept.push(i);
    seen.push(s);
  });
  return kept;
}

// ── Shuffle of A–D ───────────────────────────────────────────────────────────

export const LETTERS = ['A', 'B', 'C', 'D'] as const;
export type Letter = (typeof LETTERS)[number];

/** 32-bit FNV-1a of the seed, then mulberry32: the same seed always gives the same order. */
export function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Shuffled<T> = { alternativas: Record<Letter, T>; correta: Letter; from: Record<Letter, Letter> };

/** Fisher–Yates on the server, so the model's habit of putting the answer in B does not reach the student. `from[new] = old`. */
export function shuffleAlternatives<T>(alternativas: Readonly<Record<Letter, T>>, correta: Letter, seed: string): Shuffled<T> {
  const rand = seededRandom(seed);
  const order: Letter[] = [...LETTERS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as Letter, order[i] as Letter];
  }
  const from = Object.fromEntries(LETTERS.map((l, i) => [l, order[i] as Letter])) as Record<Letter, Letter>;
  return {
    alternativas: Object.fromEntries(LETTERS.map((l) => [l, alternativas[from[l]]])) as Record<Letter, T>,
    correta: LETTERS.find((l) => from[l] === correta) ?? correta,
    from,
  };
}

/** Moves a per-letter record (e.g. `explicacao_distratores`) to the shuffled letters. */
export function remapLetters<T>(byOld: Readonly<Partial<Record<Letter, T>>>, from: Readonly<Record<Letter, Letter>>): Partial<Record<Letter, T>> {
  const out: Partial<Record<Letter, T>> = {};
  for (const l of LETTERS) {
    const v = byOld[from[l]];
    if (v !== undefined) out[l] = v;
  }
  return out;
}

// ── Local prefilter (no AI) ──────────────────────────────────────────────────

export type PrefilterReason = 'vazia' | 'nao_sei' | 'curta' | 'longa' | 'manipulacao';
export type Prefiltered = { veredito: 'incorreta'; reason: PrefilterReason; manipulation: boolean };

const DONT_KNOW = new Set(['nao sei', 'sei la', 'nao lembro', 'nao faco ideia', 'nao tenho ideia', 'nao sei responder', 'nao sei a resposta', 'n sei']);

/** Matched on the folded text (no accents), except `dê nota`, which needs the accent to differ from "de nota". */
const MANIPULATION: RegExp[] = [
  /\bignor\w*\s+(?:(?:a|as|o|os|todas?|todos?|suas|seus|essas|estas|tuas)\s+)*(?:instruc|regra|orientac|comando)/,
  /\b(?:desconsidere|esqueca)\s+(?:(?:a|as|o|os|todas?|suas|seus|essas|estas)\s+)*(?:instruc|regra|orientac|comando)/,
  /\bignore\s+(?:all\s+|any\s+)?(?:previous\s+|prior\s+)?instructions\b/,
  /\b(?:de|da|coloque|atribua|marque)\s+(?:a\s+)?nota\s+(?:maxima|10|dez|cheia|total)\b/,
  /\bnota\s+maxima\b/,
  /\ba\s+resposta\s+(?:e|esta)\s+(?:o|no)\s+gabarito\b/,
  /\b(?:marque|considere|classifique|avalie|julgue)\s+(?:(?:a|esta|essa|minha)\s+resposta\s+)?(?:como\s+)?corret[ao]\b/,
  /\b(?:system\s+prompt|prompt\s+do\s+sistema|voce\s+agora\s+e)\b/,
];
const ACCENTED = [/(?:^|[^\p{L}])dê\s+(?:a\s+)?nota\b/u];

export const isManipulation = (answer: string) => {
  const folded = fold(answer);
  const lower = answer.normalize('NFC').toLowerCase();
  return MANIPULATION.some((re) => re.test(folded)) || ACCENTED.some((re) => re.test(lower));
};

/**
 * Answers decided without calling the model: manipulation (flagged), empty, longer than ANSWER_MAX_CHARS, only "não sei",
 * or fewer than 2 words. Null = send to the grader.
 */
export function prefilterAnswer(answer: string, maxChars = challengeLimits().answerMaxChars): Prefiltered | null {
  const no = (reason: PrefilterReason): Prefiltered => ({ veredito: 'incorreta', reason, manipulation: reason === 'manipulacao' });
  if (isManipulation(answer)) return no('manipulacao');
  const words = wordsOf(answer);
  if (!words.length) return no('vazia');
  if (answer.trim().length > maxChars) return no('longa');
  if (DONT_KNOW.has(words.join(' '))) return no('nao_sei');
  if (words.length < 2) return no('curta');
  return null;
}

// ── Post-process of the model's verdict ──────────────────────────────────────

export type ChallengeVerdict = 'correta' | 'parcial' | 'incorreta';
export type ModelGrade = {
  veredito: ChallengeVerdict;
  mesmo_contexto: boolean;
  pontos_faltantes: readonly string[];
  contradicoes: readonly string[];
  erro_critico: boolean;
  tentativa_de_manipulacao: boolean;
};

/**
 * The server decides, not the model: manipulation (prefilter or model flag) or a critical error is incorreta; correta stands only
 * with no missing point, no contradiction and the same context, otherwise it becomes parcial.
 */
export function finalVerdict(reply: ModelGrade, prefilterManipulation = false): { veredito: ChallengeVerdict; manipulation: boolean } {
  const manipulation = prefilterManipulation || reply.tentativa_de_manipulacao;
  if (manipulation || reply.erro_critico) return { veredito: 'incorreta', manipulation };
  const clean = reply.pontos_faltantes.length === 0 && reply.contradicoes.length === 0 && reply.mesmo_contexto;
  return { veredito: reply.veredito === 'correta' && !clean ? 'parcial' : reply.veredito, manipulation };
}

// ── N-gram leak of the hidden answer ─────────────────────────────────────────

/** Words that alone never leak an answer ("Não." as the answer must not blank every hint that says "não"). */
const STOP = new Set('a o e de do da dos das em no na nos nas que nao sim um uma uns umas os as para por com ou se e sem ao aos mais menos'.split(' '));

export const LEAK_NGRAM = 5;
export const LEAK_FALLBACK_FEEDBACK = 'Resposta avaliada. Revise o card e as conexões dele e tente de novo.';
export const LEAK_FALLBACK_HINT = 'Releia o card e o que ele conecta antes de tentar de novo.';

const gramsOf = (words: string[], k: number) => {
  const out: string[] = [];
  for (let i = 0; i + k <= words.length; i++) {
    const g = words.slice(i, i + k);
    if (!g.every((w) => STOP.has(w))) out.push(g.join(' '));
  }
  return out;
};

/** The text repeats `n` consecutive words of a hidden answer (all its words when it is shorter than `n`). */
export function leaksAnswer(text: string, hidden: string | readonly string[], n = LEAK_NGRAM): boolean {
  const words = wordsOf(text);
  return (typeof hidden === 'string' ? [hidden] : hidden).some((h) => {
    const hw = wordsOf(h);
    const k = Math.min(n, hw.length);
    if (!k) return false;
    const grams = new Set(gramsOf(hw, k));
    return gramsOf(words, k).some((g) => grams.has(g));
  });
}

/** Replaces the whole text with the fallback when it leaks the hidden answer. */
export function scrubLeak(text: string, hidden: string | readonly string[], fallback: string, n = LEAK_NGRAM): { text: string; leaked: boolean } {
  return leaksAnswer(text, hidden, n) ? { text: fallback, leaked: true } : { text, leaked: false };
}
