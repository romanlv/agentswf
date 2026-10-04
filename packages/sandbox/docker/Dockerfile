# The docker provider's default image (story 004): node 22 for pi, the proxy and the door's relay,
# bun for the bundled wf, git, the four harnesses, and Herdr. Its tag is a hash of this file, so
# every input is pinned here: a change to one is a new image, not a stale one under the old tag.
# The proxy and the relay are run from their sources beside this file, not copied in.
ARG BUN_VERSION=1.4.0
FROM oven/bun:${BUN_VERSION}-debian AS bun

FROM node:22.20.0-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.283
ARG CODEX_VERSION=0.159.3
ARG PI_VERSION=0.87.1
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl procps zsh \
    && rm -rf /var/lib/apt/lists/*
# The Herdr the adapter drives (`HERDR_VERSION` in its herdr.ts), by release and checksum: a box
# whose Herdr differs is refused panes. The checksums are this release's; a new one needs its own.
ENV HERDR_VERSION=0.9.1
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) arch=x86_64; sum=2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7 ;; \
      arm64) arch=aarch64; sum=f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e ;; \
      *) echo "no Herdr for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /usr/local/bin/herdr \
      "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${arch}" \
    && echo "${sum}  /usr/local/bin/herdr" | sha256sum -c - \
    && chmod 755 /usr/local/bin/herdr
# cursor-agent, a release directory holding its own node, by version and checksum, as Herdr is.
ARG CURSOR_AGENT_VERSION=2026.10.01-14929f9
RUN case "${TARGETARCH}" in \
      amd64) arch=x64; sum=ba9a855f8f813c91b9f2707127572d2dc9ae5a62818e1c36719625d0fb8bd452 ;; \
      arm64) arch=arm64; sum=c31ef0ba6b827fdf8053919de57abae4a7bd71afefdf2cab061e276faac42b3a ;; \
      *) echo "no cursor-agent for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/cursor-agent.tgz \
      "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${arch}/agent-cli-package.tar.gz" \
    && echo "${sum}  /tmp/cursor-agent.tgz" | sha256sum -c - \
    && mkdir -p /opt/cursor-agent \
    && tar --strip-components=1 -xzf /tmp/cursor-agent.tgz -C /opt/cursor-agent \
    && rm /tmp/cursor-agent.tgz \
    && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent
ENV SHELL=/bin/bash
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force
