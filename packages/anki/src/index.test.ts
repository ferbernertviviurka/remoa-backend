import { readFileSync } from 'node:fs';
import { cardDraftSchema, type FieldMapping } from '@remoa/contracts';
import { describe, expect, it } from 'vitest';
import { buildApkg, fullPackage, modernPackage, PNG_1X1 } from '../test/fixtures';
import { svgShapes } from './occlusion';
import { defaultMappings, inspect, openPackage, planImport, rootOf, tagsOf, toDrafts, type AnkiDraft } from './index';

const must = <T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
};
const drafts = async (file: Uint8Array, deckIds: string[], mappings: FieldMapping[] = []) => {
  const s = must(await inspect(file));
  return must(await toDrafts(file, must(planImport(s, mappings, deckIds))));
};
const byRef = (ds: AnkiDraft[], id: number) => ds.find((d) => d.ref === `anki-${id}`)!;

describe('inspect', () => {
  it('summarizes decks, kinds, samples, counts', async () => {
    const s = must(await inspect(await fullPackage()));
    expect(s.decks.find((d) => d.name === 'Med::Cardio')?.cardCount).toBe(4); // 101 (2nd card) + 200 x2 + 100
    expect(s.decks.find((d) => d.name === 'Default')?.cardCount).toBe(0);
    expect(Object.fromEntries(s.noteTypes.map((t) => [t.name, t.kind]))).toEqual({
      Basic: 'basic', Cloze: 'cloze', 'Image Occlusion': 'image_occlusion', 'Image Occlusion Enhanced': 'image_occlusion', Odd: 'other',
    });
    expect(s.cardCount).toBe(10);
    expect(s.mediaCount).toBe(3);
    const basic = s.noteTypes.find((t) => t.name === 'Basic')!;
    expect(basic.noteCount).toBe(4);
    expect(basic.samples).toHaveLength(3); // the blank note is not a sample
    expect(basic.samples[0]).toEqual({ Front: 'Qual a dose?\nEm adultos & crianças [imagem: a.png]', Back: "5 mg\n2 < 3\nlink 'ok'" });
    expect(s.noteTypes.find((t) => t.name === 'Cloze')?.samples[0]?.Text).toBe('{{c1::Aspirina::droga}} inibe a {{c1::COX}}') // markers kept for the client preview;
    expect(s.noteTypes.find((t) => t.name === 'Image Occlusion')?.samples[0]).toMatchObject({ Occlusion: '', Image: '[imagem: a.png]', 'Back Extra': 'Nota' });
    expect(basic.samples[0]!.Front).toContain('Em adultos & crianças'); // img placeholder is samples-only
    expect(basic.samples[0]!.Front).toContain('[imagem: a.png]');
  });

  it('rejects non-zip, missing collection, modern format, corrupt sqlite, modern media', async () => {
    for (const bad of [new Uint8Array([1, 2, 3]), new Uint8Array()]) expect((await inspect(bad)).ok).toBe(false);
    const { zipSync, strToU8 } = await import('fflate');
    const nocol = await inspect(zipSync({ media: strToU8('{}') }));
    expect(!nocol.ok && nocol.error.code).toBe('validation');
    const modern = await inspect(modernPackage());
    expect(!modern.ok && modern.error.message).toMatch(/corrompida/); // anki21b that is not zstd
    const corrupt = await inspect(zipSync({ 'collection.anki2': strToU8('not sqlite at all, really not sqlite'), media: strToU8('{}') }));
    expect(!corrupt.ok && corrupt.error.message).toMatch(/corrompida/);
    const pb = await inspect(zipSync({ 'collection.anki21': new Uint8Array(10), media: new Uint8Array([8, 1, 2, 255]) }));
    expect(!pb.ok && pb.error.message).toMatch(/Suportar/);
    const arr = await inspect(zipSync({ 'collection.anki21': new Uint8Array(10), media: strToU8('[]') }));
    expect(arr.ok).toBe(false);
  });

  it('empty collection and models-less (new schema) collections fail', async () => {
    const empty = await buildApkg({ models: [], decks: [], notes: [] });
    const r = await inspect(empty);
    expect(!r.ok && r.error.message).toMatch(/formato novo/);
  });

  it('prefers anki21 over anki2; falls back to anki2', async () => {
    const p = await buildApkg({ models: [{ id: 1, name: 'B', type: 0, fields: ['F', 'B'] }], decks: [{ id: 1, name: 'D' }], notes: [{ id: 1, mid: 1, deck: 1, fields: ['a', 'b'] }], collectionName: 'collection.anki2' });
    expect(must(await inspect(p)).cardCount).toBe(1);
  });
});

