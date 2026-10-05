// G18 CLAUDE.md rule 10 + "nothing fixed" (D-732): e-mail goes out only through notify(); no address, domain, sender or key in code.
// Reads the source tree as text, so a new offender fails CI at once. No database needed.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const API = join(import.meta.dirname);
const PKGS = join(API, '..', '..', '..', 'packages');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(join(API, '..', '..', '..'), p).split(sep).join('/');
const isTest = (p: string) => /\.test\.tsx?$/.test(p) || p.endsWith('/test-email.ts');

const apiFiles = walk(API).filter((p) => !isTest(p) && p !== join(API, 'architecture.test.ts'));
const inDir = (p: string, ...dirs: string[]) => dirs.some((d) => rel(p).startsWith(`apps/api/src/${d}/`));
/** Code (not comments): enough for these checks, a `//` line is dropped. */
const code = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('e-mail architecture (rule 10)', () => {
  it('only emails/ imports the provider SDK or @remoa/emails', () => {
    const bad = apiFiles.filter((p) => !inDir(p, 'emails') && /from ['"](resend|@remoa\/emails)['"]/.test(code(p))).map(rel);
    expect(bad).toEqual([]);
  });

  it('only emails/ and notifications/ import emails/send', () => {
    const bad = apiFiles.filter((p) => !inDir(p, 'emails', 'notifications') && /from ['"][./]+(\/emails)?\/send['"]|from ['"][./]*emails\/send['"]/.test(code(p))).map(rel);
    expect(bad).toEqual([]);
  });

  it('only emails/ and notifications/ call sendEmail / deliverEmail', () => {
    const bad = apiFiles.filter((p) => !inDir(p, 'emails', 'notifications') && /\b(sendEmail|deliverEmail)\s*\(/.test(code(p))).map(rel);
    expect(bad).toEqual([]);
  });

  it('only notifications/ writes to the notifications table', () => {
    const bad = apiFiles.filter((p) => !inDir(p, 'notifications') && /insert\s+into\s+notifications\b|\.insert\(\s*(\w+\.)?notifications\s*\)/i.test(code(p))).map(rel);
    expect(bad).toEqual([]);
  });

  it('the old plain-text mailer is gone and nobody sends e-mail through fetch to a provider', () => {
    expect(apiFiles.filter((p) => /\/account\/mailer\.ts$/.test(p))).toEqual([]);
    const bad = apiFiles.filter((p) => !inDir(p, 'emails') && /api\.resend\.com|api\.sendgrid\.com|mailgun/.test(code(p))).map(rel);
    expect(bad).toEqual([]);
  });
});

describe('nothing fixed in the code (D-732)', () => {
  // Allow list: tests, mocks/fixtures (sample data) and DB seeds (`.local` reviewer accounts, never deliverable).
  const files = [...walk(API), ...walk(PKGS)]
    .filter((p) => !isTest(p) && !p.endsWith('architecture.test.ts'))
    .filter((p) => !/\/(mocks|fixtures)\//.test(p) && !/\/seed[\w-]*\.ts$/.test(p));
  const FIXED = [
    /[\w.+-]+@remoa\.[a-z]+/i, // an address on a Remoa domain
    /\bremoa\.com\.br\b/i,
    /\bremoa\.app\b/i,
    /\bre_[A-Za-z0-9]{16,}\b/, // a Resend key
  ];

  it('no Remoa address, domain, sender or provider key is written in apps/api/src or packages/*/src', () => {
    const hits = files.flatMap((p) => FIXED.filter((r) => r.test(readFileSync(p, 'utf8'))).map((r) => `${rel(p)} ${r}`));
    expect(hits).toEqual([]);
  });
});
