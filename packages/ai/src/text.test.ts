import { describe, expect, it } from 'vitest';
import { cleanDeep, cleanText } from './text';

describe('cleanText (D-1446)', () => {
  it('drops NUL, C0 controls and lone surrogates; keeps tab, newlines, accents and emoji', () => {
    expect(cleanText('S\u0000e\u0001p\u001Fse\u000B\u000C')).toBe('Sepse');
    expect(cleanText('a\tb\nc\r\nd')).toBe('a\tb\nc\r\nd');
    expect(cleanText('ação 🫀')).toBe('ação 🫀');
    expect(cleanText('x\uD800y\uDC00z')).toBe('xyz');
  });

  it('cleanDeep walks arrays and plain objects, leaves Dates and numbers', () => {
    const at = new Date(0);
    const out = cleanDeep({ cards: [{ title: 'Se\u0000psis', n: 2 }], at, label: null });
    expect(out).toEqual({ cards: [{ title: 'Sepsis', n: 2 }], at, label: null });
    expect(out.at).toBe(at);
  });
});
