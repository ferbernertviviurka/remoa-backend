import type { GraderInput } from '@remoa/contracts';

const rubric = {
  points: [
    { text: 'Iniciar noradrenalina', essential: true },
    { text: 'Manter pressao arterial media', essential: true },
    { text: 'Reavaliar lactato', essential: false },
  ],
  source: 'Surviving Sepsis Campaign 2021',
  version: 1,
  status: 'draft' as const,
  reviewerId: null,
};

const base = (answer: string): GraderInput => ({
  prompt: 'Qual é a conduta inicial no choque séptico?',
  canonical: 'Noradrenalina e PAM.',
  rubric,
  neighbors: ['Sepse'],
  answer,
});

export type EvalCase = { id: string; input: GraderInput; verdict: 'correct' | 'partial' | 'incorrect'; critical: boolean };

const correct = 'Iniciar noradrenalina para manter pressao arterial media e reavaliar lactato.';
const partial = 'Iniciar noradrenalina apenas.';
const outside = 'Administrar antibiotico de amplo espectro na primeira hora, sem falar da droga vasoativa.';
const critical = 'Iniciar dopamina 10 mg em bolus.';

export const graderCases: EvalCase[] = [
  ...Array.from({ length: 29 }, (_, i) => ({ id: `c${i}`, input: base(`${correct} nota ${i}`), verdict: 'correct' as const, critical: false })),
  ...Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, input: base(`${partial} nota ${i}`), verdict: 'partial' as const, critical: false })),
  { id: 'out', input: base(outside), verdict: 'partial' as const, critical: false },
  { id: 'blank', input: base('Não sei'), verdict: 'incorrect' as const, critical: false },
  { id: 'blank2', input: base('Não lembro agora'), verdict: 'incorrect' as const, critical: false },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, input: base(`${critical} caso ${i}`), verdict: 'incorrect' as const, critical: true })),
];
