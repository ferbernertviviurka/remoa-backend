import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { checkImages, checkSvg, maskPolygons, toWebp } from './images';
import { loadBundle } from './load';
import { rawMap, SLUG, SVG, writeFixture, type RawMap } from './test-fixture';

const run = (opts: Parameters<typeof writeFixture>[0] = {}) => checkImages(loadBundle(SLUG, writeFixture(opts))).map((i) => `${i.where}: ${i.message}`);
const credits = (row: string) => `| arquivo | licença | crédito |\n|---|---|---|\n${row}\n`;
const imageCard = (m: RawMap) => m.cards[5] as unknown as { imagem: Record<string, unknown> };

describe('checkSvg', () => {
  it('accepts a plain labelled SVG', () => {
    expect(checkSvg(SVG)).toEqual([]);
  });

  it.each([
    ['<svg viewBox="0 0 1 1"><script>alert(1)</script><text>a</text></svg>', 'contém <script>'],
    ['<svg viewBox="0 0 1 1"><foreignObject/><text>a</text></svg>', 'contém <foreignObject>'],
    ['<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"><text>a</text></svg>', 'contém DOCTYPE/ENTITY'],
    ['<svg viewBox="0 0 1 1" onload="x()"><text>a</text></svg>', 'contém atributo de evento (on...)'],
    ['<svg viewBox="0 0 1 1"><image href="https://x.test/a.png"/><text>a</text></svg>', 'href externo: https://x.test/a.png'],
    ['<svg viewBox="0 0 1 1"><use xlink:href="data:image/png;base64,AAA"/><text>a</text></svg>', 'href externo: data:image/png;base64,AAA'],
    ['<svg viewBox="0 0 1 1"><rect style="fill:url(http://x.test/p)"/><text>a</text></svg>', 'recurso externo em estilo (url()/@import)'],
    ['<svg width="10"><text>a</text></svg>', 'sem viewBox'],
    ['<svg viewBox="0 0 1 1"><rect/></svg>', 'sem rótulo de texto'],
  ])('rejects %s', (svg, problem) => {
    expect(checkSvg(svg)).toContain(problem);
  });

  it('allows internal references', () => {
    expect(checkSvg('<svg viewBox="0 0 1 1"><use href="#a"/><rect fill="url(#g)"/><text>a</text></svg>')).toEqual([]);
  });
});

describe('maskPolygons', () => {
  it('boxes each label from its <text>, normalized to the viewBox, honoring text-anchor', () => {
    const [alfa, beta, missing] = maskPolygons(SVG, ['Alfa', ' beta ', 'Gama']);
    expect(alfa!.polygon![0]).toEqual({ x: 0.045, y: 0.14 });
    expect(beta!.polygon![0]!.x).toBeLessThan(300 / 400);
    expect(beta!.polygon![1]!.x).toBeGreaterThan(300 / 400);
    expect(missing).toEqual({ label: 'Gama', polygon: null });
    const end = maskPolygons('<svg viewBox="0 0 100 100"><text x="100" y="10" style="font-size: 10px" text-anchor="end"><tspan>Fim</tspan></text></svg>', ['Fim']);
    expect(end[0]!.polygon![1]!.x).toBe(1);
    expect(maskPolygons('<svg><text>A</text></svg>', ['A'])[0]!.polygon).not.toBeNull();
  });
});

describe('checkImages', () => {
  it('minimal map: credited original SVG with alt and labels passes', () => {
    expect(run()).toEqual([]);
  });

  it('CREDITOS.md missing or without the file', () => {
    expect(run({ credits: null })).toContain('imagens/CREDITOS.md: arquivo ausente (FR-16)');
    expect(run({ credits: credits('| outra.svg | original | Remoa |') })).toContain('imagens/esquema.svg: sem linha em CREDITOS.md');
  });

  it('licenses: cc0 waits for P-650, unknown refused, credit required, must match the card', () => {
    expect(run({ credits: credits('| esquema.svg | cc0 | Fulano |') })).toContain('imagens/esquema.svg: licença cc0 aguarda P-650 (não existe em assets.license)');
    expect(run({ credits: credits('| esquema.svg | copyright | Fulano |') })[0]).toMatch(/licença "copyright" não aceita/);
    expect(run({ credits: credits('| esquema.svg | cc_by |  |') })).toContain('imagens/esquema.svg: crédito obrigatório fora de licença original');
    expect(run({ credits: credits('| esquema.svg | servier | Servier Medical Art, CC BY 4.0 |') })).toContain('cards[t-m5-001].imagem.licenca: own no card, servier em CREDITOS.md');
  });

  it('unsafe SVG is refused (script) and labels must exist as text', () => {
    expect(run({ svg: SVG.replace('<rect', '<script>x()</script><rect') })).toContain('imagens/esquema.svg: contém <script>');
    const m = rawMap();
    imageCard(m).imagem.mascaras = [{ rotulo: 'Alfa' }, { rotulo: 'Ômega' }];
    expect(run({ map: m })).toContain('cards[t-m5-001].imagem.mascaras: rótulo "Ômega" não está num <text> de esquema.svg');
  });

  it('every image belongs to a card; raster images cannot carry masks', () => {
    const root = writeFixture({ credits: credits('| esquema.svg | original | Remoa |\n| sobra.svg | original | Remoa |\n| foto.png | cc_by | Fulano |') });
    writeFileSync(join(root, SLUG, 'imagens', 'sobra.svg'), SVG);
    writeFileSync(join(root, SLUG, 'imagens', 'foto.png'), 'png');
    const b = loadBundle(SLUG, root);
    const card = b.map!.cards[5] as { imagem: { arquivo: string } };
    card.imagem.arquivo = 'imagens/foto.png';
    const out = checkImages(b).map((i) => `${i.where}: ${i.message}`);
    expect(out).toContain('imagens/sobra.svg: imagem sem card (o texto alternativo vem do card, FR-18)');
    expect(out).toContain('imagens/foto.png: máscaras só em SVG (os rótulos vêm do <text>)');
  });
});

describe('toWebp', () => {
  it('renders the F02 variants (w800, w1600) as WebP', async () => {
    const r = await toWebp(Buffer.from(SVG), true);
    expect(r).toMatchObject({ width: 1600, height: 800 });
    expect((await sharp(r.variants.w800).metadata())).toMatchObject({ format: 'webp', width: 800 });
    const png = await sharp({ create: { width: 100, height: 50, channels: 3, background: '#fff' } }).png().toBuffer();
    expect(await toWebp(png, false)).toMatchObject({ width: 100, height: 50 });
  });
});
