#!/usr/bin/env bash
#
# THE SANDBOX SMOKE DRIVER (Subtask 7.9.7c / MOTIR-885).
#
# Build the sandbox image, run the container with EXACTLY the mount recipe the
# README documents, and execute the three in-container suites inside it:
#
#   confinement.sh   — the blast radius (read-only credential mount, unprivileged
#                      user, no docker socket, no undocumented host bind);
#   loop-smoke.sh    — `motir auto --agent <fake-agent>` end to end, with no LLM;
#   failure-smoke.sh — the same loop with an agent that FAILS mid-run, which must
#                      still push and open its pull request (MOTIR-1836).
#
# Running the assertions THROUGH the real mount recipe is the point. Every one of
# them is about how the container is launched — a suite that ran the scripts on
# the host, or in a container started some other way, would assert nothing about
# the thing users actually run.
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

echo "== running the sandbox suites in $IMAGE"
docker run --rm \
    -v "$FIXTURE:/workspace" \
    -v "$CREDENTIAL:/home/node/.config/motir:ro" \
    -e "MOTIR_SMOKE_PORT=$PORT" \
    -e "MOTIR_SMOKE_PORT_FAILURE=$FAILURE_PORT" \
    "$IMAGE" \
    bash -c '/workspace/.smoke/confinement.sh && /workspace/.smoke/loop-smoke.sh && /workspace/.smoke/failure-smoke.sh'

echo '== sandbox smoke PASSED'
