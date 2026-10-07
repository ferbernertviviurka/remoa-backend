// Smallest map that passes content:lint and content:images (10 cards, M0–M8, levels 40/40/20%), written to a temp folder.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTENT_DISCLAIMER } from '@remoa/contracts';
import { stringify } from 'yaml';
import type { Metas } from './targets';

export const SLUG = 'teste-minimo';
export const TEST_TARGETS: Record<string, Metas> = { [SLUG]: { cards: 10, casos: 1, fluxogramas: 1, imagens: 1, macetes: 1, pegadinhas: 1 } };
export const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="0" y="0" width="400" height="200" fill="#fff"/>
<text x="20" y="50" font-size="20">Alfa</text><text x="300" y="150" font-size="20" text-anchor="middle">Beta</text></svg>`;

const fonte = { doc: 'doc-a', local: 'seção 1', versao: '2026', acesso: '2026-10-01' };
const base = (id: string, modulo: string, ordem: number, nivel: number) => ({ id, modulo, ordem, nivel, titulo: `Título ${id}`, risco: 'nenhum', fontes: [fonte], tags: ['CM.06'] });
const concept = (id: string, modulo: string, ordem: number, nivel: number, extra: object = {}) => ({
  ...base(id, modulo, ordem, nivel), tipo: 'conceito', frente: `Pergunta do card ${id}?`, verso: `Resposta curta do card ${id}.`,
  ...(nivel >= 2 ? { porQue: `Explicação do raciocínio do card ${id}.` } : {}), ...extra,
});

export function rawMap() {
  const cards = [
    concept('t-m0-001', 'M0', 1, 1),
    concept('t-m1-001', 'M1', 2, 1, { preRequisitos: ['t-m0-001'] }),
    concept('t-m2-001', 'M2', 3, 2, { macete: { tipo: 'sigla', texto: 'ABC', explicacao: 'A de alfa, B de beta, C de gama.' } }),
    concept('t-m3-001', 'M3', 4, 2, {
      pegadinha: 'Erro clássico de exemplo.', naProva: 'A prova cobra o critério antigo.', naDiretriz: { texto: 'A diretriz nova mudou.', data: '2026-03-23' },
    }),
    { ...base('t-m4-001', 'M4', 5, 2), risco: 'conduta', tipo: 'fluxograma', frente: 'Qual a sequência?', passos: [{ id: 'p1', texto: 'Primeiro passo' }, { id: 'p2', texto: 'Segundo passo' }] },
    {
      ...base('t-m5-001', 'M5', 6, 1), tipo: 'imagem', frente: 'Complete o esquema.',
      imagem: { arquivo: 'imagens/esquema.svg', licenca: 'own', alt: 'Esquema com dois rótulos.', mascaras: [{ rotulo: 'Alfa' }, { rotulo: 'Beta' }] },
    },
    concept('t-m6-001', 'M6', 7, 2, { risco: 'dose', revisaoDupla: true }),
    { ...base('t-m7-001', 'M7', 8, 3), tipo: 'caso', caso: { apresentacao: 'Vinheta original.', exames: 'Exames do caso.', diagnostico: 'Diagnóstico.', conduta: 'Conduta e por que as outras erram.' } },
    concept('t-m8-001', 'M8', 9, 3),
    concept('t-m8-002', 'M8', 10, 1),
  ];
  return {
    mapa: {
      slug: SLUG, titulo: 'Mapa de teste', area: 'Clínica Médica', dominios: ['D09'], competencias: ['C02'], marcoTemporal: 'ENAMED 2026',
      revisarAte: '2027-03-23', versao: '2026.1', status: 'seed_draft', aviso: CONTENT_DISCLAIMER, metas: { ...TEST_TARGETS[SLUG]! }, selos: ['top10_enamed'],
    },
    cards,
    conexoes: cards.slice(1).map((c, i) => ({ de: cards[i]!.id, para: c.id, rotulo: 'leva a', tipo: 'leva_a' })),
  };
}

export type RawMap = ReturnType<typeof rawMap>;
export const evidenceOf = (m: RawMap) => m.cards.map((c) => ({ cardId: c.id, doc: 'doc-a', local: 'seção 1', trecho: `Trecho curto lido na fonte sobre ${c.id}.` }));

/** Writes the map folder under a fresh root and returns the root (load with `loadBundle(SLUG, root)`). */
export function writeFixture(opts: { map?: RawMap; evidence?: object[]; svg?: string; credits?: string | null; slug?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'remoa-content-'));
  const map = opts.map ?? rawMap();
  const dir = join(root, opts.slug ?? SLUG);
  mkdirSync(join(dir, 'imagens'), { recursive: true });
  writeFileSync(join(dir, 'mapa.yaml'), stringify(map));
  writeFileSync(join(dir, 'evidencias.jsonl'), (opts.evidence ?? evidenceOf(map)).map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, 'imagens', 'esquema.svg'), opts.svg ?? SVG);
  const credits = opts.credits === undefined ? '| arquivo | licença | crédito |\n|---|---|---|\n| esquema.svg | original | Remoa |\n' : opts.credits;
  if (credits !== null) writeFileSync(join(dir, 'imagens', 'CREDITOS.md'), credits);
  return root;
}
