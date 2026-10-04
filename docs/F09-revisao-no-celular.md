# F09 — Revisão no celular (o que o backend sustenta)

Data: 2026-10-04. A FRD `docs/features/F09-mobile-pwa.md` é de interface: manifesto, service worker, lista no lugar do canvas, microfone e instalação. Esse código está no `remoa-frontend` (`docs/F09-revisao-no-celular.md`). Este arquivo registra o contrato da API que essa revisão usa, porque o celular não corrige sozinho.

## Resposta de texto e de voz

`createAnswer` em `apps/api/src/challenge/session.ts` trata `inputKind: 'text'` e `inputKind: 'voice'` no mesmo ramo. Os dois mandam `text`. Os dois leem a rubrica do card, os dois chamam o mesmo `grade`, os dois gravam `answerText`. O áudio não chega neste servidor: o que entra é a transcrição que o browser já fez.

Opções (`mcq`) não passam pelo corretor. Sem rubrica válida, ou com o item em `grading: 'none'`, o fallback é `no_rubric` e a cota não é cobrada. Sem grader ligado, o fallback é `grader_error`, também sem cota. Cota `ai_grades` estourada vira `quota`. Acima de 30 correções por minuto, a cota recém-cobrada é devolvida e o fallback é `grader_error`.

Timeout do corretor: `GRADER_TIMEOUT_MS` = 8.000. Sem veredito, a cota volta e o fallback é `grader_error`. A mensagem que a tela mostra nesse caso é “não foi possível corrigir, revele e avalie”.

Erro crítico (`verdict.criticalError`) grava `gradeLocked: true`. `rate` recusa qualquer nota que não seja `again`, com a validação “grade is locked at again”.

Responder de novo o mesmo item não corrige de novo e não cobra de novo: se `answered` já existe, a saída anterior volta.

## Streaming

`createAnswerStream` só transmite feedback para texto e voz. O resto da resposta é um único evento JSON.

`claimStream` segura a linha da sessão só para reservar a cota, marcar `grading: true` e montar o `GraderInput` (enunciado, canônica, rubrica, vizinhos, resposta). A canônica fica no objeto do servidor. Quem chama o modelo é `streamGrade`, e `graderUser` não inclui a canônica. A chamada ao modelo acontece depois que o lock da linha foi solto, para o streaming não segurar a transação.

`limitStream` corta o gerador em 8 segundos. Cada pedaço de `feedback` vira um evento. No fim, `commitStream` grava o veredito, `gradeLocked` e a nota sugerida. Se o veredito não chegou, o fallback é `grader_error` e `refundQuota` devolve a unidade. O `finally` chama `commitStream` de novo se o gerador quebrou antes de gravar, para a sessão não ficar presa em `grading`.

Se a reserva da cota falha, o tipo é `delegate` e `createAnswer` tenta o caminho sem streaming. Esse segundo caminho cobra de novo só se o primeiro não consumiu.

POST JSON, sem `Accept: text/event-stream`, continua em `createAnswer`. O SSE só sai quando o cliente pede o stream. O frontend pede o stream em `features/challenge/client.ts`.

## Fila offline

Este servidor não guarda a fila do aparelho. Quando a rede volta, o frontend reenvia, em ordem, `POST /v1/challenge/answer`, `rate` e `finish` com os mesmos corpos. A correção por IA só acontece nesse reenvio. Até lá, a tela mostra `fallback: 'offline'`, que ela mesma inventa: a API não devolve esse valor.

`finish` e `rate` são idempotentes no que a sessão já gravou. Uma resposta rejeitada por validação não deve ser reenviada para sempre; o cliente tira da fila o que não é falha de rede.

## O que não está aqui

Manifesto, service worker, `offline.html`, barra inferior, lista do mapa, microfone e o convite de instalação não têm arquivo neste repo. Tema escuro também não: a decisão de não seguir o sistema foi de interface.
