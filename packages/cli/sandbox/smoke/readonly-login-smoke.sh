#!/usr/bin/env bash
#
# `motir login` UNDER THE READ-ONLY CREDENTIAL MOUNT (MOTIR-1877).
#
# The other side of the login story, and the one that is easy to ship broken: a
# container started WITH `-v "$HOME/.config/motir:…:ro"` cannot persist a login,
# because the directory it would write to is read-only ON PURPOSE — the container
# consumes a credential, it never mints or rotates one.
#
# That is a supported configuration being used correctly, so the failure must be
# ONE SENTENCE that names the way forward. An `EROFS` stack trace here is the
# MOTIR-1836 class of bug: a legitimate mount shape surfacing as a crash. This
# leg asserts the shape of the failure, not just that it fails.
#
# It runs in the MOUNTED container (run.sh's first docker run) for the same
# reason the mount-free legs run in their own: whether the bind exists is a
# property of how the container was launched.
#
# Usage:  readonly-login-smoke.sh [workspace-dir]
# Env:    MOTIR_SMOKE_PORT_RO_LOGIN (default 8789) — this leg's own stub port.
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${1:-/workspace}"
PORT="${MOTIR_SMOKE_PORT_RO_LOGIN:-8789}"
RUN_DIR="$WORKSPACE/.smoke-ro-login"
CONFIG_DIR="${MOTIR_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}/motir"
SERVER="http://127.0.0.1:$PORT"

say() { echo "== $*" >&2; }
fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }

say "read-only login smoke — the mount is present, so the login must REFUSE cleanly"

# ── the precondition ────────────────────────────────────────────────────────

[ -f "$CONFIG_DIR/config.json" ] ||
    fail "no credential mount at $CONFIG_DIR — this leg only means something with one"
if (echo probe > "$CONFIG_DIR/.probe") 2>/dev/null; then
    rm -f "$CONFIG_DIR/.probe" 2>/dev/null || true
    fail "$CONFIG_DIR is WRITABLE — the mount recipe was not followed, so the refusal path cannot be under test"
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"
BEFORE="$(cat "$CONFIG_DIR/config.json")"

# ── the stub ────────────────────────────────────────────────────────────────
# The grant must SUCCEED — the point is that the CLI gets a real token and then
# discovers it has nowhere to put it. A login that failed earlier (at the grant)
# would exercise a different path entirely and pass this leg for the wrong
# reason, so the stub approves on the first poll.

say 'starting the stub server (device routes only, approving immediately)'
node "$SMOKE_DIR/stub-server.mjs" \
    --port "$PORT" --log "$RUN_DIR/mcp-calls.ndjson" --items 1 --project SMOKE \
    --device-pending 0 \
    > "$RUN_DIR/stub.url" 2> "$RUN_DIR/stub.err" &
STUB_PID=$!
cleanup() { kill "$STUB_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 50); do
    [ -s "$RUN_DIR/stub.url" ] && break
    sleep 0.1
done
[ -s "$RUN_DIR/stub.url" ] || fail "the stub server never came up: $(cat "$RUN_DIR/stub.err")"

# ── the refusal ─────────────────────────────────────────────────────────────

say 'running `motir login --no-browser` against the read-only config dir'
set +e
(cd "$WORKSPACE" && motir login --server "$SERVER" --no-browser) > "$RUN_DIR/login.log" 2>&1
STATUS=$?
set -e

[ "$STATUS" -ne 0 ] || fail 'motir login reported SUCCESS on a read-only config dir'

# One sentence naming the fix, and the fix names the tier that needs no disk.
grep -q 'Could not write the credential' "$RUN_DIR/login.log" ||
    fail "the failure does not name what went wrong (see $RUN_DIR/login.log)"
grep -q 'MOTIR_TOKEN' "$RUN_DIR/login.log" ||
    fail 'the failure does not point at the environment tier, which is the way forward here'

# NOT a crash: `Unexpected error` is index.ts's non-CliError branch, and it is
# the one that prints a stack. Either of these in the output means the read-only
# mount reached the user as a raw filesystem error.
for smell in 'Unexpected error' 'EROFS' 'at Object.' 'node:internal'; do
    if grep -qF "$smell" "$RUN_DIR/login.log"; then
        fail "the failure leaked a stack trace / raw errno ('$smell'): $(cat "$RUN_DIR/login.log")"
    fi
done

# Nothing was written — the mount held, and the CLI did not half-write a config
# somewhere else either.
[ "$(cat "$CONFIG_DIR/config.json")" = "$BEFORE" ] ||
    fail 'the mounted credential changed — a read-only mount was somehow written through'

say 'read-only login smoke PASSED — refused in one sentence, nothing written'
