# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/drop/Dockerfile .
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY config/package.json config/
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/drop/package.json apps/drop/
COPY scripts/package.json scripts/
COPY infra/package.json infra/
RUN pnpm install --frozen-lockfile --filter '@aba/drop...'
COPY config config
COPY packages/core packages/core
COPY apps/drop apps/drop
ENV NODE_ENV=production PORT=8080
USER node
WORKDIR /app/apps/drop
EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
