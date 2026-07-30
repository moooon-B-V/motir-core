#!/usr/bin/env bash
#
# `motir login` INSIDE THE CONTAINER (MOTIR-1877).
#
# Runs in a sandbox container started with NO credential mount and NO
# `MOTIR_TOKEN` — the state a fresh machine is in — and proves the third way in:
# the device grant. It prints a code, a human approves it in a browser on some
# other device, and the container polls until the token is minted. RFC 8628 is
# written for exactly this input-constrained case, and it is the only tier that
# can bootstrap a container carrying no prior host state at all.
#
# The human is scripted by the stub (`--device-pending 1`: one
# `authorization_pending`, then approval), which is what "approved out-of-band"
# reduces to when nobody is watching. What is NOT simulated is anything on the
# CLI's side: the real binary runs the real polling loop and writes the real
# config file, and the assertion is that `motir ready` then works with no
# environment credential in play.
#
# Usage:  login-smoke.sh [workspace-dir]
# Env:    MOTIR_SMOKE_PORT_LOGIN (default 8790) — this leg's own stub port.
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${1:-/workspace}"
PORT="${MOTIR_SMOKE_PORT_LOGIN:-8790}"
RUN_DIR="$WORKSPACE/.smoke-login"
CONFIG_DIR="${MOTIR_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}/motir"
SERVER="http://127.0.0.1:$PORT"

say() { echo "== $*" >&2; }
fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }

say "login smoke — device grant against $SERVER, no mount, no MOTIR_TOKEN"

# ── the preconditions that make the leg mean anything ───────────────────────

if [ -n "${MOTIR_TOKEN:-}" ]; then
    fail 'MOTIR_TOKEN is set — an env credential would satisfy `motir ready` without the login having done anything'
fi
if [ -f "$CONFIG_DIR/config.json" ]; then
    fail "a credential already exists at $CONFIG_DIR/config.json — this leg must start with none"
fi
# The writable config dir IS the feature: with no `:ro` bind over it, $HOME is
# the container's own ephemeral layer, so the login persists for the container's
# life and dies with `--rm`.
if grep -qE " ${CONFIG_DIR}(/| )" /proc/self/mounts; then
    fail "$CONFIG_DIR is a bind mount — an in-container login is only supported without one"
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

# ── the link ────────────────────────────────────────────────────────────────
# `motir ready` needs a project, which comes from the link file, not from the
# credential. Written here rather than inherited so this leg stands alone.

cat > "$WORKSPACE/.motir.json" <<JSON
{
  "serverUrl": "$SERVER",
  "workspace": "smoke",
  "project": "SMOKE",
  "repos": { "demo-repo": "demo-repo" }
}
JSON

# ── the stub ────────────────────────────────────────────────────────────────

say 'starting the stub server (MCP + the two device routes)'
node "$SMOKE_DIR/stub-server.mjs" \
    --port "$PORT" --log "$RUN_DIR/mcp-calls.ndjson" --items 1 --project SMOKE \
    --device-pending 1 \
    > "$RUN_DIR/stub.url" 2> "$RUN_DIR/stub.err" &
STUB_PID=$!
cleanup() { kill "$STUB_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 50); do
    [ -s "$RUN_DIR/stub.url" ] && break
    sleep 0.1
done
[ -s "$RUN_DIR/stub.url" ] || fail "the stub server never came up: $(cat "$RUN_DIR/stub.err")"

# ── the login ───────────────────────────────────────────────────────────────
# `--no-browser` because there is no display and no reason to pretend otherwise;
# the printed code and URL are sufficient on their own, which is the property
# `motir login` was built around rather than degraded into.

say 'running `motir login --no-browser`'
set +e
(cd "$WORKSPACE" && motir login --server "$SERVER" --no-browser) > "$RUN_DIR/login.log" 2>&1
STATUS=$?
set -e
[ "$STATUS" -eq 0 ] || fail "motir login exited $STATUS: $(cat "$RUN_DIR/login.log")"

# The code is printed GROUPED (K4TP-9RXM) — a person reads it off this stderr and
# retypes it on another machine, so the grouping is part of the contract, not
# cosmetics.
grep -q 'K4TP-9RXM' "$RUN_DIR/login.log" ||
    fail "the login never printed the user code (see $RUN_DIR/login.log)"
grep -q "$SERVER/device" "$RUN_DIR/login.log" ||
    fail 'the login never printed the verification URL'
grep -q 'Logged in as smoke@example.invalid' "$RUN_DIR/login.log" ||
    fail 'the login never confirmed who it logged in as'

# ── the credential it wrote ─────────────────────────────────────────────────

[ -f "$CONFIG_DIR/config.json" ] ||
    fail "the login reported success but wrote no credential to $CONFIG_DIR/config.json"
grep -q 'device-not-a-real-token' "$CONFIG_DIR/config.json" ||
    fail 'the written credential does not carry the minted token'
# 0600, like every other machine the CLI runs on: the container's home is
# ephemeral, but the file is still a secret while it exists.
MODE="$(stat -c '%a' "$CONFIG_DIR/config.json")"
[ "$MODE" = 600 ] || fail "the credential is mode $MODE, expected 600"

# ── and the credential WORKS ────────────────────────────────────────────────
# The point of the leg: not that a file appeared, but that the container can now
# read the plan with nothing in the environment.

say 'reading the ready set with the credential the container minted for itself'
(cd "$WORKSPACE" && motir ready) > "$RUN_DIR/ready.log" 2>&1 ||
    fail "motir ready failed after login: $(cat "$RUN_DIR/ready.log")"
grep -q 'SMOKE-1' "$RUN_DIR/ready.log" ||
    fail "motir ready listed no items (see $RUN_DIR/ready.log)"

say 'login smoke PASSED — device grant completed in-container and the credential works'
