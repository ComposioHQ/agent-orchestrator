# syntax=docker/dockerfile:1
#
# AO cloud sandbox image — runs the full `ao` daemon + the codex agent inside one
# Daytona sandbox (the single-box cloud design). linux/amd64 only.
#
# Source of the `ao` binary: cloned from the AO repo at build time (see AO_REPO_URL /
# AO_REF). AO_REF is a branch or tag — `git clone --branch` does NOT accept a bare
# commit SHA; pin to a tag if you want a reproducible image.
#
# Why bake the `ao` binary here instead of `go build` at sandbox startup: the daemon
# is prebuilt and boots instantly, with no module fetch or compile step at boot. The
# Go toolchain is ALSO shipped in the runtime (stage 2) — not for the daemon, but so
# the agent can build / test / format the Go repo it works on.

##############################################
# Stage 1 — build the `ao` daemon binary      #
##############################################
FROM golang:1.25-bookworm AS ao-build

# Which AO source to bake. AO_REF = branch or tag (not a commit SHA).
# NOTE: the Daytona CLI has no --build-arg flag, so these ARGs CANNOT be overridden
# via `daytona snapshot create` / `daytona create` — the defaults below are what the
# build uses. Change them here to build a different source. AgentWrapper/agent-
# orchestrator is this checkout's origin (public). A private repo would need creds
# wired into the build (Daytona Git integration), not a token embedded in the URL.
ARG AO_REPO_URL=https://github.com/AgentWrapper/agent-orchestrator.git
ARG AO_REF=main

WORKDIR /src
RUN git clone --depth 1 --branch "${AO_REF}" "${AO_REPO_URL}" agent-orchestrator

# go.mod lives under backend/; the daemon entry point is ./cmd/ao. Go module deps
# are fetched here at BUILD time, so the runtime sandbox never needs the Go proxy.
# AO is CGO-free (pure-Go SQLite via modernc.org/sqlite), so a fully static,
# libc-free binary is produced with CGO disabled.
WORKDIR /src/agent-orchestrator/backend
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/ao ./cmd/ao


##############################################
# Stage 2 — runtime sandbox                   #
##############################################
# node:22 base gives Node 22 for codex (and most agent CLIs); Debian bookworm so
# apt is available for AO's runtime dependencies.
FROM node:22-bookworm-slim AS runtime

# AO runtime deps + tooling agents expect:
#   git   — AO's workspace adapter (worktrees, clone/commit/push)
#   gh    — authenticated GitHub API, pull requests, and git credential setup
#   tmux  — AO's Linux runtime; `ao` session spawn FAILS without it
#   rest  — TLS roots, curl, ps, ripgrep, less, ssh client for agent ergonomics
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        gh \
        tmux \
        ca-certificates \
        curl \
        procps \
        ripgrep \
        less \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Codex CLI (latest). Auth is supplied at RUNTIME (codex login --device-auth, or
# OPENAI_API_KEY) — never baked into the image.
# (To add Claude Code later: npm install -g @anthropic-ai/claude-code)
RUN npm install -g @openai/codex

# The prebuilt daemon from stage 1.
COPY --from=ao-build /out/ao /usr/local/bin/ao

# The Go toolchain (from the builder's /usr/local/go) so the agent can build, test,
# and format the Go repo it works on. NOT needed by the daemon (prebuilt above);
# adds ~450MB. Drop this block if the agent only ever works on non-Go repos.
COPY --from=ao-build /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

# Keep ALL mutable state under one tree (~/.ao) so a single `stop` (which preserves
# the sandbox disk) persists the DB and the agent login together. AO_DATA_DIR is
# used verbatim (no /data appended), so point it at the canonical .../data subdir to
# match AO's default layout; CODEX_HOME relocates codex's ~/.codex under the same tree.
ENV HOME=/root
ENV AO_DATA_DIR=/root/.ao/data
ENV CODEX_HOME=/root/.ao/codex
WORKDIR /root

# Build-time sanity: fail the build if any required tool is missing or unhealthy.
RUN git --version \
    && gh --version \
    && tmux -V \
    && node --version \
    && npm --version \
    && go version \
    && test -x /usr/local/bin/ao \
    && codex --version

# Keep PID 1 alive. We intentionally do NOT auto-start the daemon: you first
# authenticate codex (codex login --device-auth) and then start the headless
# daemon by hand with `ao daemon` (NOT `ao start`, which fetches/launches the
# Electron desktop app). Daytona manages the sandbox lifecycle and may override this.
CMD ["sleep", "infinity"]
