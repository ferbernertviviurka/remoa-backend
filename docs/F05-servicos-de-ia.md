# F05 — Serviços de IA (backend)

Data: 2026-10-04. Este arquivo descreve o que o `remoa-backend` implementou da FRD `docs/features/F05-ai-services.md` (pasta pai). A chave do OpenRouter não é obrigatória. Sem `OPENROUTER_API_KEY`, correção, rubrica e extração usam o caminho local. Com a chave, a chamada vai ao OpenRouter e cai no caminho local se a resposta for inválida ou a chamada falhar. A resposta canônica do card não é enviada ao modelo.

A tela (progresso do PDF, marca de rascunho, feedback ao vivo) está em `remoa-frontend/docs/F05-servicos-de-ia.md`.

## Onde mora

| Peça | Arquivo |
|---|---|
| Cliente OpenRouter, tool `grade`, streaming | `packages/ai/src/openrouter.ts` |
| Correção, rubrica, custo | `packages/ai/src/grade.ts` |
| Corretor local | `packages/ai/src/offline.ts` |
| Extração, merge, layout | `packages/ai/src/extract.ts` |
| PDF e OCR | `packages/ai/src/pdf.ts`, `packages/ai/src/ocr.ts` |
| Avaliação offline | `packages/ai/src/eval.ts`, `packages/ai/eval/grader/cases.ts` |
| Prompts | `packages/ai/prompts/grader/v2.md`, `rubric/v1.md`, `extract/v1.md` |
| Jobs, cota, `ai_calls` | `apps/api/src/ai/service.ts` |
| Streaming no desafio | `apps/api/src/challenge/session.ts` |
| Contratos | `packages/contracts/src/ai.ts` |

## FR-1 — Corrigir com saída estruturada

`gradeWithMeta` e `streamGrade` recebem o enunciado, a rubrica, os vizinhos e a resposta. O veredito é `correct`, `partial` ou `incorrect` (inglês, decisão D-019), com `matched`, `missing`, `criticalError`, `feedback` e `model`.

O modelo padrão do corretor é `anthropic/claude-3.5-haiku` (`OPENROUTER_GRADER_MODEL` troca). A chamada é `POST https://openrouter.ai/api/v1/chat/completions`. O grader não pede JSON solto: pede a ferramenta `grade`, com `tool_choice` forçado nessa função. Os campos obrigatórios são `verdict`, `matched`, `missing`, `criticalError` e `feedback`. `completeJSON` lê `tool_calls[0].function.arguments` e, se não houver, o `content`. `parseVerdict` valida com zod e descarta `costCents` se o modelo inventar esse campo.

`streamJSON` lê o SSE. Cada delta pode ser o pedaço dos argumentos da ferramenta ou o texto do conteúdo. `feedbackSoFar` extrai o valor de `"feedback"` mesmo com a string ainda aberta, para a tela mostrar o texto enquanto o modelo escreve. O timeout da chamada é 8 segundos.

`graderUser` monta o JSON do usuário só com `prompt`, `rubric`, `neighbors` e `answer`. `canonical` existe no `GraderInput` porque o desafio o carrega no servidor, mas não entra nesse JSON.

Sem chave, `streamGrade` parte o feedback local em pedaços (quebra depois de cada espaço) e no fim manda o veredito, com zero tokens e `promptVersion` `grader/v2`. Se a chave existe e a chamada falha antes de qualquer texto, o mesmo caminho local é emitido. Se já tinha saído algum feedback e o parse final falha, o veredito local substitui o do modelo, sem reenviar o texto.

Há 50 casos em `packages/ai/eval/grader/`. `pnpm ai:eval` mede a concordância do corretor local. O CI falha se ela cair mais de 3 pontos da base 0,90. A latência p95 dessa avaliação é a do corretor local, não a de uma chamada real.

## FR-2 — Só a rubrica aprova

O prompt `grader/v2` manda corrigir apenas contra a rubrica. O corretor local faz o mesmo.

`gradeOffline` normaliza o texto (NFD, sem acento, minúsculas). “Não sei”, “não lembro” e “não faço ideia” são `incorrect`, sem erro crítico, e todos os pontos da rubrica ficam em `missing`. O feedback é “Sem resposta para corrigir contra a rubrica.”

