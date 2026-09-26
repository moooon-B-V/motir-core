# syntax=docker/dockerfile:1
#
# The HOSTED AGENT image (Story MOTIR-683 · Subtask MOTIR-687).
#
# Booted by Motir, once per dispatched card, on the fleet (MOTIR-4336's
# `hostedAgentContainerService`): it runs ONE card end to end with OpenCode and
# exits. `entrypoint.ts` beside this file is the whole program; read its header
# for the run's inputs, its phases and its exit codes.
#
# ── What is in it, and what is deliberately NOT ─────────────────────────────
#   - Node (the base), git, OpenCode PINNED to the version the gateway's egress
#     contract names (`motir-gateway` `docs/hosted-run-egress.md` §2), and
#     codegraph pinned beside it. Nothing else agent-shaped: no `claude`, no
#     `codex`, no agent selector. The local sandbox (`../Dockerfile`) is the
#     multi-agent image; this is not a profile of it.
#   - NO credential of any kind. The run's three credentials (the run token, the
#     git token and the gateway run key) arrive as environment at boot and die
#     with the run (docs/decisions/hosted-agent-run.md §3–§5). The workflow that
#     publishes this image greps its filesystem and its env for key patterns
#     before it pushes.
#   - A non-root user whose only writable places are its home and /workspace.
#
# ── The build context is THIS DIRECTORY ─────────────────────────────────────
# Nothing outside `packages/cli/sandbox/hosted/` is copied in, which is what
# lets `.github/workflows/hosted-agent-image.yml` gate itself on that path alone.

ARG NODE_TAG=24-bookworm-slim
FROM node:${NODE_TAG}

LABEL org.opencontainers.image.title="motir-hosted-agent" \
      org.opencontainers.image.description="One-shot hosted coding agent: OpenCode on Motir's gateway, one card per container." \
      org.opencontainers.image.source="https://github.com/moooon-B-V/motir-core" \
      org.opencontainers.image.licenses="GPL-3.0-only"

# The versions the image pins. OpenCode's is the egress contract's, byte for
# byte; a bump there is a bump here, re-proved by the contract's own E2E.
ARG OPENCODE_VERSION=1.18.32
ARG CODEGRAPH_VERSION=1.6.0

# `git` for the clone and the push; `ca-certificates` so both, and every fetch
# the entrypoint makes, can verify TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Telemetry off in the ENV, not only in a state file, so it holds however the
# home directory is provisioned (the same reasoning as the local sandbox).
ENV CODEGRAPH_TELEMETRY=0 \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true

# Installed as root into /usr/local, so the agent cannot rewrite the binary it
# runs as. The version checks are the build's own proof of the pin.
RUN npm install -g --no-fund --no-audit \
        "opencode-ai@${OPENCODE_VERSION}" \
        "@colbymchenry/codegraph@${CODEGRAPH_VERSION}" \
    && npm cache clean --force \
    && opencode --version | grep -qxF "${OPENCODE_VERSION}" \
    && codegraph --version

COPY entrypoint.ts opencode.egress.json /opt/motir-hosted-agent/
# The entrypoint is an ES module (top-level await). Said explicitly rather than
# left to Node's syntax detection, so a Node upgrade cannot change how it loads.
RUN echo '{ "type": "module" }' > /opt/motir-hosted-agent/package.json

RUN mkdir -p /workspace && chown node:node /workspace

USER node
ENV HOME=/home/node
WORKDIR /workspace

ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/opt/motir-hosted-agent/entrypoint.ts"]
