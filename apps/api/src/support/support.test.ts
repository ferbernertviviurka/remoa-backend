// Integration (F19 T2): user tickets, attachments, limits, unread, reopen, admin inbox domain, retention, export. Needs local Supabase + storage; skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('F19 support (user side + admin inbox domain)', () => {
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let storage: typeof import('../storage/storage');
  let inbox: typeof import('./admin-inbox');
  let sent: Awaited<ReturnType<typeof import('../test-email')['captureEmails']>>;
  const users: string[] = [];

  const newUser = async (name = 'Ana Souza') => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data) values (${id}, ${id + '@test.local'}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${JSON.stringify({ name })}::jsonb)`);
    return id;
  };
  type J = { ok?: true; data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = async (u: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/support${path}`, { method, headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as J };
  };
  let n = 0;
  const input = (o: Record<string, unknown> = {}) => ({ type: 'bug', subject: `Erro na revisão ${++n}`, description: 'Ao abrir a fila de revisão o botão não responde.', attachments: [], context: null, ...o });
  const create = (u: string, o?: Record<string, unknown>) => call(u, 'POST', '/tickets', input(o));
  const admin = async (): Promise<string> => newUser('Equipe Remoa');
  const asAdmin = <T>(fn: (tx: import('@remoa/db').Tx) => Promise<T>) => dbm.db.transaction(fn);
  const upload = async (userId: string, bytes: Buffer, mime = 'image/png') => {
    const key = `support/${userId}/${uuid()}`;
    await storage.putBytes(key, bytes, mime);
    return key;
  };
  const png = (withExif = false) => {
    const img = sharp({ create: { width: 20, height: 10, channels: 3, background: '#f80' } });
    return (withExif ? img.withExif({ IFD0: { Copyright: 'secret-gps' } }) : img).png().toBuffer();
  };
  const jpeg = () => sharp({ create: { width: 20, height: 10, channels: 3, background: '#08f' } }).withExif({ IFD0: { Copyright: 'secret-gps' } }).jpeg().toBuffer();

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    storage = await import('../storage/storage');
    inbox = await import('./admin-inbox');
    sent = (await import('../test-email')).captureEmails();
    await storage.ensureBucket();
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
  });

  it('requires auth; validates with contract zod', async () => {
    expect((await app.request('/v1/support/tickets')).status).toBe(401);
    const u = await newUser();
    for (const bad of [{ subject: 'abc' }, { description: 'curta' }, { type: 'nope' }, { attachments: ['a', 'b', 'c', 'd'] }]) expect((await create(u, bad)).status).toBe(422);
    expect((await call(u, 'POST', '/tickets', 'not json')).status).toBe(422);
  });

  it('creates a ticket: global number, received e-mail without conversation text, listed', async () => {
    const u = await newUser();
    const a = await create(u, { subject: 'Segredo do assunto?' });
    const b = await create(u);
    expect(a.status).toBe(201);
    expect(b.json.data.number).toBe(a.json.data.number + 1);
    expect(a.json.data.number).toBeGreaterThanOrEqual(1001);
    const mail = sent.filter((m) => m.to === `${u}@test.local`);
    expect(mail[0]!.subject).toBe(`Chamado #${a.json.data.number} recebido`);
    expect(mail[0]!.subject + mail[0]!.text).not.toContain('Erro na revisão');
    const list = await call(u, 'GET', '/tickets');
    expect(list.json.data).toHaveLength(2);
    expect(list.json.data[0].status).toBe('open');
  });

  it('context: whitelist stored; extra keys (boardContent, token) rejected and never persisted', async () => {
    const u = await newUser();
    const ctx = { screen: '/mapa/abc', plan: 'free', browser: 'Chrome 130', os: 'macOS', appVersion: '1.0.0', timezone: 'America/Sao_Paulo' };
    for (const extra of [{ boardContent: 'x' }, { token: 'eyJ' }]) {
      const r = await create(u, { context: { ...ctx, ...extra } });
      expect(r.status).toBe(422);
    }
    expect((await create(u, { context: { ...ctx, screen: '/mapa?token=abc' } })).status).toBe(422);
    const ok = await create(u, { context: ctx });
    expect(ok.status).toBe(201);
    expect((await call(u, 'GET', `/tickets/${ok.json.data.id}`)).json.data.context).toEqual(ctx);
    const rows = await dbm.db.execute<{ c: string }>(sql`select context::text as c from support_tickets where user_id = ${u}`);
    expect(rows.map((r) => r.c).join()).not.toMatch(/boardContent|token=|eyJ/);
    const off = await create(u);
    expect((await call(u, 'GET', `/tickets/${off.json.data.id}`)).json.data.context).toBeNull();
  });

  it('attachments: sign, EXIF stripped (png+jpeg), private signed read, magic bytes / foreign key / size / reuse rejected', async () => {
    const u = await newUser();
    const sign = await call(u, 'POST', '/attachments/sign', { mime: 'image/png', sizeBytes: 1000 });
    expect(sign.json.data.key).toMatch(new RegExp(`^support/${u}/`));
    expect((await call(u, 'POST', '/attachments/sign', { mime: 'image/gif', sizeBytes: 1000 })).status).toBe(422);
    expect((await call(u, 'POST', '/attachments/sign', { mime: 'image/png', sizeBytes: 6 * 1024 * 1024 })).status).toBe(422);

    const k1 = await upload(u, await png(true));
    const k2 = await upload(u, await jpeg(), 'image/jpeg');
    expect((await sharp(await storage.getBytes(k1)).metadata()).exif).toBeDefined(); // sanity: the fixture has EXIF
    const r = await create(u, { attachments: [k1, k2] });
    expect(r.status).toBe(201);
    const stored = (await dbm.db.select({ key: dbm.supportAttachments.key }).from(dbm.supportAttachments).innerJoin(dbm.supportTickets, eq(dbm.supportTickets.id, dbm.supportAttachments.ticketId)).where(eq(dbm.supportTickets.id, r.json.data.id))).map((x) => x.key);
    expect(stored).toHaveLength(2);
    for (const k of stored) {
      const meta = await sharp(await storage.getBytes(k)).metadata();
      expect(meta.exif).toBeUndefined();
      expect((await storage.getBytes(k)).includes(Buffer.from('secret-gps'))).toBe(false);
    }
    const detail = (await call(u, 'GET', `/tickets/${r.json.data.id}`)).json.data;
    expect(detail.messages[0].attachments).toHaveLength(2);
    const url: string = detail.messages[0].attachments[0].url;
    expect(url).toMatch(/X-Amz-Expires=3600|expires=/i);
    expect((await fetch(url)).status).toBe(200);

    expect((await create(u, { attachments: [await upload(u, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')] })).json.error?.message).toBe('support_bad_attachment');
    const other = await newUser();
    expect((await create(u, { attachments: [await upload(other, await png())] })).status).toBe(422); // someone else's prefix
    expect((await create(u, { attachments: [`support/${u}/never-uploaded`] })).status).toBe(422);
    expect((await create(u, { attachments: [k1] })).status).toBe(422); // already used
    const big = await upload(u, Buffer.concat([await png(), Buffer.alloc(5 * 1024 * 1024 + 1)]));
    expect((await create(u, { attachments: [big] })).status).toBe(422);
    expect(await storage.headObject(big)).toBeNull(); // rejected uploads are deleted
  });

  it('a processed attachment lives under a fresh key: re-PUTting the signed upload key afterwards changes nothing served', async () => {
    const u = await newUser();
    const k = await upload(u, await png(true));
    const r = await create(u, { attachments: [k] });
    expect(r.status).toBe(201);
    // the presigned PUT stays valid for 10 min: the user writes raw bytes (EXIF, non-image) to the same key again
    await storage.putBytes(k, Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
    const [a] = await dbm.db.select().from(dbm.supportAttachments).where(eq(dbm.supportAttachments.ticketId, r.json.data.id));
    expect(a!.key).not.toBe(k);
    expect(a!.key.startsWith(`support/${u}/`)).toBe(true);
    expect((await storage.getBytes(a!.key)).subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('duplicate within 10 min -> 409; concurrent identical submits: exactly one wins', async () => {
    const u = await newUser();
    const same = input();
    expect((await call(u, 'POST', '/tickets', same)).status).toBe(201);
    const d = await call(u, 'POST', '/tickets', same);
    expect(d.status).toBe(409);
    expect(d.json.error!.message).toBe('support_duplicate');
    const v = await newUser();
    const body = input();
    const res = await Promise.all([1, 2, 3].map(() => call(v, 'POST', '/tickets', body)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    // outside the window it is a new ticket
    await dbm.db.execute(sql`update support_tickets set created_at = now() - interval '11 minutes' where user_id = ${u}`);
    expect((await call(u, 'POST', '/tickets', same)).status).toBe(201);
  });

  it('attachment signing 20/hour and replies 30/hour per user -> 429 support_rate_limited', async () => {
    const u = await newUser();
    const other = await newUser();
    for (let i = 0; i < 20; i++) expect((await call(u, 'POST', '/attachments/sign', {})).status).not.toBe(429);
    const s = await call(u, 'POST', '/attachments/sign', {});
    expect([s.status, s.json.error!.message]).toEqual([429, 'support_rate_limited']);
    expect((await call(other, 'POST', '/attachments/sign', {})).status).not.toBe(429);
    const id = crypto.randomUUID();
    for (let i = 0; i < 30; i++) expect((await call(u, 'POST', `/tickets/${id}/messages`, {})).status).not.toBe(429);
    const r = await call(u, 'POST', `/tickets/${id}/messages`, {});
    expect([r.status, r.json.error!.message]).toEqual([429, 'support_rate_limited']);
  });

  it('rate limit: 5/hour and 20/day per user -> 429 support_rate_limited; other users unaffected', async () => {
    const u = await newUser();
    for (let i = 0; i < 5; i++) expect((await create(u)).status).toBe(201);
    const r = await create(u);
    expect(r.status).toBe(429);
    expect(r.json.error!.message).toBe('support_rate_limited');
    expect((await create(await newUser())).status).toBe(201);
    await dbm.db.execute(sql`update support_tickets set created_at = now() - interval '2 hours' where user_id = ${u}`);
    expect((await create(u)).status).toBe(201); // hour window cleared
    const v = await newUser();
    for (let i = 0; i < 20; i++) await dbm.db.execute(sql`insert into support_tickets (user_id, type, subject, created_at) values (${v}, 'bug', 'Assunto qualquer', now() - interval '3 hours')`);
    expect((await create(v)).status).toBe(429); // day window
  });

  it('admin reply -> answered, unread for user, e-mail; read clears; internal note: hidden, no e-mail, no unread', async () => {
    const u = await newUser();
    const adm = await admin();
    const t = (await create(u)).json.data as { id: string; number: number };
    expect((await call(u, 'GET', '/unread')).json.data.count).toBe(0);

    const note = await asAdmin((tx) => inbox.replyAsAdmin(tx, adm, t.id, { body: 'nota interna sigilosa', internal: true }));
    expect(note.ok && note.data.internal).toBe(true);
    expect((await call(u, 'GET', '/unread')).json.data.count).toBe(0);
    let detail = (await call(u, 'GET', `/tickets/${t.id}`)).json.data;
    expect(detail.status).toBe('open');
    expect(JSON.stringify(detail)).not.toContain('sigilosa');
    expect(JSON.stringify((await call(u, 'GET', '/tickets')).json)).not.toContain('sigilosa');

    const before = sent.length;
    const rep = await asAdmin((tx) => inbox.replyAsAdmin(tx, adm, t.id, { body: 'Já corrigimos, tente de novo.' }));
    expect(rep.ok).toBe(true);
    if (rep.ok) await inbox.notifyAnswered(rep.data.userId, t.id, rep.data.number, rep.data.messageId);
    const got = sent.slice(before).filter((m) => m.to === `${u}@test.local`);
    expect(got).toHaveLength(1);
    expect(got[0]!.subject).toContain(`#${t.number}`);
    expect(got[0]!.subject + got[0]!.text).not.toContain('corrigimos');

    expect((await call(u, 'GET', '/unread')).json.data.count).toBe(1);
    expect((await call(u, 'GET', '/tickets')).json.data[0].unread).toBe(true);
    detail = (await call(u, 'GET', `/tickets/${t.id}`)).json.data;
    expect(detail.status).toBe('answered');
    expect(detail.messages.map((m: { authorType: string }) => m.authorType)).toEqual(['user', 'admin']);
    expect(detail.messages[1]).not.toHaveProperty('authorId');
    expect((await call(u, 'POST', `/tickets/${t.id}/read`)).status).toBe(200);
    expect((await call(u, 'GET', '/unread')).json.data.count).toBe(0);
    // an internal note after reading does not re-light the dot
    await asAdmin((tx) => inbox.replyAsAdmin(tx, adm, t.id, { body: 'outra nota', internal: true }));
    expect((await call(u, 'GET', '/unread')).json.data.count).toBe(0);
  });

  it('user reply reopens answered/resolved; resolved > 14 days -> 409 support_ticket_closed; immutable (no edit/delete routes)', async () => {
    const u = await newUser();
    const adm = await admin();
    const t = (await create(u)).json.data as { id: string; number: number };
    await asAdmin((tx) => inbox.replyAsAdmin(tx, adm, t.id, { body: 'resposta' }));
    let r = await call(u, 'POST', `/tickets/${t.id}/messages`, { body: 'obrigado, mas ainda falha', attachments: [] });
    expect(r.status).toBe(201);
    expect(r.json.data.status).toBe('open');
    expect(r.json.data.messages).toHaveLength(3);

    await asAdmin((tx) => inbox.resolveTicket(tx, t.id));
    expect((await call(u, 'GET', `/tickets/${t.id}`)).json.data.reopenableUntil).not.toBeNull();
    r = await call(u, 'POST', `/tickets/${t.id}/messages`, { body: 'voltou a acontecer' });
    expect(r.json.data.status).toBe('open');
    expect(r.json.data.reopenableUntil).toBeNull();

    await asAdmin((tx) => inbox.resolveTicket(tx, t.id));
    await dbm.db.execute(sql`update support_tickets set resolved_at = now() - interval '15 days' where id = ${t.id}`);
    r = await call(u, 'POST', `/tickets/${t.id}/messages`, { body: 'tarde demais' });
    expect(r.status).toBe(409);
    expect(r.json.error!.message).toBe('support_ticket_closed');
    expect((await call(u, 'POST', `/tickets/${t.id}/messages`, { body: '' })).status).toBe(422);

    const mid = (await call(u, 'GET', `/tickets/${t.id}`)).json.data.messages[0].id;
    for (const m of ['PUT', 'PATCH', 'DELETE']) {
      expect((await call(u, m, `/tickets/${t.id}/messages/${mid}`)).status).toBe(404);
      expect((await call(u, m, `/tickets/${t.id}`)).status).toBe(404);
    }
  });

  it('isolation: another user gets 404 on read, reply and mark-read; RLS hides tickets from authenticated role', async () => {
    const a = await newUser();
    const b = await newUser();
    const t = (await create(a)).json.data as { id: string };
    expect((await call(b, 'GET', `/tickets/${t.id}`)).status).toBe(404);
    expect((await call(b, 'POST', `/tickets/${t.id}/messages`, { body: 'oi' })).status).toBe(404);
    expect((await call(b, 'POST', `/tickets/${t.id}/read`)).status).toBe(404);
    expect((await call(b, 'GET', '/tickets/not-a-uuid')).status).toBe(404);
    expect((await call(b, 'GET', '/tickets')).json.data).toEqual([]);
    const seen = await dbm.withUser(b, (tx) => tx.execute(sql`select id from support_tickets`));
    expect(seen).toHaveLength(0);
    const mine = await dbm.withUser(a, (tx) => tx.execute(sql`select id from support_tickets`));
    expect(mine).toHaveLength(1);
  });

  it('admin inbox: list with counts + search + filters, detail with context and internal notes, assign, resolve', async () => {
    const adm = await admin();
    const u = await newUser('Carla Souza');
    const ctx = { screen: '/mapa', plan: 'free', browser: 'Safari', os: 'iOS', appVersion: '1.0.0', timezone: 'America/Sao_Paulo' };
    const marker = `Zebra${uuid().replace(/-/g, '')}`; // P-318: unique per run, the shared db keeps old tickets
    const t1 = (await create(u, { subject: `${marker} cobrança`, type: 'billing', context: ctx })).json.data as { id: string; number: number };
    const t2 = (await create(u, { subject: `${marker} outro` })).json.data as { id: string };
    const bad = await asAdmin((tx) => inbox.assignTicket(tx, adm, uuid()));
    expect(bad.ok).toBe(false);
    expect((await asAdmin((tx) => inbox.assignTicket(tx, adm, t1.id))).ok).toBe(true);
    await asAdmin((tx) => inbox.replyAsAdmin(tx, adm, t1.id, { body: 'nota', internal: true }));
    await asAdmin((tx) => inbox.resolveTicket(tx, t2.id));
    expect((await asAdmin((tx) => inbox.resolveTicket(tx, t2.id))).ok).toBe(false); // already resolved

    const page = await inbox.listTickets(adm, { q: marker });
    expect(page.ok && page.data.counts).toEqual({ all: 2, open: 0, in_review: 1, answered: 0, resolved: 1, unassigned: 0 });
    const only = await inbox.listTickets(adm, { q: marker, status: 'in_review' });
    expect(only.ok && only.data.items.map((i) => i.id)).toEqual([t1.id]);
    expect(only.ok && only.data.total).toBe(1);
    expect(only.ok && only.data.items[0]!.assignedTo?.id).toBe(adm);
    expect(only.ok && only.data.items[0]!.user?.name).toBe('Carla Souza');
    expect((await inbox.listTickets(adm, { q: `#${t1.number}` }) as { ok: true; data: { items: unknown[] } }).data.items).toHaveLength(1);
    expect((await inbox.listTickets(adm, { q: u }) as { ok: true; data: { total: number } }).data.total).toBe(2);
    expect((await inbox.listTickets(adm, { q: marker, type: 'billing' }) as { ok: true; data: { total: number } }).data.total).toBe(1);
    expect((await inbox.listTickets(adm, { q: marker, assignedToMe: true }) as { ok: true; data: { total: number } }).data.total).toBe(1);
    expect((await inbox.listTickets(adm, { q: "%_\\'; drop" }) as { ok: true; data: { total: number } }).data.total).toBe(0);

    const det = await inbox.getTicket(adm, t1.id);
    expect(det.ok && det.data.context).toEqual(ctx);
    expect(det.ok && det.data.plan).toBe('free');
    expect(det.ok && det.data.messages.map((m) => [m.authorType, m.internal])).toEqual([['user', false], ['admin', true]]);
    expect(await inbox.ticketNumberOf(t1.id)).toBe(t1.number);
    expect(await inbox.ticketNumberOf('x')).toBeNull();
    expect((await inbox.getTicket(adm, uuid())).ok).toBe(false);
    expect((await inbox.getTicket(adm, 'x')).ok).toBe(false);
  });

  it('retention (Q-046): attachments 90 d and tickets 12 months after resolution; unresolved untouched', async () => {
    const { sweepSupport } = await import('./retention');
    const u = await newUser();
    const adm = await admin();
    const k = await upload(u, await png());
    const old = (await create(u, { attachments: [k] })).json.data as { id: string };
    const fresh = (await create(u)).json.data as { id: string };
    const open = (await create(u)).json.data as { id: string };
    await asAdmin((tx) => inbox.resolveTicket(tx, old.id));
    await asAdmin((tx) => inbox.resolveTicket(tx, fresh.id));
    await dbm.db.execute(sql`update support_tickets set resolved_at = now() - interval '91 days' where id = ${old.id}`);
    expect(await sweepSupport()).toMatchObject({ attachments: 1, tickets: 0 });
    expect(await storage.headObject(k)).toBeNull();
    expect((await call(u, 'GET', `/tickets/${old.id}`)).json.data.messages[0].attachments).toEqual([]);
    await dbm.db.execute(sql`update support_tickets set resolved_at = now() - interval '13 months' where id = ${old.id}`);
    expect(await sweepSupport()).toMatchObject({ tickets: 1 });
    expect((await call(u, 'GET', `/tickets/${old.id}`)).status).toBe(404);
    expect((await call(u, 'GET', `/tickets/${fresh.id}`)).status).toBe(200);
    expect((await call(u, 'GET', `/tickets/${open.id}`)).status).toBe(200);
    void adm;
  });

  it('account export includes tickets without internal notes; deleting the account cascades', async () => {
    const { exportAccount } = await import('../account/account');
    const u = await newUser();
    const adm = await admin();
    const t = (await create(u)).json.data as { id: string };
    await asAdmin((tx) => inbox.replyAsAdmin(tx, adm, t.id, { body: 'nota interna', internal: true }));
    const out = await exportAccount(u);
    const tickets = (out.ok ? (out.data as unknown as { tickets: { messages: unknown[]; assignedTo?: unknown }[] }).tickets : []);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.messages).toHaveLength(1);
    expect(JSON.stringify(tickets)).not.toContain('nota interna');
    await dbm.db.execute(sql`delete from auth.users where id = ${u}`);
    expect(await dbm.db.execute(sql`select 1 from support_tickets where id = ${t.id}`)).toHaveLength(0);
    expect(await dbm.db.execute(sql`select 1 from support_messages where ticket_id = ${t.id}`)).toHaveLength(0);
  });
});
