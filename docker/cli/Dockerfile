# ---- Base stage: shared pnpm + monorepo setup ----
FROM node:20-bookworm-slim AS base

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config and lockfile first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json ./

# Copy postinstall script required by root package.json
COPY scripts/ scripts/

# Copy all package.json files needed by CLI and its workspace dependencies
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/plugins/ packages/plugins/

# ---- Development stage ----
FROM base AS dev

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tmux \
    curl \
    jq \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --filter @composio/ao-cli...

# Copy source files
COPY packages/core/ packages/core/
COPY packages/cli/ packages/cli/
COPY packages/web/ packages/web/

# Build transitive deps (core + plugins) excluding web — dev uses tsx for cli,
# and cli only needs web's package.json path (not its built output)
RUN pnpm --filter "@composio/ao-cli^..." --filter "!@composio/ao-web" build

# Non-root user
RUN groupadd -r aouser && useradd -r -g aouser -m aouser \
    && chown -R aouser:aouser /app
USER aouser

WORKDIR /app/packages/cli

CMD ["pnpm", "dev"]

# ---- Build stage ----
FROM base AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile --filter @composio/ao-cli...

COPY packages/core/ packages/core/
COPY packages/cli/ packages/cli/
COPY packages/web/ packages/web/

# Build all transitive workspace dependencies then CLI
RUN pnpm --filter @composio/ao-cli... build

# ---- Production stage ----
FROM node:20-bookworm-slim AS prod

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tmux \
    curl \
    jq \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Non-root user
RUN groupadd -r aouser && useradd -r -g aouser -m aouser

# Copy all built packages (cli, core, plugins, web) — pnpm workspace symlinks
# in node_modules resolve to packages/*/ so all must be present
COPY --from=build /app/packages packages
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json

RUN chown -R aouser:aouser /app
USER aouser

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["--help"]
