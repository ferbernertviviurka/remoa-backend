import { createHash } from 'node:crypto';
import { pick } from '../pick';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import {
  APKG_MAX_BYTES, PLAN_LIMITS, err, ok,
  normalizeBoardTitle,
  type ApkgSummary, type CardDraft, type FieldMapping, type GetImportProgress, type GetImportReport, type ImportPlan, type ImportProgress, type ImportReport,
  type InspectImport, type Result, type SignImportUpload, type StartImport, type FindExistingBoard, type StartImportInput,
} from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import { getBytes, headObject, presignPut, putBytes, putStream } from '../storage/storage';
import { limitFor, overAnkiImports, overTotal } from '../billing/quota';
import { planOf } from '../billing/plan';
import { asJob, dbm, run, uuids } from '../db';
import { initialShareColumns } from '../share/crypto';
import { notifyMapReady } from '../notifications/map-ready';
import { layoutImport } from './layout';
import { maybeQualifyReferral } from '../referral/qualify';
import { invalidate } from '../cache';

/** What T1's `@remoa/anki` produces for the job (`media[0]` = front image file name; image drafts carry `payload.media` + normalized masks). */
export type AnkiDraft = CardDraft & { deckId: string; deckName: string; media: string[]; backMedia?: string | null; tags?: string[]; empty: boolean };
export type AnkiPackage = { read(name: string): Uint8Array | null; sizeOf?(name: string): number | null; close(): void };
/** Injectable parser port: the real one is wired in app.ts, tests pass the contracts mock. */
export type AnkiPort = {
  inspect(file: Uint8Array): Promise<Result<ApkgSummary>>;
  planImport(summary: ApkgSummary, mappings: FieldMapping[], deckIds: string[]): Result<ImportPlan>;
  toDrafts(file: Uint8Array, plan: ImportPlan): Promise<Result<AnkiDraft[]>>;
  openPackage(file: Uint8Array): Promise<Result<AnkiPackage>>;
  rootOf(deckName: string): string;
};

/** Card contract (D-221): 1-64 chars each, at most 50; the parser already trims, this keeps a bad port from failing the CHECK. */
const cleanTags = (tags: string[] | undefined) => [...new Set((tags ?? []).map((t) => t.trim().slice(0, 64)).filter(Boolean))].slice(0, 50);

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const PIXEL_LIMIT = 50e6;
const BATCH = 200;
const STALLED_MS = 10 * 60_000;
const MERGE_GAP = 400; // importing into a board that already has cards: the new map starts this far right of the last one
const GENERIC_ERROR = 'A importação falhou. Tente de novo mais tarde.';
const MAX_PARSING = 2;
// ponytail: in-process semaphore until the Inngest worker (P-058)
let parsing = 0;
/** The parser message is meant for the student; anything else is logged, never shown. */
class ParserError extends Error {}
/** Default on-canvas size per card type (@remoa/ui nodeSize); a question image adds 90 px of height. The layout only needs it to avoid overlaps. */
const SIZE = { concept: [232, 150], case: [280, 216], flow: [248, 282], image: [248, 206] } as const;
const sizeOf = (d: AnkiDraft) => { const [w, h] = SIZE[d.type as keyof typeof SIZE] ?? SIZE.concept; return { w, h: h + (d.type !== 'image' && d.media[0] ? 90 : 0) }; };
/** Deck hubs in the quota check: every selected deck plus its ancestors (D-335: hubs are real cards and count). */
const hubCount = (names: string[]) => new Set(names.flatMap((n) => n.split('::').map((_, i, a) => a.slice(0, i + 1).join('::')))).size;
const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'svg'];

