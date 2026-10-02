import { err, ok, type Result } from '@remoa/contracts';
import { unzipSync } from 'fflate';
import { Decompress } from 'fzstd';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

export type AnkiPackage = {
  db: Database;
  /** media file name -> zip entry name (from the `media` JSON). */
  media: Map<string, string>;
  /** Uncompressed size of a media file, without inflating it. */
  sizeOf(name: string): number | null;
  /** Inflates just this file. */
  read(name: string): Uint8Array | null;
  close(): void;
};

const UNSUPPORTED = 'Não reconhecemos o formato deste pacote do Anki. Exporte de novo como .apkg (com "Suportar versões antigas do Anki" marcado, se houver) e envie o arquivo.';
const STUB = 'Este .apkg é só um aviso de versão do Anki, sem os cards. Exporte de novo marcando "Suportar versões antigas do Anki" (ou atualize o Anki) e envie o arquivo.';
const BAD_ZIP = 'O arquivo não é um pacote .apkg válido.';
const CORRUPT = 'A coleção do Anki está corrompida.';
const TOO_BIG = 'A coleção do Anki é grande demais para importar.';
/** fflate allocates the declared uncompressed size up front: cap it before inflating (zip bombs). */
export const MAX_COLLECTION_BYTES = 256 * 1024 * 1024;
const MAX_MEDIA_JSON_BYTES = 16 * 1024 * 1024;
/** FRD: never import media > 10 MB; `read` refuses bigger entries (covers SVG masks too). */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** zstd with a hard output cap (fzstd streams per block, so a bomb is aborted as soon as it passes `cap`). Null = invalid or over the cap. */
export function zstd(data: Uint8Array, cap: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const d = new Decompress((c) => {
      total += c.length;
      if (total > cap) throw new RangeError('cap');
      chunks.push(c);
    });
    d.push(data, true);
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** `MediaEntries { repeated MediaEntry entries = 1 }`, `MediaEntry { string name = 1; uint32 size = 2; bytes sha1 = 3 }` -> [name, size][] (index = zip entry name). */
export function parseMediaEntries(buf: Uint8Array): Array<[string, number]> | null {
  let i = 0;
  const varint = (): number => {
    let v = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = buf[i++];
      if (b === undefined) throw new Error('eof');
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
    }
    throw new Error('varint');
  };
  const skip = (wire: number, end: number) => {
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const n = varint();
      i += n;
    }
    else throw new Error('wire');
    if (i > end) throw new Error('len');
  };
  const out: Array<[string, number]> = [];
  try {
    while (i < buf.length) {
      const tag = varint();
      if (tag !== 0x0a) {
        skip(tag & 7, buf.length);
        continue;
      }
      const len = varint();
      const end = i + len;
      if (end > buf.length) return null;
      let name = '', size = 0;
      while (i < end) {
        const t = varint();
        if (t === 0x0a) {
          const n = varint();
          if (i + n > end) return null;
          name = new TextDecoder().decode(buf.subarray(i, i + n));
          i += n;
        } else if (t === 0x10) size = varint();
        else skip(t & 7, end);
      }
      out.push([name, size]);
    }
  } catch {
    return null;
  }
  return out;
}

let sql: Promise<SqlJsStatic> | undefined;
const sqlJs = () => (sql ??= initSqlJs());

/** Legacy (collection.anki21 | .anki2 + JSON `media`) and modern (D-220: collection.anki21b zstd + protobuf `media`, media files zstd). Never inflates media up front. */
export async function openPackage(file: Uint8Array): Promise<Result<AnkiPackage>> {
  const sizes = new Map<string, number>();
  let top: Record<string, Uint8Array>;
  let tooBig = false;
  try {
    top = unzipSync(file, {
      filter: (f) => {
        sizes.set(f.name, f.originalSize);
        const want = f.name === 'media' || f.name.startsWith('collection.');
        if (want && f.originalSize > (f.name === 'media' ? MAX_MEDIA_JSON_BYTES : MAX_COLLECTION_BYTES)) tooBig = true;
        return want && !tooBig;
      },
    });
  } catch {
    return err('validation', BAD_ZIP);
  }
  if (tooBig) return err('validation', TOO_BIG);
  const modern = top['collection.anki21b'] !== undefined;
  const coll = modern ? zstd(top['collection.anki21b']!, MAX_COLLECTION_BYTES) : (top['collection.anki21'] ?? top['collection.anki2']);
  if (!coll) return err('validation', modern ? CORRUPT : 'Não encontramos a coleção dentro do .apkg.');
  const stubOnly = !modern && !top['collection.anki21'];

  const media = new Map<string, string>();
  const declared = new Map<string, number>(); // modern: declared size per zip entry
  try {
    if (modern) {
      const raw = zstd(top.media ?? new Uint8Array(0), MAX_MEDIA_JSON_BYTES);
      const list = raw && (raw.length ? parseMediaEntries(raw) : []);
      if (!list) throw new Error('media');
      list.forEach(([name, size], idx) => {
        media.set(name, String(idx));
        declared.set(String(idx), size);
      });
    } else {
      const json: unknown = JSON.parse(new TextDecoder().decode(top.media ?? new TextEncoder().encode('{}')));
      if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('media');
      for (const [entry, name] of Object.entries(json)) if (typeof name === 'string') media.set(name, entry);
    }
  } catch {
    return err('validation', UNSUPPORTED);
  }

  let db: Database | undefined;
  try {
    db = new (await sqlJs()).Database(coll);
    // col/notes/cards must be real tables: a VIEW with a recursive CTE yields endless rows and hangs the scan
    const t = db.exec("select count(*) from sqlite_master where type = 'table' and name in ('col', 'notes', 'cards') and sql not like 'create virtual%'");
    if (t[0]?.values[0]?.[0] !== 3) throw new Error('schema');
    db.exec('select 1 from col limit 1');
    if (stubOnly) {
      // Anki >= 2.1.50 without "legacy" support ships a one-note stub in collection.anki2
      const n = db.exec('select flds from notes limit 2')[0]?.values ?? [];
      if (n.length === 1 && /latest\s+anki/i.test(String(n[0]![0]))) {
        db.close();
        return err('validation', STUB);
      }
    }
  } catch {
    db?.close();
    return err('validation', 'A coleção do Anki está corrompida.');
  }
  const opened = db;
  return ok({
    db: opened,
    media,
    sizeOf: (name) => {
      const e = media.get(name);
      return e !== undefined && sizes.has(e) ? (modern ? (declared.get(e) ?? sizes.get(e)!) : sizes.get(e)!) : null;
    },
    read: (name) => {
      const e = media.get(name);
      if (e === undefined || !sizes.has(e) || sizes.get(e)! > MAX_MEDIA_BYTES || (declared.get(e) ?? 0) > MAX_MEDIA_BYTES) return null;
      const bytes = unzipSync(file, { filter: (f) => f.name === e })[e];
      return bytes && modern ? zstd(bytes, MAX_MEDIA_BYTES) : (bytes ?? null);
    },
    close: () => opened.close(),
  });
}
