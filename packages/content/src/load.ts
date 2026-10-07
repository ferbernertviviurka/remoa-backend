import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceSchema, mapFileSchema, type Evidence, type MapFile } from '@remoa/contracts';
import { parse } from 'yaml';

/** `docs/content/enamed` of the remoa repo that contains remoa-backend; `CONTENT_DIR` overrides (tests use temp dirs). */
export const CONTENT_ROOT = process.env.CONTENT_DIR ?? fileURLToPath(new URL('../../../../docs/content/enamed', import.meta.url));

export type Issue = { level: 'erro' | 'aviso'; where: string; message: string };
export const erro = (where: string, message: string): Issue => ({ level: 'erro', where, message });
export const aviso = (where: string, message: string): Issue => ({ level: 'aviso', where, message });

export type Credit = { licenca: string; credito: string };
export type Bundle = {
  slug: string;
  dir: string;
  /** Folder name starts with `_` (D-1471): only schema and graph are checked. */
  template: boolean;
  map: MapFile | null;
  evidence: Evidence[];
  /** File names inside `imagens/` (CREDITOS.md excluded). */
  images: string[];
  /** `imagens/CREDITOS.md` rows by file name; null when the file is missing. */
  credits: Map<string, Credit> | null;
  /** Problems found while reading (schema, jsonl lines). */
  issues: Issue[];
};

/** Map folders under the root: the ones with a mapa.yaml, templates included. */
export function listSlugs(root = CONTENT_ROOT): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'mapa.yaml')))
    .map((d) => d.name)
    .sort();
}

/** `cards.3.verso` -> `cards[sepse-m1-002].verso`, so authors find the card by id. */
function where(path: (string | number)[], raw: unknown): string {
  const cards = (raw as { cards?: { id?: unknown }[] } | null)?.cards;
  const out: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    const id = path[i - 1] === 'cards' && typeof p === 'number' ? cards?.[p]?.id : undefined;
    if (typeof p === 'number') out[out.length - 1] += `[${typeof id === 'string' ? id : p}]`;
    else out.push(p);
  }
  return out.join('.') || 'mapa.yaml';
}

/** `| arquivo | licença | crédito |` rows; header and separator lines are skipped. */
export function parseCredits(md: string): Map<string, Credit> {
  const rows = new Map<string, Credit>();
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const [arquivo = '', licenca = '', credito = ''] = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!arquivo || /^-+$/.test(arquivo.replace(/:/g, '')) || /^arquivo$/i.test(arquivo)) continue;
    rows.set(arquivo.replace(/^imagens\//, ''), { licenca, credito });
  }
  return rows;
}

export function loadBundle(slug: string, root = CONTENT_ROOT): Bundle {
  const dir = join(root, slug);
  const b: Bundle = { slug, dir, template: slug.startsWith('_'), map: null, evidence: [], images: [], credits: null, issues: [] };
  const file = join(dir, 'mapa.yaml');
  if (!existsSync(file)) {
    b.issues.push(erro('mapa.yaml', `arquivo ausente em ${dir}`));
    return b;
  }
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    b.issues.push(erro('mapa.yaml', `YAML inválido: ${e instanceof Error ? e.message : String(e)}`));
    return b;
  }
  const parsed = mapFileSchema.safeParse(raw);
  if (parsed.success) b.map = parsed.data;
  else b.issues.push(...parsed.error.issues.map((i) => erro(where(i.path, raw), i.message)));

  const ev = join(dir, 'evidencias.jsonl');
  if (existsSync(ev)) {
    readFileSync(ev, 'utf8').split('\n').forEach((line, n) => {
      if (!line.trim()) return;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        b.issues.push(erro(`evidencias.jsonl:${n + 1}`, 'JSON inválido'));
        return;
      }
      const r = evidenceSchema.safeParse(json);
      if (r.success) b.evidence.push(r.data);
      else b.issues.push(erro(`evidencias.jsonl:${n + 1}`, r.error.issues.map((i) => `${i.path.join('.') || 'linha'}: ${i.message}`).join('; ')));
    });
  } else if (!b.template) b.issues.push(erro('evidencias.jsonl', 'arquivo ausente (FR-21)'));

  const img = join(dir, 'imagens');
  if (existsSync(img)) {
    b.images = readdirSync(img).filter((f) => f !== 'CREDITOS.md' && !f.startsWith('.')).sort();
    const credits = join(img, 'CREDITOS.md');
    if (existsSync(credits)) b.credits = parseCredits(readFileSync(credits, 'utf8'));
  }
  return b;
}
