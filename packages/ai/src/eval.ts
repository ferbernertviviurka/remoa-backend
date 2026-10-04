import { gradeOffline } from './offline';
import { graderCases } from './eval-cases';

export type EvalReport = { n: number; concordance: number; criticalHits: number; criticalExpected: number; p95Ms: number; costCents: number };

export function runOfflineEval(): EvalReport {
  const times: number[] = [];
  let hit = 0;
  let criticalHits = 0;
  let criticalExpected = 0;
  for (const c of graderCases) {
    const t = Date.now();
    const v = gradeOffline(c.input);
    times.push(Date.now() - t);
    if (v.verdict === c.verdict) hit++;
    if (c.critical) {
      criticalExpected++;
      if (v.criticalError) criticalHits++;
    }
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0;
  return { n: graderCases.length, concordance: hit / graderCases.length, criticalHits, criticalExpected, p95Ms: p95, costCents: 0 };
}
