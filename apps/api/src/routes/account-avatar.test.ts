// Integration: needs local Supabase + Storage (see cards.test.ts); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)('/v1/account/avatar', () => {
  const a = uuid();
  const b = uuid();
  let dbm: typeof import('@remoa/db');
  let st: typeof import('../storage/storage');
  let app: ReturnType<typeof import('../app').createApp>;

  const call = async (t: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const upload = async (t: string, bytes: Buffer, mime = 'image/png') => {
    const sign = await call(t, 'POST', '/v1/uploads/sign', { mime, sizeBytes: bytes.length, kind: 'avatar' });
    expect(sign.status).toBe(200);
    const { url, key } = sign.json.data as { url: string; key: string };
    expect((await fetch(url, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': mime } })).status).toBe(200);
    return key;
  };
  const img = (fmt: 'png' | 'jpeg' | 'gif' = 'png') => {
    const s = sharp({ create: { width: 300, height: 200, channels: 3, background: '#c33' } });
    return fmt === 'jpeg' ? s.jpeg().withExif({ IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '23/1 32/1 0/1' } }).toBuffer() : s.png().toBuffer();
  };
  const avatarKey = async (u: string) => (await dbm.db.select({ k: dbm.profiles.avatarKey }).from(dbm.profiles).where(eq(dbm.profiles.userId, u)))[0]?.k ?? null;

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    st = await import('../storage/storage');
    await st.ensureBucket();
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => ({ ta: a, tb: b })[t] ?? null });
    for (const id of [a, b]) {
      await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    }
  }, 30_000);
  afterAll(async () => {
    if (dbm) await dbm.db.execute(sql.raw(`delete from auth.users where id in ('${a}', '${b}')`));
    if (st) await Promise.all([a, b].map((u) => st.deletePrefix(`avatars/${u}/`)));
  });

  it('sign: avatar prefix, 5 MB cap, jpg/png/webp only', async () => {
    const ok = await call('ta', 'POST', '/v1/uploads/sign', { mime: 'image/webp', sizeBytes: 1000, kind: 'avatar' });
    expect(ok.json.data.key).toMatch(new RegExp(`^avatars/${a}/raw/[0-9a-f-]{36}\\.webp$`));
    expect((await call('ta', 'POST', '/v1/uploads/sign', { mime: 'image/png', sizeBytes: 6 * 1024 * 1024, kind: 'avatar' })).status).toBe(422);
    expect((await call('ta', 'POST', '/v1/uploads/sign', { mime: 'image/gif', sizeBytes: 10, kind: 'avatar' })).status).toBe(422);
  });

  it('JPEG with GPS EXIF comes out as 512/96 WebP without metadata; old objects are replaced; remove clears', async () => {
    const jpeg = await img('jpeg');
    expect((await sharp(jpeg).metadata()).exif).toBeDefined(); // fixture really has EXIF
    const raw = await upload('ta', jpeg, 'image/jpeg');
    const r = await call('ta', 'POST', '/v1/account/avatar', { key: raw });
    expect(r.status).toBe(200);
    const k1 = (await avatarKey(a))!;
    expect(k1).toMatch(new RegExp(`^avatars/${a}/[0-9a-f-]{36}/512\\.webp$`));
    const big = await sharp(await st.getBytes(k1)).metadata();
    const sm = await sharp(await st.getBytes(k1.replace('512', '96'))).metadata();
    expect([big.format, big.width, big.height, big.exif]).toEqual(['webp', 512, 512, undefined]);
    expect([sm.width, sm.exif]).toEqual([96, undefined]);
    expect((await fetch(r.json.data.large)).status).toBe(200);
    expect(await st.headObject(raw)).toBeNull();
    const ev = await dbm.db.execute<{ n: number }>(sql`select count(*)::int n from account_events where user_id = ${a} and type = 'avatar_changed'`);
    expect(ev[0]?.n).toBe(1);

    // replace: previous variants are deleted
    expect((await call('ta', 'POST', '/v1/account/avatar', { key: await upload('ta', await img()) })).status).toBe(200);
    const k2 = (await avatarKey(a))!;
    expect(k2).not.toBe(k1);
    expect(await st.headObject(k1)).toBeNull();
    expect(await st.headObject(k1.replace('512', '96'))).toBeNull();
    expect(await st.headObject(k2)).not.toBeNull();

    // remove
    expect((await call('ta', 'DELETE', '/v1/account/avatar')).status).toBe(200);
    expect(await avatarKey(a)).toBeNull();
    expect(await st.headObject(k2)).toBeNull();
    expect(await st.headObject(k2.replace('512', '96'))).toBeNull();
  }, 60_000);

  it('rejects a fake .png (gif bytes), an oversized object and another user key', async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
    const fake = await upload('ta', gif, 'image/png');
    expect((await call('ta', 'POST', '/v1/account/avatar', { key: fake })).status).toBe(422);
    expect(await st.headObject(fake)).toBeNull();

    const big = `avatars/${a}/raw/${uuid()}.png`; // bypasses the signed Content-Length on purpose
    await st.putBytes(big, Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png');
    expect((await call('ta', 'POST', '/v1/account/avatar', { key: big })).status).toBe(422);
    expect(await st.headObject(big)).toBeNull();

    const mine = await upload('ta', await img());
    expect((await call('tb', 'POST', '/v1/account/avatar', { key: mine })).status).toBe(403);
    expect((await call('ta', 'POST', '/v1/account/avatar', { key: `avatars/${a}/raw/x/../y.png` })).status).toBe(403);
    expect(await st.headObject(mine)).not.toBeNull();
    expect(await avatarKey(b)).toBeNull();
    expect((await app.request('/v1/account/avatar', { method: 'POST' })).status).toBe(401);
  });
});
