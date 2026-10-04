# G12 — Correção do desafio com IA e por voz (backend)

Data: 2026-10-04. O plano está na pasta pai, em `docs/goals/G12-correcao-por-voz.md`. O status de lá continua **planejado**. Este arquivo descreve a base que já está neste repo. A leitura em voz alta, o microfone e a fila do aparelho estão no frontend (`docs/G12-correcao-por-voz.md`).

O goal não está fechado. Falta observar uma correção com `OPENROUTER_API_KEY` de verdade. Sem a chave, o que roda é a rubrica local.

## O mesmo veredito nos dois modos

Texto e voz entram no mesmo ramo de `createAnswer` e de `createAnswerStream` (`apps/api/src/challenge/session.ts`). O corpo traz `inputKind` e `text`. A rubrica lida do card é a mesma. O `GraderInput` é o mesmo formato. `gradeAnswer` / `streamGradeAnswer` não olham o `inputKind`.

O teste citado no goal (“voice and text…”) confere que a mesma rubrica e a mesma resposta produzem o mesmo veredito. O teste “criticalError locks the grade at again” confere a trava da nota.

## Erro crítico

`gradeOffline` e o veredito do modelo expõem `criticalError`. O desafio copia isso para `gradeLocked`. `rate` só aceita `again` quando a trava está ligada. A nota sugerida vem de `verdictToGrade` (veredito mais o tempo da resposta comparado à mediana daquele modo). A trava ignora a sugestão: a tela não oferece as outras notas, e a API recusa se alguém mandar.

## Chave e fallback

`gradeWithMeta` (`packages/ai/src/grade.ts`): sem `OPENROUTER_API_KEY`, `gradeOffline`. Com a chave, OpenRouter, ferramenta `grade`, timeout de 8 segundos. Resposta inválida ou falha de rede voltam para `gradeOffline`. O prompt do usuário não inclui a resposta canônica (`graderUser`).

No desafio, ausência de rubrica é `no_rubric` e não cobra. Cota estourada é `quota`. Corretor ausente, limite de 30 por minuto ou timeout é `grader_error`, e a cota cobrada volta. O streaming reserva a cota dentro do lock, solta a linha, transmite o feedback e grava no `commitStream`. Sem veredito, `refundQuota`.

## O que este goal pedia e o backend já cobre

| Critério do goal | Onde |
|---|---|
| Mesma rubrica, mesmo veredito em texto e voz | `createAnswer`, ramo `text` e `voice` |
| Erro crítico trava em “Não lembrei” | `gradeLocked` e a validação de `rate` |
| Sem chave, rubrica local; com chave, OpenRouter e queda para a rubrica local | `gradeWithMeta` e `streamGrade` |
| Áudio do aluno não é gravado aqui | A coluna é `answer_text`, o texto já transcrito |

## O que ainda falta para tratar o goal como feito

- Uma chamada real ao OpenRouter, com a chave no ambiente, e a conferência de que o veredito inválido cai na rubrica local.
- Concordância do modelo contra os 50 casos. Hoje `pnpm ai:eval` mede só `gradeOffline`.
- O status no arquivo do goal permanece planejado de propósito, mesmo com as caixas marcadas. As caixas descrevem a base. Não autorizam marcar o goal como concluído.
