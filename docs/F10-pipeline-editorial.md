# F10 — Pipeline editorial e seeds (backend)

Data: 2026-10-04. FRD `docs/features/F10-content-pipeline.md`. A fila, a loja e o formulário de publicação estão no frontend (`docs/F10-pipeline-editorial.md`). Aqui está a regra que a API aplica.

## Papel e fila

`editorialQueue` em `apps/api/src/editorial/editorial.ts` exige perfil `reviewer` ou `admin`. Aluno recebe 404 `not_found` em `/v1/editorial/queue`. A policy de `boards` só deixa `seed_draft` passar no SELECT se `is_reviewer()`.

A fila pega os pendentes mais antigos, limite 40. O filtro `flag` separa rascunho (`flag_source` nulo), sinal da IA (`ai`) e discordância (`user_disagree`). O filtro `board` restringe ao mapa. Cada item de discordância faz LEFT JOIN em `attempts` e devolve `answerText`, `verdict`, `feedback` e `criticalError`, para a tela mostrar a resposta que o aluno disputou.

Os seeds entram com `flagSource: 'ai'`. Um backfill em `seedStudyMaps` preenche `flag_source` nulo nos cards `seed_draft` cuja fonte bate com a das diretrizes.

## Aprovar

`decideReview` grava a decisão na `review_queue`. Aprovar chama `stampedRubric`. A rubrica aprovada sempre tem pontos, fonte, versão, `status: 'approved'`, `reviewerId`, `reviewerName` e `reviewerCrm`. Se o revisor editou os pontos, esses entram. Senão ficam os pontos que já existiam. Se não havia nenhum, o texto é o verso do card, ou o título, marcado como essencial. A fonte é a da rubrica anterior, senão a do card, senão o título. A versão anterior é mantida se for um número maior que zero; senão vira 1.

O card passa a `approved` e guarda essa rubrica. O inspector do frontend lê nome e CRM daí.

Um revisor sozinho pode aprovar o próprio card. Se existir outro revisor ou admin, aprovar o próprio card (ou um card de mapa cujo dono é ele) responde `forbidden` “own card”. Admin não cai nessa trava.

`setReviewerCrm` grava o CRM no perfil, no máximo 20 caracteres. Vazio limpa o campo.

## Discordância

`resolveDispute` marca o item da fila como `approved` e registra a nota. Dois desfechos: a rubrica estava certa, ou `rubric_adjusted`.

No ajuste, mesmo um card sem rubrica ganha uma versão nova. `previousPoints` guarda os pontos anteriores (lista vazia se não havia). Os pontos novos são os enviados, ou os anteriores, ou, se ambos faltam, o verso ou o título. A versão é `(anterior ?? 0) + 1`. O status da rubrica e do card volta a `draft`, `reviewerId` da rubrica fica nulo, e uma linha nova entra em `review_queue` como `pending`.

Se o item tem `attemptId`, o e-mail do aluno é lido em `auth.users` e `sendEmail` manda “Sua discordância foi revista”. Com `RESEND_API_KEY` isso sai pelo Resend. Sem a chave, a mensagem fica na caixa em memória do processo.

## Publicar

`publishBoard` exige revisor. Se ainda existe card `draft` naquele mapa, responde 422 `validation` com a mensagem `cards still draft`.

Caso contrário, a versão do mapa sobe 1. `board_versions` guarda changelog no formato `{marco temporal}: {changelog}`, o snapshot de cards e ligações, o marco e quem aprovou. O mapa passa a `seed_approved`, com `temporalMark` e `reviewerId`. A publicação atualiza o seed. Quem já copiou o mapa fica com a cópia privada que tinha; anotações dessa cópia não são reescritas.

`listDrafts` devolve os mapas `seed_draft` (id e título) para a tela de publicar. `listSeeds` devolve os `seed_approved`, ordenados por área e depois por título, com o marco.

## Copiar um mapa pronto

`copySeed` só copia `seed_approved`. Cobra a cota de mapas e recusa se os cards da cópia estourarem a cota de cards.

Imagens só viajam se a licença do asset for `cc_by`, `servier` ou `openstax`. Licença `own` tira o `assetId` e esvazia as máscaras. Frente e verso com asset seguem a mesma regra. A cópia nasce `private`, `sourceBoardId` aponta o original, os cards nascem `approved` (já revisados), as ligações e as máscaras permitidas são recriadas com ids novos. Rubrica, fonte e posição são copiadas.

## Seeds

Cinco mapas em `packages/db/src/seed/study-outlines.ts`: sepse e choque séptico, insuficiência cardíaca descompensada, pneumonia, cetoacidose diabética e hipertensão arterial. O texto segue diretriz pública e não inventa dose: onde falta número, manda seguir a diretriz. O marco temporal gravado é `Enamed 2026.2`. O status inicial é `seed_draft`.

`pnpm seed:maps` monta mapa novo, ou mapa que ainda é o stub antigo, com `extractOffline`, `layout` e `rubricFromCard`. Não chama o OpenRouter.

`isUntouchedStubSeed` (`packages/db/src/seed/stub-board.ts`) reconhece o seed antigo: todo card está `draft` e o título termina em `: definição`, `: conduta` ou `: o que não esquecer`, ou é exatamente `Conduta de ${título}`, `Reavaliação de ${título}` ou `Caso de ${título}`. Só esse mapa, e só se nenhuma tentativa aponta esses cards, é apagado e reinserido. Mapa que um revisor já mexeu não é reescrito.

O seed local foi executado. Os mapas continuam `seed_draft` até um revisor humano aprovar e publicar. Publicar sem essa leitura não é o caminho deste pipeline.

## Concordância

`graderAgreement` conta tentativas com `verdict` não nulo. A fórmula é `1 - overridden / submitted`, em que `overridden` é `grade_overridden`. Sem tentativas, `agreement` é nulo. Revisor ou admin. Aluno recebe 404. A tela `/editorial/metricas` consome esse número.

## O que ficou de fora

- E-mail real da discordância depende de `RESEND_API_KEY`.
- Os cinco mapas não estão publicados. A aprovação humana é o portão.
- Não há dose inventada nos textos. Onde a diretriz não foi transcrita com número, o card diz para seguir a diretriz.