describe('openPackage', () => {
  it('reads media lazily with sizes', async () => {
    const pkg = must(await openPackage(await fullPackage()));
    expect(pkg.media.get('a.png')).toBeDefined();
    expect(pkg.sizeOf('a.png')).toBe(PNG_1X1.length);
    expect(pkg.read('a.png')).toEqual(PNG_1X1);
    expect(pkg.read('nope.png')).toBeNull();
    expect(pkg.sizeOf('nope.png')).toBeNull();
    pkg.close();
  });
  it('media listed but absent from the zip -> null', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const base = must(await openPackage(await fullPackage()));
    const bytes = base.db.export();
    base.close();
    const pkg = must(await openPackage(zipSync({ 'collection.anki21': bytes, media: strToU8('{"5":"gone.png"}') })));
    expect(pkg.read('gone.png')).toBeNull();
    expect(pkg.sizeOf('gone.png')).toBeNull();
    pkg.close();
  });
});

describe('planImport', () => {
  it('fills default mappings and estimates notes (not cards)', async () => {
    const s = must(await inspect(await fullPackage()));
    const med = s.decks.find((d) => d.name === 'Med')!;
    const plan = must(planImport(s, [], [med.id]));
    expect(plan.mappings).toHaveLength(5);
    expect(plan.estimatedCards).toBe(6); // notes 100,101,103,200,300,400 (first card in Med subtree)
    const cardio = s.decks.find((d) => d.name === 'Med::Cardio')!;
    expect(must(planImport(s, [], [cardio.id])).estimatedCards).toBe(3); // 100, 101, 200
    expect(must(planImport(s, [], [med.id, cardio.id, med.id])).deckIds).toEqual([med.id, cardio.id]);
  });
  it('estimates by ratio when the client dropped deck.noteCount', async () => {
    const s = must(await inspect(await fullPackage()));
    const stripped = { ...s, decks: s.decks.map(({ id, name, cardCount }) => ({ id, name, cardCount })) } as unknown as typeof s; // legacy summary without noteCount
    const med = s.decks.find((d) => d.name === 'Med')!;
    expect(must(planImport(stripped, [], [med.id])).estimatedCards).toBeGreaterThan(0);
  });
  it('validates input', async () => {
    const s = must(await inspect(await fullPackage()));
    const ok1 = s.decks[1]!.id;
    const m = defaultMappings(s)[0]!;
    expect(planImport(s, [], []).ok).toBe(false);
    expect(planImport(s, [], ['999']).ok).toBe(false);
    expect(planImport(s, [{ ...m, noteTypeId: 'zz' }], [ok1]).ok).toBe(false);
    expect(planImport(s, [m, m], [ok1]).ok).toBe(false);
    expect(planImport(s, [{ ...m, front: 'Nope' }], [ok1]).ok).toBe(false);
    expect(planImport(s, [{ ...m, title: 'Nope' }], [ok1]).ok).toBe(false);
    expect(planImport(s, [{ ...m, cardType: 'flow' }], [ok1]).ok).toBe(false);
    expect(planImport(s, [{ ...m, back: null, title: 'Back' }], [ok1]).ok).toBe(true);
  });
  it('default mappings per kind', async () => {
    const s = must(await inspect(await fullPackage()));
    const d = Object.fromEntries(defaultMappings(s).map((m) => [s.noteTypes.find((t) => t.id === m.noteTypeId)!.name, m]));
    expect(d.Basic).toMatchObject({ cardType: 'concept', front: 'Front', back: 'Back' });
    expect(d.Cloze).toMatchObject({ cardType: 'concept', front: 'Text', back: 'Back Extra' });
    expect(d['Image Occlusion']).toMatchObject({ cardType: 'image', front: 'Image', back: 'Back Extra' });
    expect(d['Image Occlusion Enhanced']).toMatchObject({ cardType: 'image', front: 'Image', back: 'Remarks' });
    expect(d.Odd).toMatchObject({ cardType: 'concept', front: 'B', back: 'C' });
  });
});

