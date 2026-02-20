FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    RALPH_REPO=/opt/ralph-claude-code \
    HOME=/root \
    PATH=/root/.local/bin:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        curl \
        gh \
        git \
        jq \
        tmux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR ${RALPH_REPO}
COPY samples/ralph-claude-code/ ./

RUN find . -type f -name "*.sh" -print0 | xargs -0 sed -i 's/\r$//' \
    && chmod +x ./*.sh ./lib/*.sh \
    && ./install.sh \
    && for cmd in ralph ralph-monitor ralph-setup ralph-import ralph-migrate ralph-enable ralph-enable-ci; do ln -sf "/root/.local/bin/${cmd}" "/usr/local/bin/${cmd}"; done \
    && npm install -g @anthropic-ai/claude-code \
    && ralph --help > /dev/null

RUN cd /tmp \
    && git config --global user.name "Ralph Container" \
    && git config --global user.email "ralph@example.local"

COPY ralph-claude-code-containerized/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN mkdir -p /workspace /root/.claude /root/.config/gh
WORKDIR /workspace

VOLUME ["/workspace", "/root/.claude", "/root/.config/gh"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
