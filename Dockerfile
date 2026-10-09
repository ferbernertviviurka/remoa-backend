# D-700: API image for Railway (also used by the hourly maintenance cron). The workspace packages export TypeScript source,
# so the API runs through tsx instead of a compiled build. Node 22: supabase-js >= 2.117 needs the native WebSocket.
FROM node:22-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# F33 PDF review/OCR worker: Portuguese language data, bounded subprocesses; maps Mistral OCR is preserved.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-por curl ca-certificates && rm -rf /var/lib/apt/lists/*

# CCR125: immutable upstream commit + verified bytes. No download during requests/jobs.
# Apache-2.0 license accompanies the model; the distro's TSV config remains available.
ENV TESSDATA_PREFIX=/opt/remoa-question-tessdata
RUN mkdir -p "$TESSDATA_PREFIX" \
    && cp -a /usr/share/tesseract-ocr/5/tessdata/configs "$TESSDATA_PREFIX/configs" \
    && curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 180 \
       https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/por.traineddata \
       --output "$TESSDATA_PREFIX/por.traineddata" \
    && printf '%s  %s\n' '711de9dbb8052067bd42f16b9119967f30bada80d57e2ef24f65d09f531adb04' "$TESSDATA_PREFIX/por.traineddata" | sha256sum --check --strict - \
    && curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 60 \
       https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/LICENSE \
       --output "$TESSDATA_PREFIX/LICENSE"

WORKDIR /app

# package.json first: its packageManager field pins pnpm 9 for corepack.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile

# Unset NODE_ENV counts as production too, but say it: STRIPE/AI/GRADER=mock refuse to boot outside development/test.
ENV NODE_ENV=production
EXPOSE 4000
# D-1204: migrations run on every deploy, before the API listens. A failed migration exits non-zero, the healthcheck never passes
# and Railway keeps the previous deploy serving. Does not depend on the dashboard reading railway.json (preDeployCommand never ran).
CMD ["sh", "-c", "pnpm db:migrate && exec pnpm --filter @remoa/api exec tsx src/index.ts"]
