import {
  err,
  ok,
  type ApkgSummary,
  type CardDraft,
  type FieldMapping,
  type ImportPlan,
  type Inspect,
  type PlanImport,
  type Result,
  type ToDrafts,
} from '@remoa/contracts';
import type { Database } from 'sql.js';
import { htmlToMd, htmlToText, imgSources, mapCloze } from './html';
import { fieldSvgMasks, nativeMasks } from './occlusion';
import { openPackage, type AnkiPackage } from './package';

export { openPackage, type AnkiPackage } from './package';

type Kind = ApkgSummary['noteTypes'][number]['kind'];
/** Draft + what the job needs (deck grouping, media to upload). `media` = files in front, in order (image cards: the card image). */
export type AnkiDraft = CardDraft & { deckId: string; deckName: string; media: string[]; backMedia: string | null; tags: string[]; empty: boolean };
/** `inspect` output plus per-deck note counts; `noteCount` is a contract change request (CCR) on ApkgSummary.decks. */
export type DeckInfo = ApkgSummary['decks'][number] & { noteCount?: number };

type Model = { id: string; name: string; kind: Kind; fields: string[] };
type Note = { id: string; mid: string; fields: string[]; deckId: string; tags: string };
type Scan = { decks: Array<{ id: string; name: string; cards: number; notes: number }>; models: Model[]; notes: Note[]; cardCount: number };

export const rootOf = (deckName: string): string => deckName.split('::')[0]!;
const inSubtree = (name: string, root: string) => name === root || name.startsWith(`${root}::`);

// --- scan ------------------------------------------------------------------
function* rows(db: Database, sql: string): Generator<unknown[]> {
  const st = db.prepare(sql);
  try {
    while (st.step()) yield st.get();
  } finally {
    st.free();
  }
}

const backish = /^(back|verso|answer|resposta)$/i;
function kindOf(name: string, type: number, fields: string[]): Kind {
  if (/image occlusion/i.test(name) || fields.some((f) => /^(occlusion|question mask)$/i.test(f))) return 'image_occlusion';
  if (type === 1) return 'cloze';
  if (fields.length === 2 || (/^(front|frente|pergunta|question)$/i.test(fields[0] ?? '') && fields.some((f, i) => i > 0 && backish.test(f)))) return 'basic';
  return 'other';
}

function scan(db: Database): Result<Scan> {
  const col = rows(db, 'select models, decks from col limit 1').next().value as [string, string] | undefined;
  if (!col) return err('validation', 'A coleção do Anki está vazia.');
  let modelsJson: Record<string, { name: string; type?: number; flds: Array<{ name: string; ord: number }> }>;
  let decksJson: Record<string, { name: string }>;
  try {
    modelsJson = JSON.parse(col[0]);
    decksJson = JSON.parse(col[1]);
  } catch {
    return err('validation', 'A coleção do Anki está corrompida.');
  }
  const models: Model[] = Object.entries(modelsJson).map(([id, m]) => {
    const fields = [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name);
    return { id, name: m.name, kind: kindOf(m.name, m.type ?? 0, fields), fields };
  });
  if (models.length === 0) return err('validation', 'Não encontramos os tipos de nota (formato novo do Anki?). Exporte de novo com "Suportar versões antigas do Anki".');
  const decks = new Map(Object.entries(decksJson).map(([id, d]) => [id, { id, name: d.name, cards: 0, notes: 0 }]));
  const deck = (id: string, name = `Deck ${id}`) => decks.get(id) ?? (decks.set(id, { id, name, cards: 0, notes: 0 }), decks.get(id)!);

  const notes: Note[] = [];
  let cardCount = 0;
  let last = '';
  for (const r of rows(db, 'select n.id, n.mid, n.flds, c.did, c.odid, n.tags from notes n join cards c on c.nid = n.id order by n.id, c.ord, c.id')) {
    const did = String(Number(r[4]) || r[3]);
    deck(did).cards++;
    cardCount++;
    const id = String(r[0]);
    if (id === last) continue; // only the note's first card decides its deck
    last = id;
    deck(did).notes++;
    notes.push({ id, mid: String(r[1]), fields: String(r[2]).split('\x1f'), deckId: did, tags: String(r[5] ?? '') });
  }
  return ok({ decks: [...decks.values()], models, notes, cardCount });
}

