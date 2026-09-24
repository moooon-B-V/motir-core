#!/usr/bin/env bash
#
# THE AGENT CAN UPDATE ITSELF; `motir` CANNOT BE REWRITTEN (MOTIR-6183).
#
# A sandbox may run for weeks. A reader who wants a coding agent's update should
# get it in place: a rebuild keeps /workspace and the Motir sign-in but loses the
# agent's own sign-in and any running session. Every agent was installed as root
# into /usr/local, so every self-update failed — Claude Code said so on every
# session: "Auto-update failed: no write permission to npm prefix".
#
# The image now installs every agent under a prefix the runtime user owns. This
# asserts, as `node` and in the built image, both halves of that:
#
#   1. the agent's binary resolves under that prefix, the directory holding its
#      resolved file is writable, and `npm install -g` goes there too — which is
#      where an npm agent's updater writes;
#   2. `motir` still resolves to the root-owned /usr/local, and `node` cannot
#      write its package — the agent updates itself, not its supervisor.
#
# Whether each VENDOR's updater writes to the location it was installed in is
# the vendor's behaviour and is not asserted here (the card names it).
#
# Usage:
#   agent-update-smoke.sh --image <tag> --profile <id> --liveness "<command>"
#
# `--liveness` is the profile's liveness command from profiles.json; its first
# word is the binary (`agy` for antigravity, `agent` for cursor).
set -euo pipefail

IMAGE=''
PROFILE=''
LIVENESS=''

while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="$2"; shift 2 ;;
        --profile) PROFILE="$2"; shift 2 ;;
        --liveness) LIVENESS="$2"; shift 2 ;;
        *) echo "agent-update-smoke.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done

[ -n "$IMAGE" ] || { echo "agent-update-smoke.sh: --image is required" >&2; exit 2; }
[ -n "$PROFILE" ] || { echo "agent-update-smoke.sh: --profile is required" >&2; exit 2; }
[ -n "$LIVENESS" ] || { echo "agent-update-smoke.sh: --liveness is required" >&2; exit 2; }

BINARY="${LIVENESS%% *}"
# Kept in sync with the Dockerfile's MOTIR_AGENT_PREFIX by packages/cli/test/sandbox.test.ts.
AGENT_PREFIX=/opt/motir-agents

fail() {
    echo "FAIL: $PROFILE: $1" >&2
    exit 1
}

# One container, as the image's own user, with the entrypoint bypassed the way
# the devcontainer recipe does it. A LOGIN shell, so PATH is the one a terminal
# gets. Each line is `key=value`; nothing here needs a tty.
report=$(docker run --rm -i --entrypoint /bin/bash "$IMAGE" -lc "
    bin=\$(command -v '$BINARY' || true)
    resolved=\$( [ -n \"\$bin\" ] && readlink -f \"\$bin\" || true)
    echo user=\$(id -un)
    echo bin=\$bin
    echo resolved=\$resolved
    echo resolved_dir_writable=\$( [ -n \"\$resolved\" ] && [ -w \"\$(dirname \"\$resolved\")\" ] && echo yes || echo no)
    echo npm_prefix=\$(npm prefix -g)
    echo npm_prefix_writable=\$( [ -w \"\$(npm prefix -g)\" ] && echo yes || echo no)
    echo motir=\$(command -v motir || true)
    echo motir_pkg_writable=\$( [ -w /usr/local/lib/node_modules/@motir/cli ] && echo yes || echo no)
")

value() { printf '%s\n' "$report" | sed -n "s/^$1=//p"; }

[ "$(value user)" = node ] || fail "expected to run as node, got [$(value user)]."

# 1. The agent can update itself.
bin="$(value bin)"
resolved="$(value resolved)"
[ -n "$bin" ] || fail "'$BINARY' is not on PATH as node."
case "$resolved" in
    "$AGENT_PREFIX"/*) ;;
    *) fail "'$BINARY' resolves to [$resolved], not under $AGENT_PREFIX — its updater would write where node cannot (MOTIR-6183)." ;;
esac
[ "$(value resolved_dir_writable)" = yes ] \
    || fail "the directory holding [$resolved] is not writable by node — an in-place update would fail (MOTIR-6183)."
[ "$(value npm_prefix)" = "$AGENT_PREFIX" ] \
    || fail "npm's global prefix is [$(value npm_prefix)], not $AGENT_PREFIX — an npm agent's updater would write to a root-owned prefix."
[ "$(value npm_prefix_writable)" = yes ] || fail "npm's global prefix $AGENT_PREFIX is not writable by node."

# The same binary from an INTERACTIVE NON-LOGIN shell — what a VS Code terminal
# opens. It reads ~/.bashrc and not /etc/profile.d, so it gets PATH from the
# image ENV; asserted separately because the login shell above does not.
interactive=$(docker run --rm -i --entrypoint /bin/bash "$IMAGE" -ic \
    "b=\$(command -v '$BINARY') && readlink -f \"\$b\"" 2>/dev/null | tail -1)
case "$interactive" in
    "$AGENT_PREFIX"/*) ;;
    *) fail "an interactive shell resolves '$BINARY' to [$interactive], not under $AGENT_PREFIX." ;;
esac

# 2. The supervisor stays root-owned.
[ "$(value motir)" = /usr/local/bin/motir ] \
    || fail "motir resolves to [$(value motir)], not the root-owned /usr/local/bin/motir."
[ "$(value motir_pkg_writable)" = no ] \
    || fail "node can write /usr/local/lib/node_modules/@motir/cli — the agent could rewrite the CLI that supervises it."

echo "== $PROFILE: '$BINARY' -> $resolved (writable by node); npm -g -> $AGENT_PREFIX; motir stays root-owned"
