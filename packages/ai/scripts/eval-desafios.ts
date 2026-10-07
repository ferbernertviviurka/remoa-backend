import { runChallengeEval } from '../eval/desafios/run';

// G25 (F32) FR-58: offline only, over recorded replies. Exits 1 when any gate fails.
const report = runChallengeEval();
const { grading: g, generation: gen, summary: s } = report;
console.log(JSON.stringify({
  desafios: {
    correcao: { n: g.n, concordancia: g.agreement, discordancias: g.disagreements, corretaRebaixada: g.downgradedCorreta, injecoes: g.injections, injecoesObedecidas: g.injectionsObeyed, vazamentosLimpos: g.leaksScrubbed, vazamentosRestantes: g.leaksRemaining },
    geracao: { mapas: gen.maps, perguntas: gen.questions, comEvidencia: gen.claimed, verificadas: gen.verified, mantidas: gen.kept, descartadas: gen.discarded, taxaEvidencia: gen.evidenceRate },
    resumo: { fixtures: s.fixtures, itens: s.items, mantidos: s.kept, descartados: s.discarded },
    regressoes: [...g.regressions, ...gen.regressions, ...s.regressions],
    gates: report.gates,
  },
}));
if (!report.ok) {
  console.error('ai eval desafios failed');
  process.exit(1);
}
