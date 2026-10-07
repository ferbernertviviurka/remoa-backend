import { describe, expect, it } from 'vitest';
import { renderDossier, sourcesTable } from './dossier';
import { loadBundle } from './load';
import { rawMap, SLUG, writeFixture } from './test-fixture';

const FONTES = `# Fontes\n\n| \`doc\` (id) | Título | Versão |\n|---|---|---|\n| \`doc-a\` | Diretriz **A** <b>x</b> | 2026 |\n\n## Outra\n| a | b |\n`;

describe('content:dossier', () => {
  const m = rawMap();
  (m.cards[0] as { verso: string }).verso = 'Resposta <script>alert(1)</script> & "aspas"';
  const b = loadBundle(SLUG, writeFixture({ map: m }));
  const verdicts = [{ cardId: 't-m0-001', veredito: 'sustenta' as const, motivo: 'ok <i>' }, { cardId: 't-m6-001', veredito: 'contradiz' as const, motivo: 'dose diferente' }];
  const html = renderDossier(b, verdicts, FONTES, '2026-10-07');

  it('renders every card in trail order with the three decision boxes and a note line', () => {
    const order = [...html.matchAll(/<section class="card[^"]*" id="([^"]+)"/g)].map((x) => x[1]);
    expect(order).toEqual(m.cards.map((c) => c.id)); // fixture ordem is 1..10
    for (const d of ['aprovo', 'ajustar', 'rejeitar']) expect(html.match(new RegExp(`type="checkbox" name="d-[^"]+" value="${d}"`, 'g'))).toHaveLength(10);
    expect(html.match(/class="nota"/g)).toHaveLength(10);
    expect(html).toContain('<h2>Assinatura</h2>');
  });

  it('escapes card text, verdicts and sources; no script tag reaches the page', () => {
    expect(html).not.toContain('<script');
    expect(html).toContain('Resposta &#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;aspas&#34;');
    expect(html).toContain('ok &#60;i&#62;');
    expect(html).toContain('Diretriz A &#60;b&#62;x&#60;/b&#62;');
  });

  it('header, risk badges, divergence, macete, case, flow, embedded image, evidence and verdicts', () => {
    expect(html).toContain('Dossiê de revisão médica: Mapa de teste');
    expect(html).toContain('Versão 2026.1 · ENAMED 2026 · revisar até 2027-03-23');
    expect(html).toContain('Conteúdo educacional. Não substitui diretriz clínica nem supervisão.');
    expect(html).toMatch(/<section class="card risco-dose" id="t-m6-001">[\s\S]*badge dose[\s\S]*<strong>Contradiz<\/strong>: dose diferente/);
    expect(html).toContain('badge conduta');
    expect(html).toContain('Na prova: A prova cobra o critério antigo.<br>Na diretriz (2026-03-23): A diretriz nova mudou.');
    expect(html).toContain('Macete (sigla)');
    expect(html).toContain('<li>Primeiro passo</li>');
    expect(html).toContain('Conduta e por que as outras erram.');
    expect(html).toMatch(/<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" alt="Esquema com dois rótulos.">/);
    expect(html).toContain('Rótulos ocultos');
    expect(html).toContain('<q>Trecho curto lido na fonte sobre t-m0-001.</q> (doc-a, seção 1)');
    expect(html).toContain('doc-a, seção 1 (2026; acesso 2026-10-01)');
    expect(html).toContain('1 sustenta, 0 parcial, 1 contradiz, 8 sem verificação');
    expect(html.match(/sem verificação para o texto atual/g)).toHaveLength(8);
  });

  it('sources table keeps only the first table of FONTES.md', () => {
    const t = sourcesTable(FONTES);
    expect(t).toContain('<th>doc (id)</th>');
    expect(t.match(/<tr>/g)).toHaveLength(2);
    expect(sourcesTable('sem tabela')).toContain('falta');
  });
});
