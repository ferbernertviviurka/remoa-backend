/** Dev-only blog drafts (T10/P-403): one post per template + the 4 category intros, all for human review. No clinical guidance (rule 6). */
import { blogDocSchema, type BlogBlock, type BlogDoc, type BlogMark, type BlogText, type CalloutVariant } from '@remoa/contracts';

const ext = (href: string) => /^https?:\/\//.test(href);
/** Inline mini-syntax: [text](href) and **bold**. */
function inline(s: string): BlogText[] {
  const out: BlogText[] = [];
  let last = 0;
  for (const m of s.matchAll(/\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g)) {
    if (m.index! > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    const marks: BlogMark[] = m[2]
      ? [{ type: 'link', attrs: ext(m[2]) ? { href: m[2], rel: 'nofollow', external: true } : { href: m[2] } }]
      : [{ type: 'bold' }];
    out.push({ type: 'text', text: m[1] ?? m[3]!, marks });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}
const p = (s: string): BlogBlock => ({ type: 'paragraph', content: inline(s) });
const h = (level: 2 | 3, s: string): BlogBlock => ({ type: 'heading', attrs: { level }, content: inline(s) });
const ul = (...items: string[]): BlogBlock => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem' as const, content: [{ type: 'paragraph' as const, content: inline(i) }] })) });
const callout = (variant: CalloutVariant, s: string): BlogBlock => ({ type: 'callout', attrs: { variant }, content: [{ type: 'paragraph', content: inline(s) }] });
const faq = (...items: [string, string][]): BlogBlock => ({ type: 'faq', attrs: { items: items.map(([q, a]) => ({ q, a })) } });
const doc = (...content: BlogBlock[]): BlogDoc => blogDocSchema.parse({ type: 'doc', content });

export type BlogDraft = {
  slug: string; title: string; seoTitle: string; description: string; template: 'leitura' | 'guia' | 'destaque'; categorySlug: string; focusKeyword: string; content: BlogDoc;
};

const leitura: BlogDraft = {
  slug: 'plano-de-estudo-para-residencia-medica',
  title: 'Como montar um plano de estudo para a residência médica',
  seoTitle: 'Plano de estudo para residência médica: passo a passo',
  description: 'Um plano de estudo para a residência médica começa pelo calendário e pela rotina, não pela lista de temas. Veja como montar o seu em cinco passos.',
  template: 'leitura',
  categorySlug: 'estrategia-de-estudo',
  focusKeyword: 'plano de estudo para residência médica',
  content: doc(
    p('Todo plano de estudo para a residência médica nasce de uma boa intenção e, na segunda semana, costuma morrer de excesso de ambição. A lista de temas é enorme, o plantão cansa, a prova parece distante e o cronograma bonito que você montou no domingo já não cabe na terça. Este texto propõe outro caminho: começar pelo que é fixo, medir o que é possível e deixar o resto flexível.'),
    h(2, 'Comece pelo calendário, não pelos temas'),
    p('A primeira pergunta de um plano não é "o que estudar", e sim "quanto tempo real eu tenho". Some as horas livres de uma semana comum, desconte plantões, deslocamentos, sono e o mínimo de descanso que você precisa para render. O número que sobra é o seu orçamento de estudo. Ele quase sempre é menor do que o que você imaginou, e tudo bem: um plano honesto com poucas horas vale mais do que um plano heroico que ninguém cumpre.'),
    p('Depois, marque no calendário as datas que não negociam: as provas que você pretende fazer, as inscrições e os períodos de estágio mais pesados. Trabalhe de trás para frente. Se a prova é daqui a oito meses, divida esse tempo em blocos de quatro semanas e dê a cada bloco um objetivo claro, como cobrir uma grande área ou fechar uma rodada de revisão.'),
    h(2, 'Divida o conteúdo em blocos que cabem numa semana'),
    p('Uma grande área inteira não cabe em uma semana, mas um subtópico cabe. Quebre cada área em unidades pequenas o bastante para serem concluídas e revisadas no mesmo ciclo. Quanto menor a unidade, mais frequentes as pequenas vitórias, e vitórias frequentes sustentam a rotina melhor do que a motivação.'),
    h(3, 'Um bloco por vez, com começo e fim'),
    p('Defina para cada bloco três coisas: o que você vai ler ou assistir, o que vai produzir (cards, resumo, mapa) e como vai se testar. Sem a terceira parte, o bloco vira consumo passivo, e a sensação de ter entendido engana. Testar-se é o que revela as lacunas enquanto ainda há tempo de corrigi-las.'),
    h(3, 'Reserve uma folga fixa'),
    p('Deixe pelo menos meio dia por semana sem tarefa marcada. Ela absorve o plantão que estourou, a gripe e o dia ruim. Sem folga, qualquer imprevisto vira atraso acumulado, e o atraso acumulado é o que faz as pessoas abandonarem o plano inteiro.'),
    callout('dica', 'Escreva o plano em uma única página. Se ele não cabe em uma folha, é detalhado demais para ser seguido com cansaço, e é com cansaço que você vai usá-lo.'),
    h(2, 'Troque a meta de horas pela meta de tarefas'),
    p('"Estudar quatro horas por dia" é uma meta fácil de escrever e difícil de avaliar: quatro horas olhando para o material contam? Prefira metas de entrega, como "fechar o bloco, gerar os cards e passar pela revisão do dia". Metas de tarefa mostram o progresso real e não punem quem aprende mais rápido em um dia bom.'),
    p('Isso não significa ignorar o tempo. Use as horas como moldura do orçamento e as tarefas como unidade de trabalho. Se uma tarefa consome o dobro do previsto, registre, ajuste o próximo bloco e siga em frente. O plano serve ao estudo, não o contrário.'),
    h(2, 'Inclua revisão desde o primeiro dia'),
    p('O erro mais comum é deixar a revisão para o final, como uma etapa à parte. Quem estuda assim reaprende do zero o que viu há três meses. O conteúdo esquecido não desaparece sem deixar rastro, mas volta tão fraco que a segunda leitura custa quase o mesmo que a primeira.'),
    p('Reserve uma fatia fixa de cada dia para revisar o que já foi estudado. Com a [repetição espaçada](/blog), essa fatia fica pequena e previsível: você revisa cada item perto do momento em que ele começaria a ser esquecido, e não antes. O ganho é duplo, porque você estuda menos e retém mais.'),
    ul('Dez a vinte minutos diários de revisão costumam ser suficientes no início.', 'Revise antes de começar conteúdo novo, quando a cabeça está mais fresca.', 'Se a fila acumular, reduza o conteúdo novo, nunca a revisão.'),
    h(2, 'Ajuste o plano a cada duas semanas'),
    p('Nenhum plano sobrevive intacto ao contato com a rotina. Em vez de tratar o desvio como fracasso, programe um encontro quinzenal consigo mesmo. Em dez minutos, olhe o que foi feito, o que ficou para trás e o que o ritmo real diz sobre o seu orçamento de horas. Corrija o plano com base nos dados, não na culpa.'),
    p('Esse ajuste também é o momento de olhar para o desempenho. Quais temas você erra com mais frequência nos exercícios? Eles merecem mais blocos. Quais já estão firmes? Eles podem ir para a revisão de manutenção. Um [mapa de estudo](/cadastro) ajuda aqui porque deixa visível onde as conexões entre os temas ainda estão frouxas.'),
    h(2, 'Cuide da energia como parte do plano'),
    p('Sono, alimentação e pausas não são luxo de quem está de folga; são o que sustenta a memória. Estudos sobre aprendizagem mostram de forma consistente que dormir bem depois de estudar ajuda a consolidar o que foi aprendido. Para uma visão geral, a [Wikipédia sobre consolidação da memória](https://pt.wikipedia.org/wiki/Consolida%C3%A7%C3%A3o_da_mem%C3%B3ria) é um bom ponto de partida. Cortar horas de sono para estudar mais costuma sair caro.'),
    p('Por fim, escolha um ritual de início e outro de fim para a sessão. Ele pode ser simples: abrir o material no mesmo lugar, anotar o objetivo do dia, e ao terminar registrar uma frase sobre o que ficou claro e o que ficou confuso. Pequenos rituais reduzem o atrito de começar, que é onde a maior parte da procrastinação acontece.'),
    h(2, 'Perguntas frequentes'),
    faq(
      ['Quantas horas por dia preciso estudar para a residência?', 'Não existe um número único. Depende da sua rotina, da prova e do ponto de partida. O que funciona é medir o seu orçamento real de horas e distribuí-lo em blocos com metas de tarefa.'],
      ['Devo começar pelos temas que mais caem ou pelos que mais erro?', 'Combine os dois critérios: priorize o que tem peso na prova e também o que o seu desempenho mostra como frágil. Revise o equilíbrio a cada duas semanas.'],
    ),
    p('Um plano de estudo bom é aquele que você ainda está seguindo daqui a três meses. Comece pequeno, meça, ajuste e proteja a revisão. Se quiser transformar o seu plano em um mapa vivo, com revisão espaçada embutida, [conheça o Remoa](/cadastro).'),
  ),
};

const guia: BlogDraft = {
  slug: 'repeticao-espacada-guia-para-estudantes',
  title: 'Repetição espaçada: guia prático para estudar menos e lembrar mais',
  seoTitle: 'Repetição espaçada: guia prático para estudantes',
  description: 'Entenda como funciona a repetição espaçada, por que ela combate o esquecimento e como começar a usá-la na rotina de estudo com poucos minutos por dia.',
  template: 'guia',
  categorySlug: 'tecnicas-de-memorizacao',
  focusKeyword: 'repetição espaçada',
  content: doc(
    p('A repetição espaçada é uma das poucas técnicas de estudo com apoio sólido de pesquisa e, ao mesmo tempo, uma das menos usadas na prática. A ideia é simples: em vez de rever o conteúdo várias vezes seguidas, você o revê em intervalos crescentes, sempre perto do momento em que ele estaria prestes a ser esquecido. Este guia explica o princípio, mostra como aplicá-lo e aponta os erros que mais atrapalham quem está começando.'),
    h(2, 'O problema que a técnica resolve'),
    p('Memória sem revisão decai. O psicólogo Hermann Ebbinghaus descreveu esse padrão no século XIX com a chamada curva do esquecimento: logo depois de aprender, perdemos rápido uma boa parte do que vimos e, depois, a perda desacelera. Você pode ler mais sobre o tema no verbete [curva do esquecimento](https://pt.wikipedia.org/wiki/Curva_do_esquecimento). O ponto prático é que cada revisão bem-feita achata essa curva, e o conteúdo passa a durar mais tempo antes de enfraquecer de novo.'),
    p('Estudantes que concentram a revisão na véspera da prova sentem que "sabem" o conteúdo, porque ele está fresco. Poucos dias depois, grande parte já se foi. A repetição espaçada distribui o esforço no tempo e troca a sensação de domínio de curto prazo por retenção de verdade.'),
    h(2, 'Como funciona na prática'),
    h(3, 'Intervalos que crescem'),
    p('Você aprende um item e o revisa no dia seguinte. Se lembrou, o próximo intervalo é maior, talvez uma semana. Se lembrou de novo, o intervalo cresce outra vez. Se esqueceu, o item volta para um intervalo curto. O sistema ajusta o calendário à dificuldade de cada item, e você gasta tempo onde ele é necessário.'),
    h(3, 'Recuperação ativa'),
    p('A revisão só funciona se você tentar lembrar antes de olhar a resposta. Reler o texto dá a impressão de familiaridade, mas treina o reconhecimento, não a recuperação. Por isso o formato de cartão é tão usado: de um lado a pergunta, do outro a resposta, e entre eles o seu esforço de lembrar.'),
    callout('nota', 'Dificuldade desejável: lembrar com algum esforço fortalece mais a memória do que lembrar sem esforço. Se toda revisão parece fácil demais, os intervalos podem estar curtos.'),
    h(2, 'Como começar em cinco passos'),
    ul(
      '**Escolha unidades pequenas.** Um cartão deve testar uma ideia, não um capítulo.',
      '**Escreva com as suas palavras.** Reformular obriga a entender, e o que você entende você lembra melhor.',
      '**Revise todo dia, mesmo pouco.** Dez minutos diários batem uma hora no fim de semana.',
      '**Seja honesto na nota.** Marcar "bom" quando você hesitou estraga o calendário.',
      '**Conecte os itens.** Cartões isolados são frágeis; ideias ligadas a outras ficam mais fáceis de recuperar.',
    ),
    h(2, 'Erros comuns'),
    p('O primeiro erro é criar cartões demais e longos demais. Cartões que pedem para recitar uma lista inteira geram revisões lentas e desanimadoras. Quebre a lista em perguntas curtas. O segundo é abandonar a revisão quando a fila cresce. Uma fila grande não é sinal de fracasso; é sinal de que você precisa reduzir o conteúdo novo por alguns dias até recuperar o ritmo.'),
    p('O terceiro erro é tratar a técnica como substituta do entendimento. A repetição espaçada preserva o que você já compreendeu; ela não ensina o que você ainda não entendeu. Primeiro entenda, depois fixe. Para conteúdos com muitas relações entre si, vale combinar os cartões com [mapas conceituais](/blog), que mostram como as peças se encaixam.'),
    h(2, 'Quanto tempo leva para ver resultado'),
    p('Nas primeiras semanas a rotina parece trabalhosa, porque você está construindo a base de cartões e ainda não colhe os intervalos longos. Depois de um mês, a revisão diária tende a se estabilizar e o esforço fica previsível. É nesse ponto que muita gente percebe que consegue manter um volume grande de conteúdo sem passar a vida revisando.'),
    p('Vale lembrar que o ganho não é uniforme. Itens simples se estabilizam rápido; itens que dependem de contexto precisam de mais voltas. Isso é esperado, e é justamente para isso que o espaçamento adaptativo existe.'),
    h(2, 'Perguntas frequentes'),
    faq(
      ['Preciso de um aplicativo para usar repetição espaçada?', 'Não é obrigatório, dá para usar fichas de papel e uma agenda. Mas um programa calcula os intervalos por você e evita o trabalho manual, o que ajuda a manter o hábito.'],
      ['Posso usar a técnica para qualquer matéria?', 'Funciona melhor para conteúdo que exige memória factual e conceitual. Para habilidades práticas, ela complementa o treino, mas não o substitui.'],
      ['E se eu perder alguns dias de revisão?', 'Retome de onde parou, sem tentar compensar tudo de uma vez. Reduza o conteúdo novo até a fila voltar ao normal.'],
    ),
    p('A repetição espaçada pede pouco e devolve muito: alguns minutos por dia, um pouco de honestidade e paciência no primeiro mês. Se você quer testar a técnica em mapas conectados, com a revisão calculada para você, [crie sua conta no Remoa](/cadastro) e comece por um único tema.'),
  ),
};

const destaque: BlogDraft = {
  slug: 'mapas-conceituais-para-estudar-residencia',
  title: 'Mapas conceituais: por que conectar ideias vence decorar listas',
  seoTitle: 'Mapas conceituais para estudar residência médica',
  description: 'Mapas conceituais ajudam a ligar os temas da residência em vez de decorá-los soltos. Veja como montar um mapa e usá-lo para revisar e se testar.',
  template: 'destaque',
  categorySlug: 'enamed-e-residencia',
  focusKeyword: 'mapas conceituais',
  content: doc(
    p('Quem estuda para a residência convive com um volume de conteúdo que parece não caber na cabeça. A reação natural é decorar: listas, tabelas, esquemas copiados. Funciona por um tempo, e depois a prova apresenta o tema por um ângulo diferente e a lista não ajuda. Os mapas conceituais atacam esse problema de frente, porque trocam a memória de itens soltos pela memória de relações.'),
    h(2, 'O que é um mapa conceitual'),
    p('Um mapa conceitual é um diagrama em que cada ideia ocupa um nó e as ligações entre os nós carregam um rótulo que explica a relação. A técnica foi desenvolvida pelo pesquisador Joseph Novak a partir da teoria da aprendizagem significativa; há uma boa introdução em [mapa conceitual](https://pt.wikipedia.org/wiki/Mapa_conceitual). O que diferencia o mapa de um simples esquema é o rótulo na ligação: dizer "A leva a B" ou "A diferencia-se de B por" exige que você entenda o vínculo, e não apenas reconheça os dois termos.'),
    h(2, 'Por que ele ajuda a lembrar'),
    h(3, 'Cada ideia ganha mais de um caminho'),
    p('Quando um conceito está ligado a vários outros, você tem várias rotas para chegar até ele. Se uma rota falha na hora da prova, outra pode funcionar. Uma lista oferece um único caminho: a posição do item na sequência. Esquecer o começo da lista costuma significar esquecer todo o resto.'),
    h(3, 'Você enxerga as lacunas'),
    p('Ao montar o mapa, os buracos aparecem sozinhos. Aquela ligação que você não sabe rotular indica exatamente o que ainda não entendeu. Em um resumo corrido, essa dúvida passa despercebida, porque o texto fluente disfarça a lacuna. No mapa, o espaço em branco é visível e incômodo, o que é ótimo para quem quer estudar com eficiência.'),
    h(3, 'Ele ensina a raciocinar por comparação'),
    p('Boa parte das questões de residência pede para distinguir situações parecidas ou escolher entre opções plausíveis. Um mapa bem feito destaca as diferenças e as semelhanças entre ideias vizinhas, que é justamente o raciocínio exigido na prova.'),
    callout('atencao', 'Mapa bonito não é mapa que ensina. Se você copiou o diagrama de alguém sem rotular as ligações com as suas palavras, ele serve de consulta, mas pouco de estudo.'),
    h(2, 'Como montar o seu em quatro etapas'),
    ul(
      '**Escolha um tema com fronteiras claras.** Um mapa por tema evita o emaranhado impossível de ler.',
      '**Liste os conceitos-chave.** Quinze a vinte nós já é um mapa grande; menos que isso costuma bastar.',
      '**Ligue e rotule.** Use verbos curtos e específicos nas ligações, evitando rótulos vagos como "relacionado a".',
      '**Teste o mapa.** Cubra um nó, tente reconstruí-lo a partir das ligações e confira.',
    ),
    h(2, 'Do mapa à revisão'),
    p('Um mapa estático é uma boa anotação, mas só vira ferramenta de memória quando entra na rotina de revisão. A ideia é revisitar os nós e as ligações em intervalos espaçados, priorizando os que você mais esquece. Assim o mapa deixa de ser um produto do estudo e passa a ser o próprio instrumento dele. Se quiser entender o mecanismo por trás desse calendário, leia o nosso [guia de repetição espaçada](/blog).'),
    p('Outra forma de usar o mapa é como teste. Esconder um card, uma conexão ou o próximo passo de um raciocínio e tentar completar a lacuna transforma o diagrama em um simulado pessoal, feito sob medida para o seu ponto fraco. É um tipo de treino que as listas não oferecem.'),
    h(2, 'Cuidados na hora de usar'),
    p('Mapas conceituais organizam o entendimento; eles não substituem a fonte. Use diretrizes, livros e materiais confiáveis para construir cada ligação e registre de onde veio a informação, para poder checar depois. Conteúdo de saúde pede cuidado redobrado: este texto fala de método de estudo, e qualquer detalhe clínico deve ser conferido na fonte oficial atualizada.'),
    p('Também evite o perfeccionismo gráfico. Gastar uma hora alinhando caixas é uma forma elegante de procrastinar. Um mapa feio e correto vale mais do que um mapa impecável e raso.'),
    h(2, 'Perguntas frequentes'),
    faq(
      ['Mapa conceitual é o mesmo que mapa mental?', 'Não. O mapa mental parte de uma ideia central e se ramifica em tópicos. O mapa conceitual forma uma rede, com ligações rotuladas entre quaisquer nós, e por isso representa melhor as relações entre os temas.'],
      ['Quantos mapas devo montar por semana?', 'Depende do seu orçamento de tempo. Comece com um mapa por bloco de estudo e use as semanas seguintes para revisá-lo, em vez de criar mapas novos o tempo todo.'],
    ),
    p('Conectar ideias dá mais trabalho no começo do que decorar, e paga de volta na prova e na prática. Se você quer um lugar para montar os seus mapas, revisar com repetição espaçada e se testar no próprio mapa, [comece no Remoa](/cadastro).'),
  ),
};

export const blogDrafts: BlogDraft[] = [leitura, guia, destaque];

const intro = (...paras: string[]) => paras.join('\n\n');
/** 150–300 words each, text to review: seeded with intro_draft = true (only a human approves). */
export const categoryIntros: Record<string, string> = {
  'estrategia-de-estudo': intro(
    'Estudar para a residência é, antes de tudo, um problema de organização. O conteúdo é vasto, o tempo é curto e a rotina de quem está na reta final da graduação ou recém-formado raramente é previsível. Nesta categoria reunimos textos sobre como transformar essa realidade em um plano que cabe na vida: como medir o seu tempo real de estudo, dividir as grandes áreas em blocos concluíveis e ajustar o ritmo quando a semana foge do roteiro.',
    'Aqui você encontra conteúdo sobre planejamento de ciclos, escolha de prioridades, equilíbrio entre conteúdo novo e revisão e uso de dados do seu próprio desempenho para decidir o que estudar a seguir. A ideia é trocar a ansiedade da lista interminável por decisões claras, com metas que você consegue cumprir e revisar.',
    'Os textos tratam de método de estudo, não de orientação clínica. Quando um assunto exigir conferência de fonte técnica, indicamos que a consulta seja feita em diretrizes e materiais oficiais atualizados. Se você está começando a montar o seu plano, comece pelo primeiro texto da lista e adapte as sugestões ao seu contexto: o melhor plano é o que você consegue seguir por meses, e não o que parece mais completo no papel.',
  ),
  'tecnicas-de-memorizacao': intro(
    'Lembrar do que foi estudado não é questão de talento, e sim de técnica. A pesquisa sobre aprendizagem descreve há décadas estratégias que fazem a memória durar mais: revisar em intervalos crescentes, tentar recuperar a informação antes de consultar a resposta, misturar temas durante o estudo e explicar o conteúdo com as próprias palavras. Esta categoria traduz esses achados para a rotina de quem precisa reter muito conteúdo em pouco tempo.',
    'Você vai ler sobre repetição espaçada, criação de bons cartões, recuperação ativa, associações entre conceitos e erros que fazem a revisão parecer eficiente sem ser. Também falamos de como combinar técnicas, por exemplo unindo cartões e mapas conceituais, para que cada ideia seja lembrada isoladamente e também dentro do contexto em que aparece.',
    'Os textos explicam métodos e mostram como aplicá-los, com exemplos genéricos e sem conteúdo clínico. Para cada técnica procuramos indicar o que a pesquisa sustenta, os limites e os cuidados na prática. Comece por onde fizer mais sentido hoje: se a sua queixa é esquecer o que viu há um mês, o guia de repetição espaçada é um bom primeiro passo.',
  ),
  'enamed-e-residencia': intro(
    'A preparação para a residência médica envolve provas com formatos, pesos e calendários diferentes, e entender esse cenário faz parte do estudo. Nesta categoria reunimos textos sobre a organização da preparação para o Enamed e para os processos seletivos de residência: como ler o edital, como distribuir o tempo entre grandes áreas e como usar a prova como instrumento de treino, e não apenas como meta final.',
    'Também abordamos o lado menos falado do processo: a gestão da ansiedade, a escolha de materiais, o uso de questões anteriores e a construção de uma rotina sustentável durante o internato ou depois da formatura. Mapas conceituais e revisão espaçada aparecem aqui como ferramentas para ligar os temas cobrados e revisar o que mais pesa na prova.',
    'Os textos são sobre estratégia de preparação. Eles não substituem os editais, as matrizes de referência nem as diretrizes oficiais, que mudam e devem ser consultados diretamente na versão vigente. Se você ainda está decidindo por onde começar, leia primeiro o texto sobre mapas conceituais e depois monte um plano que cubra, nesta ordem, o calendário das provas, as áreas de maior peso e a sua rotina real.',
  ),
  produtividade: intro(
    'Produtividade, para quem estuda medicina, não é fazer mais coisas; é conseguir fazer as coisas certas com a energia que sobra depois de plantões, aulas e a vida fora dos livros. Esta categoria reúne textos sobre foco, pausas, ambiente de estudo, uso do celular e construção de hábitos que se mantêm mesmo nas semanas ruins.',
    'Você vai encontrar ideias para começar a estudar quando falta vontade, formas de reduzir distrações, maneiras de proteger o sono e o descanso sem abandonar a rotina e métodos simples para registrar o que foi feito e o que precisa ser ajustado. Tratamos o cuidado com a energia como parte do plano, porque a memória e a atenção dependem dele.',
    'As sugestões são práticas e pequenas de propósito. Mudanças enormes de rotina raramente duram; ajustes de poucos minutos, repetidos todos os dias, costumam durar. Os textos não oferecem orientação clínica ou de saúde individual. Se o cansaço ou a ansiedade estiverem atrapalhando a sua vida de forma persistente, procure apoio de um profissional. Comece escolhendo um único hábito da lista e teste por duas semanas antes de acrescentar outro.',
  ),
};
