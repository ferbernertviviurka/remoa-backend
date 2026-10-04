// Integration: needs local Supabase + Storage (see cards.test.ts). The parser is an injected mock; the real one is covered by packages/anki.
import { config } from 'dotenv';
import { inArray, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APKG_MAX_BYTES, err, ok, type ImportPlan } from '@remoa/contracts';
import { apkgSummaryFixture, planImport } from '@remoa/contracts/mocks';
import type { AnkiDraft, AnkiPort } from '../imports/imports';
import { fullPackage } from '../../../../packages/anki/test/fixtures';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)('/v1/imports/anki', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let st: typeof import('../storage/storage');
  let app: ReturnType<typeof import('../app').createApp>;
  let drafts: AnkiDraft[] = [];
  const media: Record<string, Uint8Array> = {};

  let gate: Promise<void> | null = null; // holds mock inspect open (semaphore test)
  let estimate: number | null = null; // overrides the mock planner's estimatedCards
  const mockAnki: AnkiPort = {
    planImport: (sm, m, ids) => { const r = planImport(sm, m, ids); return r.ok && estimate !== null ? ok({ ...r.data, estimatedCards: estimate }) : r; },
    inspect: async (f) => (gate && (await gate), f.byteLength === 0 ? err('validation', 'empty file') : ok(apkgSummaryFixture)),
    toDrafts: async () => ok(drafts),
    openPackage: async () => ok({ read: (n) => media[n] ?? null, close: () => undefined }),
    rootOf: (n) => n.split('::')[0]!,
  };
  const plan = (estimatedCards = 2): ImportPlan => ({ deckIds: ['1'], mappings: [], estimatedCards });
  const draft = (i: number, over: Partial<AnkiDraft> = {}): AnkiDraft =>
    ({ ref: `r${i}`, type: 'concept', title: `T${i}`, front: `<b>Frente ${i}</b>`, back: `Verso ${i}`, source: 'Anki', payload: {}, deckId: '1', deckName: 'Clínica Médica::Sepse', media: [], empty: false, ...over }) as AnkiDraft;

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const call = async (u: string | null, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/imports${path}`, {
      method,
      headers: { ...(u ? { authorization: `Bearer ${u}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string; message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const putPkg = async (u: string) => {
    const key = `imports/${u}/${uuid()}.apkg`;
    await st.putBytes(key, Buffer.from('fake'), 'application/octet-stream');
    return key;
  };
  const finish = async (u: string, importId: string) => {
    for (let i = 0; i < 100; i++) {
      const p = (await call(u, 'GET', `/${importId}`)).json.data;
      if (p.status === 'done' || p.status === 'failed') return p;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('import did not finish');
  };
  const runImport = async (u: string, key: string, p = plan()) => {
    const s = await call(u, 'POST', '/anki', { key, plan: p });
    expect(s.status).toBe(200);
    const progress = await finish(u, s.json.data.importId);
    return { importId: s.json.data.importId as string, progress, report: (await call(u, 'GET', `/${s.json.data.importId}/report`)).json.data };
  };
  const liveCards = (boardId: string) => dbm.db.execute<{ title: string; front_asset_id: string | null; payload: any; x: number; y: number }>(sql`select title, front_asset_id, payload, x, y from cards where board_id = ${boardId} and deleted_at is null and type <> 'note' order by "order"`); // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    st = await import('../storage/storage');
    await st.ensureBucket();
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null), anki: mockAnki });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('sign: needs auth, caps size, key under the user prefix', async () => {
    const u = await newUser();
    expect((await call(null, 'POST', '/anki/sign', { sizeBytes: 10 })).status).toBe(401);
    expect((await call(u, 'POST', '/anki/sign', { sizeBytes: APKG_MAX_BYTES + 1 })).status).toBe(422);
    const r = await call(u, 'POST', '/anki/sign', { sizeBytes: 1000 });
    expect(r.status).toBe(200);
    expect(r.json.data.key).toMatch(new RegExp(`^imports/${u}/[0-9a-f-]{36}\\.apkg$`));
    expect(r.json.data.url).toMatch(/^http/);
  });

  it('inspect: foreign prefix and missing object 404, parser error 422, happy path returns the summary', async () => {
    const [a, b] = [await newUser(), await newUser()];
    const theirs = await putPkg(b);
    expect((await call(a, 'POST', '/anki/inspect', { key: theirs })).status).toBe(404);
    expect((await call(a, 'POST', '/anki/inspect', { key: `imports/${a}/${uuid()}.apkg` })).status).toBe(404);
    const empty = `imports/${a}/${uuid()}.apkg`;
    await st.putBytes(empty, Buffer.alloc(0), 'application/octet-stream');
    expect((await call(a, 'POST', '/anki/inspect', { key: empty })).status).toBe(422);
    const ok = await call(a, 'POST', '/anki/inspect', { key: await putPkg(a) });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual(apkgSummaryFixture);
  });

  it('start: creates the board and cards, reports, and a re-import reuses the board and adds nothing (D-118)', async () => {
    const u = await newUser();
    const key = await putPkg(u);
    drafts = [draft(1), draft(2, { deckName: 'Clínica Médica::Choque' })];
    const first = await runImport(u, key);
    expect(first.progress).toMatchObject({ status: 'done', processed: 2, total: 2, error: null });
    expect(first.report).toMatchObject({ imported: 2, skippedDuplicate: 0, skippedEmpty: 0, missingMedia: 0 });
    expect(first.report.boardIds).toHaveLength(1);
    const board = await dbm.db.execute<{ title: string; area: string }>(sql`select title, area from boards where id = ${first.report.boardIds[0]}`);
    expect(board[0]).toMatchObject({ title: 'Clínica Médica', area: 'CM' });
    const cards = await liveCards(first.report.boardIds[0]);
    expect(cards).toHaveLength(2); // notes only; the 3 hubs are type 'note' (D-332)

    const again = await runImport(u, key);
    expect(again.report).toMatchObject({ imported: 0, skippedDuplicate: 2, boardIds: first.report.boardIds });
    expect(await liveCards(first.report.boardIds[0])).toHaveLength(2); // no new hubs when nothing was imported
  });

  it('skips empty drafts and in-import duplicates; counts missing media and keeps the card', async () => {
    const u = await newUser();
    media['ok.png'] = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#123' } }).png().toBuffer();
    drafts = [
      draft(1, { empty: true }),
      draft(2), draft(2, { ref: 'dup', title: 'other' }),
      draft(3, { media: ['gone.png'] }),
      draft(4, { media: ['ok.png'] }),
    ];
    const r = await runImport(u, await putPkg(u), plan(5));
    expect(r.report).toMatchObject({ imported: 3, skippedEmpty: 1, skippedDuplicate: 1, missingMedia: 1 });
    const cards = await liveCards(r.report.boardIds[0]);
    expect(cards.filter((c) => c.front_asset_id)).toHaveLength(1);
    const asset = await dbm.db.execute<{ license: string; mime: string }>(sql`select license, mime from assets where user_id = ${u}`);
    expect(asset).toHaveLength(1);
    expect(asset[0]).toMatchObject({ license: 'own', mime: 'image/webp' });
  });

  it('back image becomes back_asset_id (missing counted, card kept); tags are persisted, cut to 64 and capped at 50 (D-221)', async () => {
    const u = await newUser();
    media['back.png'] = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#456' } }).png().toBuffer();
    drafts = [
      draft(1, { backMedia: 'back.png', tags: ['a::b', 'x'.repeat(100)] }),
      draft(2, { backMedia: 'gone.png', tags: Array.from({ length: 60 }, (_, i) => `t${i}`) }),
      draft(3),
    ];
    const r = await runImport(u, await putPkg(u), plan(3));
    expect(r.report).toMatchObject({ imported: 3, missingMedia: 1 });
    const rows = await dbm.db.execute<{ title: string; back_asset_id: string | null; tags: string[] }>(
      sql`select c.title, c.back_asset_id, c.tags from cards c join boards b on b.id = c.board_id where b.user_id = ${u} and c.type <> 'note' order by c.title`);
    expect(rows[0]!.back_asset_id).not.toBeNull();
    expect(rows[0]!.tags).toEqual(['a::b', 'x'.repeat(64)]);
    expect(rows[1]).toMatchObject({ back_asset_id: null });
    expect(rows[1]!.tags).toHaveLength(50);
    expect(rows[2]).toMatchObject({ back_asset_id: null, tags: [] });
  });

  it('image occlusion: real PNG becomes an asset, payload and masks rows', async () => {
    const u = await newUser();
    media['io.png'] = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#cc3333' } }).png().toBuffer();
    const polygon = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }];
    drafts = [
      { ...draft(1), type: 'image', front: null, back: null, media: ['io.png'], payload: { media: 'io.png', masks: [{ polygon, label: 'Ventrículo' }] } } as AnkiDraft,
      { ...draft(2), type: 'image', front: null, back: null, media: ['nope.png'], payload: { media: 'nope.png', masks: [] } } as AnkiDraft,
    ];
    const r = await runImport(u, await putPkg(u));
    expect(r.report).toMatchObject({ imported: 1, missingMedia: 1 });
    const [card] = await liveCards(r.report.boardIds[0]);
    const [asset] = await dbm.db.execute<{ id: string }>(sql`select id from assets where user_id = ${u}`);
    expect(card!.payload.assetId).toBe(asset!.id);
    expect(card!.payload.masks).toHaveLength(1);
    const masks = await dbm.db.execute<{ label: string; asset_id: string }>(sql`select label, asset_id from masks m join cards c on c.id = m.card_id where c.board_id = ${r.report.boardIds[0]}`);
    expect(masks).toEqual([expect.objectContaining({ label: 'Ventrículo', asset_id: asset!.id })]);
  });

  it('quota: total cards cap and per-import cap return 402 "cards" before creating anything; boards cap too', async () => {
    const u = await newUser();
    drafts = [draft(1), draft(2)];
    const key = await putPkg(u);
    const b = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'Outro' }).returning({ id: dbm.boards.id });
    await dbm.db.insert(dbm.cards).values(Array.from({ length: 49 }, (_, i) => ({ boardId: b[0]!.id, title: `c${i}` })));
    const over = await call(u, 'POST', '/anki', { key, plan: plan(2) });
    expect(over.status).toBe(402);
    expect(over.json.error!.message).toBe('cards');
    estimate = 5001;
    expect((await call(u, 'POST', '/anki', { key, plan: plan(0) })).json.error!.message).toBe('cards');
    estimate = null;
    const rows = await dbm.db.execute(sql`select 1 from imports where user_id = ${u}`);
    expect(rows).toHaveLength(0);

    const v = await newUser();
    await dbm.db.insert(dbm.boards).values([{ userId: v, title: 'A' }, { userId: v, title: 'B' }]);
    const full = await call(v, 'POST', '/anki', { key: await putPkg(v), plan: plan(2) });
    expect(full.status).toBe(402);
    expect(full.json.error!.message).toBe('boards');
  });

  it('progress/report: other users get 404, report needs done, stalled running imports read as failed (D-115)', async () => {
    const [a, b] = [await newUser(), await newUser()];
    drafts = [draft(1)];
    const r = await runImport(a, await putPkg(a), plan(1));
    expect((await call(b, 'GET', `/${r.importId}`)).status).toBe(404);
    expect((await call(b, 'GET', `/${r.importId}/report`)).status).toBe(404);
    expect((await call(a, 'GET', '/not-a-uuid')).status).toBe(404);

    const [row] = await dbm.db.insert(dbm.imports).values({ userId: a, kind: 'anki', status: 'running', stats: { processed: 1, total: 5 } }).returning({ id: dbm.imports.id });
    expect((await call(a, 'GET', `/${row!.id}/report`)).status).toBe(404);
    expect((await call(a, 'GET', `/${row!.id}`)).json.data.status).toBe('running');
    await dbm.db.transaction(async (tx) => { // the set_updated_at trigger would reset the backdate
      await tx.execute(sql`alter table imports disable trigger set_updated_at`);
      await tx.execute(sql`update imports set updated_at = now() - interval '11 minutes' where id = ${row!.id}`);
      await tx.execute(sql`alter table imports enable trigger set_updated_at`);
    });
    expect((await call(a, 'GET', `/${row!.id}`)).json.data).toMatchObject({ status: 'failed', error: 'stalled', processed: 1, total: 5 });
  });

  it('QA: one live import per user (409); a queued import that never started reads as stalled', async () => {
    const u = await newUser();
    const [row] = await dbm.db.insert(dbm.imports).values({ userId: u, kind: 'anki', status: 'queued', stats: { processed: 0, total: 1 } }).returning({ id: dbm.imports.id });
    drafts = [draft(1)];
    const busy = await call(u, 'POST', '/anki', { key: await putPkg(u), plan: plan(1) });
    expect(busy.status).toBe(409);
    await dbm.db.transaction(async (tx) => {
      await tx.execute(sql`alter table imports disable trigger set_updated_at`);
      await tx.execute(sql`update imports set updated_at = now() - interval '11 minutes' where id = ${row!.id}`);
      await tx.execute(sql`alter table imports enable trigger set_updated_at`);
    });
    expect((await call(u, 'GET', `/${row!.id}`)).json.data).toMatchObject({ status: 'failed', error: 'stalled' });
    expect((await runImport(u, await putPkg(u), plan(1))).report).toMatchObject({ imported: 1 });
  });

  it('a parser failure inside the job marks the import failed', async () => {
    const u = await newUser();
    const orig = mockAnki.toDrafts;
    mockAnki.toDrafts = async () => err('validation', 'corrupt collection');
    const s = await call(u, 'POST', '/anki', { key: await putPkg(u), plan: plan(1) });
    const p = await finish(u, s.json.data.importId);
    mockAnki.toDrafts = orig;
    expect(p).toMatchObject({ status: 'failed', error: 'corrupt collection' });
  });
  it('image drafts with the same title on the same PNG but different masks are distinct; re-import skips them all', async () => {
    const u = await newUser();
    media['same.png'] = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#369' } }).png().toBuffer();
    const sq = (o: number) => [{ x: o, y: o }, { x: o + 0.2, y: o }, { x: o + 0.2, y: o + 0.2 }];
    drafts = [0.1, 0.4, 0.7].map((o, i) => ({ ...draft(i), title: 'Card do Anki', type: 'image', front: null, back: null, media: ['same.png'], payload: { media: 'same.png', masks: [{ polygon: sq(o), label: `m${i}` }] } }) as AnkiDraft);
    const key = await putPkg(u);
    const first = await runImport(u, key, plan(3));
    expect(first.report).toMatchObject({ imported: 3, skippedDuplicate: 0 });
    const again = await runImport(u, key, plan(3));
    expect(again.report).toMatchObject({ imported: 0, skippedDuplicate: 3 });
  });

  it('quota: fresh Free user with 0 cards and estimatedCards 308 -> 402 "cards", no imports row', async () => {
    const u = await newUser();
    drafts = [draft(1)];
    estimate = 308;
    const r = await call(u, 'POST', '/anki', { key: await putPkg(u), plan: plan(0) }); // client lies: estimatedCards 0
    estimate = null;
    expect(r.status).toBe(402);
    expect(r.json.error!.message).toBe('cards');
    expect(await dbm.db.execute(sql`select 1 from imports where user_id = ${u}`)).toHaveLength(0);
  });

  it('real parser (no override): fixture package -> cards, image-occlusion card with masks, assets', async () => {
    const u = await newUser();
    const { createApp } = await import('../app');
    const real = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
    const rc = async (method: string, path: string, body?: unknown) => {
      const res = await real.request(`/v1/imports${path}`, { method, headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as { data?: any; error?: { message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const key = `imports/${u}/${uuid()}.apkg`;
    await st.putBytes(key, Buffer.from(await fullPackage()), 'application/octet-stream');
    const summary = await rc('POST', '/anki/inspect', { key });
    expect(summary.status).toBe(200);
    const deckIds = summary.json.data.decks.filter((d: { name: string }) => d.name.startsWith('Med')).map((d: { id: string }) => d.id);
    const started = await rc('POST', '/anki', { key, plan: { deckIds, mappings: [], estimatedCards: summary.json.data.cardCount } });
    expect(started.status).toBe(200);
    const id = started.json.data.importId as string;
    let p;
    for (let i = 0; i < 100; i++) { p = (await rc('GET', `/${id}`)).json.data; if (['done', 'failed'].includes(p.status)) break; await new Promise((r) => setTimeout(r, 100)); }
    expect(p).toMatchObject({ status: 'done' });
    const rep = (await rc('GET', `/${id}/report`)).json.data;
    expect(rep.imported).toBeGreaterThan(0);
    const cards = await dbm.db.execute<{ type: string; n: number }>(sql`select c.type, count(*)::int as n from cards c join boards b on b.id = c.board_id where b.user_id = ${u} group by c.type`);
    expect(cards.find((c) => c.type === 'image')?.n).toBeGreaterThan(0);
    expect(cards.filter((c) => c.type !== 'note').reduce((n, c) => n + c.n, 0)).toBe(rep.imported); // notes = deck hubs
    const ed = await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from edges e join boards b on b.id = e.board_id where b.user_id = ${u}`);
    expect(ed[0]!.n).toBeGreaterThanOrEqual(rep.imported);
    expect(await dbm.db.execute(sql`select 1 from masks m join assets a on a.id = m.asset_id where a.user_id = ${u}`)).not.toHaveLength(0);
  });
  it('layout (D-332): one hub per deck + ancestors, hub -> note and parent -> sub deck edges, no note-to-note edge, no overlap', async () => {
    const u = await newUser();
    drafts = [...Array.from({ length: 30 }, (_, i) => draft(i)), draft(100, { deckName: 'Clínica Médica::Choque' }), draft(101, { deckName: 'Clínica Médica::Choque' })];
    const r = await runImport(u, await putPkg(u), plan(32));
    const board = r.report.boardIds[0];
    expect(r.report.imported).toBe(32);
    const cards = await dbm.db.execute<{ id: string; type: string; title: string; x: number; y: number }>(sql`select id, type, title, x, y from cards where board_id = ${board} and deleted_at is null`);
    const hubs = cards.filter((c) => c.type === 'note');
    expect(hubs.map((h) => h.title).sort()).toEqual(['Choque', 'Clínica Médica', 'Sepse']);
    const edges = await dbm.db.execute<{ from_card_id: string; to_card_id: string; label: string | null }>(sql`select from_card_id, to_card_id, label from edges where board_id = ${board}`);
    const hubIds = new Set(hubs.map((h) => h.id));
    expect(edges).toHaveLength(32 + 2); // every note + Clínica->Sepse + Clínica->Choque
    expect(edges.every((e) => hubIds.has(e.from_card_id) && e.label === null)).toBe(true);
    expect(new Set(edges.map((e) => e.to_card_id)).size).toBe(edges.length);
    const box = (c: { type: string; x: number; y: number }) => ({ x: c.x, y: c.y, w: c.type === 'note' ? 248 : 232, h: c.type === 'note' ? 176 : 150 });
    for (const [i, a] of cards.entries()) for (const b of cards.slice(i + 1)) {
      const [p, q] = [box(a), box(b)];
      expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, `${a.title} x ${b.title}`).toBe(false);
    }
    expect(cards.every((c) => c.x >= 0 && c.y >= 0)).toBe(true);
  });

  it('quota (D-335): hubs count against the Free cap of 50 cards', async () => {
    const u = await newUser();
    const b = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'Outro' }).returning({ id: dbm.boards.id });
    await dbm.db.insert(dbm.cards).values(Array.from({ length: 47 }, (_, i) => ({ boardId: b[0]!.id, title: `c${i}` })));
    drafts = [draft(1), draft(2)];
    const r = await call(u, 'POST', '/anki', { key: await putPkg(u), plan: plan(2) }); // 47 + 2 notes + 2 hubs (Clínica Médica, Sepse) = 51
    expect(r.status).toBe(402);
  });

  it('a failed image does not shadow a later identical card; non-parser errors are stored generic', async () => {
    const u = await newUser();
    const sq = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }];
    const img = (i: number) => ({ ...draft(i), type: 'image', front: null, back: null, media: ['late.png'], payload: { media: 'late.png', masks: [{ polygon: sq, label: 'a' }] } }) as AnkiDraft;
    drafts = [img(1), img(2)];
    const r = await runImport(u, await putPkg(u), plan(2));
    expect(r.report).toMatchObject({ imported: 0, skippedDuplicate: 0, missingMedia: 2 });

    const orig = mockAnki.toDrafts;
    mockAnki.toDrafts = async () => { throw new Error('boom: secret internals'); };
    const s = await call(u, 'POST', '/anki', { key: await putPkg(u), plan: plan(1) });
    const p = await finish(u, s.json.data.importId);
    mockAnki.toDrafts = orig;
    expect(p).toMatchObject({ status: 'failed', error: 'A importação falhou. Tente de novo mais tarde.' });
  });

  it('semaphore: a third concurrent inspect gets 429', async () => {
    const u = await newUser();
    const key = await putPkg(u);
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    const held = [call(u, 'POST', '/anki/inspect', { key }), call(u, 'POST', '/anki/inspect', { key })];
    await new Promise((r) => setTimeout(r, 50));
    const third = await call(u, 'POST', '/anki/inspect', { key });
    gate = null;
    open();
    expect(third.status).toBe(429);
    expect((await Promise.all(held)).map((h) => h.status)).toEqual([200, 200]);
    expect((await call(u, 'POST', '/anki/inspect', { key })).status).toBe(200);
  });

  // ─── F17 / T2: board input, one-map import, existing endpoint ──────────────

  const runImportWithBoard = async (u: string, key: string, board: Record<string, unknown>, p = plan()) => {
    const s = await call(u, 'POST', '/anki', { key, plan: p, board });
    expect(s.status, `start failed: ${JSON.stringify(s.json)}`).toBe(200);
    const progress = await finish(u, s.json.data.importId);
    return { importId: s.json.data.importId as string, progress, report: (await call(u, 'GET', `/${s.json.data.importId}/report`)).json.data };
  };

  it('F17: import with board generates ONE map with title, area, matrixItemIds and access (target new)', async () => {
    const u = await newUser();
    drafts = [draft(1, { deckName: 'CM::Sepse' }), draft(2, { deckName: 'CM::Choque' })];
    const { report } = await runImportWithBoard(u, await putPkg(u), { title: 'Meu Deck', area: 'CM', matrixItemIds: [], access: 'owner', target: 'new' }, plan(2));
    expect(report.boardIds).toHaveLength(1);
    const [board] = await dbm.db.execute<{ title: string; area: string }>(sql`select title, area from boards where id = ${report.boardIds[0]}`);
    expect(board).toMatchObject({ title: 'Meu Deck', area: 'CM' });
    const cards = await liveCards(report.boardIds[0]);
    expect(cards).toHaveLength(2);
    // two decks → two columns
    expect(new Set(cards.map((c) => `${c.x},${c.y}`)).size).toBe(2);
  });

  it('F17: deck with 2 roots → 1 board with columns from both roots (not 2 boards)', async () => {
    const u = await newUser();
    drafts = [
      draft(1, { deckName: 'Root A::Sub' }),
      draft(2, { deckName: 'Root B::Sub' }),
    ];
    const { report } = await runImportWithBoard(u, await putPkg(u), { title: 'Dois Roots', area: 'CM', matrixItemIds: [], access: 'owner', target: 'new' }, plan(2));
    expect(report.boardIds).toHaveLength(1);
    const boards = await dbm.db.execute<{ id: string }>(sql`select id from boards where user_id = ${u} and archived_at is null`);
    expect(boards).toHaveLength(1); // only one board was created
    const cards = await liveCards(report.boardIds[0]);
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => `${c.x},${c.y}`)).size).toBe(2); // each root in its own column
  });

  it('F17: target existing deduplicates (0 cards on re-import) and merges matrixItemIds', async () => {
    const u = await newUser();
    // Insert a real matrix item with a unique code to test merging
    const code = `T2-TST-${uuid().slice(0, 8)}`;
    const [item] = await dbm.db.execute<{ id: string }>(sql`insert into matrix_items (area, code, title) values ('CM', ${code}, 'T2 Test Item') returning id`);
    drafts = [draft(1), draft(2)];
    const key = await putPkg(u);
    // First import: create the board
    const first = await runImportWithBoard(u, key, { title: 'Mapa Existente', area: 'CM', matrixItemIds: [], access: 'owner', target: 'new' }, plan(2));
    expect(first.report.imported).toBe(2);
    const boardId = first.report.boardIds[0] as string;

    // Re-import into the existing board with a new matrix item
    const again = await runImportWithBoard(u, await putPkg(u), { title: 'Mapa Existente', area: 'CM', matrixItemIds: [item!.id], access: 'owner', target: { boardId } }, plan(2));
    expect(again.report.boardIds).toEqual([boardId]);
    expect(again.report.imported).toBe(0);
    expect(again.report.skippedDuplicate).toBe(2);
    // Matrix item merged
    const links = await dbm.db.execute<{ matrix_item_id: string }>(sql`select matrix_item_id from board_matrix_items where board_id = ${boardId}`);
    expect(links.map((l) => l.matrix_item_id)).toContain(item!.id);
    // Clear FK refs before cleanup (boards.matrix_item_id + board_matrix_items).
    await dbm.db.execute(sql`update boards set matrix_item_id = null where matrix_item_id = ${item!.id}`);
    await dbm.db.execute(sql`delete from board_matrix_items where matrix_item_id = ${item!.id}`);
    await dbm.db.execute(sql`delete from matrix_items where id = ${item!.id}`);
  });

  it('F17: target board of another user → 404', async () => {
    const [a, b] = [await newUser(), await newUser()];
    const [boardRow] = await dbm.db.insert(dbm.boards).values({ userId: a, title: 'A board' }).returning({ id: dbm.boards.id });
    drafts = [draft(1)];
    const r = await call(b, 'POST', '/anki', { key: await putPkg(b), plan: plan(1), board: { title: 'x', area: 'CM', matrixItemIds: [], access: 'owner', target: { boardId: boardRow!.id } } });
    expect(r.status).toBe(404);
  });

  it('F17: matrixItemIds from wrong area → 422 (fail before creating import)', async () => {
    const u = await newUser();
    const code = `T2-TST-${uuid().slice(0, 8)}`;
    const [item] = await dbm.db.execute<{ id: string }>(sql`insert into matrix_items (area, code, title) values ('CM', ${code}, 'T2 CM Item') returning id`);
    drafts = [draft(1)];
    // Try to use a CM item on a CIR board → 422
    const r = await call(u, 'POST', '/anki', {
      key: await putPkg(u),
      plan: plan(1),
      board: { title: 'Wrong Area', area: 'CIR', matrixItemIds: [item!.id], access: 'owner', target: 'new' },
    });
    expect(r.status).toBe(422);
    // No import record created
    expect(await dbm.db.execute(sql`select 1 from imports where user_id = ${u}`)).toHaveLength(0);
    // No board references the item (422 means no board was created); safe to delete directly.
    await dbm.db.execute(sql`delete from matrix_items where id = ${item!.id}`);
  });

  it('F17: name collision with target new → appends "(2)"', async () => {
    const u = await newUser();
    await dbm.db.insert(dbm.boards).values({ userId: u, title: 'Conflito' });
    drafts = [draft(1)];
    const { report } = await runImportWithBoard(u, await putPkg(u), { title: 'Conflito', area: 'CM', matrixItemIds: [], access: 'owner', target: 'new' }, plan(1));
    const [b] = await dbm.db.execute<{ title: string }>(sql`select title from boards where id = ${report.boardIds[0]}`);
    expect(b!.title).toBe('Conflito (2)');
  });

  it('F17: GET /anki/existing finds board ignoring case/accents, ignores archived', async () => {
    const u = await newUser();
    const [live] = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'Sépse e Choque Séptico' }).returning({ id: dbm.boards.id });
    await dbm.db.insert(dbm.boards).values({ userId: u, title: 'Arquivo', archivedAt: new Date() });

    // Different casing and accents
    const found = await call(u, 'GET', '/anki/existing?title=sepse%20e%20choque%20septico');
    expect(found.status).toBe(200);
    expect(found.json.data.board).toMatchObject({ id: live!.id, title: 'Sépse e Choque Séptico' });

    // Archived board is not found
    const notArchived = await call(u, 'GET', '/anki/existing?title=Arquivo');
    expect(notArchived.json.data.board).toBeNull();

    // Non-existent
    const none = await call(u, 'GET', '/anki/existing?title=Nada');
    expect(none.json.data.board).toBeNull();

    // Empty title → 422
    expect((await call(u, 'GET', '/anki/existing?title=')).status).toBe(422);
  });

  it('F17: without board field the old F06 flow continues (one board per root)', async () => {
    const u = await newUser();
    drafts = [draft(1, { deckName: 'Root A' }), draft(2, { deckName: 'Root B' })];
    const { report } = await runImport(u, await putPkg(u), plan(2));
    // Old behavior: one board per root deck
    expect(report.boardIds).toHaveLength(2);
    // Use drizzle's inArray to avoid SQL array cast issues
    const boards = await dbm.db.select({ title: dbm.boards.title }).from(dbm.boards)
      .where(inArray(dbm.boards.id, report.boardIds as string[]));
    expect(boards.map((b) => b.title).sort()).toEqual(['Root A', 'Root B']);
  });
});
