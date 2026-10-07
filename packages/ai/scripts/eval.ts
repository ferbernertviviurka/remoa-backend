import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChallengeEval } from '../eval/desafios/run';
import { runOfflineEval } from '../src/eval';
import { reportMarkdown, runModelEval } from './eval-model';

// F32: 40 correções, 10 mapas de geração e 6 resumos, só com respostas gravadas. Falha aqui derruba `pnpm ai:eval`.
const desafios = runChallengeEval();
console.log(JSON.stringify({
  desafios: {
    ok: desafios.ok,
    gates: desafios.gates,
    correcao: desafios.grading.n,
    geracao: desafios.generation.maps,
    resumo: desafios.summary.fixtures,
  },
}));
if (!desafios.ok) {
  console.error('ai eval desafios failed');
  process.exit(1);
}

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
console.log(JSON.stringify({ model: { ...model, rows: model.rows.map((r) => ({ id: r.id, pass: r.pass, detail: r.skipped ?? r.detail, calls: r.calls })) } }));

// `--report` (pnpm ai:report): rewrites docs/ai/RELATORIO-VALIDACAO.md of the parent repo (or AI_REPORT_PATH).
if (process.argv.includes('--report')) {
  const out = process.env.AI_REPORT_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/ai/RELATORIO-VALIDACAO.md');
  writeFileSync(out, reportMarkdown(model, report));
  console.log(`relatório: ${join(out)}`);
}
if (model.rows.some((r) => !r.pass && !r.known)) {
  console.error('ai model eval failed');
  process.exit(1);
}