const plain = (html: string) => htmlToText(mapCloze(html, (a) => a));
/** Card body text: simple markdown (D-220); `plain` stays for titles, samples and hashes. */
const md = (html: string) => htmlToMd(mapCloze(html, (a) => a));
/** Preview samples keep cloze markers (`{{c1::answer::hint}}`) so the client can render `[...]` like the job does; capped. */
/** Preview only: `<img src="x.png">` shows as `[imagem: x.png]` so image-only fields are not blank (drafts drop images). */
const imgPlaceholder = (html: string) =>
  html.replace(/<img\b[^<>]*>/gi, (tag) => {
    const n = imgSources(tag)[0]?.replace(/[<>]/g, '').slice(0, 60);
    return n ? ` [imagem: ${n}] ` : '';
  });
const sampleText = (html: string) => htmlToText(mapCloze(imgPlaceholder(html), (a, h) => `{{c1::${a}${h ? `::${h}` : ''}}}`)).slice(0, 1000);

function summarize(s: Scan, mediaCount: number): ApkgSummary & { decks: DeckInfo[] } {
  const byModel = new Map<string, Note[]>();
  for (const n of s.notes) (byModel.get(n.mid) ?? byModel.set(n.mid, []).get(n.mid)!).push(n);
  return {
    decks: s.decks.map((d) => ({ id: d.id, name: d.name, cardCount: d.cards, noteCount: d.notes })),
    noteTypes: s.models.map((m) => {
      const ns = byModel.get(m.id) ?? [];
      const samples = ns
        .map((n) => Object.fromEntries(m.fields.map((f, i) => [f, sampleText(n.fields[i] ?? '')])))
        .filter((rec) => Object.values(rec).some(Boolean))
        .slice(0, 5);
      return { id: m.id, name: m.name, kind: m.kind, fields: m.fields, noteCount: ns.length, samples };
    }),
    cardCount: s.cardCount,
    mediaCount,
  };
}

// --- public API ------------------------------------------------------------
export const inspect: Inspect = async (file) => {
  const pkg = await openPackage(file);
  if (!pkg.ok) return pkg;
  try {
    const s = scan(pkg.data.db);
    return s.ok ? ok(summarize(s.data, pkg.data.media.size)) : s;
  } catch {
    return err('validation', 'A coleção do Anki está corrompida.');
  } finally {
    pkg.data.close();
  }
};

type NoteTypeSummary = ApkgSummary['noteTypes'][number];
const filled = (t: NoteTypeSummary, f: string) => t.samples.some((s) => (s[f] ?? '') !== '');

