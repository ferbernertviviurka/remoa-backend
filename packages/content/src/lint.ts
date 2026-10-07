// FR-31 `content:lint`: the rules the schema cannot see (they depend on the whole map or on the template being partial, D-1464).
import { CONTENT_LIMITS, countContentWords, pathModules, type CardFile, type Evidence, type MapFile } from '@remoa/contracts';
import { topoOrder } from './graph';
import { MATRIZ_COMPETENCIAS, MATRIZ_DOMINIOS } from './matriz';
import { aviso, erro, type Bundle, type Issue } from './load';
import { TARGETS, tally, type Metas } from './targets';

/** FR-4: share of cards per level, inclusive bounds in %. */
export const LEVEL_BANDS = { 1: [30, 40], 2: [40, 45], 3: [15, 25] } as const;
/** FR-3 ("aproximada"): only a warning, the FR-2 targets make ~80% concept cards (D-1473). */
export const TYPE_BANDS = { conceito: [60, 70], fluxograma: [5, 8], imagem: [6, 10], caso: [6, 10] } as const;

const at = (c: CardFile, field?: string) => `cards[${c.id}]${field ? `.${field}` : ''}`;

/** Every author-written text of a card, one entry per field (a copied run never spans two fields). */
export function cardTexts(c: CardFile): string[] {
  const out = [c.titulo, c.porQue, c.pegadinha, c.naProva, c.naDiretriz?.texto, c.macete?.texto, c.macete?.explicacao];
  if (c.tipo === 'conceito') out.push(c.frente, c.verso);
  if (c.tipo === 'fluxograma') out.push(c.frente, ...c.passos.map((p) => p.texto));
  if (c.tipo === 'imagem') out.push(c.frente, c.imagem.alt);
  if (c.tipo === 'caso') out.push(c.caso.apresentacao, c.caso.exames, c.caso.diagnostico, c.caso.conduta);
  return out.filter((s): s is string => !!s);
}

const words = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * FR-23: first run of `n`+ words of `text` that also appears in `source` (case, accents and punctuation ignored), or null.
 * Text inside "..." or “...” is a marked quotation and is skipped; each side of a quote is checked on its own.
 */
export function literalCopy(text: string, source: string, n: number = CONTENT_LIMITS.literalCopyWords): string | null {
  const src = words(source);
  if (src.length < n) return null;
  const grams = new Set<string>();
  for (let i = 0; i + n <= src.length; i++) grams.add(src.slice(i, i + n).join(' '));
  for (const part of text.split(/"[^"]*"|“[^”]*”/)) {
    const w = words(part);
    for (let i = 0; i + n <= w.length; i++) {
      const g = w.slice(i, i + n).join(' ');
      if (grams.has(g)) return g;
    }
  }
  return null;
}

const pct = (k: number, total: number) => Math.round((k / total) * 1000) / 10;

function graphRules(map: MapFile): Issue[] {
  const out: Issue[] = [];
  const byId = new Map(map.cards.map((c) => [c.id, c]));
  for (const c of map.cards)
    for (const p of c.preRequisitos) {
      const pre = byId.get(p);
      if (pre && pre.ordem >= c.ordem) out.push(erro(at(c, 'preRequisitos'), `pré-requisito ${p} tem ordem ${pre.ordem}, não menor que ${c.ordem} (FR-9)`));
    }
  const topo = topoOrder(map.cards.map((c) => ({ id: c.id, deps: c.preRequisitos.filter((p) => byId.has(p) && p !== c.id) })));
  if (!topo.ok) out.push(erro('cards', `ciclo de pré-requisitos: ${topo.cycle.join(' -> ')} (FR-9)`));
  const seen = new Map<number, string>();
  for (const c of map.cards) {
    const twin = seen.get(c.ordem);
    if (twin) out.push(erro(at(c, 'ordem'), `ordem ${c.ordem} repetida (também em ${twin})`));
    seen.set(c.ordem, c.id);
  }
  // FR-9 "ordem crescente por módulo": walking by ordem never goes back to an earlier module.
  const sorted = [...map.cards].sort((a, b) => a.ordem - b.ordem);
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1]!, sorted[i]!];
    if (pathModules.indexOf(b.modulo) < pathModules.indexOf(a.modulo))
      out.push(erro(at(b, 'ordem'), `${b.modulo} com ordem ${b.ordem} vem depois de ${a.id} (${a.modulo}, ordem ${a.ordem})`));
  }
  return out;
}

