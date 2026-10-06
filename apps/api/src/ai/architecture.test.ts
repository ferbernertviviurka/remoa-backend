// G22 (CLAUDE.md rule 13): packages/ai is the only door to an AI provider. Reads the source trees as text; no database needed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const BACKEND = join(import.meta.dirname, '..', '..', '..', '..');
const FRONTEND = join(BACKEND, '..', 'remoa-frontend');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next', '.turbo', 'coverage', 'playwright-report', 'test-results', 'storybook-static'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|cjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (root: string, p: string) => relative(root, p).split(sep).join('/');
const isTest = (p: string) => /\.(test|spec)\.tsx?$/.test(p) || /\/e2e\//.test(p);
/** Code without line comments, so a comment naming a host does not count. */
const code = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SDK = /from ['"](openai|@anthropic-ai\/[\w-]+|@mistralai\/[\w-]+|@openrouter\/[\w-]+|ai|@ai-sdk\/[\w-]+)['"]|require\(['"](openai|@anthropic-ai\/[\w-]+|@mistralai\/[\w-]+)['"]\)/;
const HOSTS = /openrouter\.ai|api\.anthropic\.com|api\.mistral\.ai|api\.openai\.com/;

const backendFiles = [...walk(join(BACKEND, 'apps')), ...walk(join(BACKEND, 'packages'))].filter((p) => !isTest(p));
const outsideAi = backendFiles.filter((p) => !rel(BACKEND, p).startsWith('packages/ai/'));

describe('AI architecture (rule 13)', () => {
  it('nothing outside packages/ai imports a provider SDK', () => {
    expect(outsideAi.filter((p) => SDK.test(code(p))).map((p) => rel(BACKEND, p))).toEqual([]);
  });

  it('nothing outside packages/ai talks to an AI host', () => {
    expect(outsideAi.filter((p) => HOSTS.test(code(p))).map((p) => rel(BACKEND, p))).toEqual([]);
  });

  it('packages/ai writes no model id and no OpenRouter address in code (they come from .env)', () => {
    const ai = backendFiles.filter((p) => rel(BACKEND, p).startsWith('packages/ai/src/'));
    const bad = ai.filter((p) => /['"`](anthropic|openai|google|meta-llama|nvidia|mistralai|deepseek|qwen)\/[\w.:-]+['"`]|openrouter\.ai|mistral-ocr-latest/.test(code(p)));
    expect(bad.map((p) => rel(BACKEND, p))).toEqual([]);
  });

  it('no package.json depends on a provider SDK', () => {
    const manifests = [join(BACKEND, 'package.json'), ...readdirSync(join(BACKEND, 'packages')).map((d) => join(BACKEND, 'packages', d, 'package.json')), join(BACKEND, 'apps', 'api', 'package.json')].filter(existsSync);
    const bad = manifests.filter((p) => /"(openai|@anthropic-ai\/[\w-]+|@mistralai\/[\w-]+)"\s*:/.test(readFileSync(p, 'utf8')));
    expect(bad.map((p) => rel(BACKEND, p))).toEqual([]);
  });

  it.skipIf(!existsSync(FRONTEND))('the frontend never calls an AI provider nor exposes an AI key as NEXT_PUBLIC_', () => {
    const files = [...walk(join(FRONTEND, 'apps')), ...walk(join(FRONTEND, 'packages'))].filter((p) => !isTest(p));
    const calls = files.filter((p) => SDK.test(code(p)) || HOSTS.test(code(p))).map((p) => rel(FRONTEND, p));
    expect(calls).toEqual([]);
    const envFiles = readdirSync(join(FRONTEND, 'apps', 'web'), { withFileTypes: true }).filter((e) => e.isFile() && /^\.env\.example$|^env\.example$/.test(e.name)).map((e) => join(FRONTEND, 'apps', 'web', e.name));
    const PUBLIC_KEY = /NEXT_PUBLIC_\w*(OPENROUTER|ANTHROPIC|MISTRAL|OPENAI|AI_)\w*/;
    const leaks = [...files, ...envFiles, join(FRONTEND, '.env.example')].filter((p) => existsSync(p) && PUBLIC_KEY.test(readFileSync(p, 'utf8'))).map((p) => rel(FRONTEND, p));
    expect(leaks).toEqual([]);
  });
});