function defaultMapping(t: NoteTypeSummary): FieldMapping {
  const nonEmpty = t.fields.filter((f) => filled(t, f));
  const first = nonEmpty[0] ?? t.fields[0] ?? '';
  const base = { noteTypeId: t.id, title: null } as const;
  switch (t.kind) {
    case 'image_occlusion': {
      const front = t.fields.find((f) => /^image$/i.test(f)) ?? t.fields.find((f) => /image|imagem/i.test(f) && !/mask|occlusion/i.test(f)) ?? first;
      const back = ['back extra', 'remarks', 'comments'].map((n) => t.fields.find((f) => f.toLowerCase() === n)).find(Boolean) ?? null;
      return { ...base, cardType: 'image', front, back };
    }
    case 'cloze': {
      const front = t.samples.length ? (t.fields.find((f) => t.samples.some((s) => /\{\{c\d+::/.test(s[f] ?? ''))) ?? first) : first;
      return { ...base, cardType: 'concept', front, back: t.fields.find((f) => /^(back extra|extra|verso extra)$/i.test(f) && f !== front) ?? null };
    }
    case 'basic': {
      const front = filled(t, t.fields[0] ?? '') || !nonEmpty.length ? (t.fields[0] ?? '') : first;
      const back = t.fields.find((f) => backish.test(f) && f !== front) ?? nonEmpty.find((f) => f !== front) ?? t.fields.find((f) => f !== front) ?? null;
      return { ...base, cardType: 'concept', front, back };
    }
    default:
      return { ...base, cardType: 'concept', front: first, back: nonEmpty.find((f) => f !== first) ?? null };
  }
}

export const defaultMappings = (summary: ApkgSummary): FieldMapping[] => summary.noteTypes.map(defaultMapping);

const selectedDecks = <D extends { name: string }>(decks: D[], selected: D[]): D[] =>
  decks.filter((d) => selected.some((s) => inSubtree(d.name, s.name)));

export const planImport: PlanImport = (summary, mappings, deckIds) => {
  if (deckIds.length === 0) return err('validation', 'Escolha ao menos um deck.');
  const decks: DeckInfo[] = summary.decks;
  const picked = [...new Set(deckIds)].map((id) => decks.find((d) => d.id === id));
  if (picked.some((d) => !d)) return err('validation', 'Deck desconhecido.');
  const seen = new Set<string>();
  for (const m of mappings) {
    const t = summary.noteTypes.find((x) => x.id === m.noteTypeId);
    if (!t) return err('validation', `Tipo de nota desconhecido: ${m.noteTypeId}.`);
    if (seen.has(m.noteTypeId)) return err('validation', `Mapeamento repetido para ${t.name}.`);
    seen.add(m.noteTypeId);
    if (m.cardType !== 'concept' && m.cardType !== 'image') return err('validation', `Tipo de card não suportado na importação: ${m.cardType}.`);
    for (const f of [m.front, m.back, m.title]) if (f !== null && !t.fields.includes(f)) return err('validation', `Campo "${f}" não existe em ${t.name}.`);
  }
  const full = [...mappings, ...defaultMappings(summary).filter((d) => !seen.has(d.noteTypeId))];
  const sel = selectedDecks(decks, picked as DeckInfo[]);
  const totalNotes = summary.noteTypes.reduce((n, t) => n + t.noteCount, 0);
  // noteCount is exact; without it (client stripped it) scale cards by notes/cards.
  const estimatedCards = sel.reduce((n, d) => n + (d.noteCount ?? Math.round((d.cardCount * totalNotes) / Math.max(1, summary.cardCount))), 0);
  return ok({ deckIds: [...new Set(deckIds)], mappings: full, estimatedCards });
};

// --- drafts ----------------------------------------------------------------
const clip = (s: string, max: number) => {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 20 ? cut.slice(0, sp) : cut).trimEnd()}…`;
};

/** File name -> readable title; null for hash-like names ("c0b4…jpeg", "630-1528466692706.png"). */
export function humanize(file: string | undefined): string | null {
  if (!file || file.length > 255) return null; // also keeps the hex-suffix regex below cheap
  const base = (file.split('/').pop() ?? file).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_ ]*[0-9a-f]{32,}$/i, '');
  const t = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^[0-9a-f]{16,}$/i.test(t.replaceAll(' ', '')) || !/[a-z]/i.test(t) || !t) return null;
  return clip(t.charAt(0).toUpperCase() + t.slice(1), 60);
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Anki note tags (hierarchical `a::b` kept) + the sub deck path as one tag, each cut to 64 chars, <= 50 (card contract). */
export function tagsOf(noteTags: string, deckName: string): string[] {
  const sub = deckName.split('::').slice(1).join(' › ');
  const all = [...noteTags.split(/\s+/), ...(sub ? [sub] : [])].map((t) => t.slice(0, 64)).filter(Boolean);
  const own = [...new Set(all)];
  return sub && own.length > 50 ? [...own.slice(0, 49), own.at(-1)!] : own.slice(0, 50);
}

function draftOf(note: Note, model: Model, m: FieldMapping, deckName: string, deckId: string, pkg: AnkiPackage): AnkiDraft {
  const raw = (f: string | null) => (f === null ? '' : (note.fields[model.fields.indexOf(f)] ?? ''));
  const resolve = (n: string) => (pkg.media.has(n) ? n : pkg.media.has(safeDecode(n)) ? safeDecode(n) : n);
  const srcs = (html: string) => [...new Set(imgSources(html).map(resolve))];
  const common = { ref: `anki-${note.id}`, tags: tagsOf(note.tags, deckName), source: `Anki · ${deckName.replaceAll('::', ' › ')}`.slice(0, 1000), deckId, deckName };
  const cap = (s: string) => (s ? s.slice(0, 5000) : null);
  const titleOf = (...candidates: string[]) => clip(candidates.find((c) => c.trim()) ?? '', 60) || humanize(srcs(frontHtml)[0]) || 'Card do Anki';
  const titleField = plain(raw(m.title));

  const frontHtml = raw(m.front);
  const backHtml = raw(m.back);
  const image = m.cardType === 'image' ? srcs(frontHtml)[0] : undefined;
  if (image !== undefined) {
    let masks = nativeMasks(model.fields.map((_, i) => note.fields[i] ?? '').join('\n'));
    if (masks.length === 0) {
      const readSvg = (n: string) => {
        const b = pkg.read(resolve(n));
        return b ? new TextDecoder().decode(b) : null;
      };
      // Question Mask: the asked shape is filled #ff7e7e (one mask per note); Original Mask: every shape
      for (const f of ['Question Mask', 'Original Mask']) {
        masks = fieldSvgMasks(raw(model.fields.find((x) => x.toLowerCase() === f.toLowerCase()) ?? null), readSvg, true);
        if (masks.length) break;
      }
    }
    const back = md(backHtml);
    const header = model.fields.filter((f) => /^(header|t[ií]tulo|title)$/i.test(f)).map((f) => plain(raw(f))).find(Boolean) ?? '';
    const title = clip(titleField || header, 60) || humanize(image) || `Oclusão de imagem · ${deckName.split('::').pop()}`;
    return { ...common, type: 'image', title, front: null, back: cap(back), payload: { media: image, masks }, media: [image], backMedia: null, empty: false };
  }

  const gap = (_a: string, h: string | undefined) => `[${h ? htmlToText(h) : '...'}]`;
  const cloze = model.kind === 'cloze';
  const front = cloze ? htmlToMd(mapCloze(frontHtml, gap)) : md(frontHtml);
  let back = cloze ? md(frontHtml) : md(backHtml);
  if (cloze) {
    const extra = md(backHtml);
    if (extra && m.back !== m.front) back = `${back}\n\n${extra}`;
  }
  const media = srcs(frontHtml);
  const plainFront = cloze ? plain(frontHtml) : plain(frontHtml).replaceAll('[...]', '');
  const title = titleOf(titleField, plainFront, plain(cloze ? frontHtml : backHtml));
  return { ...common, type: 'concept', title, front: cap(front), back: cap(back), payload: {}, media, backMedia: m.back === m.front ? null : (srcs(backHtml)[0] ?? null), empty: !front && !back && media.length === 0 };
}

/** Narrower than the contract's `ToDrafts` (returns AnkiDraft[]), still assignable to it. */
export const toDrafts = async (file: Uint8Array, plan: ImportPlan): Promise<Result<AnkiDraft[]>> => {
  const pkg = await openPackage(file);
  if (!pkg.ok) return pkg;
  try {
    const s = scan(pkg.data.db);
    if (!s.ok) return s;
    const { decks, models, notes } = s.data;
    const byId = new Map(decks.map((d) => [d.id, d]));
    const picked = plan.deckIds.map((id) => byId.get(id));
    if (picked.some((d) => !d)) return err('validation', 'Deck desconhecido.');
    const allowed = new Set(selectedDecks(decks, picked as typeof decks).map((d) => d.id));
    const mappings = new Map(plan.mappings.map((m) => [m.noteTypeId, m]));
    let defaults: Map<string, FieldMapping> | undefined;
    const mappingFor = (mid: string) =>
      mappings.get(mid) ?? (defaults ??= new Map(defaultMappings(summarize(s.data, pkg.data.media.size)).map((m) => [m.noteTypeId, m]))).get(mid);
    const modelById = new Map(models.map((m) => [m.id, m]));
    const rootIdByName = new Map(decks.map((d) => [d.name, d.id]));

    const out: Array<{ key: string; d: AnkiDraft }> = [];
    for (const n of notes) {
      const model = modelById.get(n.mid);
      const m = mappingFor(n.mid);
      const deck = byId.get(n.deckId)!;
      if (!model || !m || !allowed.has(n.deckId)) continue;
      const root = rootOf(deck.name);
      out.push({ key: deck.name, d: draftOf(n, model, m, deck.name, rootIdByName.get(root) ?? deck.id, pkg.data) });
    }
    // deck order (natural), then note order (stable sort keeps note id order)
    out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const drafts = out.map((x) => x.d);
    // P-057: several occlusion notes on one image share a title: number the repeats (text cards repeat legitimately)
    const perImage = new Map<string, { n: number; titles: Set<string> }>();
    for (const d of drafts) {
      const img = d.type === 'image' ? d.media[0] : undefined;
      if (img === undefined) continue;
      const g = perImage.get(img) ?? perImage.set(img, { n: 0, titles: new Set() }).get(img)!;
      g.n++;
      if (g.titles.has(d.title)) d.title = `${d.title.slice(0, 180)} · máscara ${g.n}`;
      g.titles.add(d.title);
    }
    return ok(drafts);
  } catch {
    return err('validation', 'A coleção do Anki está corrompida.');
  } finally {
    pkg.data.close();
  }
};

const _contract: ToDrafts = toDrafts; // compile-time check against @remoa/contracts
void _contract;
