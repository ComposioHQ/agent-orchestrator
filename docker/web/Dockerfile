# ---- Base stage: shared pnpm + monorepo setup ----
FROM node:20-bookworm-slim AS base

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# node-pty requires build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace config and lockfile first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json ./

# Copy postinstall script required by root package.json
COPY scripts/ scripts/

# Copy all package.json files needed by web and its workspace dependencies
COPY packages/core/package.json packages/core/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/plugins/ packages/plugins/

# ---- Development stage ----
FROM base AS dev

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --filter @composio/ao-web...

# Copy source files
COPY packages/core/ packages/core/
COPY packages/web/ packages/web/

# Build only transitive dependencies (core + plugins), not web itself — dev uses next dev
RUN pnpm --filter @composio/ao-web^... build

# Non-root user
RUN groupadd -r aouser && useradd -r -g aouser -m aouser \
    && chown -R aouser:aouser /app
USER aouser

WORKDIR /app/packages/web

EXPOSE 3000 14800 14801

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

CMD ["pnpm", "dev"]

# ---- Build stage ----
FROM base AS build

RUN pnpm install --frozen-lockfile --filter @composio/ao-web...

COPY packages/core/ packages/core/
COPY packages/web/ packages/web/

# Build all transitive workspace dependencies then web
RUN pnpm --filter @composio/ao-web... build

# ---- Production stage ----
FROM node:20-bookworm-slim AS prod

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Non-root user
RUN groupadd -r aouser && useradd -r -g aouser -m aouser

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy all built packages (web, core, plugins) — pnpm workspace symlinks
# in node_modules resolve to packages/*/ so all must be present
COPY --from=build /app/packages packages
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json

RUN chown -R aouser:aouser /app
USER aouser

EXPOSE 3000 14800 14801

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

WORKDIR /app/packages/web

CMD ["pnpm", "start:all"]
