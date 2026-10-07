import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderReport } from './report';
import { rawMap, writeFixture } from './test-fixture';

describe('content:report', () => {
  it('targets × done for every slug, Matriz coverage and pending sources', () => {
    const m = rawMap();
    m.mapa.slug = 'sepse';
    const root = writeFixture({ map: m, slug: 'sepse' });
    writeFileSync(join(root, 'FONTES-PENDENTES.md'), '# Pendentes\n\n- SSC 2026 pediátrica: PDF inacessível\n');
    const md = renderReport(root, '2026-10-07');
    expect(md).toContain('em 2026-10-07');
    expect(md).toContain('| sepse | rascunho | 10/90 | 1/6 | 1/5 | 1/6 | 1/8 | 1/10 |');
    expect(md).toContain('| sca | não iniciado | 0/110 |');
    expect(md).toContain('| Clínica Médica | sepse |');
    expect(md).toContain('| Cirurgia | **sem cobertura** |');
    expect(md).toContain('### Domínios: 1 de 21 declarados nos mapas');
    expect(md).toContain('- Domínio X: sepse');
    expect(md).toContain('- CM.06: 10 card(s)');
    expect(md).toContain('- SSC 2026 pediátrica: PDF inacessível');
  });

  it('works with no maps and no pending file', () => {
    const md = renderReport(writeFixture({ slug: '_template' }), '2026-10-07');
    expect(md).toContain('FONTES-PENDENTES.md não existe.');
    expect(md).toContain('Nenhum declarado ainda');
  });
});
