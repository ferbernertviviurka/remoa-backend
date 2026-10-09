# F27 — proposta revisável de publicação automática restrita à campanha

Estado: **preparada localmente; não provisionada, não staged, não deployada, não chamada em produção**. Escopo autorizado pelo humano: publicar os20artigos. A chamada ampla `blog.publish-scheduled` foi rejeitada pelo auto-review e não é utilizada nesta proposta, direta ou indiretamente.

## Problema confirmado

Connector Railway, somente leitura: projeto `content-elegance` (`8d8529c2-274c-4a9e-b5ea-f3bb7be28773`), ambiente `production` (`49bd5774-02bb-495a-a64b-6516495d5431`), único serviço `remoa-backend` (`dd941b78-4b28-4e60-a86e-e02b3c3482bc`). Serviço online, deployment `0bbdea06-0943-4ad9-a978-4e8378f717d9`, commit `55f1f0c69b6d7e95f78bba2a9aadb0d1ba1ca5e1`; `isCronJob:false`, `cronJob:null`, nenhum serviço cron paralelo no projeto acessível. Nomes das variáveis não incluem as chaves Inngest. Log em `2026-10-09T01:14:29.648264127Z`: `In cloud mode but no signing key found`. Evidência completa sanitizada em `docs/content/blog-campaign-2026-10/ops-notes.md` no workspace externo ao backend.

## Por que não usar a sessão admin como agendador

