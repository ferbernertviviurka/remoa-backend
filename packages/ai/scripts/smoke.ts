// G22 `pnpm ai:smoke`: up to 10 real calls with synthetic text, through the same client and domain functions the API uses.
// Stops before the day count passes 40 (shared file, see budget.ts). Prints metadata only.
import { z } from 'zod';
import type { GraderInput } from '@remoa/contracts';
import { aiMode, missingConfig } from '../src/config';
import { aiUsage, generateJson, generateText, jsonStats, streamText } from '../src/client';
import { gradeWithMeta, rubricWithMeta } from '../src/grade';
import { extractWithMeta } from '../src/extract';
import { budgetLeft, loadBudget, saveBudget } from './budget';

// Scripts run outside the API: an unset NODE_ENV means a local run here, not production (the prod guard still applies on Railway).
process.env.NODE_ENV ??= 'development';

const MAX_CALLS = 10;
if (aiMode() !== 'live') {
  console.error(`ai:smoke precisa de modo live; faltam: ${missingConfig().join(', ') || 'AI=mock ligado'}`);
  process.exit(1);
}
const startCount = loadBudget();
const spent = () => aiUsage().day - startCount;

const synthetic: GraderInput = {
  prompt: 'Qual a cor do céu do planeta fictício Zorbo?',
  canonical: 'Verde',
  rubric: { points: [{ text: 'O céu de Zorbo é verde', essential: true }], source: 'Manual fictício de Zorbo', version: 1, status: 'draft', reviewerId: null },
  neighbors: [],
  answer: 'O céu de Zorbo é verde.',
};

const steps: [string, () => Promise<string>][] = [
  ['texto', async () => { const r = await generateText({ fn: 'smoke', system: 'Responda em uma palavra.', user: 'Diga ok.' }); return `${r.model} ${r.latencyMs} ms tokens ${r.tokensIn}/${r.tokensOut}`; }],
  ['json', async () => { const r = await generateJson(z.object({ cor: z.string() }), { fn: 'smoke', system: 'Responda só JSON {"cor": string}.', user: 'Cor fictícia: azul.' }); return `${r.model} ${r.latencyMs} ms reparo=${r.repaired}`; }],
  ['stream', async () => { let n = 0; let model = ''; for await (const p of streamText({ fn: 'smoke', system: 'Conte de 1 a 5.', user: 'Comece.' })) { n += 1; model = p.model; } return `${model} ${n} pedaços`; }],
  ['correção', async () => { const r = await gradeWithMeta(synthetic); return `${r.verdict.model} ${r.verdict.verdict} ${r.meta.latencyMs} ms`; }],
  ['rubrica', async () => { const r = await rubricWithMeta('Céu de Zorbo', 'O céu de Zorbo é verde por causa do gás fictício X.', 'Manual fictício'); return `${r.meta.model} ${r.rubric.points.length} pontos ${r.meta.latencyMs} ms`; }],
  ['extração', async () => { const r = await extractWithMeta('Zorbo é um planeta fictício.\n\nO céu de Zorbo é verde por causa do gás X.', 'Manual fictício'); return `${r.meta.model} ${r.extracted.cards.length} cards ${r.meta.latencyMs} ms`; }],
];

let failures = 0;
for (const [name, run] of steps) {
  if (spent() >= MAX_CALLS || budgetLeft() <= 2) {
    console.log(`parado: ${spent()} chamadas nesta execução, ${aiUsage().day} hoje (teto 40)`);
    break;
  }
  try {
    const line = await run();
    if (line.includes('offline-')) failures += 1;
    console.log(`${line.includes('offline-') ? 'FALHOU (caiu no offline)' : 'ok'.padEnd(24)} ${name}: ${line}`);
  } catch (e) {
    failures += 1;
    console.log(`FALHOU ${name}: ${e instanceof Error ? (e as { code?: string }).code ?? e.name : 'erro'}`);
  }
  saveBudget();
}
saveBudget();
console.log(`\nchamadas: ${spent()} agora, ${aiUsage().day} hoje; JSON válido de primeira ${jsonStats.validFirst}/${jsonStats.calls}, após reparo ${jsonStats.validAfterRepair}`);
process.exit(failures ? 1 : 0);
