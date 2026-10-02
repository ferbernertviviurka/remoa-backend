// QA F06: hostile packages (zip bombs, SQLite views, pathological HTML) must fail fast, not hang or allocate GBs.
import { strToU8, zipSync } from 'fflate';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { buildApkg } from '../test/fixtures';
import { htmlToMd, htmlToText, imgSources, mapCloze } from './html';
import { nativeMasks, svgShapes } from './occlusion';
import { inspect, openPackage } from './index';

/** Rewrites an entry's declared uncompressed size in the central directory (what fflate allocates). */
const lieAboutSize = (z: Uint8Array, name: string, size: number) => {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  for (let i = 0; i < z.length - 46; i++)
    if (dv.getUint32(i, true) === 0x02014b50 && new TextDecoder().decode(z.subarray(i + 46, i + 46 + dv.getUint16(i + 28, true))) === name) dv.setUint32(i + 24, size, true);
  return z;
};
const basic = () =>
  buildApkg({ models: [{ id: 1, name: 'Basic', type: 0, fields: ['Front', 'Back'] }], decks: [{ id: 1, name: 'D' }], notes: [{ id: 1, mid: 1, deck: 1, fields: ['a', 'b'] }], media: { 'big.svg': '<svg/>' } });

describe('hostile packages', () => {
  it('declared sizes over the caps are refused before inflating', async () => {
    const r = await openPackage(lieAboutSize(await basic(), 'collection.anki21', 0xfffffff0));
    expect(!r.ok && r.error.message).toMatch(/grande demais/);
    const m = await openPackage(lieAboutSize(await basic(), 'media', 0xfffffff0));
    expect(!m.ok && m.error.message).toMatch(/grande demais/);
    const pkg = await openPackage(lieAboutSize(await basic(), '0', 11 * 1024 * 1024));
    expect(pkg.ok && pkg.data.read('big.svg')).toBeNull(); // 10 MB media rule inside read()
    if (pkg.ok) pkg.data.close();
  });

  it('notes/cards as recursive views are rejected instead of scanning forever', async () => {
    const db = new (await initSqlJs()).Database();
    db.run(`create table col (models text, decks text); insert into col values ('{"1":{"name":"Basic","flds":[{"name":"F","ord":0},{"name":"B","ord":1}]}}','{"1":{"name":"D"}}');
      create view notes as with recursive r(id) as (select 1 union all select id+1 from r) select id, 1 as mid, 'a' as flds from r;
      create view cards as select id as nid, 1 as did, 0 as odid, 0 as ord, id from notes;`);
    const r = await inspect(zipSync({ 'collection.anki21': db.export(), media: strToU8('{}') }));
    expect(!r.ok && r.error.message).toMatch(/corrompida/);
  });

  it('pathological fields stay linear (each < 1 s on 200 KB; quadratic cases took 3–15 s)', () => {
    const big = (s: string) => s.repeat(Math.ceil(200_000 / s.length));
    const cases: Array<() => unknown> = [
      () => htmlToText(big('<!--')), () => htmlToText(big('<style')), () => htmlToText(big('<script')), () => htmlToText(big('<')),
      () => htmlToText(big('[sound:')), () => htmlToMd(big('<b>')), () => htmlToMd(big('<a href="https://x">')), () => htmlToMd(big('<li>')), () => htmlToMd(big('<td>')),
      () => htmlToMd(big('<a ')), () => htmlToMd(big('</a>')), () => htmlToMd(big('<i><b>')), () => htmlToMd(big('<ol><li>a</li>')), () => htmlToMd(big('**')), () => htmlToMd(big('<div>')), () => htmlToText(big('[[')), () => mapCloze(big('{{c1::'), (a) => a), () => mapCloze(big('{{c1::a::'), (a) => a),
      () => mapCloze(big('{{c1::image-occlusion:'), (a) => a), () => imgSources(big('<img src="')), () => nativeMasks(big('{{c1::image-occlusion:rect:')),
      () => svgShapes(`<svg width="1" height="1">${big('<rect ')}`), () => svgShapes(`<svg width="1" height="1"><rect ${big('a')}>`), () => svgShapes(`<svg width="1" height="1">${big('<g transform="translate(')}`),
    ];
    for (const [i, f] of cases.entries()) {
      const t = performance.now();
      f();
      expect(performance.now() - t, `case ${i}`).toBeLessThan(1000); // ~45 ms alone; 1 s absorbs the monorepo's parallel test load without hiding the 3–15 s blowups of D-162;
    }
  });

  it('cloze/overlapping semantics kept by the linear rewrite', () => {
    expect(mapCloze('{{c1::a::b::c}} {{c2::x:}} {{c1::image-occlusion:rect:left=.1}}z', (a, h) => `[${a}|${h ?? ''}]`)).toBe('[a|b::c] [x:|] z');
    expect(htmlToText('[[[x]] <<b>y</b> <scriptx>k</scriptx> <SCRIPT>bad()</SCRIPT>ok <!-- a --> <!-- open')).toBe('[x <y k ok <!-- open');
  });
});
