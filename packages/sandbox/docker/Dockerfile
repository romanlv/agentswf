# The docker provider's default image (story 004): node 22 for pi, the proxy and the door's relay,
# bun for the bundled wf, git, the three harnesses, and Herdr. Its tag is a hash of this file, so
# every input is pinned here: a change to one is a new image, not a stale one under the old tag.
# The proxy and the relay are run from their sources beside this file, not copied in.
ARG BUN_VERSION=1.4.0
FROM oven/bun:${BUN_VERSION}-debian AS bun

FROM node:22.20.0-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.283
ARG CODEX_VERSION=0.157.1
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
ENV SHELL=/bin/bash
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force