const plain = (s: string | null) =>
  (s ?? '').replace(/<[^<>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').toLowerCase().replace(/\s+/g, ' ').trim();
/** D-118 dedupe key. Cards without front/back text (image occlusion) fall back to the title. */
export const dedupeHash = (c: { title: string; front: string | null; back: string | null }) => {
  const f = plain(c.front), b = plain(c.back);
  return createHash('sha1').update(f || b ? `${f}\n${b}` : `t:${plain(c.title)}`).digest('hex');
};

/** Image drafts: the title is useless (many share it); key = media + mask geometry, stored in payload.importKey. */
export const imageKey = (media: string, masks: { polygon: { x: number; y: number }[] }[]) =>
  createHash('sha1').update(`img:${media}\n${JSON.stringify(masks.map((m) => m.polygon.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)])))}`).digest('hex');

/** Parsed board input from startImportInputSchema (output type, all defaults applied). */
type ImportBoardResolved = StartImportInput['board'];

/** Same pipeline as `completeUpload` (uploads.ts): WebP w800/w1600 under assets/<userId>/<assetId>/. null = not a usable image. */
async function createAssetFromBytes(userId: string, bytes: Uint8Array): Promise<string | null> {
  if (bytes.byteLength > MAX_MEDIA_BYTES) return null;
  const original = Buffer.from(bytes);
  const meta = await sharp(original, { limitInputPixels: PIXEL_LIMIT }).metadata().catch(() => null);
  if (!meta || !IMAGE_FORMATS.includes(meta.format ?? '')) return null;
  const assetId = crypto.randomUUID();
  const base = `assets/${userId}/${assetId}`;
  try {
    const out = await Promise.all(
      ([['w800', 800], ['w1600', 1600]] as const).map(async ([name, width]) => {
        const { data, info } = await sharp(original, { limitInputPixels: PIXEL_LIMIT })
          .rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer({ resolveWithObject: true });
        await putBytes(`${base}/${name}.webp`, data, 'image/webp');
        return info;
      }),
    );
    const big = out[1]!;
    await run(userId, (tx, s) => tx.insert(s.assets).values({ id: assetId, userId, key: base, mime: 'image/webp', width: big.width, height: big.height, license: 'own' }));
    return assetId;
  } catch {
    return null;
  }
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04: an .apkg is a zip
class UploadRejected extends Error {}
/** Request body as chunks: cuts at APKG_MAX_BYTES while streaming and refuses a non-zip on the first 4 bytes, before anything is stored. */
async function* apkgChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let size = 0, head: Buffer | null = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > APKG_MAX_BYTES) throw new UploadRejected('file_too_large');
      if (!head) { yield value; continue; }
      head = Buffer.concat([head, value]);
      if (head.length < ZIP_MAGIC.length) continue;
      if (!head.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) throw new UploadRejected('not_apkg');
      yield head;
      head = null;
    }
    if (head) throw new UploadRejected('not_apkg'); // empty or shorter than the magic
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

type Stats = Partial<ImportReport> & { processed?: number; total?: number };

export function createImports({ anki }: { anki: AnkiPort }) {
  const ownKey = (userId: string, key: string) => key.startsWith(`imports/${userId}/`) && !key.slice(`imports/${userId}/`.length).includes('/');

  /** Shared key checks for inspect/start; returns the package bytes. */
  const load = async (userId: string, key: string): Promise<Result<Buffer>> => {
    if (!ownKey(userId, key)) return err('not_found', 'import not found');
    const head = await headObject(key);
    if (!head) return err('not_found', 'import not found');
    if (head.size > APKG_MAX_BYTES) return err('validation', 'file too large');
    return ok(await getBytes(key));
  };

  const sign: SignImportUpload = async (userId, input) => {
    if (await overAnkiImports(userId)) return err('quota_exceeded', 'anki'); // D-648: before the upload, not after it
    const key = `imports/${userId}/${crypto.randomUUID()}.apkg`;
    return ok({ url: await presignPut(key, 'application/octet-stream', input.sizeBytes), key });
  };

  /** D-1443: the .apkg goes through the API (no browser PUT to the bucket, so no bucket CORS). Same key and quota check as `sign`.
   * `file_too_large` is answered 413 by the route. */
  const upload = async (userId: string, body: ReadableStream<Uint8Array> | null, declaredBytes: number | null): Promise<Result<{ key: string }>> => {
    if (declaredBytes !== null && declaredBytes > APKG_MAX_BYTES) return err('validation', 'file_too_large');
    if (!body) return err('validation', 'not_apkg');
    if (await overAnkiImports(userId)) return err('quota_exceeded', 'anki');
    const key = `imports/${userId}/${crypto.randomUUID()}.apkg`;
    try {
      await putStream(key, apkgChunks(body), 'application/octet-stream');
    } catch (e) {
      if (e instanceof UploadRejected) return err('validation', e.message);
      throw e;
    }
    return ok({ key });
  };

  /** Max 2 concurrent inspect/start across users: each holds a whole .apkg in memory and parses on the event loop. */
  const limited = async <T>(fn: () => Promise<Result<T>>): Promise<Result<T>> => {
    if (parsing >= MAX_PARSING) return err('rate_limited', 'Muitas importações ao mesmo tempo. Tente de novo em instantes.');
    parsing++;
    try {
      return await fn();
    } finally {
      parsing--;
    }
  };

  const inspectImport: InspectImport = (userId, { key }) =>
    limited(async () => {
      const f = await load(userId, key);
      return f.ok ? anki.inspect(f.data) : f;
    });

  const start: StartImport = (userId, input) => limited(() => startUnlimited(userId, input));
  const startUnlimited: StartImport = async (userId, { key, plan: clientPlan, board: boardInput }) => {
    const f = await load(userId, key);
    if (!f.ok) return f;
    const summary = await anki.inspect(f.data);
    if (!summary.ok) return summary;
    // The client's estimatedCards is display-only: quota uses the server-side plan.
    const planned = anki.planImport(summary.data, clientPlan.mappings, clientPlan.deckIds);
    if (!planned.ok) return planned;
    const plan = planned.data;
    const roots = [...new Set(summary.data.decks.filter((d) => plan.deckIds.includes(d.id)).map((d) => anki.rootOf(d.name)))];
    if (!roots.length) return err('validation', 'no deck selected');

    // one live import per user: each holds the whole .apkg (up to 250 MB) in memory
    const busy = await run(userId, (tx, s) =>
      tx.select({ id: s.imports.id }).from(s.imports)
        .where(and(eq(s.imports.userId, userId), inArray(s.imports.status, ['queued', 'running']), gt(s.imports.updatedAt, new Date(Date.now() - STALLED_MS)))).limit(1));
    if (busy.length) return err('conflict', 'Já existe uma importação em andamento. Espere terminar e tente de novo.');
    const { db } = await dbm();
    if (await overAnkiImports(userId)) return err('quota_exceeded', 'anki'); // D-648
    const maxCards = PLAN_LIMITS[(await planOf(userId)).plan].ankiImportMaxCards;
    if (maxCards !== null && plan.estimatedCards > maxCards) return err('quota_exceeded', 'cards');
    const hubs = hubCount(summary.data.decks.filter((d) => plan.deckIds.includes(d.id)).map((d) => d.name));
    if (await overTotal(db, userId, 'cards', await limitFor(userId, 'cards'), plan.estimatedCards + hubs)) return err('quota_exceeded', 'cards');

    // F17: board-level quota and pre-validation (fail fast before creating the import record).
    const itemIds = boardInput.matrixItemIds;
    if (boardInput.target === 'new') {
      // Always creates 1 new board.
      if (await overTotal(db, userId, 'boards', await limitFor(userId, 'boards'), 1)) return err('quota_exceeded', 'boards');
      // Validate matrixItemIds belong to the board's area (422 before the job starts).
      if (itemIds.length) {
        const m = await dbm();
        const valid = await m.db.select({ id: m.matrixItems.id }).from(m.matrixItems).where(
          and(sql`${m.matrixItems.id} = any(${uuids(itemIds)})`, eq(m.matrixItems.area, boardInput.area),
            sql`not exists (select 1 from matrix_items c where c.parent_id = ${m.matrixItems.id})`),
        );
        if (valid.length !== itemIds.length) return err('validation', 'matrixItemId is unknown, a group, or does not belong to the board area');
      }
    } else {
      // target = { boardId }: verify ownership and active status (D-291).
      const targetBoardId = (boardInput.target as { boardId: string }).boardId;
      const [existing] = await run(userId, (tx, s) =>
        tx.select({ id: s.boards.id, area: s.boards.area }).from(s.boards)
          .where(and(eq(s.boards.id, targetBoardId), eq(s.boards.userId, userId), isNull(s.boards.archivedAt))).limit(1));
      if (!existing) return err('not_found', 'board not found');
      // Validate new matrixItemIds against the existing board's area.
      if (itemIds.length) {
        const m = await dbm();
        const valid = await m.db.select({ id: m.matrixItems.id }).from(m.matrixItems).where(
          and(sql`${m.matrixItems.id} = any(${uuids(itemIds)})`, eq(m.matrixItems.area, existing.area),
            sql`not exists (select 1 from matrix_items c where c.parent_id = ${m.matrixItems.id})`),
        );
        if (valid.length !== itemIds.length) return err('validation', 'matrixItemId is unknown, a group, or does not belong to the board area');
      }
    }

    const importId = await run(userId, async (tx, s) =>
      (await tx.insert(s.imports).values({ userId, kind: 'anki', status: 'queued', stats: { processed: 0, total: plan.estimatedCards } }).returning({ id: s.imports.id }))[0]!.id);
    // ponytail: in-process job until Inngest (F05) lands; a restart leaves it 'running'
    setImmediate(() => {
      void asJob(() => job(userId, importId, f.data, plan, boardInput)).catch(async (e) => { // FR-25: background job, 30 s statements
        createLogger({ requestId: importId }).error('import failed', { error: e instanceof Error ? e.message : String(e) });
        const message = e instanceof ParserError ? e.message : GENERIC_ERROR;
        await run(userId, (tx, s) => tx.update(s.imports).set({ status: 'failed', error: message.slice(0, 500), updatedAt: new Date() }).where(eq(s.imports.id, importId))).catch(() => undefined);
      });
    });
    return ok({ importId });
  };

  const setStats = (userId: string, importId: string, stats: Stats, status?: 'running' | 'done') =>
    run(userId, (tx, s) => tx.update(s.imports).set({ stats, updatedAt: new Date(), ...(status ? { status } : {}) }).where(eq(s.imports.id, importId)));

  /** F17 FR-11: create the new board for an import (unique title with suffix, matrixItemIds, sharing). */
  async function resolveImportBoard(userId: string, boardInput: ImportBoardResolved): Promise<string> {
    if (boardInput.target === 'new') {
      return run(userId, async (tx, s) => {
        // Q-030: suffix " (2)", " (3)" … when a normalised title already exists among active boards.
        const liveTitles = (await tx.select({ title: s.boards.title }).from(s.boards)
          .where(and(eq(s.boards.userId, userId), isNull(s.boards.archivedAt)))).map((b) => b.title);
        const usedNorm = new Set(liveTitles.map(normalizeBoardTitle));
        let finalTitle = boardInput.title;
        for (let n = 2; usedNorm.has(normalizeBoardTitle(finalTitle)); n++) finalTitle = `${boardInput.title} (${n})`;

        const share = await initialShareColumns({ access: boardInput.access, password: boardInput.password });
        const itemIds = boardInput.matrixItemIds;
        const [b] = await tx.insert(s.boards).values({
          userId, title: finalTitle, area: boardInput.area, matrixItemId: itemIds[0] ?? null, ...share,
        }).returning({ id: s.boards.id });
        if (itemIds.length) await tx.insert(s.boardMatrixItems).values(itemIds.map((id) => ({ boardId: b!.id, matrixItemId: id })));
        return b!.id;
      });
    }
    // target = { boardId }: already verified in startUnlimited.
    return (boardInput.target as { boardId: string }).boardId;
  }

  /** F17 FR-11: add new matrix items to an existing board without duplicating already-linked ones. */
  async function mergeImportMatrixItems(userId: string, boardId: string, itemIds: string[]): Promise<void> {
    if (!itemIds.length) return;
    await run(userId, async (tx, s) => {
      await tx.insert(s.boardMatrixItems).values(itemIds.map((id) => ({ boardId, matrixItemId: id }))).onConflictDoNothing();
      const [b] = await tx.select({ matrixItemId: s.boards.matrixItemId }).from(s.boards).where(eq(s.boards.id, boardId));
      if (b && !b.matrixItemId) await tx.update(s.boards).set({ matrixItemId: itemIds[0]! }).where(eq(s.boards.id, boardId));
    });
  }

  async function job(userId: string, importId: string, file: Buffer, plan: ImportPlan, boardInput: ImportBoardResolved) {
    const log = createLogger({ requestId: importId });
    const t0 = Date.now();
    await setStats(userId, importId, { processed: 0, total: plan.estimatedCards }, 'running');
    const drafts = await anki.toDrafts(file, plan);
    if (!drafts.ok) throw new ParserError(drafts.error.message);
    const opened = await anki.openPackage(file);
    if (!opened.ok) throw new ParserError(opened.error.message);
    const pkg = opened.data;
    const total = drafts.data.length;
    const rep = { boardIds: [] as string[], imported: 0, skippedDuplicate: 0, skippedEmpty: 0, missingMedia: 0 };
    let processed = 0;
    const assets = new Map<string, string | null>(); // media name -> asset id
    const assetFor = async (name: string) => {
      if (assets.has(name)) return assets.get(name)!;
      const bytes = (pkg.sizeOf?.(name) ?? 0) > MAX_MEDIA_BYTES ? null : pkg.read(name); // don't inflate oversized media
      const id = bytes ? await createAssetFromBytes(userId, bytes) : null;
      assets.set(name, id);
      return id;
    };
    try {
      // F17: one board for ALL selected decks (the F06 one-board-per-root flow is gone, D-291).
      const boardToList: [string, AnkiDraft[]][] = [];
      const boardId = await resolveImportBoard(userId, boardInput);
      if (boardInput.target !== 'new') await mergeImportMatrixItems(userId, boardId, boardInput.matrixItemIds);
      boardToList.push([boardId, drafts.data]);

      for (const [board, list] of boardToList) {
        rep.boardIds.push(board);
        const cur = await run(userId, async (tx, s) =>
          tx.select({ title: s.cards.title, front: s.cards.front, back: s.cards.back, payload: s.cards.payload, x: s.cards.x, order: s.cards.order })
            .from(s.cards).where(and(eq(s.cards.boardId, board), isNull(s.cards.deletedAt))));
        const seen = new Set(cur.map((c) => (c.payload as { importKey?: string } | null)?.importKey ?? dedupeHash(c)));
        // phase 1: dedupe + assets -> pending cards (no position yet)
        type Pending = { row: typeof import('@remoa/db').cards.$inferInsert; masks: (typeof import('@remoa/db').masks.$inferInsert)[]; deck: string; w: number; h: number };
        const pending: Pending[] = [];
        for (let i = 0; i < list.length; i += BATCH) {
          for (const d of list.slice(i, i + BATCH)) {
            if (d.empty) { rep.skippedEmpty++; continue; }
            const h = d.type === 'image' ? imageKey(d.payload.media, d.payload.masks) : dedupeHash(d);
            if (seen.has(h)) { rep.skippedDuplicate++; continue; }
            const id = crypto.randomUUID();
            let frontAssetId: string | null = null;
            let backAssetId: string | null = null;
            let payload: unknown = d.payload;
            let masks: Pending['masks'] = [];
            if (d.type === 'image') {
              const assetId = await assetFor(d.payload.media);
              if (!assetId) { rep.missingMedia++; continue; } // an image card without its image is useless
              const ms = d.payload.masks.filter((m) => m.polygon.length >= 3).map((m, k) => ({ id: crypto.randomUUID(), polygon: m.polygon, label: m.label?.trim() || String(k + 1) }));
              payload = { assetId, masks: ms, importKey: h };
              masks = ms.map((m) => ({ cardId: id, assetId, polygon: m.polygon, label: m.label }));
            } else if (d.media[0]) {
              frontAssetId = await assetFor(d.media[0]);
              if (!frontAssetId) rep.missingMedia++; // card kept without its image
            }
            if (d.type !== 'image' && d.backMedia) {
              backAssetId = await assetFor(d.backMedia);
              if (!backAssetId) rep.missingMedia++;
            }
            seen.add(h); // only once the card will really be inserted (a failed image must not shadow a later identical card)
            pending.push({
              row: { id, boardId: board, type: d.type, title: d.title, front: d.front, back: d.back, source: d.source, frontAssetId, backAssetId, tags: cleanTags(d.tags), payload },
              masks, deck: d.deckName, ...sizeOf(d),
            });
          }
          processed += Math.min(BATCH, list.length - i);
          await setStats(userId, importId, { processed, total });
        }
        if (!pending.length) continue;

        // phase 2 (D-332): one hub per deck + radial layout, then insert hubs and cards in batches
        const lay = layoutImport(pending.map((p) => ({ id: p.row.id!, deck: p.deck, w: p.w, h: p.h })));
        const x0 = cur.length ? cur.reduce((m, c) => Math.max(m, c.x), 0) + MERGE_GAP : 0;
        let order = cur.reduce((m, c) => Math.max(m, c.order + 1), 0);
        const hubRows = lay.hubs.map((h) => ({ id: h.id, boardId: board, type: 'note' as const, title: h.title, source: 'Anki', payload: {}, x: x0 + h.x, y: h.y, order: order++ }));
        const rows = pending.map((p) => {
          const pos = lay.positions.get(p.row.id!)!;
          return { ...p, row: { ...p.row, x: x0 + pos.x, y: pos.y, order: order++ } };
        });
        await run(userId, async (tx, s) => {
          await tx.insert(s.cards).values(hubRows);
          for (let i = 0; i < rows.length; i += BATCH) {
            const part = rows.slice(i, i + BATCH);
            await tx.insert(s.cards).values(part.map((p) => p.row));
            const ms = part.flatMap((p) => p.masks);
            if (ms.length) await tx.insert(s.masks).values(ms);
          }
          for (let i = 0; i < lay.edges.length; i += 1000) await tx.insert(s.edges).values(lay.edges.slice(i, i + 1000).map((e) => ({ boardId: board, fromCardId: e.from, toCardId: e.to, label: null })));
        });
        rep.imported += rows.length;
      }
    } finally {
      pkg.close();
      // after the batches' COMMITs, also when the job failed halfway (the rows already inserted stay)
      for (const mapId of rep.boardIds) await invalidate('map.changed', { userId, mapId });
    }
    const report = { ...rep, durationMs: Date.now() - t0 };
    await setStats(userId, importId, { ...report, processed: total, total }, 'done');
    if (rep.imported) await maybeQualifyReferral(userId); // F18 (D-384); never throws
    for (const boardId of rep.imported ? rep.boardIds : []) await notifyMapReady({ userId, boardId, origin: 'anki', tookMs: Date.now() - t0 }); // G18; never throws
    log.info('import done', report);
  }

  const read = (userId: string, importId: string) =>
    run(userId, async (tx, s) => {
      if (!/^[0-9a-f-]{36}$/i.test(importId)) return null;
      return (await tx.select(pick(s.imports, 'status', 'stats', 'updatedAt', 'error')).from(s.imports).where(and(eq(s.imports.id, importId), eq(s.imports.userId, userId), eq(s.imports.kind, 'anki'))))[0] ?? null;
    });

  const progress: GetImportProgress = async (userId, importId) => {
    const r = await read(userId, importId);
    if (!r) return err('not_found', 'import not found');
    const st = (r.stats ?? {}) as Stats;
    const stalled = (r.status === 'running' || r.status === 'queued') && Date.now() - r.updatedAt.getTime() > STALLED_MS; // D-115
    return ok({
      importId, status: stalled ? 'failed' : r.status, processed: st.processed ?? 0, total: st.total ?? 0,
      error: stalled ? 'stalled' : r.error,
    } satisfies ImportProgress);
  };

  const report: GetImportReport = async (userId, importId) => {
    const r = await read(userId, importId);
    if (!r || r.status !== 'done') return err('not_found', 'report not found');
    const st = r.stats as Stats;
    return ok({
      importId, boardIds: st.boardIds ?? [], imported: st.imported ?? 0, skippedDuplicate: st.skippedDuplicate ?? 0,
      skippedEmpty: st.skippedEmpty ?? 0, missingMedia: st.missingMedia ?? 0, durationMs: st.durationMs ?? 0,
    } satisfies ImportReport);
  };

  /** F17 FR-11: GET /v1/imports/anki/existing?title= — own active board whose normalised title matches. */
  const findExistingBoard: FindExistingBoard = async (userId, title) => {
    const normalized = normalizeBoardTitle(title);
    return ok(
      await run(userId, async (tx, s) => {
        const rows = await tx
          .select({ id: s.boards.id, title: s.boards.title })
          .from(s.boards)
          .where(and(eq(s.boards.userId, userId), isNull(s.boards.archivedAt)));
        const match = rows.find((r) => normalizeBoardTitle(r.title) === normalized);
        return { board: match ? { id: match.id, title: match.title } : null };
      }),
    );
  };

  return { sign, upload, inspectImport, start, progress, report, findExistingBoard };
}
export type Imports = ReturnType<typeof createImports>;
