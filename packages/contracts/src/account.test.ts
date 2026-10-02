import { describe, expect, it } from 'vitest';
import {
  computeCompleteness,
  effectiveNewCardsPerDay,
  isValidName,
  isValidPassword,
  nameSchema,
  passwordStrength,
  updatePreferencesInputSchema,
  updateProfileInputSchema,
  uploadSignInputSchema,
  usageRows,
  usageTone,
  eventSchemas,
  PLAN_LIMITS,
} from './index';

describe('computeCompleteness', () => {
  const full = { avatarKey: 'avatars/u/1.webp', name: 'Ana', goal: 'enamed_2027_1' as const };
  const ok = { emailConfirmed: true, emailPending: false };
  it.each([
    ['all done', full, true, ok, 100, []],
    ['nothing', { avatarKey: null, name: null, goal: null }, false, { emailConfirmed: false, emailPending: false }, 0, ['photo', 'name', 'email', 'goal', 'reminder']],
    ['name of 1 char after trim', { ...full, name: '  A ' }, true, ok, 80, ['name']],
    ['email pending change', full, true, { emailConfirmed: true, emailPending: true }, 80, ['email']],
    ['email unconfirmed', full, true, { emailConfirmed: false, emailPending: false }, 80, ['email']],
    ['no photo, no reminder', { ...full, avatarKey: null }, false, ok, 60, ['photo', 'reminder']],
  ] as const)('%s', (_, profile, reminderEnabled, email, percent, missing) => {
    expect(computeCompleteness(profile, { reminderEnabled }, email)).toEqual({ percent, missing });
  });
});

describe('name', () => {
  it.each([
    ['Ana', true],
    ['  João   da  Silva ', true],
    ["D'Ávila-Souza", true],
    ['Zoë', true],
    ['A', false],
    ['  A  ', false],
    ['Ana2', false],
    ['Ana!', false],
    ["-'", false],
    ['a'.repeat(60), true],
    ['a'.repeat(61), false],
  ])('%j -> %s', (name, valid) => expect(isValidName(name)).toBe(valid));
  it('collapses spaces', () => expect(nameSchema.parse('  João   da  Silva ')).toBe('João da Silva'));
});

describe('password', () => {
  it.each([
    ['', false, 0, 'weak'],
    ['abc', false, 1, 'weak'],
    ['abcdefgh', false, 1, 'weak'],
    ['12345678', false, 1, 'weak'],
    ['abcdefg1', true, 2, 'fair'],
    ['Abcdefg1', true, 3, 'good'],
    ['abcdefghijk1', true, 3, 'good'],
    ['Abcdefghijk1', true, 4, 'strong'],
    ['abcdefghij1!', true, 4, 'strong'],
    ['a1' + 'x'.repeat(71), false, 1, 'weak'], // > 72
  ] as const)('%j', (pw, valid, score, label) => {
    expect(isValidPassword(pw)).toBe(valid);
    expect(passwordStrength(pw)).toMatchObject({ score, label });
  });
  it('checklist', () =>
    expect(passwordStrength('abcdefghijkl').checks).toEqual({ minLength: true, lettersAndNumbers: false, long: true }));
});

describe('usageTone', () => {
  it.each([
    [0, 20, 'normal'],
    [15, 20, 'normal'],
    [16, 20, 'warn'],
    [19, 20, 'warn'],
    [20, 20, 'full'],
    [25, 20, 'full'],
    [0, 0, 'full'],
    [999, null, 'normal'],
  ] as const)('%d/%s -> %s', (used, limit, tone) => expect(usageTone(used, limit)).toBe(tone));
  it('usageRows covers every quota key', () => {
    const rows = usageRows({ limits: PLAN_LIMITS.free.limits, usage: { ai_grades: 20, ai_generations: 0, boards: 2, cards: 42 } });
    expect(rows.map((r) => [r.key, r.tone])).toEqual([['ai_grades', 'full'], ['ai_generations', 'normal'], ['boards', 'full'], ['cards', 'warn']]);
  });
});

describe('inputs', () => {
  it('profile update', () => {
    expect(updateProfileInputSchema.safeParse({}).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ avatarColor: 5 }).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ goal: 'undecided', stage: 'y5_6', avatarColor: 4 }).success).toBe(true);
    expect(updateProfileInputSchema.safeParse({ avatarKey: 'x' }).success).toBe(false); // server-owned
  });
  it('preferences update', () => {
    expect(updatePreferencesInputSchema.safeParse({ newCardsPerDay: 15 }).success).toBe(true);
    expect(updatePreferencesInputSchema.safeParse({ newCardsPerDay: 12 }).success).toBe(false);
    expect(updatePreferencesInputSchema.safeParse({ newCardsPerDay: 25 }).success).toBe(false);
    expect(updatePreferencesInputSchema.safeParse({ reminderHour: 9 }).success).toBe(false);
    expect(updatePreferencesInputSchema.safeParse({ reminderHour: 21, theme: 'system', reduceMotion: null }).success).toBe(true);
  });
  it('effective new cards per day', () => {
    expect(effectiveNewCardsPerDay(null, 20)).toBe(20);
    expect(effectiveNewCardsPerDay(20, 10)).toBe(10);
    expect(effectiveNewCardsPerDay(5, 10)).toBe(5);
  });
  it('avatar upload capped at 5 MB', () => {
    expect(uploadSignInputSchema.safeParse({ mime: 'image/webp', sizeBytes: 6e6, kind: 'avatar' }).success).toBe(false);
    expect(uploadSignInputSchema.safeParse({ mime: 'image/webp', sizeBytes: 6e6 }).success).toBe(true);
  });
  it('events carry no free text', () => {
    expect(eventSchemas.preference_changed.safeParse({ key: 'theme', value: 'dark' }).success).toBe(true);
    expect(eventSchemas.preference_changed.safeParse({ key: 'theme', value: 'Ana' }).success).toBe(false);
    expect(eventSchemas.profile_name_changed.safeParse({ name: 'Ana' }).success).toBe(false);
  });
});

describe('account mocks', async () => {
  const { accountFreeFixture, accountProFixture, accountDeletionFixture, accountMocks: m, resetAccountMocks, sessionsFixture } = await import('./mocks/index');
  const { accountSnapshotSchema } = await import('./index');
  it.each([accountFreeFixture, accountProFixture, accountDeletionFixture])('fixture is a valid snapshot with consistent completeness', (f) => {
    expect(accountSnapshotSchema.parse(f)).toEqual(f);
    expect(computeCompleteness(f.profile, f.preferences, { emailConfirmed: f.emailConfirmed, emailPending: !!f.pendingEmail })).toEqual(f.completeness);
  });
  it('free cap, sessions, last identity', async () => {
    resetAccountMocks();
    expect(await m.updatePreferences('u', { newCardsPerDay: 20 })).toMatchObject({ ok: false, error: { code: 'forbidden', message: 'pro_required' } });
    const cur = sessionsFixture[0]!.id;
    expect(await m.revokeSession('u', cur, cur)).toMatchObject({ ok: false });
    expect(await m.revokeOtherSessions('u', cur)).toEqual({ ok: true, data: { count: 2 } });
    expect(await m.unlinkIdentity('u', 'email')).toMatchObject({ ok: false, error: { code: 'conflict' } });
    await m.updatePreferences('u', { reminderEnabled: true });
    const snap = await m.getAccount('u');
    expect(snap.ok && snap.data.completeness.percent).toBe(80);
  });
});
