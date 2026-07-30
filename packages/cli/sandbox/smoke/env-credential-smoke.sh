#!/usr/bin/env bash
#
# THE MOUNT-FREE ENVIRONMENT TIER (MOTIR-1877).
#
# Runs INSIDE a sandbox container started with NO credential mount at all —
# `-v "$PWD:/workspace" -e MOTIR_TOKEN -e MOTIR_SERVER`, the recipe the README
# leads with — and proves that a full run works from those two variables alone.
#
# WHY THIS IS ITS OWN CONTAINER RUN. The claim is about how the container was
# LAUNCHED, exactly like the confinement assertions: whether a credential mount
# is present cannot be simulated from inside a container that has one. So the
# driver (run.sh) starts a second container without it, and this script asserts
# the absence FIRST — otherwise a mounted credential could quietly satisfy every
# assertion below and the env tier would never actually be exercised.
#
# The loop itself is not re-implemented here: `loop-smoke.sh` is the end-to-end
# suite, and it now reports which credential tier it resolved, so running it
# under these conditions is the assertion.
#
# Usage:  env-credential-smoke.sh [workspace-dir]
# Env:    MOTIR_TOKEN            — required; the whole point of the leg
#         MOTIR_SMOKE_PORT       — the stub port (run.sh gives this leg its own)
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${1:-/workspace}"
CONFIG_DIR="${MOTIR_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}/motir"

say() { echo "== $*" >&2; }
fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }

say 'env-credential smoke — no credential mount, MOTIR_TOKEN only'

# ── the preconditions that make the leg mean anything ───────────────────────

[ -n "${MOTIR_TOKEN:-}" ] || fail 'MOTIR_TOKEN is unset — this leg tests the environment tier'

if [ -f "$CONFIG_DIR/config.json" ]; then
    fail "a credential file exists at $CONFIG_DIR/config.json — this container was started WITH a mount, so the env tier is not what would be under test"
fi

# The mount table is the ground truth here too (same argument confinement.sh
# makes): a bind that exists but happens to hold no config.json would still be a
# host surface this leg claims is absent.
if grep -qE " ${CONFIG_DIR}(/| )" /proc/self/mounts; then
    fail "$CONFIG_DIR is a bind mount — the mount-free leg must run without it"
fi
say "no credential mount, no $CONFIG_DIR/config.json — the env tier is the only way in"

# ── the run ─────────────────────────────────────────────────────────────────
# `loop-smoke.sh` asserts the tier it resolved, runs `motir ready`, then drives
# the whole `motir auto` loop and checks the MCP call sequence.

exec "$SMOKE_DIR/loop-smoke.sh" "$WORKSPACE"
