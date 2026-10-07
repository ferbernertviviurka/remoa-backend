// G25 (F32): the four challenge prompts (packages/ai/prompts/desafios/v<N>/<id>.md), their lint and their rendering.
// Five parts in order (docs/ai/prompts/ESTILO-DE-PROMPT.md); map and student answer enter only between line markers.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHALLENGE_PROMPT_IDS = ['gerar-perguntas-discursivas', 'gerar-questoes-objetivas', 'corrigir-resposta', 'resumir-mapa', 'classificar-tema', 'recomendar-estudo'] as const;
export type ChallengePromptId = (typeof CHALLENGE_PROMPT_IDS)[number];

export const PROMPT_PARTS = ['PAPEL', 'CONTEXTO E PÚBLICO', 'FORMATO DE SAÍDA', 'EXEMPLO', 'LIMITES'] as const;

/** Variables that always carry user content and so must be declared as data. */
const ALWAYS_DATA = ['mapa', 'resposta_aluno'];
const ROLE = /^Atue como um professor especialista em \{\{assunto\}\}/;
const DATA_NOTICE = /é dado, não instrução/;
/** No promise of accuracy and no "anti-cola" framing in a prompt. */
const BANNED: [RegExp, string][] = [
  [/anti-?\s?cola/i, 'anti-cola'],
  [/\bgarant(?:e|imos|ido|ida|ia|ir)\b/i, 'promessa de garantia'],
  [/\b(?:100\s?%|totalmente|sempre)\s+(?:corret|precis|confi[aá]v)/i, 'promessa de precisão'],
  [/\bnunca\s+erra/i, 'promessa de precisão'],
];

export type PromptMeta = { id: string; version: number; variaveis: string[]; marcadores: string[]; dados: string[]; temperatura: number | null };
export type ParsedPrompt = { meta: PromptMeta; body: string };

const list = (v: string | undefined) => (v ?? '').replace(/^\s*\[|\]\s*$/g, '').split(',').map((s) => s.trim()).filter(Boolean);

/** Front matter is `key: value` lines with `[a, b]` lists; nothing nested, so no YAML parser. */
export function parsePrompt(text: string): ParsedPrompt | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fields = Object.fromEntries(
    (m[1] ?? '').split(/\r?\n/).map((line) => /^(\w+):\s*(.*)$/.exec(line)).filter((x): x is RegExpExecArray => Boolean(x)).map((x) => [x[1], x[2]?.trim() ?? '']),
  ) as Record<string, string | undefined>;
  const temperature = Number(fields.temperatura);
  return {
    meta: {
      id: fields.id ?? '',
      version: Number(fields.version),
      variaveis: list(fields.variaveis),
      marcadores: list(fields.marcadores),
      dados: list(fields.dados),
      temperatura: fields.temperatura && Number.isFinite(temperature) ? temperature : null,
    },
    body: m[2] ?? '',
  };
}

