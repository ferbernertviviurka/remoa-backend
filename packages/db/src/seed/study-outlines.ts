/** Study outlines for the five seed maps. No doses: a reviewer approves the draft before it is published. */
export const studyOutlines: { title: string; source: string; text: string }[] = [
  {
    title: 'Sepse e choque séptico',
    source: 'Instituto Latino-Americano de Sepse. Protocolo gerenciado de sepse, pacote da primeira hora.',
    text: `Sepse.
Disfunção orgânica ameaçadora à vida causada por resposta desregulada a uma infecção. O rascunho cita o protocolo; a dose fica na diretriz vigente.

Choque séptico.
Sepse com alteração circulatória grave. O reconhecimento é clínico e segue o protocolo, sem número inventado aqui.

Pacote da primeira hora.
Culturas antes do antibiótico, quando isso não atrasar a primeira dose. Lactato como sinal de hipoperfusão. Reavaliar a resposta.

qSOFA.
Alerta à beira do leito. Não fecha o diagnóstico sozinho.

Foco infeccioso.
Procurar e controlar o foco. A escolha do antibiótico segue a diretriz do foco provável.

Fluxo: Conduta de sepse
1. Reconhecer disfunção orgânica associada a infecção
2. Coletar culturas antes do antibiótico, se isso não atrasar a dose
3. Tratar o foco conforme a diretriz
4. Reavaliar perfusão e lactato

Fluxo: Reavaliação de sepse
1. Conferir a resposta ao pacote inicial
2. Rever foco e antibiótico com a diretriz

Caso: Caso de sepse
Apresentação: febre, taquicardia e hipotensão com foco infeccioso suspeito
Exames: lactato e culturas, sem atrasar o antibiótico
Diagnóstico: sepse, ou choque séptico se a hipoperfusão for grave
Conduta: pacote da primeira hora e reavaliação

Relação: Sepse -> Choque séptico: pode evoluir
Relação: Sepse -> Pacote da primeira hora: conduta
Relação: Pacote da primeira hora -> Conduta de sepse: organiza`,
  },
  {
    title: 'Insuficiência cardíaca descompensada',
    source: 'Sociedade Brasileira de Cardiologia. Diretriz de insuficiência cardíaca crônica e aguda.',
    text: `Congestão.
Dispneia, edema e ganho de peso recente sugerem congestão. O peso diário ajuda a perceber a descompensação.

Perfil hemodinâmico.
A diretriz separa o paciente quente ou frio, seco ou congesto. A conduta muda com o perfil, não com uma dose fixa deste rascunho.

Restrição e peso.
Orientar restrição hídrica e registro do peso. A meta de cada paciente vem da diretriz e do quadro.

Choque cardiogênico.
Perfil frio e hipoperfundido. É emergência e segue a diretriz de insuficiência cardíaca aguda.

Fluxo: Conduta de insuficiência cardíaca
1. Reconhecer congestão e o perfil hemodinâmico
2. Tratar a congestão conforme a diretriz
3. Rever o tratamento de manutenção depois da estabilização

Fluxo: Reavaliação de insuficiência cardíaca
1. Conferir peso, dispneia e perfusão
2. Ajustar o plano com a diretriz

Caso: Caso de insuficiência cardíaca
Apresentação: dispneia aos esforços e edema de membros em quem já tem insuficiência cardíaca
Exames: peso comparado ao habitual e exames que a diretriz indica
Diagnóstico: descompensação congestiva
Conduta: tratar a congestão e reavaliar o perfil

Relação: Congestão -> Perfil hemodinâmico: classifica
Relação: Perfil hemodinâmico -> Conduta de insuficiência cardíaca: orienta`,
  },
  {
    title: 'Pneumonia',
    source: 'Sociedade Brasileira de Pneumologia e Tisiologia. Diretriz de pneumonia adquirida na comunidade.',
    text: `Pneumonia adquirida na comunidade.
Infecção aguda do parênquima pulmonar adquirida fora do hospital. O esquema antimicrobiano fica na diretriz, não neste rascunho.

CURB-65.
Escala de gravidade que ajuda a decidir o local de tratamento. Não substitui o julgamento clínico.

Oxigenoterapia.
Oferecer oxigênio quando houver hipoxemia. A meta segue a diretriz.

Reavaliação em 48 horas.
Conferir febre, oxigenação e o foco. Piora ou derrame mudam a conduta.

Fluxo: Conduta de pneumonia
1. Confirmar o quadro clínico e radiológico
2. Estimar a gravidade
3. Iniciar o tratamento empírico da diretriz
4. Reavaliar em 48 horas

Fluxo: Reavaliação de pneumonia
1. Conferir resposta clínica
2. Procurar complicação, como derrame

Caso: Caso de pneumonia
Apresentação: tosse, febre e dor pleurítica
Exames: oxigenação e imagem de tórax
Diagnóstico: pneumonia adquirida na comunidade
Conduta: gravidade, tratamento da diretriz e reavaliação

Relação: Pneumonia adquirida na comunidade -> CURB-65: gravidade
Relação: CURB-65 -> Conduta de pneumonia: orienta`,
  },
  {
    title: 'Cetoacidose diabética',
    source: 'Sociedade Brasileira de Diabetes. Diretriz de cetoacidose diabética.',
    text: `Cetoacidose diabética.
Hiperglicemia, cetonemia e acidose metabólica. É emergência.

Potássio.
Conferir o potássio antes da insulina. Se estiver baixo, repor na faixa da diretriz antes de iniciar a insulina.

Hidratação.
Repor volume com o fluido que a diretriz indica. Este rascunho não fixa volume.

Desencadeante.
Procurar infecção, falha de insulina ou outro gatilho enquanto se trata a crise.

Resolução.
A crise cede quando a acidose fecha e o paciente volta a se alimentar, pelos critérios da diretriz.

Fluxo: Conduta de cetoacidose
1. Confirmar hiperglicemia, cetose e acidose
2. Conferir o potássio antes da insulina
3. Hidratar e tratar o desencadeante conforme a diretriz
4. Reavaliar até a resolução

Fluxo: Reavaliação de cetoacidose
1. Repetir glicose, potássio e gasometria
2. Decidir a transição para insulina subcutânea pela diretriz

Caso: Caso de cetoacidose
Apresentação: sede, hálito cetônico e desidratação em pessoa com diabetes
Exames: glicose, cetonas, gasometria e potássio
Diagnóstico: cetoacidose diabética
Conduta: potássio, hidratação, insulina na hora certa e busca do desencadeante

Relação: Cetoacidose diabética -> Potássio: conferir antes
Relação: Potássio -> Conduta de cetoacidose: trava a insulina`,
  },
  {
    title: 'Hipertensão arterial',
    source: 'Sociedade Brasileira de Cardiologia. Diretriz brasileira de hipertensão arterial.',
    text: `Medida correta.
A pressão só vale se a medida seguir a técnica da diretriz: repouso, manguito adequado e mais de uma leitura.

MAPA.
A monitorização ambulatorial ajuda quando a medida de consultório não basta.

Lesão de órgão-alvo.
Coração, cérebro, rim e retina mudam o risco. A investigação segue a diretriz.

Urgência e emergência.
Urgência é pressão muito alta sem lesão aguda. Emergência é pressão alta com lesão aguda de órgão. A conduta das duas não é a mesma.

Adesão.
Grande parte do descontrole vem de tratamento irregular. Perguntar sobre o uso antes de trocar o esquema.

Fluxo: Conduta de hipertensão
1. Confirmar a medida
2. Estimar o risco e procurar lesão de órgão
3. Escolher o tratamento na diretriz
4. Combinar a meta e revisar a adesão

Fluxo: Reavaliação de hipertensão
1. Repetir a medida com técnica correta
2. Perguntar sobre adesão antes de mudar a conduta

Caso: Caso de hipertensão
Apresentação: pressão alta em mais de uma medida correta, sem sintoma agudo
Exames: avaliação de risco e de lesão de órgão, como a diretriz pede
Diagnóstico: hipertensão arterial
Conduta: medida confirmada, tratamento da diretriz e revisão da adesão

Relação: Medida correta -> MAPA: complementa
Relação: Urgência e emergência -> Conduta de hipertensão: distingue`,
  },
];

/** F07 FR-6: seed map title -> matrix item code (./enamed.ts). */
export const matrixCodeByTitle: Record<string, string[]> = {
  'Sepse e choque séptico': ['CM.06.01'],
  'Insuficiência cardíaca descompensada': ['CM.01.02'],
  'Pneumonia': ['CM.02.03'],
  'Cetoacidose diabética': ['CM.05.02'],
  'Hipertensão arterial': ['CM.01.01'],
};