Um ponto só conta quando toda palavra de 5 letras ou mais daquele ponto aparece na resposta, com fronteira de palavra (`hasWord`). Um verbo compartilhado não basta. Se nenhum ponto casa, e a resposta não é branca nem erro crítico, o veredito é `partial`: o que está fora da rubrica não vira acerto. Se falta um ponto essencial, também é `partial`. Só é `correct` quando não há erro crítico e nenhum ponto essencial ficou de fora.

## FR-3 — Erro crítico

`contrary` marca erro crítico em três casos, todos medidos contra o texto da rubrica:

- Droga da lista (noradrenalina, dopamina, adrenalina, vasopressina, dobutamina) que a rubrica não cita, e a resposta também não contém as drogas que a rubrica cita. Citar a droga pedida não esconde uma dose ou via a mais.
- Dose em miligramas (`\d+\s*mg`) que a rubrica não traz.
- Via que a rubrica não traz. As vias reconhecidas são bolus, intramuscular, intravenosa, endovenosa e subcutânea. Intravenosa e endovenosa contam como a mesma via (`venosa`).

Erro crítico força `incorrect`. No desafio, `gradeLocked` fica verdadeiro e a nota só pode ser “Não lembrei” (`again`). O feedback local é “A conduta contraria a rubrica.”

Os 50 casos incluem 10 erros críticos. A avaliação conta quantos desses o corretor local marca.

## FR-4 — Rubrica

`rubricWithMeta` usa `anthropic/claude-3.5-sonnet` (`OPENROUTER_RUBRIC_MODEL`) e o prompt `rubric/v1`, em modo `json_object`. A rubrica nasce `status: draft`, `reviewerId: null`, com `source` e `version` (1 se o modelo não mandar). Se o JSON não passa no schema, vale a rubrica local.

`rubricFromCard` quebra o verso (ou o título, se o verso estiver vazio) em frases por ponto ou ponto e vírgula, fica com trechos de mais de 8 caracteres, no máximo 8, e marca só o primeiro como essencial. O cache é um `Map` no processo, chave `fonte + título + verso`. `cachedRubric` devolve essa entrada. Não existe coluna `card.version`; o hash persistido no card é SHA-256 de título, verso e fonte (`inputHash`), em `attachRubric`.

`attachRubric` só escreve no card do próprio usuário. Rubrica já `approved` responde `conflict`. Rascunho com o mesmo hash volta sem nova chamada. Cache em memória também grava sem chamar o modelo. A chamada só acontece depois disso, e só então a cota `ai_grades` é cobrada, e apenas se houver banco e chave. Falha na geração devolve a cota.

## FR-5 — Gerar mapa

`startGeneration` aceita texto ou um PDF já enviado (`pdfAssetId` do usuário). `startPdfGeneration` recebe os bytes, devolve o `jobId` na hora e segue em segundo plano, para a tela mostrar 0–100.

O texto literal do PDF vem de `pdfText` (strings entre parênteses com pelo menos quatro letras). Se passar de 40 caracteres, o OCR não roda. `ocrPdf` chama a Mistral (`mistral-ocr-latest`, timeout de 10 minutos) só com `MISTRAL_API_KEY`. Sem chave, ou se a resposta for curta, fica o texto literal. Menos de 40 caracteres vira `pdf_unreadable` e não gasta a cota de geração. A cota `ai_generations` só é cobrada depois do texto legível.

`pdfPageCount` conta `/Type /Page` que não seja `/Pages`, no mínimo 1. Esse número entra em `counts` no início do job, para a tela saber as páginas antes do mapa existir.

Estágios gravados no `Map` do processo: OCR em 10, extração em 20–30, layout em 75, pronto em 100. `generationOf` só devolve o job do mesmo usuário, com `cards`, `edges` e `pages`.

`extractWithMeta` fatia o texto e, com chave, manda cada fatia ao Sonnet (`OPENROUTER_EXTRACT_MODEL`, prompt `extract/v1`). O orçamento inteiro é `GENERATE_BUDGET_MS` = 10 minutos. Entre fatias, se o prazo acabou, lança `generate_timeout` (esse erro não cai no extrator local). Cada fatia tem timeout de no máximo 20 segundos, ou o que restar. JSON inválido ou sem cards cai em `extractOffline`.

O layout usa `@dagrejs/dagre` 1.1.4 via `createRequire`. O import nomeado quebra o processo da API no tsx. O grafo é da esquerda para a direita, nó 240×140, `nodesep` 48, `ranksep` 80, margem 80. A coordenada gravada é o canto superior esquerdo. Auto-ligação e referência inexistente são ignoradas. Referência repetida também.

