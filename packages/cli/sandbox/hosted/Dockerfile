# syntax=docker/dockerfile:1
#
# The HOSTED AGENT image (Story MOTIR-683 · MOTIR-687, made to run the CLI by
# MOTIR-6560).
#
# Booted by Motir, once per hosted run, on the fleet (MOTIR-4336's
# `hostedAgentContainerService`). It runs the Motir CLI's OWN `motir run` on the
# run the server opened, and exits with the CLI's code
# (`docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §1): a leaf, a leaf
# that spans several repositories and a parent worked through its children all
# run exactly as they do on a laptop. `entrypoint.ts` beside this file is the
# launcher; read its header for the run's inputs.
#
# ── What is in it, and what is deliberately NOT ─────────────────────────────
#   - Node (the base), `git` ≥ 2.36 (the CLI keys each repository's commit
#     identity on an `includeIf "hasconfig:remote.*.url:…"`, which 2.36 added;
#     bookworm ships 2.39), the real `gh` (the CLI opens and readies pull
#     requests with it, through its own credential shim), the `motir` CLI built
#     from THIS checkout, OpenCode PINNED to the version the gateway's egress
#     contract names (`motir-gateway` `docs/hosted-run-egress.md` §2), and
#     codegraph pinned beside it. Nothing else agent-shaped: the CLI launches
#     OpenCode itself, and nothing selects another agent.
#   - NO credential of any kind. The run's credentials (the run token and the
#     gateway run key) arrive as environment at boot and die with the run; git
#     reaches GitHub only through tokens the CLI fetches from the run's own
#     git-credential route (decision §5). The workflow that publishes this image
#     greps its filesystem and its env for key patterns before it pushes.
#   - A non-root user whose only writable places are its home and /workspace.
#
# ── The build context is the REPOSITORY ROOT ────────────────────────────────
# The CLI is built from source, and `pnpm install --frozen-lockfile` validates
# the lockfile against every workspace manifest, so the whole workspace is the
# context — exactly as for the local sandbox image (`../Dockerfile`), whose
# builder stage this one mirrors. `.dockerignore` keeps node_modules, dist and
# .env out of it.

ARG NODE_TAG=24-bookworm-slim

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build and pack the CLI from this checkout.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_TAG} AS builder
WORKDIR /src
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm || npm install -g pnpm@11.2.2
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @motir/cli...
# `mkdir -p /pkg` is required: `npm pack --pack-destination` does not create it.
RUN pnpm --filter @motir/cli build \
    && cd packages/cli \
    && mkdir -p /pkg \
    && npm pack --pack-destination /pkg

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — the image the fleet boots.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_TAG}

LABEL org.opencontainers.image.title="motir-hosted-agent" \
      org.opencontainers.image.description="One-shot hosted run: the Motir CLI's own motir run, with OpenCode on Motir's gateway." \
      org.opencontainers.image.source="https://github.com/moooon-B-V/motir-core" \
      org.opencontainers.image.licenses="GPL-3.0-only"

# The versions the image pins. OpenCode's is the egress contract's, byte for
# byte; a bump there is a bump here, re-proved by the contract's own E2E.
ARG OPENCODE_VERSION=1.18.32
ARG CODEGRAPH_VERSION=1.6.0

# `git` for every clone and push the CLI makes; `ca-certificates` so both, and
# every fetch, verify TLS; `gh` from GitHub's own apt repository (the Debian
# package lags it). The version check is the build's proof of the git floor.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version \
    && git --version | awk '{ split($3, v, "."); if (v[1] < 2 || (v[1] == 2 && v[2] < 36)) { print "git " $3 " is below the 2.36 floor"; exit 1 } }'

# Telemetry off in the ENV, not only in a state file, so it holds however the
# home directory is provisioned (the same reasoning as the local sandbox).
ENV CODEGRAPH_TELEMETRY=0 \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true

# Installed as root into /usr/local, so the agent cannot rewrite the binaries it
# runs. The version checks are the build's own proof of the pins and of a CLI
# that starts at all.
COPY --from=builder /pkg/*.tgz /tmp/motir-cli.tgz
RUN npm install -g --no-fund --no-audit \
        /tmp/motir-cli.tgz \
        "opencode-ai@${OPENCODE_VERSION}" \
        "@colbymchenry/codegraph@${CODEGRAPH_VERSION}" \
    && rm /tmp/motir-cli.tgz \
    && npm cache clean --force \
    && motir --version \
    && opencode --version | grep -qxF "${OPENCODE_VERSION}" \
    && codegraph --version

COPY packages/cli/sandbox/hosted/entrypoint.ts /opt/motir-hosted-agent/
# The launcher is an ES module (top-level await). Said explicitly rather than
# left to Node's syntax detection, so a Node upgrade cannot change how it loads.
RUN echo '{ "type": "module" }' > /opt/motir-hosted-agent/package.json

RUN mkdir -p /workspace && chown node:node /workspace

USER node
ENV HOME=/home/node \
    MOTIR_WORKSPACE=/workspace
WORKDIR /workspace

ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/opt/motir-hosted-agent/entrypoint.ts"]
