FROM node:20-slim AS base

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    git gh gpg gpg-agent jq curl ca-certificates openssh-client \
    python3 python3-venv python3-dev \
    build-essential pkg-config libssl-dev golang-go \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain stable \
    && ln -sf /root/.cargo/bin/cargo /usr/local/bin/cargo \
    && ln -sf /root/.cargo/bin/rustc /usr/local/bin/rustc
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && chmod +x /usr/local/bin/uv

RUN useradd -m -s /bin/bash agent
RUN mkdir -p /workspace/repo /workspace/worktrees /workspace/state /workspace/logs \
    && chown -R agent:agent /workspace

# Claude Code CLI requires these paths to exist
RUN mkdir -p /etc/claude-code && echo '{}' > /etc/claude-code/managed-settings.json
RUN mkdir -p /home/agent/.claude/debug && chown -R agent:agent /home/agent/.claude

# --- Build stage: compile TypeScript ---
FROM base AS build

WORKDIR /opt/agent
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npx tsc

# --- Runtime stage ---
FROM base AS runtime

WORKDIR /opt/agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /opt/agent/dist/ ./dist/
COPY --chmod=755 scripts/entrypoint.sh /opt/agent/scripts/entrypoint.sh
COPY prompts/ /opt/agent/prompts/

RUN chown -R agent:agent /opt/agent

USER agent
WORKDIR /workspace

ENV DISABLE_AUTOUPDATER=1
ENV DISABLE_NONESSENTIAL_TRAFFIC=1

ENTRYPOINT ["/opt/agent/scripts/entrypoint.sh"]
