import { runOfflineEval } from '../src/eval';

const BASELINE = 0.9;
const report = runOfflineEval();
const drop = BASELINE - report.concordance;
console.log(JSON.stringify({ ...report, baseline: BASELINE, drop }));
if (report.n < 50 || drop > 0.03 || report.criticalHits < report.criticalExpected) {
  console.error('ai eval failed');
  process.exit(1);
}
