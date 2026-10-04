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

const heartRubric = {
  points: [
    { text: 'Reconhecer congestão', essential: true },
    { text: 'Tratar conforme a diretriz', essential: true },
  ],
  source: 'Diretriz de insuficiência cardíaca',
  version: 1,
  status: 'draft' as const,
  reviewerId: null,
};

const heart = (answer: string): GraderInput => ({
  prompt: 'Qual é o primeiro passo na descompensação?',
  canonical: 'Reconhecer congestão e seguir a diretriz.',
  rubric: heartRubric,
  neighbors: ['Congestão'],
  answer,
});

export type EvalCase = { id: string; input: GraderInput; verdict: 'correct' | 'partial' | 'incorrect'; critical: boolean };

const correctAnswers = [
  'Iniciar noradrenalina para manter a pressão arterial média e reavaliar o lactato.',
  'Conduta: iniciar noradrenalina, manter a pressão arterial média e reavaliar o lactato.',
  'No choque, iniciar noradrenalina. O alvo é manter a pressão arterial média e reavaliar o lactato.',
  'Primeiro iniciar noradrenalina e manter a pressão arterial média, depois reavaliar o lactato.',
  'Vou iniciar noradrenalina, manter a pressão arterial média e reavaliar o lactato em seguida.',
  'Plano: iniciar noradrenalina; manter a pressão arterial média; reavaliar o lactato.',
  'Recomendo iniciar noradrenalina para manter a pressão arterial média e reavaliar o lactato.',
  'A sequência é iniciar noradrenalina, manter a pressão arterial média e reavaliar o lactato.',
];
const partialAnswers = [
  'Iniciar noradrenalina apenas.',
  'Só iniciar noradrenalina, sem o alvo de pressão.',
  'Vou iniciar noradrenalina e nada mais.',
  'A conduta que lembro é iniciar noradrenalina.',
];
const outside = 'Administrar antibiotico de amplo espectro na primeira hora, sem falar da droga vasoativa.';
const criticalAnswers = [
  'Iniciar dopamina.',
  'Iniciar adrenalina.',
  'Noradrenalina 10 mg em bolus.',
  'Dopamina em infusão contínua.',
  'Adrenalina 1 mg.',
  'Fazer bolus de dopamina.',
  'Dose de 10 mg de dopamina.',
  'Usar dopamina no lugar da droga da rubrica.',
  'Conduta com adrenalina, sem a droga pedida.',
  'Iniciar dopamina 10 mg em bolus.',
];

export const graderCases: EvalCase[] = [
  ...Array.from({ length: 27 }, (_, i) => ({ id: `c${i}`, input: base(correctAnswers[i % correctAnswers.length]!), verdict: 'correct' as const, critical: false })),
  { id: 'c-heart', input: heart('Reconhecer congestão e tratar conforme a diretriz.'), verdict: 'correct', critical: false },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, input: base(partialAnswers[i % partialAnswers.length]!), verdict: 'partial' as const, critical: false })),
  { id: 'p-heart', input: heart('Reconhecer congestão apenas.'), verdict: 'partial', critical: false },
  { id: 'out', input: base(outside), verdict: 'partial' as const, critical: false },
  { id: 'blank', input: base('Não sei'), verdict: 'incorrect' as const, critical: false },
  { id: 'blank2', input: base('Não lembro agora'), verdict: 'incorrect' as const, critical: false },
  ...criticalAnswers.slice(0, 9).map((answer, i) => ({ id: `k${i}`, input: base(answer), verdict: 'incorrect' as const, critical: true })),
  { id: 'k-heart', input: heart('Dobutamina 10 mg em bolus.'), verdict: 'incorrect', critical: true },
];
