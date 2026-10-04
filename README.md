# remoa-backend

API Hono, banco (Supabase, Drizzle, RLS), contratos e o domínio (FSRS, IA, Anki). Comandos, mapa de pastas e regras deste repo estão em `CLAUDE.md`. O texto das FRDs e dos goals fica na pasta pai, em `../docs/features/` e `../docs/goals/`. O quadro de `../docs/STATUS.md` ainda marca F05, F09, F10 e F11 como “não iniciado”; o estado abaixo é o do código em 2026-10-04.

F09 (PWA) não tem pasta neste repo. A fila offline e o manifesto ficam no frontend.

## FRDs

### F00 — Fundação

**Feito.** Monorepo, `packages/contracts` com mocks, schema, RLS, auth Bearer, `/health` e o CI deste repo.

**Faltou.** Preview na Vercel por pull request. Propagar `x-request-id` junto com o frontend.

### F01 — Mapa

**Feito.** `/v1/boards`: criar, listar, ler, atualizar e arquivar, com RLS.

**Faltou.** Nada de contrato aberto. O canvas é do frontend.

### F02 — Cards

**Feito.** Cards, ligações e upload. O tipo real da imagem é checado no servidor.

**Faltou.** CORS do bucket no deploy, para o PUT do browser.

### F03 — FSRS e fila

**Feito.** Agendador, fila por vencimento, retrievability e o log de tentativas. A carga de 500 cards ficou na meta.

**Faltou.** Nada de regra aberta. O commit e o CI desta leva antiga já seguiram o fluxo do repo.

### F04 — Desafio

**Feito.** Sessão, resposta, nota e o fim da sessão. A resposta canônica não volta no payload. Erro crítico trava a nota. Cota não fica cobrada se o corretor não entrega veredito.

**Faltou.** A chamada ao modelo depende de `OPENROUTER_API_KEY`. Sem a chave, vale a rubrica local da F05.

### F05 — Serviços de IA

**Feito.**

- `grade` devolve `correct`, `partial` ou `incorrect`. A saída do modelo usa a ferramenta `grade`. O feedback pode ir em streaming. A resposta canônica não vai no prompt.
- Sem `OPENROUTER_API_KEY`, a rubrica local corrige. Com a chave, a chamada vai ao OpenRouter e cai na rubrica local se a resposta for inválida ou a chamada falhar.
- “Não sei” é incorreto. Resposta plausível fora da rubrica fica parcial.
- Erro crítico: droga que a rubrica não cita, dose em mg que ela não cita, ou via que ela não cita (bolus, intramuscular, intravenosa, endovenosa, subcutânea). Intravenosa e endovenosa contam como a mesma via.
- `generateRubric` nasce `draft`. A mesma fonte, título e verso reaproveitam a rubrica.
- Mapa a partir de texto ou PDF. OCR da Mistral quando há `MISTRAL_API_KEY`. Layout com `@dagrejs/dagre` via `createRequire` (o import nomeado derruba o processo da API). Progresso de 0 a 100. PDF ilegível não gasta a cota de geração. Teto de 10 minutos.
- Texto longo é fatiado. Título igual, sem acento e sem diferença de maiúsculas, vira um card só. A fusão fica com o texto mais longo e com o rótulo da ligação.
- Prompts em `packages/ai/prompts/<nome>/vN.md`. O grader usa `grader/v2`. `ai_calls.prompt_version` é gravado.
- Custo em centavos inteiros. No máximo 30 correções por minuto. A cota diária de correções também cobre gerar rubrica. A cota mensal fica para o mapa em PDF. Sem veredito, a cota de correção volta.
- 50 casos em `packages/ai/eval/grader/`. `pnpm ai:eval` falha se a concordância do corretor local cair mais de 3 pontos da base 0,90.
- Timeout da correção: 8 s, com o aviso para revelar e avaliar.
- O teste de 20 páginas mede o caminho local, com um PDF sintético, em menos de 90 s.

**Faltou.**

- Nenhuma chamada real ao OpenRouter nem ao OCR. As chaves entram depois.
- Os 50 casos repetem poucas frases (8 formulações corretas até completar 27, mais parciais, branco e erros críticos). Não são 50 casos clínicos distintos, e a concordância não foi medida contra o modelo.
- Inngest não é o caminho padrão. Sem `INNGEST_EVENT_KEY` ou `INNGEST_DEV=1`, a geração roda no processo. O progresso fica na memória: reiniciar a API perde o job.
- O cache da rubrica é o hash de título, verso e fonte. Não existe coluna `card.version`, e não houve migration para isso.
- Custo e latência reais do modelo não foram medidos.

### F06 — Importação do Anki

**Feito.** Parser do `.apkg` (coleção antiga e `collection.anki21b`), job, dedupe, mídia em WebP e o relatório. Deck real e deck sintético de 2.000 notas passaram nas metas de tempo.

**Faltou.** O import ainda cria o mapa com o nome do baralho raiz e a área Clínica Médica. Nome, área e item vindos da tela não entram no job. Isso é o buraco do F17.

### F07 — Matriz Enamed

**Feito.** Seed da curadoria CM v1 (85 linhas), sugestão de tema e o vínculo mapa–item. Mapa seed de outra pessoa não vaza: a API responde 404.

