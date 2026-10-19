/** Offline suggestions only. Rule hits are search evidence, never a clinical conclusion or a reviewed taxonomy binding. */
export const RULE_VERSION = 'remoa-team-classification-rules-1';
export type Rule = { id: string; course: string; area: string; topic: string; patterns: string[] };
const rules: Rule[] = [];
function add(course: string, area: string, topic: string, ...patterns: string[]) {
  rules.push({ id: `${course}.${rules.filter(r => r.course === course).length + 1}`, course, area, topic, patterns });
}
const courses = ['medicine', 'psychology', 'dentistry', 'nursing', 'physiotherapy', 'pharmacy', 'biomedicine', 'nutrition', 'physical_education', 'veterinary_medicine'];
for (const course of courses) {
  add(course, 'Saúde coletiva e políticas públicas', 'Organização do SUS', '\\bSUS\\b|sistema [úu]nico de sa[úu]de', 'universalidade|integralidade|equidade|descentraliza[çc][ãa]o|regionaliza[çc][ãa]o');
  add(course, 'Saúde coletiva e políticas públicas', 'Atenção primária à saúde', 'aten[çc][ãa]o (?:prim[áa]ria|b[áa]sica)|sa[úu]de da fam[íi]lia', 'territ[óo]rio|adscri[çc][ãa]o|longitudinalidade|v[íi]nculo|agente comunit[áa]rio');
  add(course, 'Saúde coletiva e políticas públicas', 'Epidemiologia e estudos populacionais', 'incid[êe]ncia|preval[êe]ncia', 'coorte|caso.controle|risco relativo|odds ratio|estudo transversal');
}
add('medicine', 'Clínica médica', 'Diabetes mellitus', 'diabetes|diab[ée]tic', 'glicemia|hemoglobina glicada|insulina|hipoglicemi');
add('medicine', 'Clínica médica', 'Hipertensão arterial', 'hipertens[ãa]o arterial|hipertens[oa]', 'press[ãa]o arterial|anti.hipertens|anlodipino|losartana');
add('medicine', 'Clínica médica', 'Asma', '\\basma\\b|asm[áa]tic', 'broncodilatador|sibil[oa]|corticosteroide|beta.2');
add('medicine', 'Clínica médica', 'Tuberculose', 'tuberculose|mycobacterium tuberculosis', 'baciloscopia|rifampicina|isoniazida|escarro');
add('medicine', 'Clínica médica', 'HIV e aids', '\\bHIV\\b|\\baids\\b', 'antirretroviral|CD4|carga viral|imunodefici[êe]ncia');
add('medicine', 'Clínica médica', 'Insuficiência cardíaca', 'insufici[êe]ncia card[íi]aca', 'fra[çc][ãa]o de eje[çc][ãa]o|ortopneia|edema|diur[ée]tico');
add('medicine', 'Clínica médica', 'Acidente vascular cerebral', 'acidente vascular cerebral|\\bAVC\\b', 'hemiparesia|tromb[óo]lise|isqu[êe]mic|hemorr[áa]gic');
add('medicine', 'Cirurgia', 'Apendicite aguda', 'apendicite|ap[êe]ndice', 'fossa il[íi]aca|dor abdominal|blumberg|apendicectomia');
add('medicine', 'Cirurgia', 'Colecistite e colelitíase', 'colecistite|colelit[íi]ase', 'ves[íi]cula|hipoc[ôo]ndrio|murphy|colecistectomia');
add('medicine', 'Cirurgia', 'Atendimento ao trauma', 'politrauma|traumatizado|trauma tor[áa]cico|trauma abdominal', 'via a[ée]rea|hemorragia|ABCDE|pneumot[óo]rax');
add('medicine', 'Ginecologia e obstetrícia', 'Pré-natal', 'gestante|gesta[çc][ãa]o|gr[áa]vida', 'pr[ée].natal|consulta.*gestacional|caderneta da gestante');
add('medicine', 'Ginecologia e obstetrícia', 'Síndromes hipertensivas da gestação', 'pr[ée].ecl[âa]mpsia|ecl[âa]mpsia|HELLP', 'gestante|gesta[çc][ãa]o|sulfato de magn[ée]sio|protein[úu]ria');
add('medicine', 'Ginecologia e obstetrícia', 'Trabalho de parto', 'trabalho de parto|partograma', 'dilata[çc][ãa]o|contra[çc][õo]es|colo uterino|ocitocina');
add('medicine', 'Pediatria', 'Cuidados ao recém-nascido', 'rec[ée]m.nascid|neonat', 'apgar|idade gestacional|aleitamento|nascimento|fototerapia');
add('medicine', 'Pediatria', 'Desenvolvimento infantil', 'crian[çc]a|lactente', 'desenvolvimento neuropsicomotor|marcos do desenvolvimento|sustenta.*cabe[çc]a|engatinhar');
add('medicine', 'Pediatria', 'Bronquiolite', 'bronquiolite|v[íi]rus sincicial', 'lactente|crian[çc]a|satura[çc][ãa]o|oxig[êe]nio');
add('psychology', 'Psicologia clínica', 'Avaliação psicológica', 'avalia[çc][ãa]o psicol[óo]gica|psicodiagn[óo]stico', 'teste|entrevista|instrumento|SATEPSI');
add('psychology', 'Psicologia clínica', 'Terapia cognitivo-comportamental', 'cognitivo.comportamental|\\bTCC\\b', 'pensamentos autom[áa]ticos|cren[çc]as|reestrutura[çc][ãa]o cognitiva');
add('psychology', 'Psicologia social e institucional', 'Saúde mental e atenção psicossocial', 'aten[çc][ãa]o psicossocial|\\bCAPS\\b', 'reforma psiqui[áa]trica|desinstitucionaliza[çc][ãa]o|redu[çc][ãa]o de danos');
add('psychology', 'Ética profissional', 'Ética na atuação psicológica', 'c[óo]digo de [ée]tica|conselho federal de psicologia', 'sigilo|psic[óo]log|consentimento');
add('dentistry', 'Periodontia', 'Doenças periodontais', 'periodontite|gengivite|doen[çc]a periodontal', 'sondagem|bolsa periodontal|sangramento|placa bacteriana');
add('dentistry', 'Endodontia', 'Diagnóstico e tratamento endodôntico', 'endod[ôo]ntic|pulpite|necrose pulpar', 'canal radicular|polpa|periapical|obtura[çc][ãa]o');
add('dentistry', 'Dentística', 'Cárie e restauração', 'c[áa]rie|carios', 'esmalte|dentina|resina composta|restaura[çc][ãa]o');
add('dentistry', 'Cirurgia bucomaxilofacial', 'Exodontia', 'exodontia|extra[çc][ãa]o dent[áa]ria', 'alv[ée]olo|dente|anestesia|terceiro molar');
add('nursing', 'Fundamentos de enfermagem', 'Processo de enfermagem', 'processo de enfermagem|sistematiza[çc][ãa]o da assist[êe]ncia', 'diagn[óo]stico|planejamento|implementa[çc][ãa]o|avalia[çc][ãa]o');
add('nursing', 'Fundamentos de enfermagem', 'Administração de medicamentos', 'administra[çc][ãa]o de medicamentos|c[áa]lculo de medica[çc][ãa]o', 'dose|via intramuscular|via intravenosa|dilui[çc][ãa]o|gotejamento');
add('nursing', 'Segurança do paciente', 'Prevenção de infecções', 'infec[çc][ãa]o relacionada|infec[çc][õo]es relacionadas|precau[çc][ãa]o', 'higieniza[çc][ãa]o das m[ãa]os|isolamento|equipamento de prote[çc][ãa]o');
add('nursing', 'Saúde materno-infantil', 'Aleitamento materno', 'aleitamento|amamenta[çc][ãa]o', 'pega|mama|leite materno|lactente');
add('physiotherapy', 'Fisioterapia respiratória', 'Ventilação mecânica', 'ventila[çc][ãa]o mec[âa]nica|ventilador', 'PEEP|volume corrente|press[ãa]o de suporte|desmame');
add('physiotherapy', 'Fisioterapia respiratória', 'Reabilitação pulmonar', 'reabilita[çc][ãa]o pulmonar|\\bDPOC\\b', 'exerc[íi]cio|dispneia|capacidade funcional|fisioterapia');
add('physiotherapy', 'Fisioterapia neurológica', 'Reabilitação após AVC', 'acidente vascular cerebral|\\bAVC\\b', 'reabilita[çc][ãa]o|hemiparesia|fisioterapia|marcha');
add('physiotherapy', 'Fisioterapia musculoesquelética', 'Dor lombar', 'lombalgia|dor lombar', 'coluna|exerc[íi]cio|fisioterapia|mobiliza[çc][ãa]o');
add('pharmacy', 'Farmacologia', 'Farmacocinética', 'farmacocin[ée]tica', 'absor[çc][ãa]o|distribui[çc][ãa]o|metabolismo|elimina[çc][ãa]o|biodisponibilidade');
add('pharmacy', 'Farmácia clínica', 'Interações medicamentosas', 'intera[çc][ãa]o medicamentosa|intera[çc][õo]es medicamentosas', 'f[áa]rmaco|medicamento|enzima|citocromo');
add('pharmacy', 'Assistência farmacêutica', 'Organização da assistência farmacêutica', 'assist[êe]ncia farmac[êe]utica', 'sele[çc][ãa]o|programa[çc][ãa]o|aquisi[çc][ãa]o|dispensa[çc][ãa]o');
add('pharmacy', 'Tecnologia farmacêutica', 'Formas farmacêuticas', 'forma farmac[êe]utica|formas farmac[êe]uticas', 'comprimido|c[áa]psula|emuls[ãa]o|suspens[ãa]o');
add('biomedicine', 'Análises clínicas', 'Hematologia laboratorial', 'hemograma|hemat[óo]crito', 'hemoglobina|eritr[óo]cito|leuc[óo]cito|plaqueta');
add('biomedicine', 'Análises clínicas', 'Microbiologia laboratorial', 'cultura bacteriana|antibiograma', 'amostra|laborat[óo]rio|sensibilidade|identifica[çc][ãa]o');
add('biomedicine', 'Análises clínicas', 'Parasitologia', 'parasit[óo]log|helminto|protozo[áa]rio', 'fezes|m[ée]todo|diagn[óo]stico|amostra');
add('biomedicine', 'Biologia molecular', 'Técnicas de amplificação de DNA', '\\bPCR\\b|rea[çc][ãa]o em cadeia da polimerase', '\\bDNA\\b|primer|amplifica[çc][ãa]o|polimerase');
add('nutrition', 'Nutrição clínica', 'Terapia nutricional enteral', 'nutri[çc][ãa]o enteral|terapia enteral', 'sonda|dieta|f[óo]rmula|administra[çc][ãa]o');
add('nutrition', 'Avaliação nutricional', 'Avaliação antropométrica', 'antropometria|antropom[ée]tric', '[íi]ndice de massa corporal|\\bIMC\\b|prega cut[âa]nea|circunfer[êe]ncia');
add('nutrition', 'Alimentação coletiva', 'Boas práticas em serviços de alimentação', 'boas pr[áa]ticas|manipulador', 'alimentos|temperatura|higieniza[çc][ãa]o|contamina[çc][ãa]o');
add('nutrition', 'Nutrição materno-infantil', 'Aleitamento e alimentação complementar', 'aleitamento|alimenta[çc][ãa]o complementar', 'lactente|crian[çc]a|leite materno|amamenta[çc][ãa]o');
add('physical_education', 'Fisiologia do exercício', 'Respostas cardiovasculares ao exercício', 'exerc[íi]cio|treinamento', 'frequ[êe]ncia card[íi]aca|d[ée]bito card[íi]aco|consumo de oxig[êe]nio');
add('physical_education', 'Treinamento físico', 'Treinamento de força', 'treinamento de for[çc]a|muscula[çc][ãa]o|exerc[íi]cio resistido', 'carga|hipertrofia|repeti[çc][õo]es|for[çc]a muscular');
add('physical_education', 'Educação física escolar', 'Práticas pedagógicas', 'educa[çc][ãa]o f[íi]sica escolar|aula de educa[çc][ãa]o f[íi]sica', 'curr[íi]culo|pedag[óo]gic|aluno|escola');
add('physical_education', 'Atividade física e saúde', 'Prescrição de exercícios', 'prescri[çc][ãa]o de exerc[íi]cio|programa de exerc[íi]cio', 'intensidade|frequ[êe]ncia|dura[çc][ãa]o|volume');
add('veterinary_medicine', 'Clínica e cirurgia veterinária', 'Doenças de cães e gatos', '\\bc[ãa]o\\b|canin|\\bgato\\b|felin', 'cinomose|parvovirose|leishmaniose|esporotricose');
add('veterinary_medicine', 'Reprodução animal', 'Ciclo e manejo reprodutivo', 'ciclo estral|insemina[çc][ãa]o artificial', 'bovin|equin|progesterona|ovula[çc][ãa]o');
add('veterinary_medicine', 'Inspeção de produtos de origem animal', 'Inspeção de carnes', 'inspe[çc][ãa]o|abate', 'carca[çc]a|matadouro|frigor[íi]fico|condena[çc][ãa]o');
add('veterinary_medicine', 'Saúde pública veterinária', 'Zoonoses', 'zoonose|zoon[óo]tic', 'raiva|leptospirose|brucelose|leishmaniose');
export const CLASSIFICATION_RULES: readonly Rule[] = rules;
export type Evidence = { pattern: string; start: number; end: number; text: string };
export function suggest(course: string, stem: string) {
  const candidates = CLASSIFICATION_RULES.filter(rule => rule.course === course).map(rule => {
    const evidence: Evidence[] = rule.patterns.flatMap(pattern => {
      const match = new RegExp(pattern, 'iu').exec(stem);
      return match ? [{ pattern, start: match.index, end: match.index + match[0].length, text: match[0] }] : [];
    });
    return { ruleId: rule.id, proposedArea: rule.area, proposedTopic: rule.topic, evidence, signalCount: evidence.length };
  }).filter(row => row.signalCount >= 2).sort((a, b) => b.signalCount - a.signalCount || a.ruleId.localeCompare(b.ruleId));
  if (!candidates.length) return { outcome: 'abstained' as const, reason: 'insufficient_independent_signals', suggestion: null, candidates: [] };
  if (candidates.length > 1 && candidates[0]!.signalCount === candidates[1]!.signalCount)
    return { outcome: 'conflict' as const, reason: 'multiple_topics_require_review', suggestion: null, candidates: candidates.slice(0, 5) };
  return { outcome: 'suggested' as const, reason: 'two_distinct_stem_patterns', suggestion: candidates[0]!, candidates: candidates.slice(0, 5) };
}
/** Spreadsheet-facing output, including reviewer-editable fields. Formula prefixes are escaped after leading whitespace. */
export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
