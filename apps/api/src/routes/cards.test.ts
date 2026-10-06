// Integration: needs local Supabase + Storage (`pnpm db:up && pnpm db:migrate`, .env at repo root with DATABASE_URL and S3_*); skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_MAX_BYTES, type BoardGraph, type MapOp } from '@remoa/contracts';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)('cards, uploads, assets', () => {
  const a = uuid();
  const b = uuid();
  const tokens: Record<string, string> = { ta: a, tb: b };
  let dbm: typeof import('@remoa/db');
  let st: typeof import('../storage/storage');
  let app: ReturnType<typeof import('../app').createApp>;

  type J = { ok?: true; data?: any; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = async (t: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as J };
  };
  const newBoard = async (t = 'ta') => (await call(t, 'POST', '/v1/boards', { title: 'Mapa' })).json.data.id as string;
  const newCard = async (boardId: string, type: 'concept' | 'flow' | 'image' | 'case' | 'note' = 'concept', t = 'ta') => {
    const id = uuid();
    const op: MapOp = { op: 'createCard', opId: uuid(), boardId, card: { id, type, title: 'Novo', position: { x: 0, y: 0 } } };
    await call(t, 'POST', '/v1/boards/ops', { ops: [op] });
    return id;
  };
  const put = (t: string, id: string, body: unknown) => call(t, 'PUT', `/v1/cards/${id}`, body);
  const base = { title: 'Título', front: 'f', back: '**b**', source: 'Harrison' };

  /** Photo-like: gradient + noise, 5-10 MB JPEG at 3600x2400. */
  const bigJpeg = async () => {
    const [w, h] = [3600, 2400];
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const n = (Math.random() - 0.5) * 24;
        raw[i] = (x / w) * 255 + n;
        raw[i + 1] = (y / h) * 255 + n;
        raw[i + 2] = 128 + 60 * Math.sin(x / 200) * Math.cos(y / 150) + n;
      }
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer();
  };
  const tinyPng = (w = 40, h = 20) => sharp({ create: { width: w, height: h, channels: 3, background: '#c33' } }).png().toBuffer();

  async function upload(t: string, bytes: Buffer, mime = 'image/png') {
    const sign = await call(t, 'POST', '/v1/uploads/sign', { mime, sizeBytes: bytes.length });
    expect(sign.status).toBe(200);
    const { url, key } = sign.json.data as { url: string; key: string };
    const put = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': mime } });
    expect(put.status).toBe(200);
    return key;
  }
  /** D-1202: multipart POST like the web app (no content-type header: fetch sets the boundary). */
  const direct = async (t: string | null, bytes: Buffer | null, fields: Record<string, string> = {}, path = '/v1/uploads/direct') => {
    const form = new FormData();
    if (bytes) form.append('file', new Blob([new Uint8Array(bytes)]), 'x.png');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await app.request(path, { method: 'POST', headers: t ? { authorization: `Bearer ${t}` } : {}, body: form });
    return { status: res.status, json: (await res.json()) as J };
  };
  /** 105 MP solid PNG (~300 KB on disk) above PIXEL_LIMIT (100 MP). */
  const pixelBomb = () => sharp({ create: { width: 10500, height: 10000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
  const mkAsset = async (t = 'ta') => {
    const key = await upload(t, await tinyPng());
    const done = await call(t, 'POST', '/v1/uploads/complete', { key });
    expect(done.status).toBe(201);
    return done.json.data.id as string;
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    st = await import('../storage/storage');
    await st.ensureBucket();
    await st.ensureBucket(); // idempotent
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => tokens[t] ?? null });
    for (const id of [a, b]) {
      await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
      await dbm.db.insert(dbm.subscriptions).values({ userId: id, plan: 'pro', status: 'active' }); // F08: these tests are not about plan limits
    }
  }, 30_000);
  afterAll(async () => {
    // account deletion must cascade through assets → masks (migration 0004)
    if (dbm) await dbm.db.execute(sql.raw(`delete from auth.users where id in ('${a}', '${b}')`));
  });

  it('requires auth', async () => {
    const res = await app.request(`/v1/cards/${uuid()}`);
    expect(res.status).toBe(401);
  });

  it('bucket is private', async () => {
    const rows = await dbm.db.execute<{ public: boolean }>(sql`select public from storage.buckets where id = ${process.env.S3_BUCKET}`);
    expect(rows[0]?.public).toBe(false);
  });

  it('upload: sign, PUT, complete -> 2 WebP variants, asset row, original gone; 8MB-class photo < 400 KB', async () => {
    const bytes = await bigJpeg();
    expect(bytes.length).toBeGreaterThan(5 * 1024 * 1024);
    expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
    const key = await upload('ta', bytes, 'image/jpeg');
    expect(key).toMatch(new RegExp(`^uploads/${a}/[0-9a-f-]{36}\\.jpg$`));
    const done = await call('ta', 'POST', '/v1/uploads/complete', { key, license: 'own' });
    expect(done.status).toBe(201);
    const asset = done.json.data;
    expect(asset).toMatchObject({ mime: 'image/webp', width: 1600, height: 1067, license: 'own', attribution: null });
    expect(asset.key).toBe(`assets/${a}/${asset.id}`);

    const w1600 = await st.getBytes(`${asset.key}/w1600.webp`);
    const w800 = await st.getBytes(`${asset.key}/w800.webp`);
    expect(w1600.length).toBeLessThan(400 * 1024);
    expect((await sharp(w1600).metadata()).format).toBe('webp');
    expect((await sharp(w800).metadata()).width).toBe(800);
    expect(await st.headObject(key)).toBeNull();
    const rows = await dbm.db.execute<{ n: number }>(sql`select count(*)::int n from assets where id = ${asset.id}`);
    expect(rows[0]?.n).toBe(1);
    // completing again: the original is gone
    expect((await call('ta', 'POST', '/v1/uploads/complete', { key })).status).toBe(404);
  }, 60_000);

  it('small images are not upscaled; EXIF rotation is applied', async () => {
    const jpeg = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#33c' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const done = await call('ta', 'POST', '/v1/uploads/complete', { key: await upload('ta', jpeg, 'image/jpeg') });
    expect(done.json.data).toMatchObject({ width: 100, height: 200 });
  });

  it('upload validation: bad body, foreign key, nested key, wrong type', async () => {
    expect((await call('ta', 'POST', '/v1/uploads/sign', { mime: 'image/gif', sizeBytes: 10 })).status).toBe(422);
    expect((await call('ta', 'POST', '/v1/uploads/sign', { mime: 'image/png', sizeBytes: IMAGE_MAX_BYTES + 1 })).status).toBe(422);
    const key = await upload('ta', await tinyPng());
    const stolen = await call('tb', 'POST', '/v1/uploads/complete', { key });
    expect(stolen.status).toBe(403);
    expect(await st.headObject(key)).not.toBeNull(); // untouched
    expect((await call('ta', 'POST', '/v1/uploads/complete', { key: `uploads/${a}/x/../y.png` })).status).toBe(403);
    expect((await call('ta', 'POST', '/v1/uploads/complete', { key: `uploads/${a}/${uuid()}.png` })).status).toBe(404);
    // not an image, declared png
    const junk = await upload('ta', Buffer.from('not an image at all'), 'image/png');
    const bad = await call('ta', 'POST', '/v1/uploads/complete', { key: junk });
    expect(bad.status).toBe(422);
    expect(await st.headObject(junk)).toBeNull();
    // fine ones still complete
    expect((await call('ta', 'POST', '/v1/uploads/complete', { key })).status).toBe(201);
  });

  it('upload hardening: size bound to signature, sniffed format, pixel bomb', async () => {
    const sign = await call('ta', 'POST', '/v1/uploads/sign', { mime: 'image/png', sizeBytes: 100 });
    const over = await fetch(sign.json.data.url, { method: 'PUT', body: new Uint8Array(5000), headers: { 'content-type': 'image/png' } });
    expect(over.status).toBeGreaterThanOrEqual(400); // Content-Length is signed
    // SVG / HTML bytes declared as png
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const k1 = await upload('ta', svg, 'image/png');
    expect((await call('ta', 'POST', '/v1/uploads/complete', { key: k1 })).status).toBe(422);
    expect(await st.headObject(k1)).toBeNull();
    const bomb = await pixelBomb();
    const k2 = await upload('ta', bomb, 'image/png');
    expect((await call('ta', 'POST', '/v1/uploads/complete', { key: k2 })).status).toBe(422);
    expect(await st.headObject(k2)).toBeNull();
  }, 60_000);

  it('D-1202 direct: multipart -> 2 WebP variants without EXIF, asset row; same rejections as the signed flow', async () => {
    const jpeg = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#33c' } })
      .jpeg().withMetadata({ orientation: 6 }).withExif({ IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '23/1 32/1 0/1' } }).toBuffer();
    const done = await direct('ta', jpeg, { license: 'cc_by', attribution: 'Autor' });
    expect(done.status).toBe(201);
    const asset = done.json.data;
    expect(asset).toMatchObject({ mime: 'image/webp', width: 1200, height: 2400, license: 'cc_by', attribution: 'Autor' });
    expect(asset.key).toBe(`assets/${a}/${asset.id}`);
    const w1600 = await sharp(await st.getBytes(`${asset.key}/w1600.webp`)).metadata();
    expect([w1600.format, w1600.exif]).toEqual(['webp', undefined]);
    expect((await sharp(await st.getBytes(`${asset.key}/w800.webp`)).metadata()).width).toBe(800);
    expect((await call('ta', 'GET', `/v1/assets/${asset.id}`)).status).toBe(200);
    expect((await call('tb', 'GET', `/v1/assets/${asset.id}`)).status).toBe(404); // owner only

    const before = await dbm.db.execute<{ n: number }>(sql`select count(*)::int n from assets where user_id = ${a}`);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    expect((await direct('ta', svg)).status).toBe(422);
    expect((await direct('ta', Buffer.from('not an image at all'))).status).toBe(422);
    expect((await direct('ta', await pixelBomb())).status).toBe(422);
    expect((await direct('ta', null)).status).toBe(422);
    expect((await direct('ta', await tinyPng(), { license: 'stolen' })).status).toBe(422);
    const after = await dbm.db.execute<{ n: number }>(sql`select count(*)::int n from assets where user_id = ${a}`);
    expect(after[0]?.n).toBe(before[0]?.n); // nothing saved on rejection
    expect((await direct(null, await tinyPng())).status).toBe(401);
    const huge = await app.request('/v1/uploads/direct', {
      method: 'POST',
      headers: { authorization: 'Bearer ta', 'content-length': String(IMAGE_MAX_BYTES + 1024 * 1024) },
      body: 'x',
    });
    expect(huge.status).toBe(413);
  }, 60_000);

  it('GET asset: own urls fetch as image/webp; other user 404; visible via seed_approved card', async () => {
    const id = await mkAsset('ta');
    const got = await call('ta', 'GET', `/v1/assets/${id}`);
    expect(got.status).toBe(200);
    for (const u of [got.json.data.urls.w800, got.json.data.urls.w1600]) {
      const r = await fetch(u);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/webp');
    }
    expect((await call('tb', 'GET', `/v1/assets/${id}`)).status).toBe(404);
    expect((await call('ta', 'GET', `/v1/assets/not-a-uuid`)).status).toBe(404);
    expect((await call('ta', 'GET', `/v1/assets/${uuid()}`)).status).toBe(404);

    const board = await newBoard('ta');
    const card = await newCard(board, 'image');
    expect((await put('ta', card, { ...base, type: 'image', payload: { assetId: id, masks: [] } })).status).toBe(200);
    expect((await call('tb', 'GET', `/v1/assets/${id}`)).status).toBe(404); // private board
    await dbm.db.execute(sql`update boards set status = 'seed_approved' where id = ${board}`);
    expect((await call('tb', 'GET', `/v1/assets/${id}`)).status).toBe(200);
    // seed content readable but not writable by B
    expect((await call('tb', 'GET', `/v1/cards/${card}`)).status).toBe(200);
    expect((await put('tb', card, { ...base, type: 'image', payload: { assetId: id, masks: [] } })).status).toBe(404);
  });

  it('PUT/GET card for the 4 types; status/reviewer/position ignored; B gets 404', async () => {
    const board = await newBoard();
    const c = await newCard(board);
    const asset = await mkAsset();
    const step = (id: string, text: string) => ({ id, text });
    const bodies = [
      { ...base, type: 'concept', payload: {} },
      { ...base, type: 'flow', payload: { steps: [step('s1', 'um'), step('s2', 'dois')] } },
      { ...base, type: 'case', payload: { caseSteps: [{ stage: 'presentation', text: 'Dor torácica' }, { stage: 'workup', text: 'ECG' }] } },
      { ...base, type: 'image', payload: { assetId: asset, masks: [{ id: uuid(), polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], label: 'A' }] } },
    ];
    for (const body of bodies) {
      const r = await put('ta', c, { ...body, status: 'approved', reviewerId: a, position: { x: 99, y: 99 } });
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ id: c, type: body.type, title: 'Título', back: '**b**', source: 'Harrison', status: 'draft', reviewerId: null, position: { x: 0, y: 0 } });
      expect(r.json.data.payload).toEqual(body.payload);
      expect((await call('ta', 'GET', `/v1/cards/${c}`)).json.data.payload).toEqual(body.payload);
      expect((await put('tb', c, body)).status).toBe(404);
      expect((await call('tb', 'GET', `/v1/cards/${c}`)).status).toBe(404);
    }
    expect((await call('ta', 'GET', '/v1/cards/nope')).status).toBe(404);
    expect((await put('ta', 'nope', bodies[0])).status).toBe(404);
  });

  it('invalid payload per type -> 422 and nothing saved', async () => {
    const board = await newBoard();
    const c = await newCard(board);
    const bad = [
      { ...base, type: 'concept', payload: { x: 1 } },
      { ...base, type: 'flow', payload: { steps: [{ id: 's1', text: 'só um' }] } },
      { ...base, type: 'flow', payload: { steps: [{ id: 's', text: 'a' }, { id: 's', text: 'b' }] } },
      { ...base, type: 'case', payload: { caseSteps: [{ stage: 'nope', text: 'x' }] } },
      { ...base, type: 'image', payload: { assetId: 'x', masks: [] } },
      { ...base, title: '   ', type: 'concept', payload: {} },
    ];
    for (const body of bad) expect((await put('ta', c, body)).status).toBe(422);
    expect((await call('ta', 'PUT', `/v1/cards/${c}`, undefined)).status).toBe(422);
    expect((await call('ta', 'GET', `/v1/cards/${c}`)).json.data.title).toBe('Novo');
  });

  it('image: foreign/missing asset -> 422; non-uuid mask id -> 422; masks mirrored', async () => {
    const board = await newBoard();
    const c = await newCard(board, 'image');
    const mine = await mkAsset('ta');
    const theirs = await mkAsset('tb');
    const poly = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }];
    const mask = (label: string, id = uuid()) => ({ id, polygon: poly, label });
    const img = (assetId: string, masks: unknown[]) => ({ ...base, type: 'image', payload: { assetId, masks } });
    const count = async () => (await dbm.db.execute<{ n: number }>(sql`select count(*)::int n from masks where card_id = ${c}`))[0]!.n;

    expect((await put('ta', c, img(theirs, []))).status).toBe(422);
    expect((await put('ta', c, img(uuid(), []))).status).toBe(422);
    expect((await put('ta', c, img(mine, [mask('x', 'not-a-uuid' as never)]))).status).toBe(422);
    expect(await count()).toBe(0);

    const [m1, m2, m3] = [mask('um'), mask('dois'), mask('três')];
    expect((await put('ta', c, img(mine, [m1, m2, m3]))).status).toBe(200);
    expect(await count()).toBe(3);
    // edit one label, drop two
    expect((await put('ta', c, img(mine, [{ ...m2, label: 'dois!' }]))).status).toBe(200);
    expect(await count()).toBe(1);
    const row = (await dbm.db.execute<{ id: string; label: string; asset_id: string }>(sql`select id, label, asset_id from masks where card_id = ${c}`))[0]!;
    expect(row).toMatchObject({ id: m2.id, label: 'dois!', asset_id: mine });
    // switching away from image clears masks
    expect((await put('ta', c, { ...base, type: 'concept', payload: {} })).status).toBe(200);
    expect(await count()).toBe(0);
  });

  it('board GET carries previews; duplicate re-creates masks with fresh ids', async () => {
    const board = await newBoard();
    const [cf, cc, ci, cn] = [await newCard(board, 'flow'), await newCard(board, 'case'), await newCard(board, 'image'), await newCard(board)];
    const asset = await mkAsset();
    const m = { id: uuid(), polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], label: 'A' };
    await put('ta', cf, { ...base, type: 'flow', payload: { steps: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }, { id: 'c', text: 'c' }] } });
    await put('ta', cc, { ...base, type: 'case', payload: { caseSteps: [{ stage: 'presentation', text: 'x' }, { stage: 'management', text: 'y' }] } });
    await put('ta', ci, { ...base, type: 'image', payload: { assetId: asset, masks: [m] } });
    const g = (await call('ta', 'GET', `/v1/boards/${board}`)).json.data as BoardGraph;
    const by = (id: string) => g.cards.find((c) => c.id === id)!;
    expect(by(cf).preview).toEqual({ steps: 3 });
    expect(by(cc).preview).toEqual({ stages: ['presentation', 'management'] });
    expect(by(ci).preview).toEqual({ masks: 1, assetId: asset });
    expect(by(cn).preview).toBeUndefined();
    expect(by(ci)).not.toHaveProperty('payload');

    const dup = await call('ta', 'POST', `/v1/boards/${board}/duplicate`, { title: 'Cópia' });
    expect(dup.status).toBe(201);
    const g2 = (await call('ta', 'GET', `/v1/boards/${dup.json.data.id}`)).json.data as BoardGraph;
    const img = g2.cards.find((c) => c.type === 'image')!;
    expect(img.preview).toEqual({ masks: 1, assetId: asset });
    const copy = (await call('ta', 'GET', `/v1/cards/${img.id}`)).json.data;
    expect(copy.payload.masks[0].id).not.toBe(m.id);
    const rows = await dbm.db.execute<{ id: string }>(sql`select id from masks where card_id = ${img.id}`);
    expect(rows.map((r) => r.id)).toEqual([copy.payload.masks[0].id]);
  });

  it('reusing a mask id owned by another card -> 422, card unchanged', async () => {
    const board = await newBoard();
    const [c1, c2] = [await newCard(board, 'image'), await newCard(board, 'image')];
    const asset = await mkAsset();
    const m = { id: uuid(), polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], label: 'A' };
    expect((await put('ta', c1, { ...base, type: 'image', payload: { assetId: asset, masks: [m] } })).status).toBe(200);
    expect((await put('ta', c2, { ...base, title: 'novo', type: 'image', payload: { assetId: asset, masks: [m] } })).status).toBe(422);
    expect((await call('ta', 'GET', `/v1/cards/${c2}`)).json.data.title).not.toBe('novo');
  });
  it('D-095/D-096: shape and frontAssetId default, persist, validate, copy, and gate the asset', async () => {
    const board = await newBoard();
    const c = await newCard(board);
    const got = (t: string, id: string) => call(t, 'GET', `/v1/cards/${id}`);
    expect((await got('ta', c)).json.data).toMatchObject({ shape: 'rect', frontAssetId: null });
    const graph = async () => (await call('ta', 'GET', `/v1/boards/${board}`)).json.data as BoardGraph;
    expect((await graph()).cards[0]).toMatchObject({ shape: 'rect', frontAssetId: null });

    const asset = await mkAsset('ta');
    const body = { ...base, type: 'concept', payload: {}, shape: 'hexagon', frontAssetId: asset };
    expect((await put('ta', c, body)).json.data).toMatchObject({ shape: 'hexagon', frontAssetId: asset });
    expect((await got('ta', c)).json.data).toMatchObject({ shape: 'hexagon', frontAssetId: asset });
    expect((await graph()).cards[0]).toMatchObject({ shape: 'hexagon', frontAssetId: asset });
    expect((await put('ta', c, { ...base, type: 'concept', payload: {} })).json.data).toMatchObject({ shape: 'rect', frontAssetId: null }); // defaults

    // shape other than rect only for concept
    const flow = await newCard(board, 'flow');
    const r = await put('ta', flow, { ...base, type: 'flow', payload: { steps: [] }, shape: 'circle' });
    expect([r.status, r.json.error?.code]).toEqual([422, 'validation']);

    // asset the user cannot read
    const foreign = await mkAsset('tb');
    const r2 = await put('ta', c, { ...body, frontAssetId: foreign });
    expect([r2.status, r2.json.error?.code]).toEqual([422, 'validation']);
    expect((await put('ta', c, { ...body, frontAssetId: uuid() })).status).toBe(422);

    // RLS: question image readable by others only through a live card, like payload assets
    await put('ta', c, body);
    expect((await call('tb', 'GET', `/v1/assets/${asset}`)).status).toBe(404);
    await dbm.db.execute(sql`update boards set status = 'seed_approved' where id = ${board}`);
    expect((await call('tb', 'GET', `/v1/assets/${asset}`)).status).toBe(200);
    await dbm.db.execute(sql`update boards set status = 'private' where id = ${board}`);

    // duplicate copies both
    const dup = await call('ta', 'POST', `/v1/boards/${board}/duplicate`, { title: 'Cópia' });
    expect(dup.status).toBe(201);
    const copy = (await call('ta', 'GET', `/v1/boards/${dup.json.data.id}`)).json.data as BoardGraph;
    expect(copy.cards.find((x) => x.type === 'concept')).toMatchObject({ shape: 'hexagon', frontAssetId: asset });
  });
  it('G06 D-200/D-201/D-202/D-204: note, backAssetId, step/stage assets, size and tags', async () => {
    const board = await newBoard();
    const graph = async () => (await call('ta', 'GET', `/v1/boards/${board}`)).json.data as BoardGraph;
    const got = (id: string) => call('ta', 'GET', `/v1/cards/${id}`);

    // note via the map op createCard; back/backAssetId sent for a note are dropped
    const n = await newCard(board, 'note');
    expect((await got(n)).json.data).toMatchObject({ type: 'note', back: null, backAssetId: null, size: null, tags: [] });
    const img = await mkAsset('ta');
    const saved = await put('ta', n, { ...base, type: 'note', payload: {}, frontAssetId: img, backAssetId: img });
    expect(saved.status).toBe(200);
    expect(saved.json.data).toMatchObject({ type: 'note', back: null, backAssetId: null, frontAssetId: img });
    expect((await put('ta', n, { ...base, type: 'note', payload: { x: 1 } })).status).toBe(422); // strict payload

    // back image on a concept: persisted, listed, validated, copied
    const c = await newCard(board);
    const back = await mkAsset('ta');
    expect((await put('ta', c, { ...base, type: 'concept', payload: {}, backAssetId: back })).json.data).toMatchObject({ backAssetId: back });
    expect((await graph()).cards.find((x) => x.id === c)).toMatchObject({ backAssetId: back, size: null, tags: [] });
    const foreign = await mkAsset('tb');
    expect((await put('ta', c, { ...base, type: 'concept', payload: {}, backAssetId: foreign })).status).toBe(422);
    expect((await put('ta', c, { ...base, type: 'concept', payload: {}, backAssetId: uuid() })).status).toBe(422);

    // flow step and case stage images
    const [s1, s2, k1] = [await mkAsset('ta'), await mkAsset('ta'), await mkAsset('ta')];
    const flow = await newCard(board, 'flow');
    const steps = (a2: string) => ({ ...base, type: 'flow', payload: { steps: [{ id: 'a', text: 'um', assetId: s1 }, { id: 'b', text: 'dois', assetId: a2 }] } });
    expect((await put('ta', flow, steps(foreign))).status).toBe(422);
    expect((await put('ta', flow, steps(s2))).status).toBe(200);
    const cs = await newCard(board, 'case');
    const caseBody = (id: string) => ({ ...base, type: 'case', payload: { caseSteps: [{ stage: 'presentation', text: 'x', assetId: id }, { stage: 'workup', text: 'y' }, { stage: 'diagnosis', text: 'z' }, { stage: 'management', text: 'w' }] } });
    expect((await put('ta', cs, caseBody(foreign))).status).toBe(422);
    expect((await put('ta', cs, caseBody(k1))).status).toBe(200);

    // RLS: another user reads these assets only when the card is readable
    for (const id of [back, s1, s2, k1]) expect((await call('tb', 'GET', `/v1/assets/${id}`)).status).toBe(404);
    await dbm.db.execute(sql`update boards set status = 'seed_approved' where id = ${board}`);
    for (const id of [back, s1, s2, k1]) expect((await call('tb', 'GET', `/v1/assets/${id}`)).status).toBe(200);
    await dbm.db.execute(sql`update boards set status = 'private' where id = ${board}`);

    // resizeCards: absolute, idempotent, bounded, owner-only, null restores
    const resize = (t: string, bid: string, sizes: unknown[], opId = uuid()) => call(t, 'POST', '/v1/boards/ops', { ops: [{ op: 'resizeCards', opId, boardId: bid, sizes }] });
    const op = uuid();
    expect((await resize('ta', board, [{ cardId: c, size: { w: 300, h: 200 } }], op)).status).toBe(200);
    expect((await resize('ta', board, [{ cardId: c, size: { w: 300, h: 200 } }], op)).status).toBe(200); // replay
    expect((await got(c)).json.data.size).toEqual({ w: 300, h: 200 });
    expect((await graph()).cards.find((x) => x.id === c)!.size).toEqual({ w: 300, h: 200 });
    expect((await resize('ta', board, [{ cardId: c, size: { w: 10, h: 200 } }])).status).toBe(422);
    expect((await resize('ta', board, [{ cardId: c, size: { w: 700, h: 200 } }])).status).toBe(422);
    expect((await resize('tb', board, [{ cardId: c, size: { w: 200, h: 200 } }])).status).toBe(404);
    const otherBoard = await newBoard();
    await resize('ta', otherBoard, [{ cardId: c, size: { w: 500, h: 400 } }]); // card of another board: no effect
    expect((await got(c)).json.data.size).toEqual({ w: 300, h: 200 });

    // duplicate copies back image, size, tags
    await dbm.db.execute(sql`update cards set tags = array['a','b'] where id = ${c}`);
    const dup = await call('ta', 'POST', `/v1/boards/${board}/duplicate`, { title: 'Cópia' });
    const copy = (await call('ta', 'GET', `/v1/boards/${dup.json.data.id}`)).json.data as BoardGraph;
    expect(copy.cards.find((x) => x.type === 'concept')).toMatchObject({ backAssetId: back, size: { w: 300, h: 200 }, tags: ['a', 'b'] });
    expect(copy.cards.find((x) => x.type === 'note')).toBeTruthy();
    expect((await resize('ta', board, [{ cardId: c, size: null }])).status).toBe(200);
    expect((await got(c)).json.data.size).toBeNull();
  });
});
