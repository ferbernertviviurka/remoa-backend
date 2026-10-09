# F33 / FR32 — banco sintético isolado

Este diretório reproduz o ensaio de desempenho local. As 50.000 questões são placeholders sintéticos, não um acervo de questões médicas adquirido ou autorizado. Nenhum PDF, OCR, provedor de IA ou publicação de conteúdo real participa da carga.

## Isolamento e reprodução

Os scripts não carregam `.env`. O clone aceita somente URL explícita de uma base local `f33_test`, copiando schema de `public/auth/extensions` sem dados. O destino permitido é exclusivamente `remoa_perf_f33_20261008`. Arquivos de URL ficam em `/private/tmp`, com modo600; não imprimir seus conteúdos. O clone recusa substituir uma base já populada. Não desliga triggers, reinicia containers nem altera roles globais.

Executar no diretório `remoa-backend`, em uma janela sem outras suites ou builds:

```sh
node packages/db/src/perf/questions/clone.mjs
node packages/db/src/perf/questions/seed.mjs
node packages/db/src/perf/questions/readiness.mjs
pnpm --filter @remoa/db exec tsx src/perf/questions/server.mjs
```

O dump utiliza `pg_dump/psql17` do container local já existente, por incompatibilidade do cliente Homebrew14 com PostgreSQL17. As operações no container leem somente a base de fixture ou escrevem somente o novo destino. Ambiente medido: Node24.2.0, macOSarm64, Apple M3 Pro11 CPUs lógicas/18GiB host, pool API10, PostgreSQL17.11 local em Docker. Limites de CPU/RAM do container não foram medidos. O servidor HTTP próprio escuta `127.0.0.1:43133`, usa os handlers reais e sessões de Auth sintéticas; a verificação criptográfica de JWT/JWKS é substituída no harness. Gates de sessão, owner, rights e schema permanecem ativos.

Em outro terminal:

```sh
F33_EXPLAIN_PHASE=final pnpm --filter @remoa/db exec tsx src/perf/questions/explain.mjs
node packages/db/src/perf/questions/load.mjs
node packages/db/src/perf/questions/create-load.mjs
```

O ensaio principal mantém20 usuários concorrentes em circuito fechado:30s de aquecimento e300s medidos. Alterna busca, filtro de área/dificuldade, caderno de erros, sessões recentes, retomada de200 itens e resposta. A versão final também agenda uma criação de200 itens por usuário em0/60/120/180/240s (100 amostras), passando a responder/retomar a nova sessão ativa e mantendo as anteriores ativas. Não cria uma sessão por volta do circuito, nem desativa a admissão. Cada mutação possui UUID novo e revisão otimista. A amostra de criação é separada: cinco ondas de20 usuários criando200 itens, após um aquecimento por usuário; não representa cinco minutos contínuos de criação. Não executar ambas simultaneamente. Nenhum limite de admissão é desativado.

## Forma dos dados e evidência

O seed contém50.000 raízes públicas distintas,5.000 sucessoras em rascunho e100.000 respostas históricas. Raízes têm `canonical_id=id`; versões apontam para a raiz.20 estudantes possuem sessões de estudo/simulado,50 históricas de100 itens por estudante e um simulado ativo de200 itens. A carga acrescenta respostas e sessões à base isolada;100.000 é o tamanho inicial, não um limite congelado.

Todos os triggers ficam habilitados (`session_replication_role=origin`). O seed passa pelo gate de assinatura com identidade, CRM, hash e direitos explicitamente sintéticos; isso exercita constraints e não equivale à aprovação médica de conteúdo. Um único tema/área com três dificuldades provoca filtros amplos. Não há assets nas questões; o custo de assinatura/download de imagens não está nesta medição.

`explain-before.json`, `explain-after-index.json`, `explain-after-ids.json` e `explain-combined.json` guardam planos. O primeiro diagnóstico sem timeout foi cancelado após102s; `baseline-cancel.json` registra a consulta identificada, sem atribuir esse tempo à operação errada. Os planos posteriores limitam cada consulta a5s.

A migration0046 adiciona GIN trigram para busca por substring e btree da expressão `coalesce(canonical_id,id)` para seleção da última versão. A lista primeiro seleciona IDs autorizados; uma CTE materializada reutiliza esse conjunto para total global e página, hidratando somente `limit+1`. O estado pessoal usa últimas tentativas em lote, excluindo simulados ativos e anuladas. Cursor vazio conserva o total global. Nenhum cache relaxa a verificação dos direitos.

