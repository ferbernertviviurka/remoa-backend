import { runOfflineEval } from '../src/eval';
import { runModelEval } from './eval-model';

// F05: the offline grader must stay within 3 points of the baseline.
const BASELINE = 0.9;
const report = runOfflineEval();
const drop = BASELINE - report.concordance;
console.log(JSON.stringify({ offline: { ...report, baseline: BASELINE, drop } }));
if (report.n < 50 || drop > 0.03 || report.criticalHits < report.criticalExpected) {
  console.error('ai eval failed');
  process.exit(1);
}

// G22: model eval over fixtures (default) or live (AI_EVAL_LIVE=1). Logs of the client go to stderr only on warnings.
process.env.LOG_LEVEL ??= 'error';
const model = await runModelEval();
console.log(JSON.stringify({ model }));
if (model.passed < model.n) {
  console.error('ai model eval failed');
  process.exit(1);
}
