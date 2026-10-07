import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatIssues, hasErrors, lintBundle, literalCopy } from './lint';
import { CONTENT_ROOT, listSlugs, loadBundle, parseCredits, type Issue } from './load';
import { TARGETS } from './targets';
import { evidenceOf, rawMap, SLUG, TEST_TARGETS, writeFixture, type RawMap } from './test-fixture';

type Card = RawMap['cards'][number] & Record<string, unknown>;
const lint = (opts: Parameters<typeof writeFixture>[0] = {}, slug = SLUG) => lintBundle(loadBundle(slug, writeFixture(opts)), { targets: TEST_TARGETS });
/** Lint a copy of the minimal map after `edit` mutates it (evidence follows the edited cards unless given). */
const lintWith = (edit: (m: RawMap & { cards: Card[] }) => void, evidence?: object[]) => {
  const m = rawMap() as RawMap & { cards: Card[] };
  edit(m);
  return lint({ map: m, evidence: evidence ?? evidenceOf(m) });
};
const errors = (xs: Issue[]) => xs.filter((i) => i.level === 'erro').map((i) => `${i.where}: ${i.message}`);
const has = (xs: Issue[], re: RegExp) => errors(xs).some((e) => re.test(e));

describe('content:lint', () => {
  it('minimal valid map passes (only the FR-3 band warns: 1 flow in 10 cards is 10%)', () => {
    const r = lint();
    expect(errors(r)).toEqual([]);
    expect(r.map((i) => i.message)).toEqual(['fluxograma: 10% (aproximado 5–8%, FR-3)']);
  });

  // The docs live in the parent repo; CI checks out remoa-backend alone.
  it.skipIf(!existsSync(CONTENT_ROOT))('the real _template passes in template mode (schema + graph) and is skipped for the full rules', () => {
    const b = loadBundle('_template');
    expect(b.template).toBe(true);
    expect(errors(lintBundle(b))).toEqual([]);
  });

  it('schema errors carry the card id in the path', () => {
    const r = lintWith((m) => void (m.cards[0]!.verso = Array(41).fill('palavra').join(' ')));
    expect(errors(r)).toEqual([expect.stringMatching(/^cards\[t-m0-001\]\.verso: até 40 palavras/)]);
  });

  it('missing mapa.yaml, invalid YAML, bad evidence lines', () => {
    const root = mkdtempSync(join(tmpdir(), 'remoa-content-'));
    expect(has(lintBundle(loadBundle('nada', root)), /arquivo ausente/)).toBe(true);
    mkdirSync(join(root, 'quebrado'));
    writeFileSync(join(root, 'quebrado', 'mapa.yaml'), 'mapa: [unclosed');
    expect(has(lintBundle(loadBundle('quebrado', root)), /YAML inválido/)).toBe(true);
    const ev = [...evidenceOf(rawMap()), { cardId: 'x-1', doc: 'd', local: 'l' }, { cardId: 'nao-existe', doc: 'd', local: 'l', trecho: 't' }];
    const r = lint({ evidence: ev });
    expect(has(r, /evidencias\.jsonl:11: trecho/)).toBe(true);
    expect(r.some((i) => i.level === 'aviso' && /card inexistente: nao-existe/.test(i.message))).toBe(true);
    const root2 = writeFixture();
    writeFileSync(join(root2, SLUG, 'evidencias.jsonl'), '{not json}\n');
    expect(has(lintBundle(loadBundle(SLUG, root2), { targets: TEST_TARGETS }), /evidencias\.jsonl:1: JSON inválido/)).toBe(true);
  });

  it('missing evidencias.jsonl is an error outside templates', () => {
    const root = writeFixture();
    const b = loadBundle(SLUG, root);
    b.evidence = [];
    expect(has(lintBundle(b, { targets: TEST_TARGETS }), /sem evidência de "doc-a"/)).toBe(true);
    const fs = { ...loadBundle(SLUG, root) };
    expect(fs.issues).toEqual([]);
  });

  it('FR-1: every module M0–M8 has cards', () => {
    expect(has(lintWith((m) => void (m.cards[0]!.modulo = 'M1')), /módulo M0 sem cards/)).toBe(true);
  });

  it('FR-2: metas must equal the table and be reached; unknown slug fails', () => {
    expect(has(lintWith((m) => void (m.mapa.metas = { ...m.mapa.metas, cards: 11 })), /mapa\.metas\.cards: 11 no arquivo, 10 na tabela/)).toBe(true);
    expect(has(lintWith((m) => void (m.cards[3]!.pegadinha = undefined)), /metas\.pegadinhas: 0 de 1/)).toBe(true);
    const r = lintBundle(loadBundle(SLUG, writeFixture()), { targets: TARGETS });
    expect(has(r, /slug fora da tabela de metas/)).toBe(true);
    expect(TARGETS.sepse).toEqual({ cards: 90, casos: 6, fluxogramas: 5, imagens: 6, macetes: 8, pegadinhas: 10 });
    expect(Object.keys(TARGETS)).toHaveLength(10);
  });

  it('FR-2: folder and mapa.slug must agree', () => {
    expect(has(lint({ slug: 'outra-pasta' }, 'outra-pasta'), /slug "teste-minimo" diferente da pasta "outra-pasta"/)).toBe(true);
  });

  it('FR-4: level bands are errors; FR-3 type bands only warn', () => {
    const r = lintWith((m) => void (m.cards[9]!.nivel = 2, m.cards[9]!.porQue = 'Porque sim, explicado.'));
    expect(has(r, /nível 1: 30%/)).toBe(false);
    expect(has(r, /nível 2: 50% \(esperado 40–45%/)).toBe(true);
    const many = lintWith((m) => void m.cards.splice(4, 1, { ...m.cards[0]!, id: 't-m4-001', modulo: 'M4', ordem: 5, nivel: 2, porQue: 'x y z.' }));
    expect(many.some((i) => i.level === 'aviso' && /fluxograma: 0%/.test(i.message))).toBe(true);
  });

  it('Matriz: ids unknown to the Enamed Matrix are errors; empty lists only warn', () => {
    const r = lintWith((m) => { m.mapa.dominios = ['D09', 'D22']; m.mapa.competencias = ['Competência Y']; });
    expect(errors(r)).toEqual([expect.stringContaining('"D22"'), expect.stringContaining('"Competência Y"')]);
    const e = lintWith((m) => { m.mapa.dominios = []; });
    expect(errors(e)).toEqual([]);
    expect(e.some((i) => i.level === 'aviso' && i.where === 'mapa.dominios')).toBe(true);
  });

  it('FR-9: prerequisite must have a smaller ordem', () => {
    expect(has(lintWith((m) => void (m.cards[0]!.preRequisitos = ['t-m1-001'])), /pré-requisito t-m1-001 tem ordem 2, não menor que 1/)).toBe(true);
  });

  it('FR-9: cycles are reported as a path', () => {
    const r = lintWith((m) => void (m.cards[0]!.preRequisitos = ['t-m1-001']));
    expect(has(r, /ciclo de pré-requisitos: (t-m0-001 -> t-m1-001 -> t-m0-001|t-m1-001 -> t-m0-001 -> t-m1-001)/)).toBe(true);
  });

  it('FR-9: ordem unique and never going back a module', () => {
    expect(has(lintWith((m) => void (m.cards[2]!.ordem = 2)), /ordem 2 repetida/)).toBe(true);
    expect(has(lintWith((m) => void (m.cards[9]!.modulo = 'M2')), /M2 com ordem 10 vem depois de t-m8-001/)).toBe(true);
  });

  it('FR-5: no isolated card and no self connection', () => {
    expect(has(lintWith((m) => void m.conexoes.pop()), /cards\[t-m8-002\]: card isolado/)).toBe(true);
    expect(has(lintWith((m) => void m.conexoes.push({ de: 't-m0-001', para: 't-m0-001', rotulo: 'x', tipo: 'leva_a' })), /conexão de um card com ele mesmo/)).toBe(true);
    expect(has(lintWith((m) => void (m.conexoes[0]!.rotulo = '')), /conexoes\[0\]\.rotulo/)).toBe(true);
  });

  it('FR-21: source present, real date, matching evidence', () => {
    expect(has(lintWith((m) => void (m.cards[0]!.fontes = [])), /cards\[t-m0-001\]\.fontes: card sem fonte/)).toBe(true);
    expect(has(lintWith((m) => void (m.cards[0]!.fontes = [{ ...m.cards[0]!.fontes[0]!, acesso: 'AAAA-MM-DD' }])), /placeholder AAAA-MM-DD/)).toBe(true);
    expect(has(lintWith((m) => void (m.cards[0]!.fontes = [{ ...m.cards[0]!.fontes[0]!, doc: 'doc-b' }])), /sem evidência de "doc-b"/)).toBe(true);
  });

  it('FR-7/FR-14: porQue required on level 2–3 concepts', () => {
    expect(has(lintWith((m) => void (m.cards[2]!.porQue = undefined)), /cards\[t-m2-001\]\.porQue: conceito de nível 2 sem porQue/)).toBe(true);
  });

  it('FR-27: dose needs revisaoDupla', () => {
    expect(has(lintWith((m) => void (m.cards[6]!.revisaoDupla = undefined)), /risco: dose exige revisaoDupla/)).toBe(true);
  });

  it('FR-19: macete explained and short', () => {
    expect(has(lintWith((m) => void (m.cards[2]!.macete = { tipo: 'sigla', texto: 'ABC' } as never)), /macete\.explicacao/)).toBe(true);
    expect(has(lintWith((m) => void (m.cards[2]!.macete = { tipo: 'rima', texto: 'um dois três quatro cinco seis sete oito nove', explicacao: 'x' })), /macete com mais de 8 palavras/)).toBe(true);
  });

  it('case needs 4 stages; flow 2–12 steps; image needs alt (schema)', () => {
    expect(has(lintWith((m) => void delete (m.cards[7]!.caso as Record<string, unknown>).exames), /caso\.exames/)).toBe(true);
    expect(has(lintWith((m) => void (m.cards[4]!.passos = [{ id: 'p1', texto: 'só um' }])), /passos/)).toBe(true);
    expect(has(lintWith((m) => void ((m.cards[5]!.imagem as Record<string, unknown>).alt = '')), /imagem\.alt/)).toBe(true);
  });

  it('FR-24: naProva and naDiretriz (dated) come together', () => {
    expect(has(lintWith((m) => void (m.cards[3]!.naDiretriz = undefined)), /naDiretriz: divergência prova × diretriz/)).toBe(true);
    expect(has(lintWith((m) => void (m.cards[3]!.naDiretriz = { texto: 'x', data: 'AAAA-MM-DD' })), /naDiretriz\.data/)).toBe(true);
  });

  it('FR-8/FR-28: aviso, status seed_draft, revisarAte (schema)', () => {
    expect(has(lintWith((m) => void (m.mapa.status = 'seed_approved')), /mapa\.status/)).toBe(true);
    expect(has(lintWith((m) => void (m.mapa.aviso = 'outro')), /mapa\.aviso/)).toBe(true);
    expect(has(lintWith((m) => void (m.mapa.revisarAte = 'AAAA-MM-DD')), /mapa\.revisarAte/)).toBe(true);
  });

  it('FR-23: 12+ words copied from the evidence fail, quoted passages do not', () => {
    const trecho = 'Sepsis and septic shock are medical emergencies and treatment and resuscitation should begin immediately';
    const ev = (m: RawMap) => evidenceOf(m).map((e) => (e.cardId === 't-m0-001' ? { ...e, trecho } : e));
    const copy = (verso: string) => {
      const m = rawMap() as RawMap & { cards: Card[] };
      m.cards[0]!.verso = verso;
      return lint({ map: m, evidence: ev(m) });
    };
    expect(has(copy('Veja: sepsis and SEPTIC shock are medical emergencies, and treatment and resuscitation should begin.'), /cópia literal de 12\+ palavras/)).toBe(true);
    expect(has(copy('A norma diz "sepsis and septic shock are medical emergencies and treatment and resuscitation should begin".'), /cópia literal/)).toBe(false);
    expect(has(copy('Sepse e choque séptico são emergências; tratar já.'), /cópia literal/)).toBe(false);
  });

  it('literalCopy ignores accents/case and short sources', () => {
    expect(literalCopy('a b c', 'a b c', 3)).toBe('a b c');
    expect(literalCopy('Á B c d', 'x a b c', 3)).toBe('a b c');
    expect(literalCopy('um dois', 'um', 12)).toBeNull();
  });

  it('image file must exist', () => {
    expect(has(lintWith((m) => void ((m.cards[5]!.imagem as { arquivo: string }).arquivo = 'imagens/outra.svg')), /imagens\/outra\.svg não existe/)).toBe(true);
  });

  it('cards without Matriz tags warn', () => {
    const r = lintWith((m) => void (m.cards[0]!.tags = []));
    expect(hasErrors(r)).toBe(false);
    expect(r).toContainEqual(expect.objectContaining({ level: 'aviso', where: 'cards[t-m0-001].tags' }));
  });

  it('formats issues and lists slugs', () => {
    const out = formatIssues('x', [{ level: 'erro', where: 'a', message: 'b' }, { level: 'aviso', where: 'c', message: 'd' }]);
    expect(out).toBe('x: 1 erro(s), 1 aviso(s)\n  ERRO   a  b\n  aviso  c  d');
    expect(listSlugs(writeFixture())).toEqual([SLUG]);
  });

  it('parses CREDITOS.md tables', () => {
    const c = parseCredits('# Créditos\n\n| arquivo | licença | crédito |\n|:--|---|---|\n| imagens/a.svg | original | Remoa |\n| b.png | cc_by | Fulano, CC BY 4.0 |\n');
    expect([...c]).toEqual([['a.svg', { licenca: 'original', credito: 'Remoa' }], ['b.png', { licenca: 'cc_by', credito: 'Fulano, CC BY 4.0' }]]);
  });
});
