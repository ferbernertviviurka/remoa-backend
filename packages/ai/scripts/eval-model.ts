// G22 model eval runner. Default: replays eval/fixtures (no network, runs in CI). AI_EVAL_LIVE=1: real calls under the 40/day
// budget; with AI_EVAL_RECORD=1 the replies are saved as the new fixtures. Reports valid JSON (first try / after repair), latency.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelCases } from '../eval/model/cases';
import { aiMode } from '../src/config';
import { jsonStats } from '../src/client';
import { gradeWithMeta } from '../src/grade';
import { extractWithMeta } from '../src/extract';
import { budgetLeft, loadBudget, saveBudget } from './budget';

// Scripts run outside the API: an unset NODE_ENV means a local run here, not production (the prod guard still applies on Railway).
process.env.NODE_ENV ??= 'development';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../eval/fixtures');
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

export async function runModelEval() {
  const live = process.env.AI_EVAL_LIVE === '1';
  const record = live && process.env.AI_EVAL_RECORD === '1';
  if (live && aiMode() !== 'live') throw new Error('AI_EVAL_LIVE=1 needs OPENROUTER_API_KEY, AI_BASE_URL and AI_MODEL');
  if (!live) {
    // Replay: a fake configuration that only the fixture fetch below ever sees.
    Object.assign(process.env, { OPENROUTER_API_KEY: 'replay', AI_BASE_URL: 'http://replay.invalid/api/v1', AI_MODEL: 'fixture/model', AI_MAX_RETRIES: '0', AI_REQUIRE_FREE: '0', AI_RPD_LIMIT: '1000', AI: '' });
    delete process.env.AI_MODEL_FALLBACKS;
  } else loadBudget();
  const rows: { id: string; pass: boolean; ms: number; model: string }[] = [];
  for (const c of modelCases) {
    if (live && budgetLeft() <= 2) break;
    const path = join(fixtures, `${c.id}.json`);
    const replies: unknown[] = live ? [] : (JSON.parse(readFileSync(path, 'utf8')) as { replies: unknown[] }).replies.slice();
    const recorded: unknown[] = [];
    const fetchImpl = (live
      ? async (url: string, init?: RequestInit) => {
          const res = await fetch(url, init);
          if (record && res.ok) recorded.push(await res.clone().json());
          return res;
        }
      : async () => Response.json(replies.shift() ?? { error: { code: 599, message: 'fixture exhausted' } })) as typeof fetch;
    const started = Date.now();
    let pass = false;
    let model = '';
    if (c.fn === 'grader') {
      const r = await gradeWithMeta(c.input, fetchImpl);
      model = r.verdict.model;
      pass = !model.startsWith('offline') && c.expect(r.verdict.verdict);
    } else {
      const r = await extractWithMeta(c.text, c.source, fetchImpl);
      model = r.meta.model;
      pass = !model.startsWith('offline') && c.expect(r.extracted.cards);
    }
    rows.push({ id: c.id, pass, ms: Date.now() - started, model });
    if (record && recorded.length) writeFileSync(path, JSON.stringify({ note: `Recorded ${new Date().toISOString()} (synthetic input)`, replies: recorded }, null, 2) + '\n');
    if (live) saveBudget();
  }
  const ms = rows.map((r) => r.ms);
  return {
    mode: live ? 'live' : 'fixtures',
    n: rows.length,
    passed: rows.filter((r) => r.pass).length,
    jsonValidFirst: jsonStats.calls ? jsonStats.validFirst / jsonStats.calls : null,
    jsonValidAfterRepair: jsonStats.calls ? (jsonStats.validFirst + jsonStats.validAfterRepair) / jsonStats.calls : null,
    p50Ms: pct(ms, 0.5),
    p95Ms: pct(ms, 0.95),
    rows,
  };
}
