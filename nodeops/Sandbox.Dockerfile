FROM nodeops/sandbox:debian

RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        gnupg \
        openssh-client \
        procps \
        tar && \
    mkdir -p /etc/apt/keyrings && \
    curl --fail --location --silent --show-error \
        https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install --yes --no-install-recommends nodejs && \
    npm install --global \
        @anthropic-ai/claude-code@2.1.228 \
        @openai/codex@0.147.0 && \
    rm -rf /var/lib/apt/lists/* /root/.npm && \
    claude --version && \
    codex --version

RUN architecture="$(dpkg --print-architecture)" && \
    case "$architecture" in \
        amd64) cursor_arch=x64 ;; \
        arm64) cursor_arch=arm64 ;; \
        *) echo "unsupported Cursor Agent architecture: $architecture" >&2; exit 1 ;; \
    esac && \
    cursor_version=2026.08.11-e8db854 && \
    mkdir -p "/opt/cursor-agent/$cursor_version" && \
    curl --fail --location --silent --show-error \
        "https://downloads.cursor.com/lab/$cursor_version/linux/$cursor_arch/agent-cli-package.tar.gz" \
        | tar --strip-components=1 -xzf - -C "/opt/cursor-agent/$cursor_version" && \
    ln -s "/opt/cursor-agent/$cursor_version/cursor-agent" /usr/local/bin/cursor-agent && \
    cursor-agent --version
