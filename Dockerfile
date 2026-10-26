# syntax=docker/dockerfile:1.7
# Two targets: "web" (Next.js + voice WebSocket) and "worker" (SQS jobs, LibreOffice for PDF).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/* \
 && wget -qO /etc/ssl/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY config/package.json config/
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY scripts/package.json scripts/
COPY infra/package.json infra/
RUN pnpm install --frozen-lockfile --filter '!@aba/infra'

FROM deps AS build
COPY . .
RUN pnpm --filter @aba/web build

FROM base AS web
ENV NODE_ENV=production RDS_CA_FILE=/etc/ssl/rds-global-bundle.pem PORT=3000
COPY --from=build /app /app
USER node
EXPOSE 3000
# Bootstrap (create runtime role if missing, apply migrations as owner), then serve.
CMD ["sh", "-c", "cd /app/scripts && npx tsx bootstrap-db.ts && cd /app/apps/web && npx tsx server.ts"]

FROM base AS worker
ENV NODE_ENV=production RDS_CA_FILE=/etc/ssl/rds-global-bundle.pem SOFFICE_BIN=soffice
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer-nogui fonts-liberation && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app /app
COPY config /app/config
COPY packages /app/packages
COPY apps/worker /app/apps/worker
USER node
WORKDIR /app/apps/worker
ENTRYPOINT ["npx", "tsx", "src/main.ts"]