function cardRules(c: CardFile, evidence: Evidence[]): Issue[] {
  const out: Issue[] = [];
  if (c.fontes.length === 0) out.push(erro(at(c, 'fontes'), 'card sem fonte (FR-21, D-1452)'));
  c.fontes.forEach((f, i) => {
    if (f.acesso === 'AAAA-MM-DD') out.push(erro(at(c, `fontes[${i}].acesso`), 'data de acesso ainda é o placeholder AAAA-MM-DD'));
    if (!evidence.some((e) => e.doc === f.doc)) out.push(erro(at(c, `fontes[${i}]`), `sem evidência de "${f.doc}" para este card em evidencias.jsonl (FR-21)`));
  });
  if (c.tipo === 'conceito' && c.nivel >= 2 && !c.porQue) out.push(erro(at(c, 'porQue'), `conceito de nível ${c.nivel} sem porQue (FR-7, FR-14)`));
  if (c.risco === 'dose' && c.revisaoDupla !== true) out.push(erro(at(c, 'revisaoDupla'), 'risco: dose exige revisaoDupla: true (FR-27)'));
  if (c.macete && countContentWords(c.macete.texto) > CONTENT_LIMITS.maceteWords)
    out.push(erro(at(c, 'macete.texto'), `macete com mais de ${CONTENT_LIMITS.maceteWords} palavras`));
  if (!!c.naProva !== !!c.naDiretriz)
    out.push(erro(at(c, c.naProva ? 'naDiretriz' : 'naProva'), 'divergência prova × diretriz precisa de naProva e naDiretriz (com data) juntos (FR-24)'));
  if (c.tags.length === 0) out.push(aviso(at(c, 'tags'), 'sem tags da Matriz (domínio, competência)'));
  const texts = cardTexts(c);
  for (const e of evidence)
    for (const t of texts) {
      const copied = literalCopy(t, e.trecho);
      if (copied) {
        out.push(erro(at(c), `cópia literal de ${CONTENT_LIMITS.literalCopyWords}+ palavras da evidência (${e.doc}): "${copied}" (FR-23)`));
        return out;
      }
    }
  return out;
}

export type LintOptions = { targets?: Record<string, Metas> };

/** All issues of a loaded map (reading/schema problems included). Errors fail `content:lint`; warnings only print. */
export function lintBundle(b: Bundle, opts: LintOptions = {}): Issue[] {
  const out = [...b.issues];
  const map = b.map;
  if (!map) return out;
  out.push(...graphRules(map));
  if (b.template) return out; // D-1471: the template is a partial example; schema and graph only.

  const targets = opts.targets ?? TARGETS;
  if (map.mapa.slug !== b.slug) out.push(erro('mapa.slug', `slug "${map.mapa.slug}" diferente da pasta "${b.slug}"`));
  const goal = targets[map.mapa.slug];
  if (!goal) out.push(erro('mapa.slug', 'slug fora da tabela de metas (FR-2, targets.ts)'));
  else {
    for (const k of Object.keys(goal) as (keyof Metas)[]) if (map.mapa.metas[k] !== goal[k]) out.push(erro(`mapa.metas.${k}`, `${map.mapa.metas[k]} no arquivo, ${goal[k]} na tabela do FR-2`));
    const done = tally(map);
    for (const k of Object.keys(goal) as (keyof Metas)[]) if (done[k] < goal[k]) out.push(erro(`metas.${k}`, `${done[k]} de ${goal[k]} (FR-2)`));
  }

  for (const [k, ids] of [['dominios', MATRIZ_DOMINIOS], ['competencias', MATRIZ_COMPETENCIAS]] as const) {
    for (const id of map.mapa[k]) if (!(id in ids)) out.push(erro(`mapa.${k}`, `"${id}" não existe na Matriz do Enamed (use ids como ${k === 'dominios' ? 'D09' : 'C02'}, MATRIZ.md)`));
    if (!map.mapa[k].length) out.push(aviso(`mapa.${k}`, 'vazio: declare quais itens da Matriz o mapa cobre'));
  }

  for (const m of pathModules) if (!map.cards.some((c) => c.modulo === m)) out.push(erro('cards', `módulo ${m} sem cards (FR-1)`));

  const n = map.cards.length;
  for (const [lvl, [lo, hi]] of Object.entries(LEVEL_BANDS)) {
    const p = pct(map.cards.filter((c) => c.nivel === Number(lvl)).length, n);
    if (p < lo || p > hi) out.push(erro('cards', `nível ${lvl}: ${p}% (esperado ${lo}–${hi}%, FR-4)`));
  }
  for (const [tipo, [lo, hi]] of Object.entries(TYPE_BANDS)) {
    const p = pct(map.cards.filter((c) => c.tipo === tipo).length, n);
    if (p < lo || p > hi) out.push(aviso('cards', `${tipo}: ${p}% (aproximado ${lo}–${hi}%, FR-3)`));
  }

  const linked = new Set<string>();
  map.conexoes.forEach((e, i) => {
    if (e.de === e.para) out.push(erro(`conexoes[${i}]`, 'conexão de um card com ele mesmo'));
    linked.add(e.de).add(e.para);
  });
  for (const c of map.cards) if (!linked.has(c.id)) out.push(erro(at(c), 'card isolado: nenhuma conexão (FR-5)'));

  const files = new Set(b.images);
  for (const c of map.cards) {
    if (c.tipo === 'imagem' && !files.has(c.imagem.arquivo.replace(/^imagens\//, ''))) out.push(erro(at(c, 'imagem.arquivo'), `${c.imagem.arquivo} não existe`));
    out.push(...cardRules(c, b.evidence.filter((e) => e.cardId === c.id)));
  }
  const ids = new Set(map.cards.map((c) => c.id));
  for (const e of b.evidence) if (!ids.has(e.cardId)) out.push(aviso('evidencias.jsonl', `evidência de card inexistente: ${e.cardId}`));
  return out;
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.level === 'erro');

export function formatIssues(slug: string, issues: Issue[]): string {
  const errors = issues.filter((i) => i.level === 'erro').length;
  const head = `${slug}: ${errors} erro(s), ${issues.length - errors} aviso(s)`;
  return [head, ...issues.map((i) => `  ${i.level === 'erro' ? 'ERRO ' : 'aviso'}  ${i.where}  ${i.message}`)].join('\n');
}
