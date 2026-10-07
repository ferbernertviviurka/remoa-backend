// G25 (F32) FR-58: 6 recorded `resumir-mapa` items over tiny maps. Each item cites card ids; unknown ids do not count (FR-49), and
// every number must be written in a cited card (FR-9). `esperado`: kept, dropped for citation, or dropped for numbers.
export type SummaryOutcome = 'mantido' | 'citacao' | 'numeros';
export type SummaryItem = { texto: string; cards: string[]; esperado: SummaryOutcome };
export type SummaryFixture = { id: string; cards: Record<string, string>; itens: SummaryItem[] };

const i = (texto: string, cards: string[], esperado: SummaryOutcome = 'mantido'): SummaryItem => ({ texto, cards, esperado });

export const summaryFixtures: SummaryFixture[] = [
  {
    id: 'r01',
    cards: {
      c1: 'Sepse: disfunção orgânica ameaçadora à vida causada por resposta desregulada à infecção.',
      c2: 'Choque séptico: necessidade de vasopressor para manter PAM ≥ 65 mmHg e lactato > 2 mmol/L apesar de reposição volêmica.',
      c3: 'Reposição inicial: cristaloide 30 mL/kg nas primeiras 3 horas.',
    },
    itens: [
      i('Choque séptico exige vasopressor para PAM ≥ 65 mmHg.', ['c2']),
      i('Repor cristaloide 30 mL/kg nas primeiras 3 horas.', ['c3']),
      i('Lactato > 4 mmol/L define choque séptico.', ['c2'], 'numeros'),
      i('Antibiótico na primeira hora.', ['c9'], 'citacao'),
    ],
  },
  {
    id: 'r02',
    cards: {
      c1: 'Hipercalemia: potássio sérico > 5,5 mEq/L.',
      c2: 'Com alteração no ECG, fazer gluconato de cálcio para estabilizar a membrana do miocárdio.',
      c3: 'Insulina regular com glicose desloca o potássio para dentro da célula.',
    },
    itens: [
      i('Hipercalemia: K > 5,5 mEq/L.', ['c1']),
      i('Gluconato de cálcio estabiliza a membrana.', ['c2', 'c7']),
      i('Insulina com glicose desloca potássio para dentro da célula.', [], 'citacao'),
    ],
  },
  {
    id: 'r03',
    cards: {
      c1: 'Cetoacidose diabética: glicemia elevada, acidose metabólica e cetonemia.',
      c2: 'Se potássio < 3,3 mEq/L, repor potássio antes de iniciar insulina.',
      c3: 'Hidratação inicial com soro fisiológico 0,9%.',
    },
    itens: [
      i('Repor potássio antes da insulina se K < 3,3 mEq/L.', ['c2']),
      i('Iniciar insulina a 0,1 UI/kg/h.', ['c2'], 'numeros'),
      i('Hidratar com soro fisiológico 0,9%.', ['c3']),
    ],
  },
  {
    id: 'r04',
    cards: {
      c1: 'Anafilaxia: reação alérgica grave de início súbito com acometimento de pele, via aérea ou circulação.',
      c2: 'Primeira droga: adrenalina intramuscular na face lateral da coxa.',
      c3: 'Dose de adrenalina no adulto: 0,5 mg IM, podendo repetir a cada 5 minutos.',
    },
    itens: [
      i('Adrenalina IM é a primeira droga.', ['c2']),
      i('Adulto: 0,5 mg IM, repetível a cada 5 minutos.', ['c3']),
      i('Adulto: 0,5 mg IM na coxa.', ['c2'], 'numeros'),
    ],
  },
  {
    id: 'r05',
    cards: {
      c1: 'CURB-65 avalia gravidade da pneumonia adquirida na comunidade.',
      c2: 'Critérios do CURB-65: confusão, ureia > 50 mg/dL, frequência respiratória ≥ 30 irpm, PA sistólica < 90 mmHg ou diastólica ≤ 60 mmHg e idade ≥ 65 anos.',
      c3: 'Escore de 0 a 1 permite tratamento ambulatorial.',
    },
    itens: [
      i('CURB-65 estima a gravidade da pneumonia comunitária.', ['c1']),
      i('Idade ≥ 65 anos pontua.', ['c2']),
      i('Ureia > 40 mg/dL pontua.', ['c2'], 'numeros'),
      i('Escore de 0 a 1: tratamento ambulatorial.', ['[C3]']),
    ],
  },
  {
    id: 'r06',
    cards: {
      c1: 'Hipertensão arterial: PA ≥ 140/90 mmHg em consultório, em mais de uma ocasião.',
      c2: 'Emergência hipertensiva: PA elevada com lesão aguda de órgão-alvo.',
      c3: 'Na emergência hipertensiva, usar anti-hipertensivo endovenoso e reduzir a PA de forma gradual.',
    },
    itens: [
      i('Hipertensão: PA ≥ 140/90 mmHg em mais de uma ocasião.', ['c1']),
      i('Na emergência, reduzir a PA em 25% na primeira hora.', ['c3'], 'numeros'),
      i('Emergência hipertensiva tem lesão aguda de órgão-alvo.', ['x1'], 'citacao'),
    ],
  },
];
