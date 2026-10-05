# F11 — Relatórios e telemetria (backend)

Data: 2026-10-04. FRD `docs/features/F11-reports.md`. As consultas ficam em `apps/api/src/reports/`, não numa pasta de server do Next. A tela `/progresso` e o disparo dos eventos estão no frontend (`docs/F11-relatorios.md`).

## O que o progresso devolve

`getProgress` (`progress.ts`) roda dentro de `run(userId)`, então o RLS vale. O dia de estudo vem de `dayWindow`: fuso do perfil, e o dia vira às 04:00. A expressão SQL é `(created_at no fuso) - 4 horas`, depois a data.

A janela das tentativas é 30 dias a partir desse dia. O agrupamento é por dia, área e item da matriz. Nota 3 ou mais conta como acerto (`hits`). `summarizeBuckets` transforma isso no relatório.

`retention7d` e `retention30d` são acertos sobre tentativas. Sem tentativas, o valor é `null`, e a tela mostra o texto de “sem dado”, não zero.

`reviewsPerDay` tem sempre 30 posições, uma por dia, com zero onde não houve revisão.

`streakDays` olha dias distintos com tentativa. Se hoje não tem, a contagem começa ontem. A consulta de dias estudados volta até 400 dias, para uma sequência longa não ser cortada pela janela de 30.

`accuracy` tem uma linha da área (`matrixItemId` nulo), que conta toda tentativa da janela, e uma linha por item da matriz que apareceu. Somar as linhas pode passar do total da janela, porque a linha da área já inclui os itens. A área no código é `CM`.

## Cards fracos

A consulta lê `fsrs_state` com `reps > 0`, `last_review` preenchido e `sub_id = ''`, junta o título e o mapa do card, e `weakFromMemory` chama `retrievability` de `@remoa/fsrs`. É a mesma lembrança do mapa. Não usa `exp(-dias/stability)` no SQL.

Card nunca revisado tem lembrança 0 e não entra: `reps === 0` ou `lastReview` nulo são descartados. Entra quem está abaixo de 0,7. A lista é ordenada da menor lembrança para a maior e cortada em 20. Cada item traz `cardId`, `boardId`, `title` e `r`. O link da tela é `/mapas/${boardId}?modo=desafio`.

O filtro `sub_id = ''` deixa de fora passo de fluxograma e máscara de imagem. Esses estados têm sub-id próprio e não aparecem em `/progresso`, mesmo com lembrança baixa. Card atrasado com lembrança alta também não entra: a regra é `r < 0.7`, não “está na fila”.

## Desempenho

`summarize` percorre as tentativas uma vez. O teste de agregação com 50 mil tentativas em memória ficou abaixo de 300 ms. Os índices estão na migration `0016_f11_attempt_indexes.sql` e no schema Drizzle: `attempts_user_card_idx`, `attempts_user_created_idx` e `attempts_user_card_created_idx`. Não foi gerado snapshot novo do Drizzle para isso.

A rota de relatório mapeia falha inesperada de `getProgress` para HTTP 500. `getProgress` devolve `ok` salvo se `run` lançar.

## CSV

`attemptsCsv` devolve no máximo 5.000 linhas, as mais recentes. O cabeçalho é `id,created_at,grade,mode,input_kind`. Não há texto da resposta. Campo com aspas, vírgula ou quebra de linha é escapado no padrão CSV. A rota é `/v1/reports/attempts.csv`. A tela pede com o Bearer da sessão.

## Eventos

Os schemas em `packages/contracts` (eventos) são `.strict()`. O cliente valida o corpo do evento e só depois acrescenta `plan`, `platform` e `appVersion`. Colocar esses três dentro do schema do evento quebraria os testes que comparam o payload exato.

Os eventos que o produto dispara, e que os contratos aceitam, incluem `signup`, `board_created`, `board_generated_from_pdf`, `card_created`, `anki_imported`, `challenge_started`, `answer_submitted`, `grade_overridden`, `review_completed`, `paywall_viewed`, `subscription_started`, `subscription_canceled`, `ai_graded` e `rubric_generated`, além dos da fila, da disputa, da publicação e do progresso. Não há analytics de produto externo: o servidor não regrava esses eventos, o frontend só os acumula em `window.__remoaEvents` para o teste, e o dado de estudo fica em `attempts`.

## Concordância do grader

Está em `graderAgreement`, documentada no arquivo da F10. Revisor ou admin. Fórmula `1 - notas alteradas / correções com veredito`.

## O que ficou de fora

- Passo de fluxo e máscara não entram nos cards fracos.
- Não há consulta duplicada dentro do Next.
- Telemetria de eventos não sai do browser (sem analytics externo).
