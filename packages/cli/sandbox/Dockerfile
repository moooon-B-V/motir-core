# syntax=docker/dockerfile:1
#
# The Motir SANDBOX BASE image (Subtask 7.9.7a / MOTIR-1505).
#
# What this is: the confined, reproducible container an unattended `motir auto`
# run executes in, instead of a skip-permissions coding agent loose on the host.
# Running `motir auto` in a normal console stays fully supported — the container
# is the RECOMMENDED path, not a requirement.
#
# What this image DOES confine: the FILESYSTEM blast radius. The only host
# surfaces inside are the two mounts below — a writable `/workspace` (your
# `.motir.json` tree) and a READ-ONLY `~/.config/motir` (the PAT). No docker
# socket, no host filesystem beyond those.
#
# What it does NOT confine: EGRESS. The network is open by default and stays
# that way — every coding agent needs its provider API, and every dispatched
# item needs git remotes + the Motir server. Confine the network at the docker
# level (`--network`) if your threat model needs it; this image will not pretend
# to.
#
# Build (context is the motir-core repo ROOT, not this directory):
#   docker build -f packages/cli/sandbox/Dockerfile -t motir-sandbox:base .
#
# This slice ships the BASE only. The per-agent install layers (claude / codex /
# opencode / kimi / antigravity / cursor / aider / goose) land in 7.9.7b
# (MOTIR-1506) by filling the seam in `install-agent.sh`; the build/version
# matrix + write-confinement smoke tests are 7.9.7c (MOTIR-885); publishing to
# GHCR with digest pinning is 7.9.7e (MOTIR-1788).

# The Node base. Floored at >= 24.15 (the Kimi Code CLI's requirement, which is
# the highest across the supported agents and therefore covers all of them). The
# tag is an ARG so 7.9.7e can pin a digest at publish time without editing this
# file; the floor itself is ASSERTED below rather than trusted to the tag.
ARG NODE_TAG=24-bookworm-slim

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build the `motir` binary from this checkout and pack it as a tarball
# ─────────────────────────────────────────────────────────────────────────────
# `@motir/cli` is not published to npm yet (that is Epic-8 work), so the image
# builds it from source. `npm pack` produces the same artifact a published
# release would, which keeps the runtime stage's install path identical to the
# one 7.9.7e will use against GHCR/npm.
FROM node:${NODE_TAG} AS builder

WORKDIR /src

# pnpm comes from corepack so the version is the one pinned by the repo's
# `packageManager` field. The prompt must be disabled explicitly — corepack asks
# before downloading a package manager, and there is no TTY to answer it here.
# The npm fallback keeps the build working on a base image without corepack.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm || npm install -g pnpm@11.2.2

# The whole workspace is copied because `pnpm install --frozen-lockfile`
# validates the lockfile against EVERY workspace manifest; a partial copy fails
# the frozen check. `.dockerignore` keeps node_modules/.next/.git out of the
# context, so this stays small. `--filter @motir/cli...` then installs only the
# CLI's own dependency closure, and `--ignore-scripts` skips the root
# postinstall (prisma generate + design-system build) which the CLI never needs.
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @motir/cli...
# `npm pack` is run from the package directory, not via `--workspace`: this repo
# declares its workspace in pnpm-workspace.yaml, which npm does not read.
RUN pnpm --filter @motir/cli build \
    && cd packages/cli \
    && npm pack --pack-destination /pkg

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — the sandbox base
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_TAG} AS base

LABEL org.opencontainers.image.title="motir-sandbox" \
      org.opencontainers.image.description="Confined sandbox for unattended `motir auto` runs (base image, no coding agent)." \
      org.opencontainers.image.source="https://github.com/moooon-B-V/motir-core" \
      org.opencontainers.image.licenses="GPL-3.0-only"

# Assert the Node floor rather than assuming the tag delivers it. A base image
# that silently drifted below 24.15 would fail at Kimi's first run instead of
# here, which is far more expensive to diagnose.
RUN node -e "const [maj, min] = process.versions.node.split('.').map(Number); \
if (maj < 24 || (maj === 24 && min < 15)) { \
  console.error('motir-sandbox: Node ' + process.versions.node + ' is below the >= 24.15 floor required by the supported coding agents.'); \
  process.exit(1); \
}"

# git + gh are part of the CONTRACT, not conveniences: every dispatched item's
# GIT WORKFLOW section runs git, and the session-branch/PR steps run gh.
# ca-certificates/curl/gnupg are needed to add the GitHub CLI apt source;
# openssh-client covers SSH git remotes; less is gh's pager.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        less \
        openssh-client \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# The `motir` binary itself. Installed globally from the packed tarball so it is
# on PATH for every user, and smoke-tested in the same layer — a base that
# cannot run `motir --version` must fail the BUILD, not the first `motir auto`.
COPY --from=builder /pkg/*.tgz /tmp/motir-cli.tgz
RUN npm install -g /tmp/motir-cli.tgz \
    && rm /tmp/motir-cli.tgz \
    && motir --version

# ── The per-agent layer seam (AGENT build-arg selector) ──────────────────────
# `--build-arg AGENT=<profile>` selects which coding agent is installed on top
# of this base. The SELECTOR is this slice's deliverable; the LAYERS themselves
# are 7.9.7b's (MOTIR-1506) and are filled into `install-agent.sh`'s case block.
# The default `base` is a deliberate no-op: the base image ships no agent, which
# is exactly what the CI build/version matrix and a `--print` workflow want.
ARG AGENT=base
ENV MOTIR_SANDBOX_AGENT=${AGENT}
COPY --chmod=0755 packages/cli/sandbox/install-agent.sh /usr/local/lib/motir-sandbox/install-agent.sh
RUN /usr/local/lib/motir-sandbox/install-agent.sh "${AGENT}"

COPY --chmod=0755 packages/cli/sandbox/entrypoint.sh /usr/local/bin/motir-sandbox-entrypoint

# Run unprivileged. The node image already ships a `node` user at uid/gid 1000,
# which is the common host uid — so files the agent writes into the /workspace
# bind mount stay owned by the invoking user rather than by root.
RUN mkdir -p /workspace /home/node/.config/motir \
    && chown -R node:node /workspace /home/node/.config

USER node
# HOME is set explicitly because the CLI resolves its config dir from
# `MOTIR_CONFIG_HOME` -> `XDG_CONFIG_HOME` -> `$HOME/.config` (see
# src/config/userConfig.ts) — pinning HOME is what makes the read-only PAT mount
# target below deterministic.
ENV HOME=/home/node
WORKDIR /workspace

# The entrypoint drops into /workspace so `motir auto` is a one-liner:
#   docker run --rm -it \
#     -v "$PWD:/workspace" \
#     -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
#     motir-sandbox:base motir auto --agent "<cmd>"
# With no command it opens an interactive shell instead.
ENTRYPOINT ["motir-sandbox-entrypoint"]
CMD ["bash", "-l"]
