# D-700: API image for Railway (also used by the hourly maintenance cron). The workspace packages export TypeScript source,
# so the API runs through tsx instead of a compiled build. Node 22: supabase-js >= 2.117 needs the native WebSocket.
FROM node:22-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# package.json first: its packageManager field pins pnpm 9 for corepack.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile

# Unset NODE_ENV counts as production too, but say it: STRIPE/AI/GRADER=mock refuse to boot outside development/test.
ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "@remoa/api", "exec", "tsx", "src/index.ts"]