`apps/api/src/admin/core/require-admin.ts` exige12horas desde a última autenticação real (`amr[].timestamp`) para `/v1/admin/*`. Refresh não renova essa idade no código. Portanto um JWT/refreshtoken obtido legitimamente hoje não sustenta a campanha20dias. Não alongar validade, falsificar claims, promover usuário, exportar cookies internos ou fornecer service-role à tarefa. [Sessões Supabase](https://supabase.com/docs/guides/auth/sessions) usam JWT curto e tokens de refresh rotativos; aqui existe ainda a restrição local de12h. SkillSupabase e diretrizes de env/deploy lidas; nenhuma mudança no Auth ou banco proposta.

## Contrato combinado com a lane architect_campaign

Novo endpoint literal **`POST /v1/cron/blog.campaign-2026-10`**, antes do `/:job` genérico. Autenticação por **`BLOG_CAMPAIGN_2026_10_SECRET`**, nova credencial específica, com pelo menos32caracteres e diferente de `CRON_SECRET`. Sem body e sem query. Não aceita IDs, slugs, datas, relógio, hashes ou seleção enviados pelo caller. Resposta `{ok:true,data:{campaignId:'F27-editorial-20d',published:integer0..20}}`.

Servidor deve manter allowlist compilada dos20slugs, datas e fingerprints do manifest aprovado. `BLOG_CAMPAIGN_2026_10_ENROLLMENT` contém exatamente20registros `{slug,id,coverAssetId}` com IDs reais aprovados depois da criação/upload pela sessão admin. Ausência de config/secret falha fechada, não recai no cron amplo. Job deve conferir status agendado, due por relógio servidor, conteúdo/metadata/capa esperados e não exclusão; lock+update+auditoria `system` idempotentes na mesma transação. Nenhum cleanup/manutenção/conta/billing/email fica acessível por essa credencial. Expiração fixa `2026-10-29T06:00:00Z`. A lane architect implementa/revisa/testa o servidor; estes scripts não implementam banco, auth privilegiada ou contrato de feature.

**Detalhes importantes para revisão:** o hash de conteúdo precisa tratar a serializaçãoTiptap real (`rel:null`, hint`external`, orderedListstart1/attrs vazios e parágrafo final vazio) de forma canônica, sem aceitar alterações semânticas. Publicação deve continuar revalidando blog/post/categoria/Landing/feed/sitemap. Falha de revalidação após commit precisa de recuperação idempotente, sem publicar outra vez. UI não expõe todo campo do manifest; exigir excerpt/canonical/keyword/etc requer conferir a gravação real. O client verifica apenas o contrato pequeno da resposta; a seleção e integridade pertencem ao servidor.

## Caller pronto para revisão

- `run-targeted.mjs`: Node puro, nenhum pacote, URL literal única. Sem body/query ou override de endpoint. Defaultdry-run sem rede. `--execute` usa somente a secret dedicada, rejeita presença de DATABASE_URL/CRON_SECRET/service-role/JWTadmin; abort45s, sem redirecionamento, sem retry de transporte incerto, logs sem segredo/body. Fora da janela fixa encerra sem rede.
- `run-targeted.test.mjs`:9testes com fetchmock, todos verdes: janela/credenciais, URL/body/query, sucesso/no-op, negaçãoHTTP sem conteúdo sensível, uma única tentativa em transporte incerto, resposta malformada/outrocampaignId/count inválido. `node --test scripts/blog-campaign/run-targeted.test.mjs` reexecuta offline.
- `Dockerfile`: imagemNode22-slim, copia apenas o caller, usuárioNode, sembootAPI/migrations/DB/manutenção.
- `railway.campaign.json`: Dockerfile acima, cron`*/5 * * * *`, restartNEVER. Chamadas fora do horário due retornam0; reexecuções normais dependem da idempotência servidor. Para20dias, são até5760inícios de serviço com288execuções/dia; não são5760publicações. Alternativa econômica `0 12 * * *` roda às09hBrasília, mas perde tentativas adicionais no mesmo dia se houver falha. [RailwayCron](https://docs.railway.com/cron-jobs) opera emUTC, intervalo mínimo5min e pode atrasar alguns minutos; não prometer minuto exato.

## Passos concretos, somente após código aprovado e autorização de deploy

1. Finalizar20posts/capas e obterIDs reais por leitura admin legítima ou linksPreview assinados criados pelaUI auditada. Não derivar assetId de suposição nem preencherplaceholder. Conferir20readbacks contra o manifest.
2. Rever endpoint/caller/testes e escolher commit contendo **somente** as alterações aprovadas, sobre o baseline de produção. Este workspace tem outros trabalhos ativos; não deployar HEAD amplo por conveniência. ODockerfileAPI existente executa `pnpm db:migrate` no boot: a revisão do commit deve confirmar ausência de migrations novas inadvertidas. A campanha não requer migration.
3. Gerar credencial dedicada sem expor valor e configurar apenas os dois campos de campanha naAPI: secret e enrollment validado. Não reusar CRON_SECRET. Nenhum valor precisa sair em relatório.
4. Preparar novo serviço `remoa-blog-campaign-2026-10` no mesmo projeto/ambiente com **staged:true**. Ferramentas Railway suportam create-service vazio, connect-service-source com commitSha fixo, update-service comDockerfile/config/cron/restart e set-variables por referência. Não executar create-deployment, que dispara deploy imediatamente.
5. Fonte verificada do projeto: `ferbernertviviurka/remoa-backend`; **commitSha revisado ainda pendente**, nunca inventar SHA. Ligar fonte staged e pinado, configure o arquivo` scripts/blog-campaign/railway.campaign.json` e oDockerfile. Ocaller só precisa de `BLOG_CAMPAIGN_2026_10_SECRET=${{remoa-backend.BLOG_CAMPAIGN_2026_10_SECRET}}`; não copiar bloco de env daAPI. Variáveis de campanha no servidor devem ser scoped nele, não shared no ambiente.
6. Ler o patch inteiro do ambiente e confirmar que contém somente este trabalho. `accept-deploy` comita **todas** as alterações staged do ambiente, não só o serviço. Só executar com autorização explícita de deploy obtida pelo root e com o commit/config/enrollment concretos revisáveis.
7. Depois do deploy aprovado, confirmar no connector estado do serviço comoCron, resultado das execuções e logs do endpoint restrito; confirmar publicação natural do primeiro artigo e ausência de posts externos à campanha. Testes positivos/negativos de lógica devem ocorrer primeiro em ambiente isolado, não disparando cron amplo emprodução. Depois da janela, ocaller não chamaAPI; arquivar/remover o serviço com aprovação separada se necessário.

## Parâmetros preparados, ainda não enviados

```json
{
  "create_service": {
    "projectId": "8d8529c2-274c-4a9e-b5ea-f3bb7be28773",
    "environmentId": "49bd5774-02bb-495a-a64b-6516495d5431",
    "name": "remoa-blog-campaign-2026-10",
    "staged": true
  },
  "connect_service_source": {
    "projectId": "8d8529c2-274c-4a9e-b5ea-f3bb7be28773",
    "environmentId": "49bd5774-02bb-495a-a64b-6516495d5431",
    "serviceId": "REQUIRES_CREATED_SERVICE_ID",
    "repo": "ferbernertviviurka/remoa-backend",
    "commitSha": "REQUIRES_REVIEWED_COMMIT_SHA",
    "staged": true
  },
  "update_service": {
    "projectId": "8d8529c2-274c-4a9e-b5ea-f3bb7be28773",
    "environmentId": "49bd5774-02bb-495a-a64b-6516495d5431",
    "serviceId": "REQUIRES_CREATED_SERVICE_ID",
    "railwayConfigFile": "scripts/blog-campaign/railway.campaign.json",
    "dockerfilePath": "scripts/blog-campaign/Dockerfile",
    "startCommand": "node /job/run-targeted.mjs --execute",
    "cronSchedule": "*/5 * * * *",
    "restartPolicyType": "NEVER",
    "staged": true
  },
  "set_variables": {
    "projectId": "8d8529c2-274c-4a9e-b5ea-f3bb7be28773",
    "environmentId": "49bd5774-02bb-495a-a64b-6516495d5431",
    "serviceId": "REQUIRES_CREATED_SERVICE_ID",
    "variables": {
      "BLOG_CAMPAIGN_2026_10_SECRET": "${{remoa-backend.BLOG_CAMPAIGN_2026_10_SECRET}}"
    },
    "staged": true
  }
}
```

Os placeholders são gates explícitos de prontidão, não parâmetros executáveis. A ferramenta aceita configuraçãoStaged; esta lane **não chamou nenhuma ferramenta de mutação**, nem staged, nem endpoint.

## Custo e limites

Não há preço em reais/dólares estimado: faltam plano, uso medido, consumo real e saldo do workspace. Novo serviço gera uso de recursos/billing doRailway; a frequência escolhida muda os inícios/no-ops. Consulte plano/usage antes da aprovação e não declare custozero ou incluído sem evidência. A opção diária minimiza chamadas, a opção5min oferece recuperação mais rápida. Recursos e valores monetários não foram inventados. Uma falha de configuração/enrollment deixa o job fechado, deve aparecer comoexit1/log e exige ação; não contornar ativando os jobs amplos.

## Alternativa de restaurar Inngest geral

Configurar chaves legítimasInngest e registrar `https://backend.remoa.com.br/api/inngest` pode restaurar o agendador do produto, mas também ativa todas as funções registradas (manutenção/notificações/cleanup etc). Não está sendo utilizado como alternativa à rejeição do cron amplo. Requer avaliação e autorização própria do escopo. Documentação oficial: [chaves](https://www.inngest.com/docs/platform-and-operations/keys-and-access) e [registro de apps](https://www.inngest.com/docs/platform-and-operations/apps-and-syncs). Nenhuma chave será fabricada ou copiada de outra conta.

## Revisão de menor custo — leitura em 2026-10-09

Nova leitura do connector confirmou somente `remoa-backend`, online, nenhuma mudança staged/applying e nenhum cron. `list-workspaces` informa workspace pessoal `My Projects` (`4473f3ad-d67d-4070-80d6-2eca4a9b55bf`), mas não informa plano, créditos ou gasto. As capabilities disponíveis não têm consulta de billing/assinatura: métricas de CPU/memória não provam saldo incluído. Não assumir Hobby por ser workspace pessoal.

**Opção mínima usando Railway:** manter a API contínua e criar o caller dedicado com `cronSchedule: "0 12 * * *"`, config/caller/secret/commit isolado descritos acima e sem volume/domínio/servidor HTTP. São 20 execuções esperadas na campanha, em vez de 5760 na frequência de 5 minutos; não são valores de billing. O arquivo `railway.campaign.json` ainda contém a opção 5 minutos e deve ser ajustado no commit revisado se o root escolher diária; evitar conflito entre config-as-code e override do dashboard. Uma falha diária deixa o post pendente até uma execução posterior; recuperação manual somente pelo endpoint restrito autorizado. O endpoint e caller expiram, mas a configuração cron continuaria iniciando no-ops depois da janela: desativar o cron/retirar o serviço após a campanha, conforme autorização de lifecycle.

Não configurar cron no serviço da API existente: cron substitui o padrão de execução daquele serviço e requer processo que termina; nossa API permanece atendendo HTTP. [Railway Cron](https://docs.railway.com/cron-jobs) documenta que uma execução que continua ativa faz a seguinte ser ignorada. Não há opção no connector de acrescentar um cron independente dentro do mesmo serviço contínuo sem mudar o código/arquitetura do processo.

[Preços Railway](https://docs.railway.com/pricing/plans) consultados hoje cobram recursos efetivamente usados, não uma taxa fixa publicada por cada serviço adicional; builds não têm cobrança de CPU/memória. As taxas de container publicadas são RAM US$0,000231/GB/min, CPU US$0,000463/vCPU/min e egress US$0,05/GB. Fórmula para avaliar uso real: soma dos GB-min de memória × taxa + vCPU-min × taxa + GB de egress × taxa. Duração, consumo e saldo incluído desta conta não são conhecidos; não fornecer total monetário ou garantir zero. Um caller que termina rapidamente pode ter consumo pequeno, mas isso é inferência operacional, não medição da conta.

**Alternativa sem novo serviço Railway:** GitHub Actions no repositório já conectado, onde existem workflows `ci.yml` e `bench.yml`. Workflow novo exclusivo desta campanha, presente na branch default, `schedule: cron: "0 12 * * *"`, `permissions: contents: read`, `concurrency` exclusiva sem cancelar execução em andamento, `timeout-minutes: 2`, runner Ubuntu standard, checkout do SHA isolado/revisado, Node22, comando único `node scripts/blog-campaign/run-targeted.mjs --execute`, secret dedicada de repository/environment disponibilizada somente ao step de execução. Sem instalação de dependências, artifacts, cache, migrations ou CRON_SECRET. Opcional segunda tentativa independente às12:15Z (`0,15 12 * * *`) melhora recuperação mantendo 40 inícios esperados; o servidor continua responsável por due/escopo/idempotência.

[GitHub Schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) avisa de atrasos e possível descarte sob alta carga, sobretudo no início da hora; não garante09:00 exato. [Billing GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) informa gratuidade de runners standard para repo público e franquia por plano para repo privado, com cobrança acima dela. Não foram verificadas visibilidade/franquia/saldo/permissões de secrets deste repo; não chamar esta alternativa gratuita sem esses dados. Criar workflow na default pode acionar autodeploy Railway ligado à branch: integrar somente commit isolado aprovado e controlar pin da fonte de produção. Esta alternativa é proposta, não arquivo de workflow criado ou executado.

**Autorização das ferramentas:** `railway_accept_deploy` exige que o humano tenha explicitamente confirmado deploy; a autorização atual relatada pelo root inclui implantação e pode satisfazer esse requisito, sem repetir pergunta só por existir essa regra. A ferramenta comita todas as mudanças staged do ambiente, portanto continua obrigatório conferir patch completo, SHA e enrollment concretos. A descrição não exige confirmação separada para cada serviço. A decisão de criar recurso com uso faturável permanece dependente da autorização/limite de custo existente na sessão; não ampliar escopo para outros jobs. Esta lane recebeu instrução expressa de somente leitura e não fez criação, staging, configuração, deploy ou chamada cron.