**Faltou.** A matriz oficial do INEP não lista temas por área. O seed não é a lista do edital. Falta a revisão editorial dessa taxonomia.

### F08 — Cobrança, cotas e LGPD

**Feito.** Checkout (Pix no período, cartão na assinatura), cupom, portal, webhook assinado e idempotente, cotas por plano, exportar e excluir conta. A exclusão cancela a assinatura antes. O texto da resposta sai depois de 180 dias.

**Faltou.** Chaves de teste do Stripe e um teste de ponta com Pix e cartão de verdade.

### F10 — Pipeline editorial e seeds

**Feito.**

- Papel `reviewer`. Aluno recebe 404 em `/v1/editorial/queue`. RLS lê `seed_draft` só para revisor.
- Fila ordenada por criação, limite 40, filtros por mapa e por origem da marca.
- Aprovar grava nome e CRM. Card sem rubrica ganha uma rubrica com o texto do próprio card, para o inspector mostrar quem aprovou.
- Publicar exige todos os cards fora de rascunho. Grava a versão, o changelog e o marco, e passa o mapa a `seed_approved`. A cópia de quem já tinha o mapa não perde a anotação privada.
- Copiar o mapa leva cards, ligações e máscaras. Imagem com licença `own` fica de fora. `cc_by`, `servier` e `openstax` entram.
- Ajuste de discordância grava versão nova da rubrica mesmo se o card não tinha uma. O aviso ao aluno usa Resend quando há `RESEND_API_KEY`.
- Cinco mapas-semente (sepse, insuficiência cardíaca, pneumonia, cetoacidose, hipertensão), sem dose inventada, em `seed_draft`. Mapa que o revisor já alterou não é reescrito. `pnpm seed:maps` já rodou no banco local.

**Faltou.** Publicar continua sendo decisão humana: os seeds não devem ir a `seed_approved` sem revisão. Sem a chave do Resend, o e-mail da discordância fica só na memória do processo.

### F11 — Relatórios e telemetria

**Feito.** Agregados de retenção, sequência (dia de estudo no fuso do perfil, virada às 04:00), acurácia da área e do item, e até 20 cards com lembrança abaixo de 70%. A lembrança usa `retrievability` do FSRS. Card nunca revisado não entra. CSV com no máximo 5.000 linhas, sem o texto da resposta. Concordância do grader só para revisor ou admin. Índices de `attempts` por usuário e data. O teste de 50 mil tentativas em memória ficou abaixo de 300 ms. Eventos em `packages/contracts` são estritos; plano, plataforma e versão entram depois da validação.

**Faltou.** A lista de cards fracos só olha `fsrs_state.sub_id` vazio. Passo de fluxograma e máscara, que têm sub-id próprio, não aparecem mesmo com lembrança baixa.

### F12 — Onboarding

**Feito.** Nada além do que a conta e a home já expõem. Não há um fluxo de primeiro mapa neste repo.

**Faltou.** A API de onboarding descrita na FRD.

### F13 — Conta

**Feito.** Perfil, avatar, e-mail, senha, sessões, preferências e o registro de eventos da conta.

**Faltou.** No projeto de produção: `secure_password_change` e a validade do código. E-mail real depende de `RESEND_API_KEY`.

### F15 — Planos e checkout

**Feito.** Livro de preços, cupom, sessão de checkout e a leitura da assinatura, por cima do F08.

**Faltou.** Stripe com chave de teste. Fora de desenvolvimento, o mock de pagamento fica fechado.

### F17 — Importador Anki v2

**Feito.** Compartilhar mapa (só eu, privado com senha, público), página de leitura, cópia para quem tem o link e o limite de tentativas de senha. A verificação local percorreu esse fluxo.

**Faltou.** O job de import ainda ignora o nome, a área e o item escolhidos na tela. Um mapa por importação, em vez de um mapa por baralho raiz, também fica em aberto enquanto a tela nova não existir. O goal G09 está pausado.

## Goals

### G09 — Importador Anki mais simples

**Feito.** O backend do F17: acesso, senha, link e cópia. O parser do F06 continua valendo.

**Faltou.** Status: pausado. O import não grava o que o aluno escolheu de nome, área e item. Falta um mapa por importação quando a tela passar a pedir isso.

### G12 — Correção do desafio com IA e por voz

**Feito, como base, não como goal fechado.** A mesma rubrica e a mesma resposta dão o mesmo veredito em texto e em voz. Erro crítico trava a nota em “Não lembrei”. Sem a chave, a rubrica local corrige. Com a chave, o OpenRouter entra e a rubrica local cobre a falha. Os critérios em `../docs/goals/G12-correcao-por-voz.md` estão marcados. O status do goal continua **planejado**.

**Faltou.** Uma correção observada com `OPENROUTER_API_KEY` de verdade. Até lá, o que roda é o corretor local.

### G05 — Planos

**Feito.** Preço, cupom e checkout que a tela `/planos` consome. O outro arquivo `G04-planos.md` é o mesmo pedido, com o nome antigo do pacote.

**Faltou.** Cobrança real no Stripe, a mesma pendência do F08 e do F15.
