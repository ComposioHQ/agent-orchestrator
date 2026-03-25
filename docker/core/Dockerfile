# ---- Base stage: shared pnpm + monorepo setup ----
FROM node:20-bookworm-slim AS base

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config and lockfile first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy postinstall script (rebuild-node-pty.js) required by root package.json
COPY scripts/ scripts/

# Copy all package.json files to resolve workspace dependencies
COPY packages/core/package.json packages/core/package.json

# Install production dependencies only for core
RUN pnpm install --frozen-lockfile --filter @composio/ao-core...

# ---- Build stage ----
FROM base AS build

COPY packages/core/ packages/core/
COPY tsconfig.base.json ./

RUN pnpm --filter @composio/ao-core build

# ---- Development stage ----
FROM base AS dev

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY packages/core/ packages/core/
COPY tsconfig.base.json ./

# Non-root user
RUN groupadd -r aouser && useradd -r -g aouser -m aouser \
    && chown -R aouser:aouser /app
USER aouser

WORKDIR /app/packages/core

CMD ["pnpm", "test:watch"]

# ---- Production stage ----
FROM node:20-bookworm-slim AS prod

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Non-root user
RUN groupadd -r aouser && useradd -r -g aouser -m aouser

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json

RUN chown -R aouser:aouser /app
USER aouser

CMD ["node", "packages/core/dist/index.js"]
