// Integration (F17 T3 + T4): sharing, the public page, unlock limit and copy. Needs local Supabase (DATABASE_URL + S3 from
// the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHARE_ACCESS_HEADER, SHARE_LIMITS } from '@remoa/contracts';

config({ path: '../../.env' });
process.env.SHARE_SECRET ||= 'test-share-secret-test-share-secret';

// Recursive allowlist of keys in a SharedBoard (record keys under `assets` are asset ids, checked separately).
const ALLOWED = new Set([
  'locked', 'access', 'title', 'area', 'matrixItems', 'code', 'cards', 'id', 'type', 'shape', 'front', 'frontAssetId', 'back', 'backAssetId',
  'size', 'w', 'h', 'source', 'position', 'x', 'y', 'order', 'payload', 'steps', 'text', 'note', 'assetId', 'caseSteps', 'stage', 'masks',
  'polygon', 'label', 'edges', 'fromCardId', 'toCardId', 'question', 'assets', 'width', 'height', 'attribution', 'urls', 'w800', 'w1600',
  'cardCount', 'updatedAt', 'ownBoardId',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function unknownKeys(v: unknown, parent = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => unknownKeys(x, parent));
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => [...(ALLOWED.has(k) || (parent === 'assets' && UUID.test(k)) ? [] : [`${parent}.${k}`]), ...unknownKeys(x, k)]);
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)('F17 sharing: /v1/boards/:id/share, /v1/public/shared, /v1/boards/copy', () => {
  const [a, b, f, g] = [uuid(), uuid(), uuid(), uuid()]; // owner (pro), copier (pro), free copier, copier hit by a storage failure (pro)
  const tokens: Record<string, string> = { ta: a, tb: b, tf: f, tg: g };
  let dbm: typeof import('@remoa/db');
  let st: typeof import('../storage/storage');
  let app: ReturnType<typeof import('../app').createApp>;
  let ipSeq = 0;
  const ip = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

  type Res = { status: number; headers: Headers; json: { ok?: true; data?: any; error?: { code: string; message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const req = async (method: string, path: string, o: { t?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...(o.t ? { authorization: `Bearer ${o.t}` } : {}), ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    return { status: res.status, headers: res.headers, json: res.headers.get('content-type')?.includes('json') ? await res.json() : {} };
  };
  const putShare = (id: string, body: unknown, t = 'ta') => req('PUT', `/v1/boards/${id}/share`, { t, body });
  const tokenOf = (url: string) => url.split('/m/')[1]!;
  const view = (token: string, o: { grant?: string; t?: string } = {}) =>
    req('GET', `/v1/public/shared/${token}`, { t: o.t, headers: { 'x-forwarded-for': ip(), ...(o.grant ? { [SHARE_ACCESS_HEADER]: o.grant } : {}) } });
  const unlock = (token: string, password: string, from = ip()) => req('POST', `/v1/public/shared/${token}/unlock`, { body: { password }, headers: { 'x-forwarded-for': from } });
  const copy = (token: string, t = 'tb', grant?: string) => req('POST', '/v1/boards/copy', { t, body: { token }, headers: grant ? { [SHARE_ACCESS_HEADER]: grant } : {} });
  const newBoard = async (title = 'Cardio') => (await req('POST', '/v1/boards', { t: 'ta', body: { title } })).json.data.id as string;
  const count = async (q: string) => Number((await dbm.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${q}`)))[0]!.n);

  /** Board of `a` with two images (real objects), an image card with a mask, a flow step image, an edge, FSRS state and tags. */
  async function richBoard() {
    const id = await newBoard('Insuficiência cardíaca');
    const [img1, img2] = [uuid(), uuid()];
    for (const asset of [img1, img2]) {
      for (const v of ['w800', 'w1600']) await st.putBytes(`assets/${a}/${asset}/${v}.webp`, Buffer.from(`${asset}-${v}`), 'image/webp');
      await dbm.db.insert(dbm.assets).values({ id: asset, userId: a, key: `assets/${a}/${asset}`, mime: 'image/webp', width: 800, height: 600, attribution: 'Livro X' });
    }
    const [c1, c2, c3, m1] = [uuid(), uuid(), uuid(), uuid()];
    await dbm.db.insert(dbm.cards).values([
      { id: c1, boardId: id, type: 'concept', title: 'IC', front: 'O que é?', back: 'Síndrome', frontAssetId: img2, tags: ['pessoal'], status: 'draft', order: 0,
        rubric: { points: [{ text: 'Síndrome clínica', essential: true }], source: 'Diretriz', version: 1, status: 'approved', reviewerId: a } },
      { id: c2, boardId: id, type: 'image', title: 'RX', payload: { assetId: img1, masks: [{ id: m1, polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], label: 'Cardiomegalia' }] }, order: 1 },
      { id: c3, boardId: id, type: 'flow', title: 'Conduta', payload: { steps: [{ id: 's1', text: 'Diurético', assetId: img2 }, { id: 's2', text: 'IECA' }] }, order: 2 },
    ]);
    await dbm.db.insert(dbm.masks).values({ id: m1, cardId: c2, assetId: img1, polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], label: 'Cardiomegalia' });
    await dbm.db.insert(dbm.edges).values({ boardId: id, fromCardId: c1, toCardId: c3, label: 'trata' });
    await dbm.db.insert(dbm.fsrsState).values({ userId: a, cardId: c1, due: new Date(), reps: 3, state: 'review' });
    const [item] = await dbm.db.execute<{ id: string }>(sql`select id from matrix_items where parent_id is not null limit 1`);
    if (item) await dbm.db.insert(dbm.boardMatrixItems).values({ boardId: id, matrixItemId: item.id });
    return { id, img1: img1 as string, img2: img2 as string, mask: m1, cards: [c1, c2, c3] as string[], item: item?.id ?? null };
  }

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    st = await import('../storage/storage');
    await st.ensureBucket();
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => tokens[t] ?? null });
    for (const id of [a, b, f, g]) {
      await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
      if (id !== f) await dbm.db.insert(dbm.subscriptions).values({ userId: id, plan: 'pro', status: 'active' });
    }
  });
  afterAll(async () => {
    if (!dbm) return;
    await dbm.db.execute(sql.raw(`delete from auth.users where id in ('${a}', '${b}', '${f}', '${g}')`));
    for (const id of [a, b, f, g]) await st.deletePrefix(`assets/${id}/`);
  });

  it('PUT share: every transition, token/hash/version in the database, owner only', async () => {
    const id = await newBoard();
    const row = async () => (await dbm.db.select().from(dbm.boards).where(eq(dbm.boards.id, id)))[0]!;
    expect((await req('GET', `/v1/boards/${id}/share`, { t: 'ta' })).json.data).toEqual({ access: 'owner', url: null, copies: 0 });
    expect((await req('GET', `/v1/boards/${id}/share`, { t: 'tb' })).status).toBe(404);
    expect((await putShare(id, { access: 'public' }, 'tb')).status).toBe(404);

    const pub = await putShare(id, { access: 'public' });
    expect(pub.json.data).toMatchObject({ access: 'public', copies: 0 });
    expect(pub.json.data.url).toMatch(/^http:\/\/localhost:3000\/m\/[A-Za-z0-9_-]{43}$/);
    let r = await row();
    expect([r.access, r.sharePasswordHash, r.shareSecretVersion]).toEqual(['public', null, 2]);
    expect(r.sharedAt).toBeTruthy();
    // GET /v1/boards/:id carries shareUrl for the owner, never the hash or version
    const g = (await req('GET', `/v1/boards/${id}`, { t: 'ta' })).json.data.board;
    expect(g.shareUrl).toBe(pub.json.data.url);
    expect(Object.keys(g)).not.toEqual(expect.arrayContaining(['shareToken', 'sharePasswordHash', 'shareSecretVersion', 'copyCount']));

    expect((await putShare(id, { access: 'password' })).status).toBe(422); // entering password without one
    const pw = await putShare(id, { access: 'password', password: 'segredo1' });
    expect(pw.json.data.url).toBe(pub.json.data.url); // public -> password keeps the link
    r = await row();
    expect(r.sharePasswordHash).toMatch(/^scrypt\$v1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(r.shareSecretVersion).toBe(3);
    expect((await putShare(id, { access: 'password' })).json.data.access).toBe('password'); // no change: kept
    expect((await row()).shareSecretVersion).toBe(3);

    expect((await putShare(id, { access: 'public' })).json.data.url).toBe(pub.json.data.url);
    r = await row();
    expect([r.access, r.sharePasswordHash, r.shareSecretVersion]).toEqual(['public', null, 4]); // password -> public drops the hash

    const rot = await putShare(id, { access: 'public', rotate: true });
    expect(rot.json.data.url).not.toBe(pub.json.data.url);
    expect((await view(tokenOf(pub.json.data.url))).status).toBe(404); // old link
    expect((await view(tokenOf(rot.json.data.url))).status).toBe(200);

    expect((await putShare(id, { access: 'password', password: 'segredo2', rotate: true })).json.data.access).toBe('password');
    const off = await putShare(id, { access: 'owner' });
    expect(off.json.data).toEqual({ access: 'owner', url: null, copies: 0 });
    r = await row();
    expect([r.access, r.shareToken, r.sharePasswordHash, r.sharedAt]).toEqual(['owner', null, null, null]);
    expect((await view(tokenOf(rot.json.data.url))).status).toBe(404);

    // owner -> password directly, and the input rules of the contract
    expect((await putShare(id, { access: 'password', password: 'abcdef' })).json.data.access).toBe('password');
    expect((await putShare(id, { access: 'public', password: 'abcdef' })).status).toBe(422);
    expect((await putShare(id, { access: 'owner', rotate: true })).status).toBe(422);
    expect((await putShare(id, { access: 'password', password: '12345' })).status).toBe(422);
  });

  it('archiving turns the link off and back to owner; unarchiving does not turn it on', async () => {
    const id = await newBoard();
    const url = (await putShare(id, { access: 'public' })).json.data.url as string;
    const arch = await req('PATCH', `/v1/boards/${id}`, { t: 'ta', body: { archived: true } });
    expect(arch.json.data).toMatchObject({ access: 'owner', shareUrl: null });
    expect((await view(tokenOf(url))).status).toBe(404);
    expect((await putShare(id, { access: 'public' })).status).toBe(422); // archived
    expect((await req('PATCH', `/v1/boards/${id}`, { t: 'ta', body: { archived: false } })).json.data.access).toBe('owner');
  });

  it('seed boards can never carry a link', async () => {
    const id = await newBoard();
    await dbm.db.update(dbm.boards).set({ status: 'seed_draft' }).where(eq(dbm.boards.id, id));
    expect((await putShare(id, { access: 'public' })).status).toBe(422);
    await expect(dbm.db.update(dbm.boards).set({ access: 'public', shareToken: 'x'.repeat(43) }).where(eq(dbm.boards.id, id))).rejects.toThrow();
  });

  it('public page: allowlisted keys only, no owner data, headers, owner gets ownBoardId, images through signed API URLs', async () => {
    const rich = await richBoard();
    const token = tokenOf((await putShare(rich.id, { access: 'public' })).json.data.url);
    const r = await view(token);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    const data = r.json.data;
    expect(unknownKeys(data)).toEqual([]);
    const raw = JSON.stringify(data);
    for (const leak of [a, `${a}@test.local`, `assets/${a}`, 'scrypt$', 'pessoal', 'stability', 'reps']) expect(raw).not.toContain(leak);
    expect(data).toMatchObject({ locked: false, access: 'public', title: 'Insuficiência cardíaca', area: 'CM', cardCount: 3, ownBoardId: null });
    expect(data.edges).toHaveLength(1);
    if (rich.item) expect(data.matrixItems).toHaveLength(1);
    expect(Object.keys(data.assets).sort()).toEqual([rich.img1, rich.img2].sort());
    expect(data.cards.find((c: { type: string }) => c.type === 'image').payload.masks).toHaveLength(1);

    const img = data.assets[rich.img1].urls.w800 as string;
    const path = img.replace(/^https?:\/\/[^/]+/, '');
    const got = await app.request(path);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/webp');
    expect(Buffer.from(await got.arrayBuffer()).toString()).toBe(`${rich.img1}-w800`);
    expect((await app.request(path.replace(/s=[^&]+/, 's=forged'))).status).toBe(404);
    expect((await app.request(path.replace('/w800', '/w1600'))).status).toBe(404); // signature is per variant

    expect((await view(token, { t: 'ta' })).json.data.ownBoardId).toBe(rich.id);
    expect((await view(token, { t: 'tb' })).json.data.ownBoardId).toBeNull();

    await putShare(rich.id, { access: 'public', rotate: true });
    expect((await app.request(path)).status).toBe(404); // rotated link stops serving its images
    expect((await view('A'.repeat(43))).status).toBe(404);
    expect((await view('short')).status).toBe(404);
  });

  it('private: locked shape only, wrong 401, 6th attempt 429, right password unlocks; new password/rotate invalidate the grant', async () => {
    const id = await newBoard('Segredo de título');
    const token = tokenOf((await putShare(id, { access: 'password', password: 'senha-certa' })).json.data.url);
    const locked = await view(token);
    expect(locked.status).toBe(200);
    expect(locked.json).toEqual({ ok: true, data: { locked: true } });
    expect(Object.keys(locked.json.data)).toEqual(['locked']);
    expect(JSON.stringify(locked.json)).not.toContain('Segredo');
    expect((await view(token, { t: 'ta' })).json.data).toMatchObject({ locked: false, ownBoardId: id }); // owner needs no password

    const wrong = await unlock(token, 'errada');
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toEqual({ code: 'unauthorized', message: 'invalid password' });
    const from = ip();
    for (let i = 0; i < 5; i++) expect((await unlock(token, `errada-${i}`, from)).status).toBe(401);
    expect((await unlock(token, 'senha-certa', from)).status).toBe(429); // blocked even with the right one
    expect(await count(`share_attempts where created_at > now() - interval '1 minute'`)).toBeGreaterThanOrEqual(5);

    const ok = await unlock(token, 'senha-certa');
    expect(ok.status).toBe(200);
    const grant = ok.json.data.value as string;
    expect(new Date(ok.json.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(11 * 3600 * 1000);
    expect((await view(token, { grant })).json.data).toMatchObject({ locked: false, title: 'Segredo de título' });
    expect((await view(token, { grant: `${grant}x` })).json.data).toEqual({ locked: true });

    await putShare(id, { access: 'password', password: 'outra-senha' });
    expect((await view(token, { grant })).json.data).toEqual({ locked: true });
    expect((await copy(token, 'tb', grant)).status).toBe(403);
    expect((await unlock(token, 'senha-certa')).status).toBe(401);
    const grant2 = (await unlock(token, 'outra-senha')).json.data.value as string;
    const rotated = tokenOf((await putShare(id, { access: 'password', rotate: true })).json.data.url);
    expect((await view(rotated, { grant: grant2 })).json.data).toEqual({ locked: true });
    expect((await view(token, { grant: grant2 })).status).toBe(404);
    expect((await unlock('B'.repeat(43), 'x')).status).toBe(404);
    expect((await req('POST', `/v1/public/shared/${rotated}/unlock`, { body: {} })).status).toBe(422);
  });

  it('unlock: a parallel burst of wrong passwords cannot pass the limit; the token and password never reach the logs', async () => {
    const token = tokenOf((await putShare(await newBoard(), { access: 'password', password: 'senha-do-log' })).json.data.url);
    const from = ip();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => (out.push(String(chunk)), write(chunk, ...rest))) as typeof process.stdout.write;
    try {
      const statuses = (await Promise.all(Array.from({ length: 12 }, (_, i) => unlock(token, `burst-${i}`, from)))).map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(SHARE_LIMITS.unlockAttempts);
      expect(statuses.filter((s) => s === 429)).toHaveLength(12 - SHARE_LIMITS.unlockAttempts);
      await unlock(token, 'senha-do-log');
      await view(token);
    } finally {
      process.stdout.write = write;
    }
    const logs = out.join('');
    expect(logs).toContain('/v1/public/shared/:token');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('senha-do-log');
    expect(logs).not.toContain('burst-');
  });

  it('copy: new assets and objects for the copier, FSRS from zero, survives the owner account being deleted; copy_count', async () => {
    const rich = await richBoard();
    const token = tokenOf((await putShare(rich.id, { access: 'password', password: 'turma-2026' })).json.data.url);
    expect((await copy(token)).status).toBe(403); // private without grant
    expect((await req('POST', '/v1/boards/copy', { body: { token } })).status).toBe(401); // no session
    const grant = (await unlock(token, 'turma-2026')).json.data.value as string;

    const res = await copy(token, 'tb', grant);
    expect(res.status).toBe(201);
    const board = res.json.data;
    expect(board).toMatchObject({ userId: b, title: 'Insuficiência cardíaca', access: 'owner', shareUrl: null, sourceBoardId: null, status: 'private' });
    expect(board.copiedFrom.at).toBeTruthy();
    const dbRow = (await dbm.db.select().from(dbm.boards).where(eq(dbm.boards.id, board.id)))[0]!;
    expect(dbRow.sourceBoardId).toBe(rich.id);
    if (rich.item) expect(await count(`board_matrix_items where board_id = '${board.id}'`)).toBe(1);

    const g = (await req('GET', `/v1/boards/${board.id}`, { t: 'tb' })).json.data;
    expect(g.cards).toHaveLength(3);
    expect(g.edges).toHaveLength(1);
    expect(g.cards.every((c: { tags: string[]; status: string }) => c.tags.length === 0 && c.status === 'draft')).toBe(true);
    const copiedIds = g.cards.map((c: { id: string }) => c.id);
    expect(copiedIds.some((x: string) => rich.cards.includes(x))).toBe(false);
    expect(await count(`fsrs_state where card_id in ('${copiedIds.join("','")}')`)).toBe(0);
    const concept = (await req('GET', `/v1/cards/${g.cards.find((c: { type: string }) => c.type === 'concept').id}`, { t: 'tb' })).json.data;
    expect(concept.rubric).toMatchObject({ status: 'draft', reviewerId: null, points: [{ text: 'Síndrome clínica', essential: true }] }); // rule 6

    const assets = await dbm.db.select().from(dbm.assets).where(eq(dbm.assets.userId, b));
    expect(assets).toHaveLength(2);
    expect(assets.every((x) => x.key === `assets/${b}/${x.id}` && ![rich.img1, rich.img2].includes(x.id))).toBe(true);
    const image = g.cards.find((c: { type: string }) => c.type === 'image');
    const detail = (await req('GET', `/v1/cards/${image.id}`, { t: 'tb' })).json.data;
    expect(assets.map((x) => x.id)).toContain(detail.payload.assetId);
    const masks = await dbm.db.select().from(dbm.masks).where(eq(dbm.masks.cardId, image.id));
    expect(masks).toHaveLength(1);
    expect(masks[0]!.assetId).toBe(detail.payload.assetId);
    expect(masks[0]!.id).toBe(detail.payload.masks[0].id);
    expect(masks[0]!.id).not.toBe(rich.mask);

    expect((await req('GET', `/v1/boards/${rich.id}/share`, { t: 'ta' })).json.data.copies).toBe(1);

    // owner leaves: rows cascade and the purge job removes their objects; the copy keeps working
    await dbm.db.execute(sql.raw(`delete from boards where user_id = '${a}'`));
    await dbm.db.execute(sql.raw(`delete from assets where user_id = '${a}'`));
    await st.deletePrefix(`assets/${a}/`);
    for (const x of assets) expect((await st.getBytes(`${x.key}/w1600.webp`)).length).toBeGreaterThan(0);
    expect((await req('GET', `/v1/assets/${detail.payload.assetId}`, { t: 'tb' })).status).toBe(200);
  });

  it('copy: own board = duplicate; quota and storage failures create nothing', async () => {
    const rich = await richBoard();
    const token = tokenOf((await putShare(rich.id, { access: 'public' })).json.data.url);
    const own = await copy(token, 'ta');
    expect(own.status).toBe(201);
    expect(own.json.data).toMatchObject({ userId: a, sourceBoardId: rich.id, copiedFrom: null });
    expect((await req('GET', `/v1/boards/${rich.id}/share`, { t: 'ta' })).json.data.copies).toBe(0);

    // free plan: 2 boards max
    for (const t of ['x', 'y']) await dbm.db.insert(dbm.boards).values({ userId: f, title: t });
    const before = await count(`boards where user_id = '${f}'`);
    const q = await copy(token, 'tf');
    expect(q.status).toBe(402);
    expect(q.json.error).toEqual({ code: 'quota_exceeded', message: 'boards' });
    expect(await count(`boards where user_id = '${f}'`)).toBe(before);
    expect(await count(`assets where user_id = '${f}'`)).toBe(0);

    // free plan with room for a board but not for the cards (limit 50 live cards)
    await dbm.db.execute(sql.raw(`delete from boards where user_id = '${f}' and title = 'y'`));
    const [fb] = await dbm.db.select({ id: dbm.boards.id }).from(dbm.boards).where(eq(dbm.boards.userId, f));
    await dbm.db.insert(dbm.cards).values(Array.from({ length: 49 }, (_, i) => ({ boardId: fb!.id, title: `c${i}` })));
    const qc = await copy(token, 'tf');
    expect(qc.json.error).toEqual({ code: 'quota_exceeded', message: 'cards' });
    expect(await count(`boards where user_id = '${f}'`)).toBe(1);

    // an object missing in storage: 500, no rows and no orphan objects for the copier
    const ghost = uuid();
    await dbm.db.insert(dbm.assets).values({ id: ghost, userId: a, key: `assets/${a}/${ghost}`, mime: 'image/webp', width: 10, height: 10 });
    await dbm.db.update(dbm.cards).set({ backAssetId: ghost }).where(eq(dbm.cards.id, rich.cards[0]!));
    const failed = await copy(token, 'tg');
    expect(failed.status).toBe(500);
    expect(await count(`boards where user_id = '${g}'`)).toBe(0);
    expect(await count(`assets where user_id = '${g}'`)).toBe(0);
    expect(await st.deletePrefix(`assets/${g}/`)).toBe(0); // the objects copied before the failure were removed
  });
});
