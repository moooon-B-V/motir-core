#!/usr/bin/env bash
#
# THE SANDBOX SMOKE DRIVER (Subtask 7.9.7c / MOTIR-885).
#
# Build the sandbox image and run it through the recipes the README documents,
# executing each suite in the container shape that suite is about.
#
# ── run 1: WITH the read-only credential mount ──────────────────────────────
#   confinement.sh          — the blast radius (read-only credential mount,
#                             unprivileged user, no docker socket, no
#                             undocumented host bind);
#   loop-smoke.sh           — `motir ready` + `motir auto --agent <fake-agent>`
#                             end to end, with no LLM;
#   failure-smoke.sh        — the same loop with an agent that FAILS mid-run,
#                             which must still push and open its pull request
#                             (MOTIR-1836);
#   readonly-login-smoke.sh — `motir login` under that mount must refuse in ONE
#                             sentence naming the fix, never an EROFS trace.
#
# ── run 2: NO credential mount, `-e MOTIR_TOKEN -e MOTIR_SERVER` ────────────
#   env-credential-smoke.sh — the mount-free tier the README now leads with, and
#                             the default for CI (MOTIR-1877).
#
# ── run 3: NO credential mount and NO token — a fresh machine ───────────────
#   login-smoke.sh          — `motir login` performed INSIDE the container: a
#                             device grant, approved out of band, written to the
#                             container's own config dir.
#
# Running the assertions THROUGH the real recipes is the point, and it is why
# three container runs rather than three scripts in one: whether a credential
# mount is present, and whether a token is in the environment, are properties of
# HOW THE CONTAINER WAS LAUNCHED. A suite that ran on the host, or inside a
# container started some other way, would assert nothing about what users run.
#
# Usage:
#   packages/cli/sandbox/smoke/run.sh [--image <tag>] [--keep] [--no-build]
#
# From anywhere; the build context is always the repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE='motir-sandbox:smoke'
BUILD=1
KEEP=0
PORT="${MOTIR_SMOKE_PORT:-8787}"
FAILURE_PORT="${MOTIR_SMOKE_PORT_FAILURE:-8788}"
# One port per suite, so no two can race the same socket. A suite that READS the
# plan under the mount also needs an entry in the credential below (it is
# read-only, so every entry is minted before the container starts); the login
# legs need none — they either carry the token in the environment or mint one.
RO_LOGIN_PORT="${MOTIR_SMOKE_PORT_RO_LOGIN:-8789}"
ENV_PORT="${MOTIR_SMOKE_PORT_ENV:-8790}"
LOGIN_PORT="${MOTIR_SMOKE_PORT_LOGIN:-8791}"

while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="$2"; shift 2 ;;
        --no-build) BUILD=0; shift ;;
        --keep) KEEP=1; shift ;;
        *) echo "run.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done

if [ "$BUILD" -eq 1 ]; then
    echo "== building $IMAGE (base profile — the smoke run needs no coding agent)"
    docker build \
        -f "$REPO_ROOT/packages/cli/sandbox/Dockerfile" \
        --build-arg AGENT=base \
        -t "$IMAGE" \
        "$REPO_ROOT"
fi

# ── the host side of the mount recipe ───────────────────────────────────────
# Two directories, mirroring what a user actually has: a workspace root, and a
# `~/.config/motir` holding the PAT. Both are throwaway — the credential is a
# fake token for a stub server that accepts anything, so nothing real is exposed.

FIXTURE="$(mktemp -d)"
CREDENTIAL="$(mktemp -d)"

cleanup() {
    if [ "$KEEP" -eq 1 ]; then
        echo "== kept: workspace $FIXTURE, credential $CREDENTIAL"
        return
    fi
    # The container writes into /workspace as uid 1000, which is very often NOT
    # the uid running this script (GitHub's runner is 1001). Those files cannot
    # be chmod'ed from here — chmod needs OWNERSHIP, which is exactly what we do
    # not have — and their parent directories were created by the container too,
    # so plain `rm -rf` fails with "Permission denied" and takes the whole run
    # down with it in the trap.
    #
    # So hand the tree back with a throwaway root container, which is the only
    # party that can chown it. `--entrypoint chown` bypasses the image's own
    # entrypoint (this is housekeeping, not a sandbox run).
    docker run --rm --user 0:0 \
        -v "$FIXTURE:/workspace" --entrypoint chown "$IMAGE" \
        -R "$(id -u):$(id -g)" /workspace >/dev/null 2>&1 || true
    rm -rf "$FIXTURE" "$CREDENTIAL" 2>/dev/null ||
        echo "== note: could not fully remove $FIXTURE — remove it by hand." >&2
}
trap cleanup EXIT

