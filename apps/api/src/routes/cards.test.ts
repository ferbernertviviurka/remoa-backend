// Integration: needs local Supabase + Storage (`pnpm db:up && pnpm db:migrate`, .env at repo root with DATABASE_URL and S3_*); skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardGraph, MapOp } from '@remoa/contracts';

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
  const newCard = async (boardId: string, type: 'concept' | 'flow' | 'image' | 'case' = 'concept', t = 'ta') => {
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
    expect((await call('ta', 'POST', '/v1/uploads/sign', { mime: 'image/png', sizeBytes: 11 * 1024 * 1024 })).status).toBe(422);
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
    // 60 MP solid PNG (tiny on disk) exceeds the pixel limit
    const bomb = await sharp({ create: { width: 8000, height: 7500, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    const k2 = await upload('ta', bomb, 'image/png');
    expect((await call('ta', 'POST', '/v1/uploads/complete', { key: k2 })).status).toBe(422);
    expect(await st.headObject(k2)).toBeNull();
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
});
