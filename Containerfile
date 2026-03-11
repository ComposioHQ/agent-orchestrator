FROM docker.io/node:lts-trixie-slim AS builder

ARG PNPM_VERSION=9.15.4

ENV PNPM_HOME=/pnpm
ENV PNPM_VERSION=${PNPM_VERSION}
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  g++ \
  git \
  make \
  python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM docker.io/node:lts-trixie-slim AS runtime

ARG PNPM_VERSION=9.15.4
ARG AO_INSTALL_AGENTS=claude-code,codex,aider,goose

ENV PNPM_HOME=/pnpm
ENV PNPM_VERSION=${PNPM_VERSION}
ENV AO_INSTALL_AGENTS=${AO_INSTALL_AGENTS}
ENV PATH="/root/.local/bin:${PNPM_HOME}:${PATH}"
ENV AO_CONFIG_PATH=/app/agent-orchestrator.yaml
ENV HOME=/root

RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends \
  bzip2 \
  ca-certificates \
  curl \
  gh \
  git \
  lsof \
  openssh-client \
  pipx \
  procps \
  python3 \
  python3-venv \
  tmux \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*
RUN corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app

COPY --from=builder /app /app
COPY scripts/container-entrypoint.sh /usr/local/bin/ao-entrypoint
COPY scripts/install-coding-agents.sh /usr/local/bin/install-coding-agents

RUN chmod +x /usr/local/bin/ao-entrypoint /usr/local/bin/install-coding-agents
RUN /usr/local/bin/install-coding-agents "$AO_INSTALL_AGENTS"

EXPOSE 3000 14800 14801

VOLUME ["/root/.agent-orchestrator", "/projects"]

ENTRYPOINT [ "/usr/local/bin/ao" ]