describe('image and fallback titles', () => {
  const build = (notes: Array<[number, string[]]>) =>
    buildApkg({
      models: [
        { id: 3, name: 'Image Occlusion', type: 1, fields: ['Occlusion', 'Image', 'Header', 'Back Extra'] },
        { id: 1, name: 'Basic', type: 0, fields: ['Front', 'Back'] },
      ],
      decks: [{ id: 1, name: 'Root::Sub::3.5 Nervous Tissue' }],
      notes: notes.map(([mid, fields], i) => ({ id: 10 + i, mid, deck: 1, fields })),
    });
  const occ = '{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}';
  it('mapped title > Header > humanized file > deck fallback', async () => {
    const f = await build([
      [3, [occ, '<img src="a.png">', 'Meu cabeçalho', '']],
      [3, [occ, '<img src="Epithelial_tissue-diagram.PNG">', '', '']],
      [3, [occ, '<img src="c0b46517e362a5da48698fa11e494aa86eb677fe.jpeg">', '', '']],
      [3, [occ, '<img src="630-1528466692706.png">', '', '']],
    ]);
    const t = (await drafts(f, ['1'])).map((d) => d.title);
    expect(t).toEqual(['Meu cabeçalho', 'Epithelial tissue diagram', 'Oclusão de imagem · 3.5 Nervous Tissue', 'Oclusão de imagem · 3.5 Nervous Tissue']);
    const s = must(await inspect(f));
    const m = defaultMappings(s).find((x) => x.cardType === 'image')!;
    const mapped = await drafts(f, ['1'], [{ ...m, title: 'Back Extra' }]);
    expect(mapped[0]!.title).toBe('Meu cabeçalho'); // Back Extra empty -> falls through to Header
  });
  it('concept with only an image uses the file name', async () => {
    const ds = await drafts(await build([[1, ['<img src="Heart_valves.jpg">', ''], ], [1, ['<img src="c0b46517e362a5da48698fa11e494aa86eb677fe.jpeg">', '']]]), ['1']);
    expect(ds.map((d) => d.title)).toEqual(['Heart valves', 'Card do Anki']);
  });
});

