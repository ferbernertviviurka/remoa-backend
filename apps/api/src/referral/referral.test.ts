// Integration (F18 T2): attribution, public lookup, qualification + double grant, antifraud, sweep, RLS, deletion.
// Needs local Supabase (DATABASE_URL in the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateReferralCode, REFERRAL_LIMITS, type MapOp } from '@remoa/contracts';
import type { Logger } from '@remoa/log';
import { DISPOSABLE_DOMAINS, flagWeakSignals, isDisposable } from './fraud';
import { emailHash } from './email-normalize';

config({ path: '../../.env' });
// D-537: XFF counts only through trusted hops; these requests model 1 proxy(ies) in front of the API.
vi.stubEnv('TRUSTED_PROXY_HOPS', '1');


const memLog = () => {
  const lines: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const log: Logger = { info: (msg, extra) => void lines.push({ level: 'info', msg, extra }), warn: (msg, extra) => void lines.push({ level: 'warn', msg, extra }), error: (msg, extra) => void lines.push({ level: 'error', msg, extra }) };
  return { log, lines };
};

describe('F18 antifraud (unit)', () => {
  it('disposable domains, case and gmail-normalized', () => {
    expect(isDisposable('x@YOPMAIL.com')).toBe(true);
    expect(isDisposable('x+tag@mailinator.com')).toBe(true);
    expect(isDisposable('x@gmail.com')).toBe(false);
    expect(DISPOSABLE_DOMAINS.size).toBeGreaterThan(20);
  });
  it('weak signals flag on the 2nd hit within an hour, never block, ids only in the log', () => {
    const { log, lines } = memLog();
    const ref = uuid();
    expect(flagWeakSignals(ref, '1.2.3.4', 'UA', log, 1_000)).toBe(false);
    expect(flagWeakSignals(ref, '1.2.3.5', 'UA', log, 2_000)).toBe(false); // other IP
    expect(flagWeakSignals(ref, '1.2.3.4', 'UA', log, 3_000)).toBe(true);
    expect(flagWeakSignals(ref, '1.2.3.4', 'UA', log, 3_000 + 3_600_000 + 1)).toBe(false); // window passed... only one left in it
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).not.toMatch(/1\.2\.3|UA/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('F18 referral: attribution, qualification, grants, antifraud', () => {
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let q: typeof import('./qualify');
  let att: typeof import('./attribution');
  const users: string[] = [];
  const tokens: Record<string, string> = {};
  let ipSeq = 0;
  const ip = () => `10.18.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

  type Res = { status: number; headers: Headers; json: { ok?: true; data?: any; error?: { code: string; message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const req = async (method: string, path: string, o: { u?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(o.u ? { authorization: `Bearer t-${o.u}` } : {}), ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    return { status: res.status, headers: res.headers, json: res.headers.get('content-type')?.includes('json') ? await res.json() : {} };
  };
  const exec = <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) => dbm.db.execute<T>(q) as unknown as Promise<T[]>;

  /** auth user (+ profile via trigger). `ageHours` back-dates created_at; `confirmed` sets email_confirmed_at. */
  async function user(o: { email?: string; name?: string; ageHours?: number; confirmed?: boolean } = {}) {
    const id = uuid();
    users.push(id);
    tokens[`t-${id}`] = id;
    const email = o.email ?? `${id}@test.local`;
    const created = new Date(Date.now() - (o.ageHours ?? 0) * 3_600_000).toISOString();
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role, created_at, email_confirmed_at, raw_user_meta_data)
      values (${id}, ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${created}, ${o.confirmed === false ? null : created}, ${JSON.stringify({ name: o.name ?? 'Daniel Souza Lima' })}::jsonb)`);
    return id;
  }
  async function codeOf(userId: string) {
    const code = generateReferralCode();
    await dbm.db.execute(sql`insert into referral_codes (user_id, code) values (${userId}, ${code})`);
    return code;
  }
  const attribute = (u: string, code: string) => req('POST', '/v1/referral/attribution', { u, body: { code } });
  const referral = async (referee: string) => (await exec<{ id: string; status: string; reject_reason: string | null; channel: string; referrer_id: string }>(sql`select * from referrals where referee_id = ${referee}`))[0];
  const grants = (referralId: string) => exec<{ user_id: string }>(sql`select user_id from entitlement_grants where referral_id = ${referralId}`);
  /** Board with `n` live cards straight in the DB (no hook). */
  async function board(owner: string, n: number, archived = false) {
    const [b] = await exec<{ id: string }>(sql`insert into boards (user_id, title, archived_at) values (${owner}, 'Cardio', ${archived ? new Date().toISOString() : null}) returning id`);
    for (let i = 0; i < n; i++) await dbm.db.execute(sql`insert into cards (board_id, type, title, "order") values (${b!.id}, 'concept', ${'c' + i}, ${i})`);
    return b!.id;
  }
  /** Referrer + referee already attributed (fresh referee, confirmed e-mail). */
  async function pair(o: { refereeEmail?: string; referrerEmail?: string } = {}) {
    const referrer = await user({ email: o.referrerEmail, name: 'Beatriz Lima' });
    const code = await codeOf(referrer);
    const referee = await user({ email: o.refereeEmail });
    expect((await attribute(referee, code)).json.data).toEqual({ attributed: true });
    return { referrer, referee, code };
  }

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    q = await import('./qualify');
    att = await import('./attribution');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => tokens[t] ?? null });
  });
  afterAll(async () => {
    if (!dbm || !users.length) return;
    await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
  });

  it('GET /v1/public/referral/:code: valid, unknown, malformed, deleted referrer; no-store + noindex; per-IP limit', async () => {
    const r = await user({ name: '  Beatriz   Lima ' });
    const code = await codeOf(r);
    const ok = await req('GET', `/v1/public/referral/${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ valid: true, code, inviterFirstName: 'Beatriz' });
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('x-robots-tag')).toBe('noindex');
    expect((await req('GET', '/v1/public/referral/22222222')).json.data).toEqual({ valid: false });
    expect((await req('GET', '/v1/public/referral/0OIL1234')).json.data).toEqual({ valid: false }); // malformed: same answer
    await dbm.db.execute(sql`update profiles set deleted_at = now() where user_id = ${r}`);
    expect((await req('GET', `/v1/public/referral/${code}`)).json.data).toEqual({ valid: false });
    const fixed = { 'x-forwarded-for': '10.99.99.99' };
    for (let i = 0; i < REFERRAL_LIMITS.publicLookupsPerMinute; i++) expect((await req('GET', '/v1/public/referral/22222222', { headers: fixed })).status).toBe(200);
    const limited = await req('GET', '/v1/public/referral/22222222', { headers: fixed });
    expect([limited.status, limited.json.error?.code]).toEqual([429, 'rate_limited']);
  });

  it('attribution: auth, malformed, unknown, own code, old account, has a map, deleted referrer → { attributed: false }', async () => {
    const r = await user();
    const code = await codeOf(r);
    expect((await req('POST', '/v1/referral/attribution', { body: { code } })).status).toBe(401);
    const fresh = await user();
    expect((await attribute(fresh, 'nope')).status).toBe(422);
    expect((await attribute(fresh, '22222222')).json.data).toEqual({ attributed: false });
    expect((await attribute(r, code)).json.data).toEqual({ attributed: false }); // own code
    const old = await user({ ageHours: REFERRAL_LIMITS.newAccountHours + 1 });
    expect((await attribute(old, code)).json.data).toEqual({ attributed: false });
    const withMap = await user();
    await board(withMap, 0, true); // even an archived map means "not new"
    expect((await attribute(withMap, code)).json.data).toEqual({ attributed: false });
    for (const u of [fresh, r, old, withMap]) expect(await referral(u)).toBeUndefined();
    const gone = await user();
    const goneCode = await codeOf(gone);
    await dbm.db.execute(sql`update profiles set deleted_at = now() where user_id = ${gone}`);
    expect((await attribute(fresh, goneCode)).json.data).toEqual({ attributed: false });
  });

  it('attribution: link row + referred_by; first touch wins (second code, concurrent codes)', async () => {
    const { referrer, referee } = await pair();
    const row = await referral(referee);
    expect(row).toMatchObject({ channel: 'link', status: 'signed_up', referrer_id: referrer });
    expect((await exec<{ referred_by: string }>(sql`select referred_by from profiles where user_id = ${referee}`))[0]!.referred_by).toBe(referrer);
    const other = await codeOf(await user());
    expect((await attribute(referee, other)).json.data).toEqual({ attributed: false });
    expect((await referral(referee))!.referrer_id).toBe(referrer);

    const [c1, c2, c3] = [await codeOf(await user()), await codeOf(await user()), await codeOf(await user())];
    const racer = await user();
    const rs = await Promise.all([c1, c2, c3].map((c) => attribute(racer, c)));
    expect(rs.filter((x) => x.json.data?.attributed).length).toBe(1);
    expect((await exec(sql`select 1 from referrals where referee_id = ${racer}`)).length).toBe(1);
  });

  it('attribution promotes the e-mail invite of the same referrer (normalized: dots, +tag, case)', async () => {
    const referrer = await user();
    const code = await codeOf(referrer);
    const local = `ana.${uuid().slice(0, 8)}`;
    await dbm.db.execute(sql`insert into referrals (referrer_id, invited_email_hash, invited_email_masked, channel, status, expires_at)
      values (${referrer}, ${emailHash(`${local.replace('.', '')}@gmail.com`)}, 'a***@gmail.com', 'email', 'invited', now() + interval '30 days')`);
    const referee = await user({ email: `${local.toUpperCase()}+remoa@gmail.com` });
    expect((await attribute(referee, code)).json.data).toEqual({ attributed: true });
    const rows = await exec<{ channel: string; status: string }>(sql`select channel, status from referrals where referrer_id = ${referrer}`);
    expect(rows).toEqual([{ channel: 'email', status: 'signed_up' }]);
  });

  it('qualification: not referred / unconfirmed / < 3 cards / archived → no grant; map ops with 3 cards → both sides once', async () => {
    const solo = await user();
    expect(await q.maybeQualifyReferral(solo)).toBe('none');

    const { referee } = await pair();
    const id = await board(referee, 2);
    expect(await q.maybeQualifyReferral(referee)).toBe('pending');
    await board(referee, 3, true);
    expect(await q.maybeQualifyReferral(referee)).toBe('pending'); // archived does not count
    await dbm.db.execute(sql`update auth.users set email_confirmed_at = null where id = ${referee}`);
    await dbm.db.execute(sql`insert into cards (board_id, type, title, "order") values (${id}, 'concept', 'c3', 3)`);
    expect(await q.maybeQualifyReferral(referee)).toBe('pending'); // e-mail not confirmed
    await dbm.db.execute(sql`update auth.users set email_confirmed_at = now() where id = ${referee}`);
    await dbm.db.execute(sql`update cards set deleted_at = now() where board_id = ${id} and title = 'c3'`);

    // the real path: the canvas creates the 3rd card → hook in applyMapOps
    const ops: MapOp[] = [{ op: 'createCard', opId: uuid(), boardId: id, card: { id: uuid(), type: 'concept', title: 'IECA', position: { x: 0, y: 0 } } }];
    expect((await req('POST', '/v1/boards/ops', { u: referee, body: { ops } })).status).toBe(200);
    const row = (await referral(referee))!;
    expect(row.status).toBe('qualified');
    expect((await grants(row.id)).map((g) => g.user_id).sort()).toEqual([row.referrer_id, referee].sort());
    // idempotent: sequential and concurrent re-runs create nothing
    expect(await q.maybeQualifyReferral(referee)).toBe('none');
    await Promise.all([1, 2, 3].map(() => q.maybeQualifyReferral(referee)));
    expect(await grants(row.id)).toHaveLength(2);
    // the referrer's Pro is in force through getEntitlements (T4)
    const ent = await req('GET', '/v1/billing/entitlements', { u: row.referrer_id });
    expect([ent.status, ent.json.data.plan]).toEqual([200, 'pro']);
  });

  it('concurrent first calls grant exactly one pair', async () => {
    const { referee } = await pair();
    await board(referee, 3);
    const out = await Promise.all([1, 2, 3, 4].map(() => q.maybeQualifyReferral(referee)));
    expect(out.filter((x) => x === 'qualified')).toHaveLength(1);
    expect(await grants((await referral(referee))!.id)).toHaveLength(2);
  });

  it('double grant is atomic: a failure on the 2nd side rolls back the 1st and the status; the retry grants both', async () => {
    const { referee } = await pair();
    await board(referee, 3);
    const { grantReferralMonth } = await import('../billing/grants');
    let calls = 0;
    const flaky: import('./grant').GrantFn = async (tx, a) => {
      if (++calls === 2) throw new Error('simulated insert failure');
      return grantReferralMonth(tx, a);
    };
    const { log, lines } = memLog();
    expect(await q.maybeQualifyReferral(referee, { grant: flaky, log })).toBe('pending');
    expect(lines.some((l) => l.level === 'error')).toBe(true);
    const row = (await referral(referee))!;
    expect(row.status).toBe('signed_up');
    expect(await grants(row.id)).toHaveLength(0);
    expect(await q.maybeQualifyReferral(referee)).toBe('qualified');
    expect(await grants(row.id)).toHaveLength(2);
  });

  it('antifraud: disposable e-mail and Gmail self-referral → rejected with reason, no grant, referral_rejected logged', async () => {
    const l = `bia${uuid().slice(0, 6)}`;
    const cases: [{ referrerEmail?: string; refereeEmail: string }, string][] = [
      [{ refereeEmail: `x${uuid().slice(0, 6)}@yopmail.com` }, 'disposable_email'],
      [{ referrerEmail: `${l}@gmail.com`, refereeEmail: `${l.slice(0, 2)}.${l.slice(2)}+alt@googlemail.com` }, 'self_referral'],
    ];
    for (const [o, reason] of cases) {
      const { referee } = await pair(o);
      await board(referee, 3);
      const { log, lines } = memLog();
      expect(await q.maybeQualifyReferral(referee, { log })).toBe('rejected');
      const row = (await referral(referee))!;
      expect([row.status, row.reject_reason]).toEqual(['rejected', reason]);
      expect(await grants(row.id)).toHaveLength(0);
      expect(lines.find((l) => l.msg === 'referral_rejected')?.extra).toEqual({ event: 'referral_rejected', reason });
      expect(await q.maybeQualifyReferral(referee)).toBe('none'); // final
    }
  });

  it(`antifraud: ${REFERRAL_LIMITS.qualifiedPer30Days} qualified in 30 days → the next is rejected velocity_limit; older ones do not count`, async () => {
    const { referrer, referee } = await pair();
    const fill = (n: number, ago: string) =>
      dbm.db.execute(sql`insert into referrals (referrer_id, channel, status, signed_up_at, qualified_at)
        select ${referrer}, 'link', 'qualified', now() - ${ago}::interval, now() - ${ago}::interval from generate_series(1, ${n})`);
    await fill(REFERRAL_LIMITS.qualifiedPer30Days - 1, '1 day');
    await fill(5, '31 days');
    const second = await user();
    expect((await attribute(second, (await exec<{ code: string }>(sql`select code from referral_codes where user_id = ${referrer}`))[0]!.code)).json.data.attributed).toBe(true);
    await board(referee, 3);
    await board(second, 3);
    expect(await q.maybeQualifyReferral(referee)).toBe('qualified'); // 10th
    expect(await q.maybeQualifyReferral(second)).toBe('rejected'); // 11th
    expect((await referral(second))!.reject_reason).toBe('velocity_limit');
  });

  it('sweep: expires invites past expires_at, qualifies what the hooks missed', async () => {
    const referrer = await user();
    await dbm.db.execute(sql`insert into referrals (referrer_id, invited_email_hash, invited_email_masked, channel, status, expires_at) values
      (${referrer}, ${uuid()}, 'a***@x.com', 'email', 'invited', now() - interval '1 minute'),
      (${referrer}, ${uuid()}, 'b***@x.com', 'email', 'invited', now() + interval '1 day')`);
    const { referee } = await pair();
    await board(referee, 3); // straight to the DB: no hook ran
    const { sweepReferrals } = await import('./sweep');
    const r = await sweepReferrals();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await exec<{ status: string }>(sql`select status from referrals where referrer_id = ${referrer} order by expires_at`)).map((x) => x.status)).toEqual(['expired', 'invited']);
    expect((await referral(referee))!.status).toBe('qualified');
  });

  it('RLS: the referrer reads only referral_friends() (no e-mail, hash, referee id or reason); rejected looks signed_up', async () => {
    const { referrer, referee } = await pair({ refereeEmail: `z${uuid().slice(0, 6)}@yopmail.com` });
    await board(referee, 3);
    expect(await q.maybeQualifyReferral(referee)).toBe('rejected');
    await expect(dbm.withUser(referrer, (tx) => tx.execute(sql`select * from referrals`))).rejects.toThrow();
    await expect(dbm.withUser(referee, (tx) => tx.execute(sql`update profiles set referred_by = null where user_id = ${referee}`))).rejects.toThrow();
    const friends = await dbm.withUser(referrer, (tx) => tx.execute(sql`select * from referral_friends()`));
    expect(friends).toHaveLength(1);
    expect(friends[0]).toMatchObject({ display_name: 'Daniel L.', status: 'signed_up', removed: false });
    expect(Object.keys(friends[0]!).sort()).toEqual(['display_name', 'id', 'invited_at', 'qualified_at', 'removed', 'signed_up_at', 'status']);
    expect(JSON.stringify(friends)).not.toMatch(/yopmail|disposable|@/);
    expect(await dbm.withUser(referee, (tx) => tx.execute(sql`select * from referral_friends()`))).toHaveLength(0);
  });

  it('deletion (D-387): referee soft-deleted → "removed"; hard delete drops their grant, keeps the referrer\'s', async () => {
    const { referrer, referee } = await pair();
    await board(referee, 3);
    expect(await q.maybeQualifyReferral(referee)).toBe('qualified');
    const id = (await referral(referee))!.id;
    await dbm.db.execute(sql`update profiles set deleted_at = now() where user_id = ${referee}`);
    let f = await dbm.withUser(referrer, (tx) => tx.execute(sql`select display_name, removed, status from referral_friends()`));
    expect(f[0]).toEqual({ display_name: null, removed: true, status: 'qualified' });
    await dbm.db.execute(sql`delete from auth.users where id = ${referee}`);
    expect((await grants(id)).map((g) => g.user_id)).toEqual([referrer]);
    f = await dbm.withUser(referrer, (tx) => tx.execute(sql`select display_name, removed, status from referral_friends()`));
    expect(f[0]).toEqual({ display_name: null, removed: true, status: 'qualified' });
  });

  it('attribution refuses a referral cycle (A→B then B→A, A→B→C then C→A): no mutual farming, no grant-lock deadlock', async () => {
    const a = await user();
    const codeA = await codeOf(a);
    const b = await user();
    expect((await attribute(b, codeA)).json.data).toEqual({ attributed: true });
    const codeB = await codeOf(b);
    expect((await attribute(a, codeB)).json.data).toEqual({ attributed: false });
    const c = await user();
    expect((await attribute(c, codeB)).json.data).toEqual({ attributed: true });
    const d = await user();
    const codeC = await codeOf(c);
    expect((await attribute(d, codeC)).json.data).toEqual({ attributed: true }); // a chain is fine
    // a fresh A2 refers X; X refers Y; Y's code offered to A2 → cycle
    const a2 = await user();
    const x = await user();
    expect((await attribute(x, await codeOf(a2))).json.data).toEqual({ attributed: true });
    const y = await user();
    expect((await attribute(y, await codeOf(x))).json.data).toEqual({ attributed: true });
    expect((await attribute(a2, await codeOf(y))).json.data).toEqual({ attributed: false });
    // simultaneous mutual attempt: at most one wins
    const p = await user();
    const r = await user();
    const [cp, cr] = [await codeOf(p), await codeOf(r)];
    const both = await Promise.all([attribute(p, cr), attribute(r, cp)]);
    expect(both.filter((z) => z.json.data?.attributed).length).toBe(1);
  });

  it('invites: the response never waits for the e-mail provider (no timing oracle on existing accounts)', async () => {
    const { sendInvites } = await import('./invites');
    const referrer = await user();
    const realFetch = globalThis.fetch;
    let release!: () => void;
    const hang = new Promise<Response>((res) => (release = () => res(new Response('{}', { status: 200 }))));
    process.env.RESEND_API_KEY = 'test-key';
    globalThis.fetch = (() => hang) as typeof fetch;
    try {
      const out = await Promise.race([
        sendInvites(referrer, [`${uuid()}@example.com`], memLog().log),
        new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 1500)),
      ]);
      expect(out).not.toBe('timeout');
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.RESEND_API_KEY;
      release();
    }
  });

  it('P-192: invitee unsubscribe token, idempotent suppression, suppressed invite is silent and looks identical; entitlements.referralPending', async () => {
    process.env.UNSUBSCRIBE_SECRET ||= 'test-secret-test-secret';
    const { sendInvites } = await import('./invites');
    const { inviteeUnsubscribeToken } = await import('../account/reminders');
    const mailer = await import('../account/mailer');
    const { getEntitlements } = await import('../billing/entitlements');
    const referrer = await user();
    const pending = async () => ((await getEntitlements(referrer)) as { data: { referralPending: boolean } }).data.referralPending;
    expect(await pending()).toBe(false);
    const a = `${uuid()}@example.com`;
    const b = `${uuid()}@example.com`;
    const token = inviteeUnsubscribeToken(emailHash(b));
    const url = `/v1/public/unsubscribe?token=${token}`;
    expect((await req('GET', `/v1/public/unsubscribe?token=${emailHash(b)}.${'A'.repeat(43)}`)).status).toBe(422); // forged
    expect((await req('POST', url)).status).toBe(200);
    expect((await req('POST', url)).status).toBe(200); // idempotent
    expect(await exec(sql`select 1 from email_suppressions where email_hash = ${emailHash(b)}`)).toHaveLength(1);
    const out = await sendInvites(referrer, [a, b], memLog().log);
    expect(out).toEqual({ ok: true, data: { sent: 2, invitesLeftToday: out.ok ? out.data.invitesLeftToday : -1 } });
    await new Promise((r) => setTimeout(r, 50));
    expect(await exec(sql`select 1 from referrals where referrer_id = ${referrer} and invited_email_hash = ${emailHash(b)}`)).toHaveLength(0);
    expect(mailer.sentEmails().filter((m) => m.to === b)).toHaveLength(0);
    const sentA = mailer.sentEmails().filter((m) => m.to === a);
    expect(sentA).toHaveLength(1);
    expect(sentA[0]!.text).toContain(`/v1/public/unsubscribe?token=${inviteeUnsubscribeToken(emailHash(a))}`);
    expect(await pending()).toBe(true);
    await dbm.db.execute(sql`update referrals set status = 'expired' where referrer_id = ${referrer}`);
    expect(await pending()).toBe(false);
  });

  it('attributeReferral logs self-referral as referral_rejected and never the code', async () => {
    const r = await user();
    const code = await codeOf(r);
    const { log, lines } = memLog();
    expect(await att.attributeReferral(r, code, { log, ip: '1.1.1.1', ua: 'x' })).toEqual({ attributed: false });
    expect(lines[0]).toMatchObject({ msg: 'referral_rejected', extra: { event: 'referral_rejected', reason: 'self_referral' } });
    expect(JSON.stringify(lines)).not.toContain(code);
  });
});