`saveBoard` cria o mapa `private`, cards `draft`, fonte `Gerado por IA, não revisado` quando o card não traz fonte, e as ligações com rótulo. Card do tipo imagem é pulado nessa gravação.

Inngest só recebe o evento se `inngestConfigured()` for verdadeiro (`INNGEST_EVENT_KEY` ou `INNGEST_DEV=1`). Sem isso, `dispatchBoardJob` devolve falso e `executeGeneration` roda no processo. Não dispara o evento e o processo ao mesmo tempo. O progresso mora na memória: reiniciar a API perde o job. Falha depois da cobrança chama `refundGeneration`.

## FR-6 — Fatiar e fundir

`chunkText` junta parágrafos até cerca de 1.500 caracteres, quebrando em linha em branco. Sem marcação, `extractOffline` faz conceitos de cerca de 400 caracteres e liga o seguinte ao anterior com o rótulo `leva a`.

Blocos marcados:

- `Fluxo:` vira card `flow`, com passos numerados (até 12).
- `Caso:` vira card `case`. As linhas `Apresentação`, `Exames`, `Diagnóstico` e `Conduta` viram `presentation`, `workup`, `diagnosis` e `management`. Etapa repetida é ignorada.
- `Relação: De -> Para: rótulo` vira ligação. O título é comparado sem acento e sem diferença de maiúsculas.

`mergeDrafts` junta cards com o mesmo título dobrado (NFD, sem marca, minúsculas, espaços colapsados). Fica o verso mais longo, preenche frente ou fonte vazias, e reescreve as ligações para o card que ficou. Ligação repetida ganha o rótulo se a primeira não tinha. Auto-ligação e ponta inexistente saem.

## FR-7 — Prompts versionados

As versões gravadas são `grader/v2`, `rubric/v1` e `extract/v1`. `ai_calls.prompt_version` recebe a versão da chamada. O changelog dos prompts está em `packages/ai/prompts/CHANGELOG.md`. O `v1.md` do grader permanece no disco; o código lê o v2.

## FR-8 — Custo, ritmo e cota

`costCents` usa preço de lista em centavos por milhão de tokens. Haiku 3.5: 80 de entrada e 400 de saída. Sonnet 3.5: 300 e 1.500. Modelo com “sonnet” no nome, ou qualquer modelo que não seja Haiku e não comece com `offline`, usa a tabela do Sonnet. Zero tokens custam 0. Custo positivo abaixo de meio centavo vira 1, porque `ai_calls.cost_cents` é inteiro.

`allowGrade` guarda, na memória do processo, os horários das últimas correções daquele usuário. A partir de 30 em 60 segundos responde `rate_limited` (“30 por minuto”). No fluxo com cota já cobrada, essa recusa devolve a cota.

A cota diária é `ai_grades` (plano Free: 20 por dia). Gerar rubrica gasta essa cota, não a cota mensal de mapas. A cota mensal `ai_generations` (Free: 1) é a do PDF ou do texto longo. Sem veredito, `refundQuota` devolve a correção. Sem mapa, `refundGeneration` devolve a geração.

`recordCall` e os inserts de `grade` / `rubric` só rodam com `DATABASE_URL`. Falha ao gravar a linha de custo não derruba o veredito.

## FR-9 — Avaliação

`runOfflineEval` percorre `graderCases`, compara o veredito com o gabarito do caso, conta erros críticos detectados e devolve `n`, concordância, `criticalHits`, `criticalExpected`, p95 e custo 0. Não chama o OpenRouter. Os 50 casos repetem formulações: 27 corretos giram 8 frases de sepse, 8 parciais giram 4 frases de “só noradrenalina”, mais casos de coração, resposta fora da rubrica, branco e os erros críticos. A concordância do corretor local fica em 90% ou mais. Não é um conjunto de 50 casos clínicos distintos, e não foi medida contra o modelo.

## FR-10 — Mocks

Os mocks determinísticos continuam em `packages/contracts`, para o frontend e para testes que não precisam de chave.

## O que este repo não fecha da FRD

- Nenhuma chamada real ao OpenRouter ou à Mistral foi observada. As chaves entram depois.
- Custo e latência de produção não foram medidos. O teste de 20 páginas usa um PDF sintético no caminho local e espera status `done`, progresso 100 e 20 páginas em menos de 90 segundos, com algum progresso abaixo de 100 no meio.
- O job padrão não é o Inngest. O progresso não sobrevive a um restart.
- O cache da rubrica não é `card.version`.
