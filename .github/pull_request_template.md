## Feature

ID da feature (ex: F03), tarefa (ex: T2 / backend) e breve descrição.

## O que mudou

- ...
- ...

## Modelo usado e escalação

- Modelo: haiku / sonnet / opus
- Escalou? sim / não
- Por quê (se aplicável): ...

## Decisões D-xxx registradas no STATUS

- D-NNN: ...
- D-NNN: ...

## Checklist (Definition of Done)

- [ ] Requisitos P0 do FRD implementados, com os critérios de aceite verificados por teste
- [ ] `pnpm check` e `pnpm test:e2e` verdes; cobertura de domínio ≥ 90%
- [ ] Toda UI em Torph (`@remoa/ui` + `@remoa/strings`); `pnpm strings:check` verde
- [ ] Eventos Mixpanel do FRD disparando com as propriedades definidas
- [ ] RLS e validação zod nos novos endpoints; sem segredo no diff
- [ ] `docs/STATUS.md` atualizado (feature, decisões, modelo usado, pendências) e o `docs/features/Fxx-*.md` com status e perguntas respondidas
- [ ] Revisão por outro agente (`qa`) aprovada

## Pendências / questões

- ...
