// D-220: Anki >= 2.1.50 packages (collection.anki21b zstd + protobuf media). full-modern.apkg is committed
// (made once by test/make-modern-fixture.mjs, Node >= 24) so Node 20 CI covers it.
import { readFileSync } from 'node:fs';
import nodeZlib from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildApkg, fullPackage, PNG_1X1 } from '../test/fixtures';
import { inspect, openPackage, toDrafts, planImport, type AnkiDraft } from './index';
import { parseMediaEntries, zstd } from './package';

// zlib.zstd needs Node >= 22.15 (absent from @types/node 20 and from CI's Node 20)
const zlib = nodeZlib as unknown as { zstdCompressSync?: (b: Uint8Array) => Uint8Array };
const modern = () => new Uint8Array(readFileSync(new URL('../test/full-modern.apkg', import.meta.url)));
const must = <T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
};
const run = async (file: Uint8Array, deckIds = ['10', '11', '12', '20']) => {
  const s = must(await inspect(file));
  return { s, ds: must(await toDrafts(file, must(planImport(s, [], deckIds)))) };
};

describe('modern package (.anki21b)', () => {
  it('imports exactly like the legacy equivalent', async () => {
    const [m, l] = [await run(modern()), await run(await fullPackage())];
    expect(m.s).toEqual(l.s);
    expect(m.ds).toEqual(l.ds);
    expect(m.s.mediaCount).toBe(3);
  });

  it('reads zstd media lazily; sizes come from the protobuf', async () => {
    const pkg = must(await openPackage(modern()));
    expect(pkg.sizeOf('a.png')).toBe(PNG_1X1.length);
    expect(pkg.read('a.png')).toEqual(PNG_1X1);
    expect(pkg.read('nope.png')).toBeNull();
    pkg.close();
  });

  it("corrupt zstd collection fails with validation", async () => {
    const bad = await inspect(zipSync({ 'collection.anki21b': new Uint8Array([1, 2, 3, 4]), media: new Uint8Array(), meta: new Uint8Array([8, 3]) }));
    expect(!bad.ok && bad.error.message).toMatch(/corrompida/);
  });

  it.skipIf(!zlib.zstdCompressSync)('decompression is capped (bomb) and invalid media maps are refused', async () => {
    const bomb = zlib.zstdCompressSync!(new Uint8Array(4 * 1024 * 1024));
    expect(zstd(bomb, 1024)).toBeNull();
    expect(zstd(bomb, 8 * 1024 * 1024)?.length).toBe(4 * 1024 * 1024);
    const sql = zlib.zstdCompressSync!(strToU8('x'));
    const r = await inspect(zipSync({ 'collection.anki21b': sql, media: zlib.zstdCompressSync!(Uint8Array.from([0x0a, 0x7f, 1])) }));
    expect(!r.ok && r.error.message).toMatch(/formato/);
  });
});

describe('parseMediaEntries', () => {
  it.each([
    ['empty', [], []],
    ['one entry + unknown field', [0x0a, 7, 0x0a, 1, 0x61, 0x10, 5, 0x18, 1], [['a', 5]]],
    ['two entries', [0x0a, 3, 0x0a, 1, 0x61, 0x0a, 5, 0x0a, 1, 0x62, 0x10, 0x80, 0x01], [['a', 0], ['b', 128]]],
  ])('%s', (_n, bytes, want) => expect(parseMediaEntries(Uint8Array.from(bytes as number[]))).toEqual(want));
  it.each([
    ['length past the end', [0x0a, 50, 0x0a]],
    ['name past the entry', [0x0a, 3, 0x0a, 9, 0x61]],
    ['truncated varint', [0x0a, 0x80]],
    ['varint too long', [0x0a, 6, 0x10, 0xff, 0xff, 0xff, 0xff, 0xff]],
    ['bad wire type', [0x0b]],
  ])('rejects %s', (_n, bytes) => expect(parseMediaEntries(Uint8Array.from(bytes))).toBeNull());
});

describe('stub-only package', () => {
  const model = { id: 1, name: 'Basic', type: 0 as const, fields: ['Front', 'Back'] };
  it('anki2 with only the "update Anki" note is refused', async () => {
    const stub = await buildApkg({
      models: [model], decks: [{ id: 1, name: 'Default' }], collectionName: 'collection.anki2',
      notes: [{ id: 1, mid: 1, deck: 1, fields: ['Please update to the latest Anki version, then import the .colpkg/.apkg file again.', ''] }],
    });
    const r = await inspect(stub);
    expect(!r.ok && r.error.message).toMatch(/aviso de versão/);
  });
  it('a real one-note anki2 deck is not mistaken for a stub', async () => {
    const p = await buildApkg({ models: [model], decks: [{ id: 1, name: 'D' }], collectionName: 'collection.anki2', notes: [{ id: 1, mid: 1, deck: 1, fields: ['a', 'b'] }] });
    expect(must(await inspect(p)).cardCount).toBe(1);
  });
});

describe('occlusion titles (P-057)', () => {
  it('numbers repeated titles on the same image only', async () => {
    const io = { id: 3, name: 'Image Occlusion', type: 1 as const, fields: ['Occlusion', 'Image', 'Header', 'Back Extra'] };
    const basic = { id: 1, name: 'Basic', type: 0 as const, fields: ['Front', 'Back'] };
    const mask = (n: number) => `{{c${n}::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1}}`;
    const p = await buildApkg({
      models: [io, basic], decks: [{ id: 1, name: 'D' }],
      notes: [
        { id: 1, mid: 3, deck: 1, fields: [mask(1), '<img src="a.png">', 'Coração', ''] },
        { id: 2, mid: 3, deck: 1, fields: [mask(1), '<img src="a.png">', 'Coração', ''] },
        { id: 3, mid: 3, deck: 1, fields: [mask(1), '<img src="a.png">', 'Coração', ''] },
        { id: 4, mid: 3, deck: 1, fields: [mask(1), '<img src="b.png">', 'Coração', ''] },
        { id: 5, mid: 1, deck: 1, fields: ['Igual', 'x'] },
        { id: 6, mid: 1, deck: 1, fields: ['Igual', 'y'] },
      ],
      media: { 'a.png': PNG_1X1, 'b.png': PNG_1X1 },
    });
    const { ds } = await run(p, ['1']);
    const t = (ds as AnkiDraft[]).map((d) => d.title);
    expect(t).toEqual(['Coração', 'Coração · máscara 2', 'Coração · máscara 3', 'Coração', 'Igual', 'Igual']);
  });
});
