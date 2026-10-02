import { strToU8, zipSync } from 'fflate';
import zlib from 'node:zlib';
import initSqlJs from 'sql.js';

export type FxModel = { id: number; name: string; type: 0 | 1; fields: string[] };
export type FxNote = { id: number; mid: number; fields: string[]; deck: number; cards?: number[]; tags?: string };
export type FxDeck = { id: number; name: string };

/** 1x1 transparent PNG. */
export const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==').split('').map((c) => c.charCodeAt(0)),
);

export async function buildApkg(opts: {
  models: FxModel[];
  decks: FxDeck[];
  notes: FxNote[];
  media?: Record<string, Uint8Array | string>;
  collectionName?: string;
  /** Anki >= 2.1.50 layout: zstd collection.anki21b + protobuf media. Needs Node >= 22.15 (zlib.zstd); CI uses the committed full-modern.apkg. */
  modern?: boolean;
}): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`create table col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
create table notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
create table cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
create table revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
create table graves (usn integer, oid integer, type integer);`);
  const models = Object.fromEntries(
    opts.models.map((m) => [m.id, { id: m.id, name: m.name, type: m.type, flds: m.fields.map((name, ord) => ({ name, ord })) }]),
  );
  const decks = Object.fromEntries(opts.decks.map((d) => [d.id, { id: d.id, name: d.name }]));
  db.run('insert into col values (1,0,0,0,11,0,0,0,?,?,?,?,?)', ['{}', JSON.stringify(models), JSON.stringify(decks), '{}', '{}']);
  let cardId = 1000;
  for (const n of opts.notes) {
    db.run("insert into notes values (?,?,?,0,0,?,?,?,0,0,'')", [n.id, `g${n.id}`, n.mid, n.tags ?? '', n.fields.join('\x1f'), n.fields[0] ?? '']);
    for (const [ord, c] of (n.cards ?? [n.deck]).entries()) {
      db.run("insert into cards values (?,?,?,?,0,0,0,0,0,0,0,0,0,0,0,0,0,'')", [cardId++, n.id, c, ord]);
    }
  }
  const sqlite = db.export();
  db.close();
  const mediaMap: Record<string, string> = {};
  const files: Record<string, Uint8Array> = {};
  Object.entries(opts.media ?? {}).forEach(([name, bytes], i) => {
    mediaMap[String(i)] = name;
    files[String(i)] = typeof bytes === 'string' ? strToU8(bytes) : bytes;
  });
  if (opts.modern) {
    const zstd = (b: Uint8Array) => (zlib as unknown as { zstdCompressSync(b: Uint8Array): Uint8Array }).zstdCompressSync(b);
    const varint = (n: number) => {
      const o: number[] = [];
      for (; n >= 0x80; n = Math.floor(n / 128)) o.push((n % 128) | 0x80);
      return [...o, n];
    };
    const entries = Object.keys(files).map((k) => {
      const nm = strToU8(mediaMap[k]!);
      const body = [0x0a, ...varint(nm.length), ...nm, 0x10, ...varint(files[k]!.length), 0x1a, 20, ...new Array<number>(20).fill(7)];
      return [0x0a, ...varint(body.length), ...body];
    });
    const pb = Uint8Array.from(entries.flat());
    const packed = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, zstd(v)]));
    return zipSync({ 'collection.anki21b': zstd(sqlite), media: zstd(pb), meta: Uint8Array.from([8, 3]), ...packed });
  }
  return zipSync({ [opts.collectionName ?? 'collection.anki21']: sqlite, media: strToU8(JSON.stringify(mediaMap)), ...files });
}

export const modernPackage = () => zipSync({ 'collection.anki21b': new Uint8Array(4), media: new Uint8Array(4), meta: new Uint8Array(2) });

const BASIC = { id: 1, name: 'Basic', type: 0 as const, fields: ['Front', 'Back'] };
const CLOZE = { id: 2, name: 'Cloze', type: 1 as const, fields: ['Text', 'Back Extra'] };
const IO = { id: 3, name: 'Image Occlusion', type: 1 as const, fields: ['Occlusion', 'Image', 'Header', 'Back Extra'] };
const IOE = { id: 4, name: 'Image Occlusion Enhanced', type: 0 as const, fields: ['ID (hidden)', 'Header', 'Image', 'Question Mask', 'Original Mask', 'Remarks'] };
const ODD = { id: 5, name: 'Odd', type: 0 as const, fields: ['A', 'B', 'C'] };

export const decks: FxDeck[] = [
  { id: 1, name: 'Default' },
  { id: 10, name: 'Med' },
  { id: 11, name: 'Med::Cardio' },
  { id: 12, name: 'Med::Cardio::Arritmias' },
  { id: 20, name: 'Outro' },
];

const IOE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><g><rect fill="#fff" x="20" y="10" width="40" height="20"/><ellipse cx="100" cy="50" rx="20" ry="10"/></g></svg>`;

export const fullPackage = (modern = false) =>
  buildApkg({
    modern,
    models: [BASIC, CLOZE, IO, IOE, ODD],
    decks,
    notes: [
      { id: 100, mid: 1, deck: 11, fields: ['<b>Qual&nbsp;a dose?</b><br>Em adultos &amp; crianças<img src="a.png">', '<div>5 mg</div><div>2 &lt; 3</div> <a href="x">link</a> &#39;ok&#39;'] },
      { id: 101, mid: 1, deck: 12, cards: [12, 11], fields: ['Segunda pergunta?', 'Resposta'] },
      { id: 102, mid: 1, deck: 20, fields: ['Fora do deck Med', 'x'] },
      { id: 103, mid: 1, deck: 10, fields: ['', ''] },
      { id: 200, mid: 2, deck: 11, cards: [11, 11], fields: ['{{c1::<b>Aspirina</b>::droga}} inibe a {{c2::COX}}', 'Extra'] },
      { id: 300, mid: 3, deck: 10, fields: [
        '{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1:oi=1}}<br>{{c1::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.2}}<br>{{c2::image-occlusion:polygon:points=0.1,0.1 0.5,0.1 0.3,0.4}}<br>{{c1::image-occlusion:rect:left=.:top=.3:width=.1:height=.1}}',
        '<img src="a.png">', '', 'Nota'] },
      { id: 400, mid: 4, deck: 10, fields: ['x', 'Cabeçalho', '<img src="a.png">', '<img src="q.svg">', '<img src="o%20x.svg">', ''] },
      { id: 500, mid: 5, deck: 20, fields: ['', 'Primeiro', 'Segundo'] },
    ],
    media: { 'a.png': PNG_1X1, 'q.svg': IOE_SVG, 'o x.svg': IOE_SVG },
  });