`load-results-before-combined.json` conserva a primeira carga: zero falhas, mas filtros533ms e erros546ms no p95 ultrapassaram a meta500ms. A carga de seis operações aprovada fica em `load-results-six-operations.json`; a última carga de sete operações fica em `load-results.json`; amostras isoladas de criação em `create-results.json` e seus baselines. Cada arquivo informa início/fim, amostra, bytes, queries e metas. Perfis de memória registram máximos amostrados a cada5s, não um pico absoluto. Os tempos HTTP incluem leitura e parse do corpo pelo cliente, em loopback/PostgreSQL local; não simulam WAN, OCR ou storage de imagens.

Orçamentos F33 são constantes em relação à quantidade de itens: catálogo4 queries, recentes4 normalmente/10 ao expirar em lote, retomada10/16 ao expirar, resposta26/32 ao expirar, criação23 por filtro/29 por prova (incluindo validação da sessão de Auth na escrita). Cada `asServer` inclui mudança e restauração de role, contabilizadas como queries;26 queries não significam26 buscas de questões nem um SELECT por item. Os budgets e casos HTTP estão em `apps/api/src/perf`.

Não aplicar migrations ao `DATABASE_URL` padrão. As migrations0045/0046/0047 foram aplicadas somente nas bases isoladas de fixture e desempenho. O schema de produção permanece pendente de revisão e aplicação coordenada.

A migration0047 adiciona a ordenação global `(created_at DESC,id DESC)` e estatística da expressão `(reviewed_hash=content_hash)`. O gate usa `IS TRUE`, equivalente à igualdade no predicado de acesso: comparaçãoNULL continua negada. Sem essa estatística, o planner estimava103 elegíveis onde havia50.000 e ordenava todas as linhas; com ela, o plano lê200 candidatas pelo índice. A distribuição sintética é50.000TRUE/5.000NULL, explicitada em `review-statistics.json`; não extrapolar essa distribuição para o acervo real. Estatísticas seguem o owner de migration/tabela e não são representadas nos snapshotsDrizzle; o DDL customizado está na0047. ANALYZE após grandes importações e a manutenção normal de autovacuum mantêm as estimativas atuais. O índice anterior por visibility/catalogStatus permanece por ter prefixos de filtro distintos.

A criação isolada passou após índice/estatísticas e remoção do parse duplicado:100 amostras/20 usuários/200 itens, p95353ms,0 falhas. A validação final `questionSessionPublicSchema.parse` continua estrita e integral; snapshot com campoextra `correctKey` é rejeitado e não vaza na resposta. As etapas aparecem no Server-Timing; seus p95 são independentes e não devem ser somados como uma requisição individual. O ensaio final misto confirmou o gate durante os cinco minutos completos, conforme a tabela abaixo.


## Resultado final controlado

Aquecimento: 2026-10-08T23:51:59.399Z; período medido: 23:52:29.502Z–23:57:29.563Z (300.059ms). Foram20 usuários concorrentes,67.431 requisições e0 falhas, incluindo100 criações de200 itens distribuídas pelos cinco minutos. Todos os p95 ficaram dentro das metas fixas.

| Operação | Amostras | p95 ms | Máximo ms | Meta p95 ms | Queries |
|---|---:|---:|---:|---:|---:|
| Busca |11.228|98,317|384,905|500|4|
| Filtros |11.227|247,523|532,707|500|4|
| Caderno de erros |11.226|154,515|427,652|500|4|
| Sessões recentes |11.219|106,082|391,974|500|4|
| Retomada de200 itens |11.217|106,402|376,948|400|10|
| Resposta |11.214|158,937|457,562|400|26|
| Criação de200 itens |100|324,336|400,120|400|23|

A meta é p95, não máximo: houve caudas acima de500ms em filtros e acima de400ms em resposta/criação. Retomada/criação preservaram200 itens e aproximadamente493kB por resposta; nenhum gabarito foi exposto antes da submissão/encerramento. As contagens de queries incluem controles de role e Auth.

A readiness imediatamente anterior à carga final mediu50.000 raízes/50.000 IDs canônicos únicos,5.000 versões,114.082 respostas acumuladas e563MB na base isolada, com zero canonical_idNULL e triggers ativos. A contagem100.000 em load-results é explicitamente o seed inicial; cargas anteriores e esta carga acrescentam tentativas. Esta é evidência de desempenho com dados sintéticos locais, não comprovação de50.000 questões adquiridas nem latência de produção. Imagens, WAN, OCR, provedores e verificação remota JWT/JWKS permanecem fora da amostra.
