# ---- Base stage: shared pnpm + monorepo setup ----
FROM node:20-bookworm-slim AS base

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config and lockfile first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json ./

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

# Build dependencies first
RUN pnpm --filter @composio/ao-core build

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

# Build in dependency order
RUN pnpm --filter @composio/ao-core build \
    && pnpm --filter @composio/ao-web build \
    && pnpm --filter @composio/ao-cli build

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

COPY --from=build /app/packages/cli/dist packages/cli/dist
COPY --from=build /app/packages/cli/package.json packages/cli/package.json
COPY --from=build /app/packages/cli/templates packages/cli/templates
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json

RUN chown -R aouser:aouser /app
USER aouser

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["--help"]