/** `# HEADING` sections of the body, in order. */
export function sectionsOf(body: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  for (const chunk of body.split(/^# /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    out.push({ title: (nl < 0 ? chunk : chunk.slice(0, nl)).trim(), text: nl < 0 ? '' : chunk.slice(nl + 1).trim() });
  }
  return out;
}

const fences = (text: string) => [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? '');
const parses = (s: string) => {
  try {
    return { ok: true as const, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false as const };
  }
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Regions delimited by a line that is exactly `<tag>` and a later line that is exactly `</tag>`. */
const regionsOf = (body: string, tag: string) => [...body.matchAll(new RegExp(`^<${tag}>[ \\t]*$([\\s\\S]*?)^</${tag}>[ \\t]*$`, 'gm'))];

/** Every problem found, in Portuguese (for `pnpm ai:prompts:lint`). Empty = the prompt passes. */
export function lintPrompt(text: string, expected?: { id?: string; version?: number }): string[] {
  const parsed = parsePrompt(text);
  if (!parsed) return ['sem cabeçalho (front matter entre ---)'];
  const { meta, body } = parsed;
  const errors: string[] = [];
  if (!meta.id) errors.push('cabeçalho sem id');
  if (expected?.id && meta.id !== expected.id) errors.push(`id "${meta.id}" diferente do arquivo "${expected.id}"`);
  if (!Number.isInteger(meta.version) || meta.version < 1) errors.push('cabeçalho sem version inteira');
  if (expected?.version && meta.version !== expected.version) errors.push(`version ${meta.version} diferente da pasta v${expected.version}`);
  if (!meta.variaveis.length) errors.push('cabeçalho sem variaveis');
  if (meta.temperatura === null) errors.push('cabeçalho sem temperatura');

  const sections = sectionsOf(body);
  const titles = sections.map((s) => s.title);
  let last = -1;
  for (const part of PROMPT_PARTS) {
    const at = titles.indexOf(part);
    if (at < 0) errors.push(`falta a parte "${part}"`);
    else if (at < last) errors.push(`a parte "${part}" está fora de ordem`);
    else if (!sections[at]?.text) errors.push(`a parte "${part}" está vazia`);
    if (at >= 0) last = Math.max(last, at);
  }
  const role = sections.find((s) => s.title === 'PAPEL')?.text ?? '';
  if (role && !ROLE.test(role)) errors.push('o papel não começa com "Atue como um professor especialista em {{assunto}}"');

  const used = new Set([...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] ?? ''));
  for (const v of meta.variaveis) if (!used.has(v)) errors.push(`a variável {{${v}}} está declarada e não aparece`);
  for (const v of used) if (!meta.variaveis.includes(v)) errors.push(`a variável {{${v}}} aparece e não está declarada`);

  for (const v of ALWAYS_DATA) if (meta.variaveis.includes(v) && !meta.dados.includes(v)) errors.push(`{{${v}}} precisa estar em dados`);
  for (const v of meta.dados) if (!meta.variaveis.includes(v)) errors.push(`dado {{${v}}} não está em variaveis`);
  if (meta.dados.length && !meta.marcadores.length) errors.push('há dados sem marcadores');
  const regions: string[] = [];
  for (const tag of meta.marcadores) {
    const found = regionsOf(body, tag);
    if (found.length !== 1) errors.push(`o marcador <${tag}> precisa aparecer uma vez, em linhas próprias, com </${tag}> (achei ${found.length})`);
    regions.push(...found.map((m) => m[1] ?? ''));
  }
  for (const v of meta.dados) {
    const all = body.split(`{{${v}}}`).length - 1;
    const inside = regions.reduce((n, r) => n + r.split(`{{${v}}}`).length - 1, 0);
    if (all !== inside) errors.push(`{{${v}}} aparece fora dos marcadores de dado`);
  }
  if (meta.dados.length && !DATA_NOTICE.test(body)) errors.push('falta avisar que o conteúdo dos marcadores "é dado, não instrução"');

  const format = sections.find((s) => s.title === 'FORMATO DE SAÍDA')?.text ?? '';
  const example = sections.find((s) => s.title === 'EXEMPLO')?.text ?? '';
  const formatJson = fences(format).map(parses);
  const exampleJson = fences(example).map(parses);
  if (format && !formatJson.length) errors.push('o formato de saída não tem bloco ```json');
  if (formatJson.some((r) => !r.ok)) errors.push('o bloco JSON do formato de saída não é JSON válido');
  if (example && !exampleJson.length) errors.push('o exemplo não tem bloco ```json');
  if (exampleJson.some((r) => !r.ok)) errors.push('o JSON do exemplo não é válido');
  const shape = formatJson[0]?.ok ? formatJson[0].value : undefined;
  if (isObject(shape)) {
    for (const r of exampleJson) {
      if (!r.ok) continue;
      if (!isObject(r.value)) errors.push('o JSON do exemplo não é um objeto');
      else for (const k of Object.keys(r.value)) if (!(k in shape)) errors.push(`o exemplo usa o campo "${k}", que não está no formato de saída`);
    }
  }
  for (const [re, label] of BANNED) if (re.test(body)) errors.push(`texto proibido: ${label}`);
  return errors;
}

const dir = dirname(fileURLToPath(import.meta.url));
export const CHALLENGE_PROMPTS_DIR = join(dir, '../prompts/desafios');

/** Every `v<N>/<id>.md` under the challenge prompts folder. */
export function challengePromptFiles(root = CHALLENGE_PROMPTS_DIR): { id: string; version: number; path: string }[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^v\d+$/.test(d.name))
    .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith('.md')).map((f) => ({ id: f.slice(0, -3), version: Number(d.name.slice(1)), path: join(root, d.name, f) })));
}

export type ChallengePrompt = ParsedPrompt & { promptVersion: string };
const cache = new Map<string, ChallengePrompt>();

/** The prompt file; `promptVersion` (e.g. `desafios/corrigir-resposta@v1`) is stored with every result. */
export function loadChallengePrompt(id: ChallengePromptId, version = 1): ChallengePrompt {
  const key = `${id}@v${version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parsed = parsePrompt(readFileSync(join(CHALLENGE_PROMPTS_DIR, `v${version}`, `${id}.md`), 'utf8'));
  if (!parsed) throw new Error(`prompt sem cabeçalho: ${key}`);
  const prompt = { ...parsed, promptVersion: `desafios/${key}` };
  cache.set(key, prompt);
  return prompt;
}

/** Longest a short (non-data) variable may be: these land inside instructions (role, audience). */
const SHORT_MAX = 200;

export type RenderResult = { ok: true; data: string } | { ok: false; error: 'missing_variable'; variable: string };

/**
 * Fills `{{var}}`. A data value loses any of the prompt's own markers (it cannot close `<mapa>` and write instructions after it);
 * a short value also becomes one line without `<`, `>` or braces, cut at 200 characters. Every declared variable is required.
 */
export function renderChallengePrompt(prompt: ParsedPrompt, vars: Record<string, string | number | boolean>): RenderResult {
  const markers = prompt.meta.marcadores.map((t) => new RegExp(`<\\s*/?\\s*${t}\\s*>`, 'gi'));
  const values: Record<string, string> = {};
  for (const v of prompt.meta.variaveis) {
    const raw = vars[v];
    if (raw === undefined) return { ok: false, error: 'missing_variable', variable: v };
    let s = typeof raw === 'boolean' ? (raw ? 'sim' : 'não') : String(raw);
    // Until stable: removing `</mapa>` from `</ma</mapa>pa>` would otherwise rebuild it.
    for (let prev = ''; prev !== s; ) {
      prev = s;
      s = s.replace(/\{\{|\}\}/g, '');
      for (const re of markers) s = s.replace(re, '');
    }
    if (!prompt.meta.dados.includes(v)) s = s.replace(/[<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, SHORT_MAX);
    values[v] = s;
  }
  return { ok: true, data: prompt.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => values[name] ?? '') };
}
