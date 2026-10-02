/**
 * F07 — Taxonomia de tópicos de Clínica Médica (curadoria Remoa, NÃO oficial).
 *
 * O INEP não publica tópicos por área. Fontes verificadas em 2026-10-02:
 *  - Portaria Inep nº 478/2025, art. 3º, I (Clínica Médica é área de formação; sem lista de temas)
 *    https://abmes.org.br/arquivos/legislacoes/Portaria-Inep-478-2025-07-18.pdf
 *  - Manual do Enamed https://download.inep.gov.br/educacao_superior/enade/manuais/manual_do_enamed_para_participantes_e_ies.pdf
 *  - Edital Inep nº 71/2026 https://download.inep.gov.br/enamed/edital_71_de_28_de_maio_de_2026.pdf (Anexo I é só cronograma)
 * Os 21 conteúdos do art. 8º são transversais; nenhum é específico de Clínica Médica.
 *
 * Portanto esta lista é curadoria Remoa (D-094, provisória), só títulos de tópico: sem dose, droga ou conduta.
 * Pendente de revisão editorial por revisor com CRM. Não afirma peso nem cobrança de prova.
 * Códigos: CM.0X = grupo (especialidade), CM.0X.YY = item. Mudar a lista exige migração de vínculos.
 */
export const ENAMED_TEMPORAL_MARK =
  'Remoa CM v1 (2026-10-02), curadoria não oficial alinhada à Portaria Inep 478/2025';

export type EnamedItem = { code: string; title: string; parentCode?: string; targetCards: number };

const groups: [string, string, string[]][] = [
  ['CM.01', 'Cardiologia', ['Hipertensão arterial sistêmica', 'Insuficiência cardíaca', 'Doença arterial coronariana e síndromes coronarianas agudas', 'Arritmias', 'Valvopatias', 'Endocardite infecciosa', 'Síncope', 'Dislipidemias', 'Parada cardiorrespiratória']],
  ['CM.02', 'Pneumologia', ['Asma', 'Doença pulmonar obstrutiva crônica', 'Pneumonias', 'Tromboembolismo pulmonar', 'Derrame pleural', 'Tuberculose pulmonar', 'Nódulo pulmonar e câncer de pulmão', 'Insuficiência respiratória']],
  ['CM.03', 'Gastroenterologia', ['Doença do refluxo gastroesofágico', 'Doença ulcerosa péptica', 'Hemorragia digestiva', 'Hepatites virais', 'Cirrose hepática e suas complicações', 'Doenças inflamatórias intestinais', 'Pancreatites', 'Diarreias', 'Doença celíaca']],
  ['CM.04', 'Nefrologia', ['Lesão renal aguda', 'Doença renal crônica', 'Distúrbios do sódio e do potássio', 'Distúrbios acidobásicos', 'Síndrome nefrótica', 'Síndrome nefrítica', 'Litíase urinária', 'Infecção do trato urinário']],
  ['CM.05', 'Endocrinologia', ['Diabetes mellitus', 'Cetoacidose diabética e estado hiperglicêmico', 'Hipotireoidismo', 'Hipertireoidismo', 'Nódulos de tireoide', 'Obesidade e síndrome metabólica', 'Doenças da suprarrenal', 'Osteoporose', 'Distúrbios do cálcio e da paratireoide']],
  ['CM.06', 'Infectologia', ['Sepse e choque séptico', 'Síndromes febris', 'HIV/aids e infecções oportunistas', 'Infecções sexualmente transmissíveis', 'Tuberculose', 'Arboviroses', 'Meningites e encefalites', 'Infecções de pele e partes moles', 'Malária e leishmanioses', 'Imunização do adulto']],
  ['CM.07', 'Hematologia', ['Anemias', 'Distúrbios da coagulação', 'Leucemias', 'Linfomas', 'Mieloma múltiplo', 'Trombocitopenias', 'Hemoterapia e transfusão']],
  ['CM.08', 'Reumatologia', ['Artrite reumatoide', 'Lúpus eritematoso sistêmico', 'Gota e artropatias por cristais', 'Espondiloartrites', 'Vasculites', 'Osteoartrite', 'Fibromialgia', 'Esclerose sistêmica']],
  ['CM.09', 'Neurologia', ['Acidente vascular cerebral', 'Epilepsias e crise convulsiva', 'Cefaleias', 'Demências', 'Doença de Parkinson', 'Doenças neuromusculares', 'Esclerose múltipla', 'Rebaixamento do nível de consciência e coma']],
];

const pad = (n: number) => String(n).padStart(2, '0');

export const ENAMED_ITEMS: EnamedItem[] = groups.flatMap(([code, title, items]) => [
  { code, title, targetCards: 40 },
  ...items.map((t, i) => ({ code: `${code}.${pad(i + 1)}`, title: t, parentCode: code, targetCards: 40 })),
]);