describe('svg shapes', () => {
  const svg = (body: string) => `<svg width="100" height="50" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  it('path (relative and absolute), polygon, rect rx, translate groups, ellipse', () => {
    const r = svgShapes(svg(`<path d="m10 5h20v10h-20z"/><path d="M50,0 L100,0 L100,25 Z"/><polygon points="0,0 10,0 10,10"/><rect x="0" y="0" width="10" height="10" rx="2" ry="2"/><g transform="translate(50 25)"><g><ellipse cx="10" cy="5" rx="10" ry="5"/></g></g><rect x="0" y="0" width="100" height="50"/>`));
    expect(r.skipped).toBe(0);
    expect(r.masks).toHaveLength(6);
    expect(r.masks[0]!.polygon).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }]);
    expect(r.masks[4]!.polygon[0]).toEqual({ x: 0.5, y: 0.5 });
  });
  it('counts unsupported shapes (curves, no size)', () => {
    expect(svgShapes(svg(`<path d="M0 0 C 1 1 2 2 3 3 z"/><path d="m0 0h10v10z"/>`)).skipped).toBe(1);
    expect(svgShapes('<svg></svg>').masks).toEqual([]);
  });
  it('activeOnly keeps just the #ff7e7e shape', () => {
    const body = `<g stroke="#2d2d2d"><path d="m0 0h10v10h-10z" fill="#ffeba2"/><path d="m20 0h10v10h-10z" fill="#ff7e7e"/></g>`;
    expect(svgShapes(svg(body), true).masks).toHaveLength(1);
    expect(svgShapes(svg(body)).masks).toHaveLength(2);
  });
});

describe('tags and back media (D-221)', () => {
  it('tagsOf: note tags + sub deck path, cut/deduped/capped', () => {
    expect(tagsOf('a  b::c a', 'Med::Cardio::Arritmias')).toEqual(['a', 'b::c', 'Cardio › Arritmias']);
    expect(tagsOf('', 'Med')).toEqual([]);
    expect(tagsOf(` ${'x'.repeat(100)} `, 'M')).toEqual(['x'.repeat(64)]);
    const many = Array.from({ length: 80 }, (_, i) => `t${i}`).join(' ');
    const r = tagsOf(many, 'M::Sub');
    expect(r).toHaveLength(50);
    expect(r.at(-1)).toBe('Sub');
  });

  it('drafts carry tags and the back field image', async () => {
    const p = await buildApkg({
      models: [{ id: 1, name: 'Basic', type: 0, fields: ['Front', 'Back'] }], decks: [{ id: 1, name: 'R' }, { id: 2, name: 'R::U1::Sub' }],
      notes: [
        { id: 1, mid: 1, deck: 2, tags: ' x::y z ', fields: ['f<img src="a.png">', 'b<img src="o%20x.png"><img src="c.png"><img src="https://e/x.png">'] },
        { id: 2, mid: 1, deck: 2, fields: ['f', 'b'] },
      ],
      media: { 'a.png': PNG_1X1, 'o x.png': PNG_1X1, 'c.png': PNG_1X1 },
    });
    const ds = await drafts(p, ['1']);
    expect(byRef(ds, 1)).toMatchObject({ media: ['a.png'], backMedia: 'o x.png', tags: ['x::y', 'z', 'U1 › Sub'] });
    expect(byRef(ds, 2)).toMatchObject({ backMedia: null, tags: ['U1 › Sub'] });
  });
});

describe('toDrafts', () => {
  it('basic: html stripped, media collected, source and deck root', async () => {
    const ds = await drafts(await fullPackage(), ['10']);
    const d = byRef(ds, 100);
    expect(d).toMatchObject({
      type: 'concept', title: 'Qual a dose?', front: '**Qual a dose?**\nEm adultos & crianças', back: "5 mg\n2 < 3\nlink 'ok'",
      source: 'Anki · Med › Cardio', deckId: '10', deckName: 'Med::Cardio', media: ['a.png'], empty: false, payload: {},
    });
    expect(rootOf(d.deckName)).toBe('Med');
    expect(ds.every((x) => cardDraftSchema.safeParse(x).success)).toBe(true);
    expect(ds.some((x) => x.ref === 'anki-102')).toBe(false); // other root deck
  });

  it('subtree selection and ordering (deck, then note)', async () => {
    const all = await drafts(await fullPackage(), ['10']);
    expect(all.map((d) => d.ref)).toEqual(['anki-103', 'anki-300', 'anki-400', 'anki-100', 'anki-200', 'anki-101']);
    const sub = await drafts(await fullPackage(), ['12']);
    expect(sub.map((d) => d.ref)).toEqual(['anki-101']); // first card of 101 is in 12
  });

  it('empty note flagged', async () => {
    const ds = await drafts(await fullPackage(), ['10']);
    expect(byRef(ds, 103)).toMatchObject({ empty: true, title: 'Card do Anki', front: null, back: null });
  });

  it('cloze: front [...] / [hint], back full text, title from full text', async () => {
    const d = byRef(await drafts(await fullPackage(), ['10']), 200);
    expect(d.front).toBe('[droga] inibe a [...]');
    expect(d.back).toBe('**Aspirina** inibe a COX\n\nExtra');
    expect(d.title).toBe('Aspirina inibe a COX');
  });

  it('native image occlusion: masks normalized, rect/ellipse/polygon, invalid skipped', async () => {
    const d = byRef(await drafts(await fullPackage(), ['10']), 300);
    expect(d.type).toBe('image');
    if (d.type !== 'image') return;
    expect(d.payload.media).toBe('a.png');
    expect(d.payload.masks).toHaveLength(3);
    expect(d.payload.masks[0]!.polygon).toEqual([{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.30000000000000004 }, { x: 0.1, y: 0.30000000000000004 }]);
    expect(d.payload.masks[1]!.polygon).toHaveLength(4);
    expect(d.payload.masks[2]!.polygon).toHaveLength(3);
    expect(d.back).toBe('Nota');
    expect(d.title).toBe('A'); // humanized image name ("a.png")
    expect(d.media).toEqual(['a.png']);
  });

  it('IOE: masks from the SVG media, normalized by svg size, url-encoded name resolved', async () => {
    const d = byRef(await drafts(await fullPackage(), ['10']), 400);
    if (d.type !== 'image') throw new Error('expected image');
    expect(d.payload.masks).toHaveLength(2);
    expect(d.payload.masks[0]!.polygon[0]).toEqual({ x: 0.1, y: 0.1 });
    expect(d.payload.masks[1]!.polygon[0]).toEqual({ x: 0.4, y: 0.4 });
  });

  it('unknown type: first two non-empty fields; image mapping without image falls back to concept', async () => {
    const s = must(await inspect(await fullPackage()));
    const ds = await drafts(await fullPackage(), ['20']);
    expect(byRef(ds, 500)).toMatchObject({ front: 'Primeiro', back: 'Segundo', type: 'concept' });
    const odd = defaultMappings(s).find((m) => s.noteTypes.find((t) => t.id === m.noteTypeId)?.name === 'Odd')!;
    const asImage = await drafts(await fullPackage(), ['20'], [{ ...odd, cardType: 'image' }]);
    expect(byRef(asImage, 500).type).toBe('concept');
  });

  it('custom mapping: title field and swapped front/back; long title trimmed at a word', async () => {
    const s = must(await inspect(await fullPackage()));
    const basic = defaultMappings(s).find((m) => m.front === 'Front')!;
    const ds = await drafts(await fullPackage(), ['10'], [{ ...basic, title: 'Back', front: 'Back', back: 'Front' }]);
    expect(byRef(ds, 101)).toMatchObject({ title: 'Resposta', front: 'Resposta', back: 'Segunda pergunta?' });
    const long = 'palavra '.repeat(20);
    const p = await buildApkg({ models: [{ id: 1, name: 'B', type: 0, fields: ['F', 'B'] }], decks: [{ id: 1, name: 'D' }], notes: [{ id: 1, mid: 1, deck: 1, fields: [long, 'b'] }, { id: 2, mid: 1, deck: 1, fields: ['x'.repeat(100), 'b'] }] });
    const t = await drafts(p, ['1']);
    expect(t[0]!.title.length).toBeLessThanOrEqual(60);
    expect(t[0]!.title.endsWith('palavra…')).toBe(true);
    expect(t[1]!.title).toHaveLength(60);
  });

  it('plan with unknown deck, and failing package', async () => {
    const f = await fullPackage();
    const s = must(await inspect(f));
    const plan = must(planImport(s, [], ['10']));
    expect((await toDrafts(f, { ...plan, deckIds: ['nope'] })).ok).toBe(false);
    expect((await toDrafts(new Uint8Array([1]), plan)).ok).toBe(false);
  });

  it('only the plan mappings are used; missing ones fall back to defaults', async () => {
    const f = await fullPackage();
    const s = must(await inspect(f));
    const plan = { ...must(planImport(s, [], ['10'])), mappings: [] };
    expect(must(await toDrafts(f, plan)).length).toBe(6);
  });
});

describe.skipIf(!process.env.ANKI_SAMPLE)('real sample (ANKI_SAMPLE)', () => {
  const file = () => new Uint8Array(readFileSync(process.env.ANKI_SAMPLE!));
  it('inspects and converts', async () => {
    const f = file();
    let t = performance.now();
    const s = must(await inspect(f));
    expect(performance.now() - t).toBeLessThan(5000);
    expect(s.decks).toHaveLength(21);
    expect(s.noteTypes).toHaveLength(4);
    const kinds = Object.fromEntries(s.noteTypes.map((n) => [n.name.replace(/ \d+$/, ''), n.kind]));
    expect(kinds['Cloze Overlapping']).toBe('cloze');
    expect(kinds['Image Occlusion Enhanced']).toBe('image_occlusion');
    expect(kinds['Image Occlusion']).toBe('image_occlusion');
    expect(['basic', 'other']).toContain(kinds.Replace);
    expect(s.mediaCount).toBe(281);
    const root = s.decks.find((d) => d.name === 'Anatomy and Physiology')!;
    const plan = must(planImport(s, [], [root.id]));
    expect(plan.estimatedCards).toBe(308);
    t = performance.now();
    const ds = must(await toDrafts(f, plan));
    expect(performance.now() - t).toBeLessThan(15000);
    expect(ds).toHaveLength(308);
    for (const d of ds) {
      expect(cardDraftSchema.safeParse(d).success).toBe(true);
      expect(`${d.title}\n${d.front}\n${d.back}`).not.toMatch(/<\/?[a-z][^>]*>|&nbsp;/i);
    }
    expect(ds.some((d) => d.type === 'image' && d.payload.masks.length >= 1)).toBe(true);
    for (const d of ds) {
      expect(d.tags.length).toBeLessThanOrEqual(50);
      expect(d.tags.every((t) => t.length >= 1 && t.length <= 64)).toBe(true);
    }
    expect(ds.every((d) => d.tags.length > 0)).toBe(true);
    expect(ds.some((d) => d.tags.some((t) => /^Anatomy_and_Physiology::Unit01_Intro_to_A&P::1\.1_Intro$/.test(t)))).toBe(true);
    expect(ds.some((d) => d.tags.includes('Unit 01: Intro to A&P › 1.1 Intro'))).toBe(true);
    expect(ds.filter((d) => /\*\*|\n- /.test(`${d.front}\n${d.back}`)).length).toBeGreaterThan(100); // markdown now carried (D-220)
  });
});
