// G25 (F32) FR-58: 10 tiny maps (3 cards) with a recorded `gerar-perguntas-discursivas` batch each. `esperado` is the outcome of
// the server guards: kept, discarded by evidence (FR-8, quote not literal or card not in the map) or by numbers (FR-9).
import type { Evidence } from '../../src/challenge-guards';

export type GeneratedOutcome = 'mantida' | 'evidencia' | 'numeros';

export type RecordedQuestion = {
  enunciado: string;
  resposta_esperada: string;
  pontos_essenciais: string[];
  explicacao: string;
  cards: string[];
  evidencias: Evidence[];
  esperado: GeneratedOutcome;
};

export type GenerationFixture = { id: string; tema: string; cards: Record<string, string>; perguntas: RecordedQuestion[] };

const q = (enunciado: string, resposta: string, evidencias: [string, string][], esperado: GeneratedOutcome = 'mantida', extraCards: string[] = []): RecordedQuestion => ({
  enunciado,
  resposta_esperada: resposta,
  pontos_essenciais: [resposta],
  explicacao: '',
  cards: extraCards,
  evidencias: evidencias.map(([card, trecho]) => ({ card, trecho })),
  esperado,
});

export const generationFixtures: GenerationFixture[] = [
  {
    id: 'm01', tema: 'Sepse',
    cards: {
      c1: 'Sepse: disfunção orgânica ameaçadora à vida causada por resposta desregulada à infecção.',
      c2: 'Choque séptico: necessidade de vasopressor para manter PAM ≥ 65 mmHg e lactato > 2 mmol/L apesar de reposição volêmica.',
      c3: 'Reposição inicial: cristaloide 30 mL/kg nas primeiras 3 horas.',
    },
    perguntas: [
      q('Qual o alvo de PAM no choque séptico?', 'PAM ≥ 65 mmHg com vasopressor.', [['c2', 'necessidade de vasopressor para manter PAM ≥ 65 mmHg']]),
      q('Qual o volume inicial de cristaloide na sepse com hipoperfusão?', '30 mL/kg nas primeiras 3 horas.', [['c3', 'cristaloide 30 mL/kg nas primeiras 3 horas']]),
      q('Como se define sepse?', 'Disfunção orgânica causada por resposta desregulada do hospedeiro à infecção.', [['c1', '“disfunção orgânica ameaçadora à vida causada por resposta desregulada à infecção”']]),
    ],
  },
  {
    id: 'm02', tema: 'Hipercalemia',
    cards: {
      c1: 'Hipercalemia: potássio sérico > 5,5 mEq/L.',
      c2: 'Com alteração no ECG, fazer gluconato de cálcio para estabilizar a membrana do miocárdio.',
      c3: 'Insulina regular com glicose desloca o potássio para dentro da célula.',
    },
    perguntas: [
      q('A partir de qual valor de potássio sérico se define hipercalemia?', 'Potássio > 5,5 mEq/L.', [['c1', 'potássio sérico > 5,5 mEq/L']]),
      q('Qual droga estabiliza a membrana do miocárdio na hipercalemia com alteração no ECG?', 'Gluconato de cálcio.', [['c2', 'fazer gluconato de cálcio para estabilizar a membrana do miocárdio']]),
      q('Como a insulina age na hipercalemia?', 'Desloca o potássio para dentro da célula; é dada com glicose.', [['c3', 'desloca o  potássio para dentro da célula']]),
    ],
  },
  {
    id: 'm03', tema: 'Diagnóstico de diabetes',
    cards: {
      c1: 'Glicemia de jejum ≥ 126 mg/dL confirma diabetes quando repetida.',
      c2: 'HbA1c ≥ 6,5% é critério diagnóstico de diabetes.',
      c3: 'Glicemia ao acaso ≥ 200 mg/dL com sintomas clássicos dispensa confirmação.',
    },
    perguntas: [
      q('Qual valor de glicemia de jejum confirma diabetes?', '≥ 126 mg/dL, quando repetido.', [['c1', 'Glicemia de jejum ≥ 126 mg/dL confirma diabetes']]),
      q('Qual o ponto de corte da HbA1c para diagnóstico de diabetes?', 'HbA1c ≥ 6,5%.', [['c2', 'HbA1c ≥ 6,5% é critério diagnóstico']]),
      q('Quando a glicemia ao acaso dispensa confirmação?', 'Glicemia ao acaso ≥ 200 mg/dL com sintomas clássicos.', [['c3', 'glicemia aleatória acima de 200 com sintomas']], 'evidencia'),
    ],
  },
  {
    id: 'm04', tema: 'Cetoacidose diabética',
    cards: {
      c1: 'Cetoacidose diabética: glicemia elevada, acidose metabólica e cetonemia.',
      c2: 'Se potássio < 3,3 mEq/L, repor potássio antes de iniciar insulina.',
      c3: 'Hidratação inicial com soro fisiológico 0,9%.',
    },
    perguntas: [
      q('Quais achados definem a cetoacidose diabética?', 'Glicemia elevada, acidose metabólica e cetonemia.', [['c1', 'glicemia elevada, acidose metabólica e cetonemia']]),
      q('Quando repor potássio antes da insulina na cetoacidose?', 'Quando o potássio está < 3,3 mEq/L.', [['c2', 'Se potássio < 3,3 mEq/L, repor potássio antes de iniciar insulina']]),
      q('Qual a solução da hidratação inicial na cetoacidose?', 'Soro fisiológico 0,9%.', [['c3', 'soro fisiológico 0,9%']]),
    ],
  },
  {
    id: 'm05', tema: 'Anafilaxia',
    cards: {
      c1: 'Anafilaxia: reação alérgica grave de início súbito com acometimento de pele, via aérea ou circulação.',
      c2: 'Primeira droga: adrenalina intramuscular na face lateral da coxa.',
      c3: 'Dose de adrenalina no adulto: 0,5 mg IM, podendo repetir a cada 5 minutos.',
    },
    perguntas: [
      q('Qual a primeira droga na anafilaxia e por qual via?', 'Adrenalina intramuscular na face lateral da coxa.', [['c2', 'adrenalina intramuscular na face lateral da coxa']]),
      q('Qual a dose de adrenalina IM no adulto com anafilaxia?', '1 mg IM, repetida a cada 5 minutos.', [['c3', '0,5 mg IM, podendo repetir a cada 5 minutos']], 'numeros'),
      q('O que caracteriza a anafilaxia?', 'Reação alérgica grave de início súbito com pele, via aérea ou circulação.', [['c1', 'reação alérgica grave de início súbito']]),
    ],
  },
  {
    id: 'm06', tema: 'Tromboembolismo pulmonar',
    cards: {
      c1: 'TEP de alto risco: embolia pulmonar com hipotensão ou choque.',
      c2: 'No TEP de alto risco, a conduta é trombólise sistêmica se não houver contraindicação.',
      c3: 'Anticoagulação é a base do tratamento do TEP sem instabilidade.',
    },
    perguntas: [
      q('O que define TEP de alto risco?', 'Embolia pulmonar com hipotensão ou choque.', [['c1', 'embolia pulmonar com hipotensão ou choque']]),
      q('Qual a conduta no TEP de alto risco sem contraindicação?', 'Trombólise sistêmica.', [['c2', 'a conduta é trombólise sistêmica se não houver contraindicação']]),
      q('Compare o tratamento do TEP de alto risco com o do TEP sem instabilidade.', 'Alto risco: trombólise sistêmica; sem instabilidade: anticoagulação.', [['c2', 'trombólise sistêmica'], ['c3', 'Anticoagulação é a base do tratamento do TEP sem instabilidade']]),
    ],
  },
  {
    id: 'm07', tema: 'Insuficiência cardíaca',
    cards: {
      c1: 'ICFEr: insuficiência cardíaca com fração de ejeção ≤ 40%.',
      c2: 'Betabloqueador, IECA ou BRA, antagonista mineralocorticoide e iSGLT2 reduzem mortalidade na ICFEr.',
      c3: 'Diurético de alça alivia congestão, sem benefício comprovado em mortalidade.',
    },
    perguntas: [
      q('Qual fração de ejeção define ICFEr?', 'Fração de ejeção ≤ 40%.', [['c1', 'fração de ejeção ≤ 40%']]),
      q('Quais classes reduzem mortalidade na ICFEr?', 'Betabloqueador, IECA ou BRA, antagonista mineralocorticoide e iSGLT2.', [['c2', 'Betabloqueador, IECA ou BRA, antagonista mineralocorticoide e iSGLT2 reduzem mortalidade']]),
      q('O diurético de alça reduz mortalidade na insuficiência cardíaca?', 'Não; alivia congestão sem benefício comprovado em mortalidade.', [['c3', 'alivia congestão, sem benefício comprovado em mortalidade']]),
    ],
  },
  {
    id: 'm08', tema: 'Pneumonia adquirida na comunidade',
    cards: {
      c1: 'CURB-65 avalia gravidade da pneumonia adquirida na comunidade.',
      c2: 'Critérios do CURB-65: confusão, ureia > 50 mg/dL, frequência respiratória ≥ 30 irpm, PA sistólica < 90 mmHg ou diastólica ≤ 60 mmHg e idade ≥ 65 anos.',
      c3: 'Escore de 0 a 1 permite tratamento ambulatorial.',
    },
    perguntas: [
      q('O que o CURB-65 avalia?', 'Gravidade da pneumonia adquirida na comunidade.', [['c1', 'CURB-65 avalia gravidade da pneumonia adquirida na comunidade']]),
      q('Qual frequência respiratória pontua no CURB-65?', 'FR ≥ 24 irpm.', [['c2', 'frequência respiratória ≥ 30 irpm']], 'numeros'),
      q('Qual escore do CURB-65 permite tratamento ambulatorial?', 'Escore de 0 a 1.', [['c1', 'CURB-65 avalia gravidade'], ['c3', 'Escore de 0 a 1 permite tratamento ambulatorial']]),
    ],
  },
  {
    id: 'm09', tema: 'Hipoglicemia',
    cards: {
      c1: 'Hipoglicemia: glicemia < 70 mg/dL.',
      c2: 'Com rebaixamento de consciência, administrar glicose hipertônica endovenosa.',
      c3: 'Sem acesso venoso, usar glucagon intramuscular.',
    },
    perguntas: [
      q('Qual glicemia define hipoglicemia?', 'Glicemia < 70 mg/dL.', [['c1', 'glicemia < 70 mg/dL']]),
      q('Qual a conduta na hipoglicemia com rebaixamento de consciência?', 'Glicose hipertônica endovenosa.', [['c2', 'administrar glicose hipertônica endovenosa']]),
      q('E se não houver acesso venoso?', 'Glucagon intramuscular.', [['c3', 'Sem acesso venoso, usar glucagon intramuscular']]),
    ],
  },
  {
    id: 'm10', tema: 'Hipertensão arterial',
    cards: {
      c1: 'Hipertensão arterial: PA ≥ 140/90 mmHg em consultório, em mais de uma ocasião.',
      c2: 'Emergência hipertensiva: PA elevada com lesão aguda de órgão-alvo.',
      c3: 'Na emergência hipertensiva, usar anti-hipertensivo endovenoso e reduzir a PA de forma gradual.',
    },
    perguntas: [
      q('Qual valor de PA de consultório define hipertensão?', 'PA ≥ 140/90 mmHg em mais de uma ocasião.', [['c1', 'PA ≥ 140/90 mmHg em consultório']]),
      q('O que caracteriza a emergência hipertensiva?', 'Lesão aguda de órgão-alvo.', [['c2', 'PA elevada com lesão aguda de órgão-alvo']]),
      q('Como tratar a emergência hipertensiva?', 'Anti-hipertensivo endovenoso com redução gradual da PA.', [['c3', 'usar anti-hipertensivo endovenoso e reduzir a PA de forma gradual']]),
    ],
  },
];
