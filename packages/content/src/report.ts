// FR-34 `content:report`: targets × done per map, Matriz coverage from the maps' own tags, pending sources.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enamedAreaToArea } from '@remoa/contracts';
import { MATRIZ_COMPETENCIAS, MATRIZ_DOMINIOS } from './matriz';
import { checkImages } from './images';
import { hasErrors, lintBundle } from './lint';
import { CONTENT_ROOT, listSlugs, loadBundle, type Bundle } from './load';
import { TARGETS, tally, type Metas } from './targets';

const KEYS: (keyof Metas)[] = ['cards', 'casos', 'fluxogramas', 'imagens', 'macetes', 'pegadinhas'];

export function renderReport(root = CONTENT_ROOT, today = new Date().toISOString().slice(0, 10)): string {
  const slugs = [...new Set([...Object.keys(TARGETS), ...listSlugs(root).filter((s) => !s.startsWith('_'))])];
  const bundles = new Map<string, Bundle>(slugs.filter((s) => existsSync(join(root, s, 'mapa.yaml'))).map((s) => [s, loadBundle(s, root)]));
  const out = [
    '# Relatório de cobertura dos mapas do ENAMED',
    '',
    `Gerado por \`pnpm content:report\` em ${today}. Não editar à mão. Cada célula é feito/meta (FR-2); metas em \`remoa-backend/packages/content/src/targets.ts\`.`,
    '',
    `| Mapa | Estado | ${KEYS.join(' | ')} | Lint |`,
    `|---|---|${KEYS.map(() => '---|').join('')}---|`,
  ];
  for (const s of slugs) {
    const goal = TARGETS[s];
    const b = bundles.get(s);
    const done = b?.map ? tally(b.map) : null;
    const cell = (k: keyof Metas) => `${done ? done[k] : 0}/${goal ? goal[k] : '?'}`;
    const issues = b ? [...lintBundle(b), ...checkImages(b)] : [];
    const errors = issues.filter((i) => i.level === 'erro').length;
    const state = !b ? 'não iniciado' : !b.map ? 'arquivo inválido' : hasErrors(issues) ? 'rascunho' : 'lint verde';
    out.push(`| ${s} | ${state} | ${KEYS.map(cell).join(' | ')} | ${b ? `${errors} erro(s)` : '-'} |`);
  }

  const maps = [...bundles.values()].flatMap((b) => (b.map ? [b.map] : []));
  out.push('', '## Matriz do ENAMED', '', '| Área | Mapas |', '|---|---|');
  for (const area of Object.keys(enamedAreaToArea)) {
    const names = maps.filter((m) => m.mapa.area === area).map((m) => m.mapa.slug);
    out.push(`| ${area} | ${names.length ? names.join(', ') : '**sem cobertura**'} |`);
  }
  for (const [k, title, names] of [['dominios', 'Domínios', MATRIZ_DOMINIOS], ['competencias', 'Competências', MATRIZ_COMPETENCIAS]] as const) {
    const by = new Map<string, string[]>();
    for (const m of maps) for (const d of m.mapa[k]) by.set(d, [...(by.get(d) ?? []), m.mapa.slug]);
    const ids = Object.keys(names);
    const covered = ids.filter((id) => by.has(id));
    out.push('', `### ${title}: ${covered.length} de ${ids.length} cobertos (Portaria Inep 478/2025)`, '', '**Cobertos**', '');
    if (!covered.length) out.push('Nenhum ainda (`mapa.' + k + '`).');
    for (const id of covered) out.push(`- ${id} ${names[id as keyof typeof names]}: ${by.get(id)!.join(', ')}`);
    out.push('', '**Não cobertos**', '');
    for (const id of ids.filter((i) => !by.has(i))) out.push(`- ${id} ${names[id as keyof typeof names]}`);
    const unknown = [...by.keys()].filter((id) => !(id in names));
    if (unknown.length) out.push('', `**Ids fora da Matriz**: ${unknown.join(', ')}`);
  }
  const tags = new Map<string, number>();
  for (const m of maps) for (const c of m.cards) for (const t of c.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  out.push('', '### Tags dos cards', '');
  if (!tags.size) out.push('Nenhuma tag nos cards ainda.');
  for (const [t, n] of [...tags].sort(([a], [b]) => a.localeCompare(b))) out.push(`- ${t}: ${n} card(s)`);

  out.push('', '## Pendências de fonte', '');
  const pend = join(root, 'FONTES-PENDENTES.md');
  const lines = existsSync(pend) ? readFileSync(pend, 'utf8').split('\n').filter((l) => /^\s*([-*]\s+\S|\|)/.test(l)) : [];
  out.push(existsSync(pend) ? (lines.length ? lines.join('\n') : 'FONTES-PENDENTES.md sem itens.') : 'FONTES-PENDENTES.md não existe.');
  out.push('');
  for (const b of bundles.values()) {
    const missing = b.map ? b.map.cards.filter((c) => !c.fontes.length || c.fontes.some((f) => !b.evidence.some((e) => e.cardId === c.id && e.doc === f.doc))).length : 0;
    if (missing) out.push(`- ${b.slug}: ${missing} card(s) sem fonte ou sem evidência em evidencias.jsonl`);
  }
  return out.join('\n') + '\n';
}
