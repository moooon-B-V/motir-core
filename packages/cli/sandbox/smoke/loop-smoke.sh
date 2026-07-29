#!/usr/bin/env bash
#
# The AGENT-INDEPENDENT LOOP SMOKE TEST (Subtask 7.9.7c / MOTIR-885).
#
# Runs `motir auto --agent <fake-agent>` end to end INSIDE the sandbox image with
# no LLM, no Motir deployment, no Postgres and no network: a stub MCP server
# (stub-server.mjs) scripts the ready set, a fake agent (fake-agent.sh) does the
# integration, a stub `gh` (bin/gh) stands in for the pull-request call, and the
# whole fixture — bare origin, checkout, `.motir.json` — is built here, in
# /workspace, by the unprivileged `node` user.
#
# WHY IT IS AGENT-INDEPENDENT. The loop's contract is "launch a command, hand it
# the prompt, believe its exit code". Validating it against a real coding agent
# would test the agent's mood, cost money, and need a key the image deliberately
# does not carry. Substituting a scripted agent tests the thing that is actually
# Motir's: the SEQUENCE — next_ready → transition_status → dispatch_prompt →
# (agent) → mark_integrated, re-queried once per iteration until the ready set
# drains, then ONE pull request per repo.
#
# It asserts the sequence, not just the exit code: every MCP call is recorded and
# checked by assert-run.mjs. A run that exits 0 having silently skipped
# `mark_integrated` must fail this test.
#
# Usage:  loop-smoke.sh [workspace-dir]
# Env:    MOTIR_SMOKE_PORT (default 8787 — must match the port in the mounted
#         credential, which is READ-ONLY and therefore written before the run).
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${1:-/workspace}"
PORT="${MOTIR_SMOKE_PORT:-8787}"
ITEMS="${MOTIR_SMOKE_ITEMS:-2}"
RUN_DIR="$WORKSPACE/.smoke-run"

say() { echo "== $*" >&2; }
fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }

say "loop smoke — workspace $WORKSPACE, stub port $PORT, $ITEMS items"

# ── the fixture ─────────────────────────────────────────────────────────────
# Built HERE rather than on the host: /workspace is the only writable host
# surface, the container runs as uid 1000, and a fixture created by the host
# user would hand git a tree it considers dubiously owned. Building it inside
# also makes "writes to /workspace succeed" part of the test rather than a
# claim.

rm -rf "$RUN_DIR" "$WORKSPACE/demo-repo"
mkdir -p "$RUN_DIR"

# Every git identity is passed with `-c` rather than written to a global config:
# this script also runs on a developer's host (`--no-container`-style, straight
# from a shell), and a smoke test that edits ~/.gitconfig would be a side effect
# nobody asked for.
say 'building the fixture repo'
git init --quiet --bare --initial-branch=main "$RUN_DIR/origin.git"
git clone --quiet "$RUN_DIR/origin.git" "$WORKSPACE/demo-repo" 2>/dev/null
(
    cd "$WORKSPACE/demo-repo"
    echo '# demo repo' > README.md
    git add README.md
    git -c user.name='Smoke Fixture' -c user.email='smoke@example.invalid' \
        commit --quiet -m 'chore: seed the smoke fixture'
    git push --quiet -u origin main
)

cat > "$WORKSPACE/.motir.json" <<JSON
{
  "serverUrl": "http://127.0.0.1:$PORT",
  "workspace": "smoke",
  "project": "SMOKE",
  "repos": { "demo-repo": "demo-repo" }
}
JSON

# ── the stub server ─────────────────────────────────────────────────────────

CALL_LOG="$RUN_DIR/mcp-calls.ndjson"
GH_LOG="$RUN_DIR/gh-calls.log"
: > "$GH_LOG"

say 'starting the stub MCP server'
node "$SMOKE_DIR/stub-server.mjs" \
    --port "$PORT" --log "$CALL_LOG" --items "$ITEMS" --project SMOKE \
    > "$RUN_DIR/stub.url" 2> "$RUN_DIR/stub.err" &
STUB_PID=$!
cleanup() { kill "$STUB_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 50); do
    [ -s "$RUN_DIR/stub.url" ] && break
    sleep 0.1
done
[ -s "$RUN_DIR/stub.url" ] || fail "the stub server never came up: $(cat "$RUN_DIR/stub.err")"
say "stub server at $(cat "$RUN_DIR/stub.url")"

# ── the run ─────────────────────────────────────────────────────────────────
# The credential comes from the READ-ONLY mount (or MOTIR_CONFIG_HOME when this
# script is run outside a container); nothing here writes to it. That is not a
# convenience — an unattended run that needed to write beside its PAT could not
# work in the sandbox at all, so the smoke run proves it does not have to.

export PATH="$SMOKE_DIR/bin:$PATH"
export MOTIR_SMOKE_GH_LOG="$GH_LOG"

say 'running motir auto with the fake agent'
set +e
(
    cd "$WORKSPACE"
    motir auto --agent "$SMOKE_DIR/fake-agent.sh" 2>&1
) | tee "$RUN_DIR/auto.log"
STATUS=${PIPESTATUS[0]}
set -e

[ "$STATUS" -eq 0 ] || fail "motir auto exited $STATUS (see $RUN_DIR/auto.log)"

# ── the assertions ──────────────────────────────────────────────────────────

say 'asserting the MCP call sequence'
node "$SMOKE_DIR/assert-run.mjs" \
    --calls "$CALL_LOG" --gh "$GH_LOG" --items "$ITEMS" --project SMOKE

say 'asserting the integrated work reached origin'
BRANCH="$(sed -n 's/.*\(motir\/auto-[0-9-]*\).*/\1/p' "$RUN_DIR/auto.log" | head -1)"
[ -n "$BRANCH" ] || fail 'the run never named a session branch'

COMMITS="$(git -C "$WORKSPACE/demo-repo" rev-list --count "origin/main..origin/$BRANCH")"
[ "$COMMITS" -eq "$ITEMS" ] || fail "origin/$BRANCH carries $COMMITS commits, expected $ITEMS"

for i in $(seq 1 "$ITEMS"); do
    git -C "$WORKSPACE/demo-repo" cat-file -e "origin/$BRANCH:.smoke-work/SMOKE-$i.txt" 2>/dev/null \
        || fail "SMOKE-$i left no integrated file on origin/$BRANCH"
done

grep -q 'github.example.invalid' "$RUN_DIR/auto.log" \
    || fail 'the run summary carries no pull-request URL'

say "loop smoke PASSED — $ITEMS items integrated on $BRANCH, one pull request opened"
