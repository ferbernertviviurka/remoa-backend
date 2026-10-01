# CLAUDE.md — remoa-backend

Backend do Remoa: banco (Supabase/Postgres + Drizzle + RLS), contratos compartilhados, domínio (FSRS, IA, Anki) e a API HTTP (`apps/api`, Hono) que o `remoa-frontend` consome.

Regras, vocabulário e DoD do produto: `../CLAUDE.md`, `../AGENTS.md`, `../docs/STATUS.md` e `../docs/features/Fxx-*.md` (pasta `remoa/` que contém este repo). Leia antes de qualquer tarefa.

## Mapa

```
apps/api/            Hono: /health, /v1/* com Bearer do Supabase; rotas por lane em src/routes/<lane>.ts
packages/contracts/  tipos + zod (a "API" entre repos; o frontend usa via link:)
packages/db/         schema Drizzle, migrations (0000 gerada, 0001_rls manual), seed, withUser()
packages/fsrs/       agendador ts-fsrs        packages/ai/   grader e geração (Claude API)
packages/anki/       parser .apkg             packages/log/  @remoa/log (JSON + requestId)
supabase/            config do Supabase local
.claude/agents/      backend, backend-deep, data-fsrs, ai-engineer, content
```

## Comandos

```
pnpm i && pnpm db:up            Supabase local (Docker)
pnpm --silent db:env > .env     chaves locais -> .env (lido por api, db, testes)
pnpm db:migrate && pnpm db:seed
pnpm dev                        API em http://localhost:4000
pnpm check                      lint + typecheck + test (inclui teste de RLS)
```

## Regras deste repo

- `packages/contracts` e `packages/db` só mudam via `architect` com entrada no decision log (`../docs/STATUS.md`). Mudança em contrato quebra o frontend: rode `pnpm check` lá também.
- Todo endpoint valida entrada com zod de `@remoa/contracts`, responde `{ error: { code, message } }` e loga com `@remoa/log`. Rotas de usuário passam por `requireUser`; consultas do usuário passam por `withUser()` para o RLS valer (a conexão é superuser, D-021).
- Depois de `pnpm db:generate`, apague o `CREATE TABLE auth.users` que o drizzle-kit reemite.