# uid 1000 inside the container is very often NOT the uid running CI, so the
# workspace has to be world-writable for the run to be able to use it at all.
chmod 777 "$FIXTURE"
cp -a "$SMOKE_DIR" "$FIXTURE/.smoke"
chmod -R a+rX "$FIXTURE/.smoke"
chmod a+x "$FIXTURE/.smoke"/*.sh "$FIXTURE/.smoke"/*.mjs "$FIXTURE/.smoke/bin"/*

# The credential the CLI reads. Its server URL must match the port the stub
# listens on INSIDE the container — the mount is read-only, so it cannot be
# rewritten later from a random port.
#
# ONE entry per suite, because each suite runs its OWN stub on its OWN port and
# the CLI looks a credential up BY SERVER URL: a token for 8787 alone makes the
# failure suite exit "Not logged in to http://127.0.0.1:8788" before it dispatches
# anything. Separate ports (rather than sharing one) keep the two suites from
# racing the same socket, and the read-only mount is exactly why both have to be
# minted up front.
cat > "$CREDENTIAL/config.json" <<JSON
{
  "tokens": {
    "http://127.0.0.1:$PORT": {
      "token": "smoke-not-a-real-token",
      "user": { "id": "u1", "name": "Smoke User", "email": "smoke@example.invalid" }
    },
    "http://127.0.0.1:$FAILURE_PORT": {
      "token": "smoke-not-a-real-token",
      "user": { "id": "u1", "name": "Smoke User", "email": "smoke@example.invalid" }
    }
  }
}
JSON
chmod 755 "$CREDENTIAL"
chmod 644 "$CREDENTIAL/config.json"

# ── the run ─────────────────────────────────────────────────────────────────
# `--network none` would be truer to the confinement story, but the stub server
# binds 127.0.0.1 and the loopback interface exists in every network mode, so the
# default is used here and the EGRESS question is left where the image header
# leaves it: a docker-level decision, not something this image pretends to make.

echo "== [1/3] the MOUNTED recipe — confinement, the loop, the failure path, the login refusal"
docker run --rm \
    -v "$FIXTURE:/workspace" \
    -v "$CREDENTIAL:/home/node/.config/motir:ro" \
    -e "MOTIR_SMOKE_PORT=$PORT" \
    -e "MOTIR_SMOKE_PORT_FAILURE=$FAILURE_PORT" \
    -e "MOTIR_SMOKE_PORT_RO_LOGIN=$RO_LOGIN_PORT" \
    "$IMAGE" \
    bash -c '/workspace/.smoke/confinement.sh && /workspace/.smoke/loop-smoke.sh && /workspace/.smoke/failure-smoke.sh && /workspace/.smoke/readonly-login-smoke.sh'

# ── the mount-free recipes (MOTIR-1877) ─────────────────────────────────────
# NO `-v …/.config/motir` here, deliberately and load-bearingly: each script
# asserts the absence of that bind against /proc/self/mounts before it asserts
# anything else, so neither leg can pass on a credential it was handed by the
# mount rather than by the tier under test.

echo "== [2/3] the ENV recipe — no credential mount, MOTIR_TOKEN + MOTIR_SERVER only"
docker run --rm \
    -v "$FIXTURE:/workspace" \
    -e "MOTIR_TOKEN=env-not-a-real-token" \
    -e "MOTIR_SERVER=http://127.0.0.1:$ENV_PORT" \
    -e "MOTIR_SMOKE_PORT=$ENV_PORT" \
    "$IMAGE" \
    /workspace/.smoke/env-credential-smoke.sh

echo "== [3/3] the FRESH-MACHINE recipe — no mount, no token: \`motir login\` in the container"
docker run --rm \
    -v "$FIXTURE:/workspace" \
    -e "MOTIR_SMOKE_PORT_LOGIN=$LOGIN_PORT" \
    "$IMAGE" \
    /workspace/.smoke/login-smoke.sh

echo '== sandbox smoke PASSED'
