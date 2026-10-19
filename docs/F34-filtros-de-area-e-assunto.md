# F34 — Filtros de área e assunto

D-1888 / CCR-175, 19/10/2026. O estado da entrega é mantido no `docs/STATUS.md` do projeto Remoa.

Fernando autorizou disponibilizar as sugestões com o aviso **“Classificação automática, ainda não revisada”**. Essa autorização permite organizar e filtrar questões; não registra uma nova aprovação editorial ou médica.

- Banco, catálogo administrativo e Criador compartilham a hierarquia curso → área → assunto. Trocar o curso limpa seleções incompatíveis; assuntos pertencem às áreas selecionadas. O catálogo administrativo também reinicia o cursor e a seleção em lote.
- As classificações automáticas ficam em tabelas próprias, com execução e evidências imutáveis vinculadas aos hashes originais. Não alteram enunciados, alternativas, respostas, assinaturas nem os campos históricos da matriz ENAMED.
- O conjunto inicial contém 1.209 sugestões em 119 nós; 1.167 questões são aptas para resolução. As demais sugestões correspondem a questões anuladas ou indisponíveis. As 26 questões legadas classificadas continuam separadas. Sem sugestão segura, a questão permanece em **Não classificadas**.
- “Não classificadas” significa ausência de área **ou** assunto efetivo. Contagens na hierarquia representam questões públicas aptas; catálogos também podem incluir questões apenas para consulta. Outros filtros podem reduzir a disponibilidade.
- A API de hierarquia é `GET /v1/questions/classification?course=<curso>`. Os filtros existentes `areaIds`/`topicIds` aceitam nós ENAMED e automáticos; `classificationStatus=unclassified` seleciona as não classificadas.
- Classificações automáticas são aplicáveis à origem `catalog`. Ao mudar para IA ou mista, a interface limpa os identificadores automáticos e informa a mudança. O backend rejeita esses identificadores fora do catálogo antes de geração ou cobrança.
- A prévia e o início da prova verificam a classificação atual, inclusive questões fixadas quando há filtro automático ou de não classificadas. Revogação da execução, da fonte, do lote ou divergência dos hashes impede usar o vínculo; seleções que deixaram de corresponder retornam `exam_changed`. Sessões já iniciadas preservam seu snapshot.
- A ativação ocorre pelo endpoint administrativo auditado e idempotente, com pacote fixado no servidor. Ordem de disponibilização: frontend compatível → backend e migração 0062 → indexação → conferência de produção. Indisponibilidade da hierarquia mostra erro e opção de tentar novamente, sem simular catálogo vazio.
