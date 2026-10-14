// G28-P / F35: study profile + public reference, through the app, on an isolated DB (skipped without DATABASE_URL).
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { accountExportSchema, accountSnapshotSchema } from '@remoa/contracts';

config({ path: '../../.env' });

type Json = { data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!process.env.DATABASE_URL)('F35 study profile and reference routes', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let ufpr = '';
  let usp = '';

  const newUser = async (meta?: unknown) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data) values (${id}, ${`${id}@test.local`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${meta === undefined ? null : JSON.stringify(meta)}::jsonb)`);
    return id;
  };
  let ipN = 0;
  const call = async (as: string | null, method: string, path: string, body?: unknown, ip = `203.0.113.${++ipN}`) => {
    const res = await app.request(`/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(as ? { authorization: `Bearer ${as}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, res, json: (await res.json()) as Json };
  };
  const input = (o: Record<string, unknown> = {}) => ({ situation: 'graduacao', course: 'medicine', goals: ['enamed'], period: 9, institutionText: 'Minha faculdade', ...o });

  beforeAll(async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    dbm = await import('@remoa/db');
    const { seedReference } = await import('../../../../packages/db/src/seed/reference');
    await seedReference(dbm.db);
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
    const idOf = async (acronym: string) => (await dbm.db.select({ id: dbm.institutions.id }).from(dbm.institutions).where(eq(dbm.institutions.acronym, acronym)))[0]!.id;
    ufpr = await idOf('UFPR');
    usp = await idOf('USP');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (dbm && users.length) await dbm.db.execute(sql`delete from auth.users where id = any(${`{${users.join(',')}}`}::uuid[])`);
    if (dbm) await dbm.db.execute(sql`delete from reference_suggestions where normalized like 'f35 test%'`);
  });

  describe('public reference', () => {
    it('courses: all, ordered, no auth, cacheable', async () => {
      const r = await call(null, 'GET', '/public/reference/courses');
      expect(r.status).toBe(200);
      expect(r.res.headers.get('cache-control')).toContain('max-age');
      expect(r.json.data.map((c: { name: string }) => c.name)).toEqual([
        'Medicina', 'Enfermagem', 'Odontologia', 'Farmácia', 'Fisioterapia', 'Nutrição', 'Psicologia', 'Educação Física', 'Biomedicina', 'Medicina Veterinária',
        'Outra área não relacionada à área da saúde',
      ]);
      expect(r.json.data[0].code).toBe('medicine');
      expect(r.json.data.find((c: { code: string }) => c.code === 'nursing').councilCode).toBe('COREN');
    });
    it('goals: null courseCodes = all; ?course filters; bad course 422', async () => {
      const all = (await call(null, 'GET', '/public/reference/goals')).json.data as { code: string; courseCodes: string[] | null }[];
      const nursing = (await call(null, 'GET', '/public/reference/goals?course=nursing')).json.data as typeof all;
      expect(nursing.length).toBeLessThan(all.length);
      expect(nursing.every((g) => g.courseCodes === null || g.courseCodes.includes('nursing'))).toBe(true);
      expect(nursing.some((g) => g.code === 'enamed')).toBe(false);
      expect((await call(null, 'GET', '/public/reference/goals?course=nope')).status).toBe(422);
    });
    it('institutions: accent/case-insensitive, acronym first, uf filter, limit, validation', async () => {
      const accented = (await call(null, 'GET', '/public/reference/institutions?q=SÃO PAULO&limit=5')).json;
      const plain = (await call(null, 'GET', '/public/reference/institutions?q=sao%20paulo&limit=5')).json;
      expect(plain.data.length).toBeGreaterThan(0);
      expect(plain.data).toEqual(accented.data);
      expect(plain.data.length).toBeLessThanOrEqual(5);
      expect((await call(null, 'GET', '/public/reference/institutions?q=farmacia')).status).toBe(200);
      const u = (await call(null, 'GET', '/public/reference/institutions?q=ufpr')).json.data;
      expect(u[0]).toMatchObject({ acronym: 'UFPR', uf: 'PR', type: 'public' });
      const sp = (await call(null, 'GET', '/public/reference/institutions?q=universidade&uf=SP&limit=20')).json.data as { uf: string }[];
      expect(sp.length).toBeGreaterThan(0);
      expect(sp.every((x) => x.uf === 'SP')).toBe(true);
      // G29: empty q opens the field with a list (public first); one letter already searches.
      const first = (await call(null, 'GET', '/public/reference/institutions?limit=8')).json.data as { type: string }[];
      expect(first).toHaveLength(8);
      expect(first[0]!.type).toBe('public');
      expect((await call(null, 'GET', '/public/reference/institutions?q=')).json.data).toHaveLength(10);
      expect((await call(null, 'GET', '/public/reference/institutions?q=a')).status).toBe(200);
      expect((await call(null, 'GET', '/public/reference/institutions?q=usp&limit=99')).status).toBe(422);
      expect((await call(null, 'GET', '/public/reference/institutions?q=100%25')).status).toBe(200); // % is literal, not a wildcard
    });
    it('rate limit per IP: 429 after 60 in a minute, other IPs unaffected', async () => {
      const ip = '198.51.100.9';
      for (let i = 0; i < 60; i++) expect((await call(null, 'GET', '/public/reference/courses', undefined, ip)).status).toBe(200);
      const r = await call(null, 'GET', '/public/reference/courses', undefined, ip);
      expect(r.status).toBe(429);
      expect(r.json.error?.code).toBe('rate_limited');
      expect((await call(null, 'GET', '/public/reference/courses', undefined, '198.51.100.10')).status).toBe(200);
    });
  });

  describe('study profile', () => {
    it('requires auth', async () => {
      expect((await call(null, 'GET', '/account/study-profile')).status).toBe(401);
    });
    it('no row and no metadata: null profile, legacy capabilities', async () => {
      const u = await newUser();
      const r = await call(u, 'GET', '/account/study-profile');
      expect(r.status).toBe(200);
      expect(r.json.data.profile).toBeNull();
      expect(r.json.data.capabilities).toMatchObject({ showEnamed: true, needsConfirmation: true, subjectSystem: 'enamed' });
    });
    it('valid signup metadata creates the row (source signup), idempotent', async () => {
      const u = await newUser({ study_profile: input({ context: 'signup', institutionText: 'Facul X' }) });
      const a = await call(u, 'GET', '/account/study-profile');
      expect(a.json.data.profile).toMatchObject({ source: 'signup', course: 'medicine', situation: 'graduacao', institutionText: 'Facul X', goals: ['enamed'] });
      expect(a.json.data.capabilities).toMatchObject({ showEnamed: true, needsConfirmation: false });
      await call(u, 'GET', '/account/study-profile');
      const n = await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from study_profiles where user_id = ${u}`);
      expect(n[0]!.n).toBe(1);
    });
    it('D-1862: the council number never comes from metadata and the metadata key is removed after adoption', async () => {
      const u = await newUser({ study_profile: input({ context: 'signup', situation: 'profissional', period: undefined, councilNumber: 'SP-123456' }), full_name: 'Keep me' });
      const r = await call(u, 'GET', '/account/study-profile');
      expect(r.json.data.profile).toMatchObject({ source: 'signup', situation: 'profissional', councilNumber: null });
      const meta = await dbm.db.execute<{ m: Record<string, unknown> }>(sql`select raw_user_meta_data as m from auth.users where id = ${u}`);
      expect(meta[0]!.m).not.toHaveProperty('study_profile');
      expect(meta[0]!.m).toMatchObject({ full_name: 'Keep me' });
      expect(JSON.stringify(meta[0]!.m)).not.toContain('SP-123456');
    });
    it('invalid metadata is ignored (no 500)', async () => {
      for (const meta of [{ study_profile: { course: 'medicine' } }, { study_profile: 'x' }, { study_profile: input({ goals: [] }) }]) {
        const u = await newUser(meta);
        const r = await call(u, 'GET', '/account/study-profile');
        expect(r.status).toBe(200);
        expect(r.json.data.profile).toBeNull();
      }
    });
    it('PUT validation errors are 422 and write nothing', async () => {
      const u = await newUser();
      for (const bad of [{}, input({ goals: [] }), input({ course: 'nope' }), input({ course: 'other_health' }), input({ period: 3, situation: 'residente' }), input({ councilNumber: '123' }), input({ institutionId: usp, institutionText: 'x' }), input({ extra: 1 })]) {
        const r = await call(u, 'PUT', '/account/study-profile', bad);
        expect(r.status).toBe(422);
      }
      expect((await call(u, 'PUT', '/account/study-profile', input({ institutionId: uuid(), institutionText: undefined }))).status).toBe(422); // unknown institution
      expect((await call(u, 'GET', '/account/study-profile')).json.data.profile).toBeNull();
    });
    it('PUT: institution overrides city/uf/type; source becomes profile; update keeps one row', async () => {
      const u = await newUser();
      const r = await call(u, 'PUT', '/account/study-profile', input({ institutionId: ufpr, institutionText: undefined, city: 'Lugar Errado', uf: 'AC', institutionType: 'private' }));
      expect(r.status).toBe(200);
      expect(r.json.data.profile).toMatchObject({ source: 'profile', city: 'Curitiba', uf: 'PR', institutionType: 'public', institutionText: null, institution: { id: ufpr, acronym: 'UFPR' } });
      const r2 = await call(u, 'PUT', '/account/study-profile', input({ institutionText: 'Outra', goals: ['enamed', 'residencia_medica'] }));
      expect(r2.json.data.profile).toMatchObject({ institution: null, institutionText: 'Outra', goals: ['enamed', 'residencia_medica'] });
      expect((await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from study_profiles where user_id = ${u}`))[0]!.n).toBe(1);
    });
    it('council number kept for profissional with a council, dropped otherwise', async () => {
      const u = await newUser();
      const keep = await call(u, 'PUT', '/account/study-profile', input({ situation: 'profissional', period: undefined, councilNumber: 'CRM 12345' }));
      expect(keep.json.data.profile.councilNumber).toBe('CRM 12345');
      const drop = await call(u, 'PUT', '/account/study-profile', input({ situation: 'profissional', period: undefined, course: 'other_health', courseOtherText: 'Podologia', councilNumber: '999' }));
      expect(drop.status).toBe(200);
      expect(drop.json.data.profile.councilNumber).toBeNull();
    });
    it('confirm flips a migration row to profile and capabilities follow the course', async () => {
      const med = await newUser();
      await dbm.db.insert(dbm.studyProfiles).values({ userId: med, source: 'migration', goals: ['enamed'] });
      const before = await call(med, 'GET', '/account/study-profile');
      expect(before.json.data.profile).toMatchObject({ source: 'migration', course: null });
      expect(before.json.data.capabilities).toMatchObject({ showEnamed: true, needsConfirmation: true });
      const after = await call(med, 'POST', '/account/study-profile/confirm', input());
      expect(after.status).toBe(200);
      expect(after.json.data.profile.source).toBe('profile');
      expect(after.json.data.capabilities).toMatchObject({ showEnamed: true, needsConfirmation: false });

      const nur = await newUser();
      await dbm.db.insert(dbm.studyProfiles).values({ userId: nur, source: 'migration', goals: ['enamed'] });
      const n = await call(nur, 'POST', '/account/study-profile/confirm', input({ course: 'nursing', goals: ['provas_curso'] }));
      expect(n.json.data.capabilities).toMatchObject({ showEnamed: false, needsConfirmation: false, subjectSystem: 'course_disciplines' });
      expect(n.json.data.capabilities.suggestedGoals.length).toBeGreaterThan(0);
    });
    it('RLS A/B through the API: each user only sees their own', async () => {
      const a = await newUser();
      const b = await newUser();
      await call(a, 'PUT', '/account/study-profile', input({ situation: 'profissional', period: undefined, councilNumber: 'CRM 777' }));
      const rb = await call(b, 'GET', '/account/study-profile');
      expect(rb.json.data.profile).toBeNull();
      await call(b, 'PUT', '/account/study-profile', input({ course: 'nursing', goals: ['provas_curso'] }));
      expect((await call(a, 'GET', '/account/study-profile')).json.data.profile).toMatchObject({ course: 'medicine', councilNumber: 'CRM 777' });
      expect((await call(b, 'GET', '/account/study-profile')).json.data.profile).toMatchObject({ course: 'nursing', councilNumber: null });
    });
  });

  describe('suggestions', () => {
    it('upserts by kind + normalized text, count + 1, stores no user id; 422 on bad body', async () => {
      const u = await newUser();
      expect((await call(u, 'POST', '/account/study-profile/suggestions', { kind: 'course', text: ' F35 Test  Podologia ' })).status).toBe(200);
      expect((await call(u, 'POST', '/account/study-profile/suggestions', { kind: 'course', text: 'f35 test podología' })).status).toBe(200);
      const rows = await dbm.db.execute<Record<string, unknown>>(sql`select * from reference_suggestions where normalized like 'f35 test%'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'course', normalized: 'f35 test podologia', count: 2, status: 'pending' });
      expect(Object.keys(rows[0]!).some((k) => k.includes('user'))).toBe(false);
      expect((await call(u, 'POST', '/account/study-profile/suggestions', { kind: 'nope', text: 'xx' })).status).toBe(422);
      expect((await call(u, 'POST', '/account/study-profile/suggestions', { kind: 'goal', text: 'x' })).status).toBe(422);
    });
    it('rate limited per user (429)', async () => {
      const u = await newUser();
      for (let i = 0; i < 20; i++) expect((await call(u, 'POST', '/account/study-profile/suggestions', { kind: 'goal', text: `f35 test goal ${i}` })).status).toBe(200);
      expect((await call(u, 'POST', '/account/study-profile/suggestions', { kind: 'goal', text: 'f35 test goal over' })).status).toBe(429);
    });
  });

  describe('account snapshot, export, deletion', () => {
    it('getAccount carries studyProfile + capabilities and the new completeness items', async () => {
      const u = await newUser();
      const { getAccount } = await import('../account/profile');
      const auth = { email: 'a@test.local', emailConfirmed: true, pendingEmail: null, identities: [], joinedAt: new Date() };
      const before = await getAccount(u, auth);
      expect(before.studyProfile).toBeNull();
      expect(before.capabilities).toMatchObject({ needsConfirmation: true });
      expect(before.completeness.missing).toEqual(expect.arrayContaining(['study_focus', 'course_institution']));
      await call(u, 'PUT', '/account/study-profile', input());
      const after = accountSnapshotSchema.parse(await getAccount(u, auth));
      expect(after.studyProfile).toMatchObject({ course: 'medicine', source: 'profile' });
      expect(after.completeness.missing).toEqual(['photo', 'name', 'reminder']);
    });
    it('export contains the study profile (incl. council number); deleting the user cascades', async () => {
      const u = await newUser();
      await call(u, 'PUT', '/account/study-profile', input({ situation: 'profissional', period: undefined, councilNumber: 'CRM 555' }));
      const r = await call(u, 'POST', '/account/export');
      expect(r.status).toBe(200);
      const data = accountExportSchema.parse(r.json.data);
      expect(data.studyProfile).toMatchObject({ userId: u, courseCode: 'medicine', councilNumber: 'CRM 555', source: 'profile' });
      const other = await newUser();
      expect(accountExportSchema.parse((await call(other, 'POST', '/account/export')).json.data).studyProfile).toBeNull();
      await dbm.db.execute(sql`delete from auth.users where id = ${u}`);
      expect((await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from study_profiles where user_id = ${u}`))[0]!.n).toBe(0);
    });
  });
});
