// G14 contracts: CCR-017 (cadastro), CCR-018 (mapas), CCR-019 (desafio), CCR-020 (lista de espera no admin).
import { describe, expect, it } from 'vitest';
import {
  AREA_OPTIONS, CHALLENGE_MIN_CARDS, SELF_MARK_GRADE, adminActions, adminExportResources, adminWaitlistListQuerySchema, boardListQuerySchema,
  challengeErrors, normalizeBrPhone, onboardingAnswersPatchSchema, profileSchema, signUpProfileInputSchema, startSessionInputSchema,
  syncGoals, unavailableChallengeOption, updateProfileInputSchema,
} from './index';
import { mocks } from './mocks';
import { adminMocks } from './mocks/admin';
import { fixtureUserId } from './mocks/fixtures';
import { accountFreeFixture } from './mocks/account';

const address = { cep: '01310-100', street: 'Av. Paulista', number: 'S/N', district: 'Bela Vista', city: 'São Paulo', uf: 'SP' };

describe('CCR-017 cadastro', () => {
  it('normalizes BR phones to E.164 and rejects invalid ones', () => {
    expect(normalizeBrPhone('(11) 91234-5678')).toBe('+5511912345678');
    expect(normalizeBrPhone('+55 21 3456-7890')).toBe('+552134567890');
    expect(normalizeBrPhone('5511912345678')).toBe('+5511912345678');
    for (const bad of ['11 81234-5678', '(01) 91234-5678', '1191234567', '11 1234-5678', '', '+1 415 555 0100']) expect(normalizeBrPhone(bad)).toBeNull();
  });

  it('sign-up profile: userType and phone (G20) required; sex and address optional; CEP normalized', () => {
    expect(signUpProfileInputSchema.safeParse({}).success).toBe(false);
    expect(signUpProfileInputSchema.safeParse({ userType: 'medico_formado' }).success).toBe(false);
    expect(signUpProfileInputSchema.parse({ userType: 'medico_formado', phone: '2134567890' })).toEqual({ userType: 'medico_formado', phone: '+552134567890' });
    const full = signUpProfileInputSchema.parse({ userType: 'aluno', sex: 'prefiro_nao_dizer', phone: '11912345678', address });
    expect(full.phone).toBe('+5511912345678');
    expect(full.address).toMatchObject({ cep: '01310100', complement: null, uf: 'SP' });
    expect(signUpProfileInputSchema.safeParse({ userType: 'aluno', phone: '11912345678', address: { ...address, uf: 'XX' } }).success).toBe(false);
    expect(signUpProfileInputSchema.safeParse({ userType: 'aluno', phone: '11912345678', address: { ...address, cep: '123' } }).success).toBe(false);
    expect(signUpProfileInputSchema.safeParse({ userType: 'estudante', phone: '11912345678' }).success).toBe(false);
  });

  it('profile update: goals multi-select (deduped, max 5), null clears sex/address (not phone, G20), goal and goals are exclusive', () => {
    expect(updateProfileInputSchema.parse({ goals: ['undecided', 'undecided', 'residencia_usp'] }).goals).toEqual(['undecided', 'residencia_usp']);
    expect(updateProfileInputSchema.safeParse({ goals: ['undecided', 'residencia_usp', 'enamed_2027_1', 'enamed_2027_2', 'enamed_2028_1', 'enamed_2028_2'] }).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ goal: 'undecided', goals: ['undecided'] }).success).toBe(false);
    expect(updateProfileInputSchema.parse({ address: null, sex: null })).toEqual({ address: null, sex: null });
    expect(updateProfileInputSchema.safeParse({ phone: null }).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ userType: null }).success).toBe(false);
    expect(syncGoals({ goals: ['residencia_usp', 'undecided'] })).toEqual({ goals: ['residencia_usp', 'undecided'], goal: 'residencia_usp' });
    expect(syncGoals({ goals: [] })).toEqual({ goals: [], goal: null });
    expect(syncGoals({ goal: 'undecided' })).toEqual({ goals: ['undecided'], goal: 'undecided' });
    expect(profileSchema.safeParse(accountFreeFixture.profile).success).toBe(true);
  });

  it('every grande área is listed; only CM is available; onboarding refuses the others', () => {
    expect(AREA_OPTIONS).toEqual([
      { id: 'CM', available: true }, { id: 'CIR', available: false }, { id: 'GO', available: false }, { id: 'PED', available: false }, { id: 'MP', available: false },
    ]);
    expect(onboardingAnswersPatchSchema.safeParse({ area: 'CM' }).success).toBe(true);
    expect(onboardingAnswersPatchSchema.safeParse({ area: 'PED' }).success).toBe(false);
    expect(onboardingAnswersPatchSchema.safeParse({ goals: [] }).success).toBe(false);
    expect(onboardingAnswersPatchSchema.parse({ goals: ['undecided', 'residencia_usp'] }).goals).toEqual(['undecided', 'residencia_usp']);
  });
});

