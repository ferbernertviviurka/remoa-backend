import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { httpErrorBodySchema, nameSchema, notificationTypeSchema, notificationTypes, signUpInputSchema } from './index';
import { isNotificationType, isValidEmail, isValidName, readErrorBody } from './constants';
import * as leaf from './constants';
import * as root from './index';
import * as catalog from './question-catalog';

// CCR-058: `@remoa/contracts/constants` stays zod-free, and its guards agree with the zod schemas.
describe('@remoa/contracts/constants', () => {
  it('CCR127 preserves F33 root/catalog/leaf identities and exact literal types',()=>{
    const names=['QUESTION_PDF_PARSER_VERSION','QUESTION_PDF_OCR_MODEL_ID','QUESTION_PDF_OCR_MODEL_COMMIT','QUESTION_PDF_OCR_MODEL_SHA256','QUESTION_PDF_OCR_DPI','QUESTION_PDF_OCR_VERSION','catalogAlternativeKeys'] as const;
    for(const name of names){expect(root[name]).toBe(leaf[name]);expect(catalog[name]).toBe(leaf[name]);}
    const dpi:180=leaf.QUESTION_PDF_OCR_DPI;
    const parser:'f33-layout-v7'=leaf.QUESTION_PDF_PARSER_VERSION;
    const keys:readonly ['A','B','C','D','E','F','G','H','I','J']=leaf.catalogAlternativeKeys;
    expect({dpi,parser,keys}).toEqual({dpi:180,parser:'f33-layout-v7',keys:['A','B','C','D','E','F','G','H','I','J']});
  });
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
