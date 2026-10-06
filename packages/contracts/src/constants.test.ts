import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { httpErrorBodySchema, nameSchema, notificationTypeSchema, notificationTypes, signUpInputSchema } from './index';
import { isNotificationType, isValidEmail, isValidName, readErrorBody } from './constants';

// CCR-058: `@remoa/contracts/constants` stays zod-free, and its guards agree with the zod schemas.
describe('@remoa/contracts/constants', () => {
  it('imports nothing at runtime (only `import type`)', () => {
    const src = readFileSync(new URL('./constants.ts', import.meta.url), 'utf8');
    expect(src.match(/^import (?!type ).*$/gm)).toBeNull();
  });

  it('isNotificationType agrees with notificationTypeSchema', () => {
    for (const x of [...notificationTypes, 'nope', 'toString', 1, null, undefined]) expect(isNotificationType(x)).toBe(notificationTypeSchema.safeParse(x).success);
  });

  it.each<unknown>([
    { error: { code: 'not_found', message: 'x' } },
    { error: { code: 'quota_exceeded', message: '', extra: 1 } },
    { error: { code: 'nope', message: 'x' } },
    { error: { code: 'toString', message: 'x' } },
    { error: { code: 'internal' } },
    { error: null },
    { error: 'internal' },
    null,
    'text',
    {},
  ])('readErrorBody matches httpErrorBodySchema for %j', (body) => {
    const parsed = httpErrorBodySchema.safeParse(body);
    expect(readErrorBody(body)).toEqual(parsed.success ? parsed.data.error : null);
  });

  it.each(['Ana', '  Ana   Souza ', 'A', 'José D’Ávila', "O'Neil", 'Jo-Ann', 'a'.repeat(60), 'a'.repeat(61), '12', 'Ana 2', '---', ' ', 'Ñandú'])('isValidName agrees with nameSchema for %j', (s) => {
    expect(isValidName(s)).toBe(nameSchema.safeParse(s).success);
  });

  it.each(['a@b.co', ' Ana@Remoa.App ', 'a.b+c@d-e.com.br', 'a@b', 'a..b@c.com', '.a@b.com', 'a@b.c', 'a@-b.com', 'sem arroba', '', "o'neil@x.org"])('isValidEmail agrees with signUpInputSchema.email for %j', (v) => {
    expect(isValidEmail(v)).toBe(signUpInputSchema.shape.email.safeParse(v).success);
  });
});