describe('CCR-018 mapas', () => {
  it('list filter defaults to active; delete is permanent and owner-only', async () => {
    expect(boardListQuerySchema.parse({})).toEqual({ status: 'active' });
    expect(boardListQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false);
    const created = await mocks.createBoard(fixtureUserId, { title: 'Para apagar' });
    if (!created.ok) throw new Error('create failed');
    await mocks.updateBoard(fixtureUserId, created.data.id, { archived: true });
    const archived = await mocks.listBoards(fixtureUserId, { status: 'archived' });
    expect(archived.ok && archived.data.find((b) => b.id === created.data.id)?.archivedAt).toBeInstanceOf(Date);
    const active = await mocks.listBoards(fixtureUserId);
    expect(active.ok && active.data.some((b) => b.id === created.data.id)).toBe(false);
    expect((await mocks.deleteBoard('someone-else', created.data.id)).ok).toBe(false);
    expect(await mocks.deleteBoard(fixtureUserId, created.data.id)).toEqual({ ok: true, data: { id: created.data.id } });
    const all = await mocks.listBoards(fixtureUserId, { status: 'all' });
    expect(all.ok && all.data.some((b) => b.id === created.data.id)).toBe(false);
  });
});

describe('CCR-019 desafio', () => {
  it('options default to self/random/write; ai and voice are refused for now', () => {
    expect(startSessionInputSchema.parse({ kind: 'daily' }).options).toEqual({ gradingMode: 'self', order: 'random', answerMode: 'write' });
    expect(unavailableChallengeOption({ gradingMode: 'ai', order: 'flow', answerMode: 'write' })).toBe(challengeErrors.gradingModeUnavailable);
    expect(unavailableChallengeOption({ gradingMode: 'self', order: 'flow', answerMode: 'voice' })).toBe(challengeErrors.answerModeUnavailable);
    expect(unavailableChallengeOption({ gradingMode: 'self', order: 'flow', answerMode: 'write' })).toBeNull();
    expect(SELF_MARK_GRADE).toEqual({ correct: 'good', wrong: 'again' });
  });

  it('the mock refuses unavailable options and echoes the applied ones', async () => {
    expect(CHALLENGE_MIN_CARDS).toBe(10);
    const ai = await mocks.startSession(fixtureUserId, { kind: 'daily', options: { gradingMode: 'ai' } });
    expect(!ai.ok && ai.error).toEqual({ code: 'validation', message: challengeErrors.gradingModeUnavailable });
    const r = await mocks.startSession(fixtureUserId, { kind: 'daily', options: { order: 'flow' } });
    expect(r.ok && r.data.options).toEqual({ gradingMode: 'self', order: 'flow', answerMode: 'write' });
  });
});

describe('CCR-020 lista de espera', () => {
  it('admin list: search + audit row; CSV through the export resource', async () => {
    expect(adminActions).toContain('waitlist.view');
    expect(adminExportResources).toContain('waitlist');
    expect(adminWaitlistListQuerySchema.parse({ page: '2', segment: 'y5_6' })).toMatchObject({ page: 2, pageSize: 25, segment: 'y5_6' });
    const r = await adminMocks.listAdminWaitlist('admin', { q: 'carla' });
    expect(r.ok && r.data.items.map((i) => i.email)).toEqual(['carla@example.com']);
    const audit = await adminMocks.listAudit('admin', {});
    expect(audit.ok && audit.data.items[0]?.action).toBe('waitlist.view');
  });
});
