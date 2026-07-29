#!/usr/bin/env bash
#
# THE FAILURE-PATH LOOP SMOKE TEST (Subtask MOTIR-1836).
#
# loop-smoke.sh proves the HAPPY path: the ready set drains, every item
# integrates, one pull request opens. This proves the other half — that a run
# whose agent FAILS still closes out — inside the container, under the real
# read-only credential mount, which is where the defect lived.
#
# ── WHAT WENT WRONG, AND WHY IT NEEDS A SANDBOX LEG ─────────────────────────
# The session exclude list used to live INSIDE the credential config dir, which
# the sandbox mounts read-only by design (the container consumes a PAT and never
# mints one). `addExclude()` runs on EVERY failed agent, so the write threw, and
# the throw escaped `runAutoLoop` BEFORE `closeOutRepos()` — an unattended run
# that had integrated five items pushed nothing and opened no pull request.
#
# The happy path could not see this: `removeExclude` returns before writing when
# there is nothing to remove, and `mkdir -p` on an existing directory succeeds on
# a read-only filesystem. ONLY the failure path writes — so only a failing agent,
# under the real mount, reproduces it. That is precisely the leg the harness was
# missing, and it is why this is a container test rather than another unit test.
#
# Two legs, because the fix has two independent halves and either one alone
# would let the other rot:
#
#   LEG 1 — RELOCATION. State resolves to the STATE home (~/.local/state/motir),
#           not the credential dir. The run closes out; the store is written;
#           the read-only mount is never touched.
#   LEG 2 — DEGRADATION. With MOTIR_STATE_HOME forced back onto the read-only
#           mount (the pre-fix location), the run STILL closes out — the store
#           write warns instead of dying. This is the safety net for any other
#           unwritable-state-home configuration, and it fails loudly if someone
#           later makes the write fatal again.
#
# Usage:  failure-smoke.sh [workspace-dir]
# Env:    MOTIR_SMOKE_PORT (default 8788 — deliberately NOT loop-smoke.sh's
#         8787, so both can run in one container without racing the port; it
#         must match the server URL in the credential the driver writes.)
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${1:-/workspace}"
PORT="${MOTIR_SMOKE_PORT_FAILURE:-8788}"
ITEMS=2
FAIL_ITEM='SMOKE-2'
STATE_HOME="$HOME/.local/state"
CONFIG_DIR="${MOTIR_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}/motir"

say() { echo "== $*" >&2; }
fail() { echo "FAILURE-SMOKE FAILED: $*" >&2; exit 1; }

STUB_PID=''
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; return 0; }
trap cleanup EXIT

# ── one leg ─────────────────────────────────────────────────────────────────
# Each leg gets a FRESH fixture and a fresh stub server: the stub hands out each
# item exactly once, and leg 1 leaves items served and branches pushed, so a
# shared fixture would make leg 2 assert nothing.

run_leg() {
    # One name per `local`: bash declares every name in a `local` statement
    # before running its assignments, so a later initialiser referencing an
    # earlier name reads it as unset — which `set -u` turns into a hard error.
    local label="$1"
    local run_dir="$WORKSPACE/.failure-run-$label"
    local repo="$WORKSPACE/demo-repo-$label"

    say "leg $label — building the fixture"
    rm -rf "$run_dir" "$repo"
    mkdir -p "$run_dir"

    git init --quiet --bare --initial-branch=main "$run_dir/origin.git"
    git clone --quiet "$run_dir/origin.git" "$repo" 2>/dev/null
    (
        cd "$repo"
        echo "# demo repo ($label)" > README.md
        git add README.md
        git -c user.name='Smoke Fixture' -c user.email='smoke@example.invalid' \
            commit --quiet -m 'chore: seed the failure-smoke fixture'
        git push --quiet -u origin main
    )

    cat > "$WORKSPACE/.motir.json" <<JSON
{
  "serverUrl": "http://127.0.0.1:$PORT",
  "workspace": "smoke",
  "project": "SMOKE",
  "repos": { "demo-repo": "demo-repo-$label" }
}
JSON

    CALL_LOG="$run_dir/mcp-calls.ndjson"
    GH_LOG="$run_dir/gh-calls.log"
    AUTO_LOG="$run_dir/auto.log"
    : > "$GH_LOG"

    say "leg $label — starting the stub MCP server on $PORT"
    node "$SMOKE_DIR/stub-server.mjs" \
        --port "$PORT" --log "$CALL_LOG" --items "$ITEMS" --project SMOKE \
        > "$run_dir/stub.url" 2> "$run_dir/stub.err" &
    STUB_PID=$!

    for _ in $(seq 1 50); do
        [ -s "$run_dir/stub.url" ] && break
        sleep 0.1
    done
    [ -s "$run_dir/stub.url" ] || fail "the stub server never came up: $(cat "$run_dir/stub.err")"

    say "leg $label — running motir auto; $FAIL_ITEM's agent will fail"
    export PATH="$SMOKE_DIR/bin:$PATH"
    export MOTIR_SMOKE_GH_LOG="$GH_LOG"
    export MOTIR_SMOKE_FAIL_ITEM="$FAIL_ITEM"

    set +e
    (
        cd "$WORKSPACE"
        motir auto --agent "$SMOKE_DIR/failing-agent.sh" 2>&1
    ) | tee "$AUTO_LOG"
    STATUS=${PIPESTATUS[0]}
    set -e

    kill "$STUB_PID" 2>/dev/null || true
    STUB_PID=''

    # ── the assertions ──────────────────────────────────────────────────────
    # The run REPORTS failure — that is correct and expected. What must not
    # happen is the run DYING before its close-out.

    [ "$STATUS" -ne 0 ] || fail "leg $label: motir auto exited 0 despite a failed agent"

    grep -q "$FAIL_ITEM" "$AUTO_LOG" \
        || fail "leg $label: the summary never names the failed item $FAIL_ITEM"

    local created
    created="$(grep -c '^pr create' "$GH_LOG" || true)"
    [ "$created" -eq 1 ] \
        || fail "leg $label: expected exactly ONE pull request after the failure, got $created (the run aborted before close-out — MOTIR-1836)"

    local branch
    branch="$(sed -n 's/.*\(motir\/auto-[0-9-]*\).*/\1/p' "$AUTO_LOG" | head -1)"
    [ -n "$branch" ] || fail "leg $label: the run never named a session branch"

    git -C "$repo" fetch --quiet origin
    local commits
    commits="$(git -C "$repo" rev-list --count "origin/main..origin/$branch")"
    [ "$commits" -eq 1 ] \
        || fail "leg $label: origin/$branch carries $commits commits, expected 1 (SMOKE-1's work, pushed despite SMOKE-2 failing)"

    git -C "$repo" cat-file -e "origin/$branch:.smoke-work/SMOKE-1.txt" 2>/dev/null \
        || fail "leg $label: SMOKE-1 integrated but its work never reached origin/$branch"
    if git -C "$repo" cat-file -e "origin/$branch:.smoke-work/$FAIL_ITEM.txt" 2>/dev/null; then
        fail "leg $label: $FAIL_ITEM failed, yet its work is on origin/$branch"
    fi

    grep -q 'github.example.invalid' "$AUTO_LOG" \
        || fail "leg $label: the run summary carries no pull-request URL"

    say "leg $label — PASSED (1 item integrated, 1 failed, one pull request opened)"
}

# ── the READ-ONLY credential mount is never written, in either leg ──────────

refute_store_in_config_dir() {
    if [ -e "$CONFIG_DIR/session-excludes.json" ]; then
        fail "the exclude store was written into the credential dir ($CONFIG_DIR) — state must not live beside the PAT (MOTIR-1836)"
    fi
}

# ── LEG 1: the state home is writable — the store relocates there ───────────

rm -rf "$STATE_HOME/motir"
unset MOTIR_STATE_HOME || true
run_leg 'relocated'

refute_store_in_config_dir
[ -f "$STATE_HOME/motir/session-excludes.json" ] \
    || fail "the exclude store was not written to the state home ($STATE_HOME/motir) — the relocation half of the fix is not in effect"
grep -q "$FAIL_ITEM" "$STATE_HOME/motir/session-excludes.json" \
    || fail "the failed item $FAIL_ITEM was not recorded in the exclude store"
say "leg relocated — the store landed in $STATE_HOME/motir, the credential dir is untouched"

# ── LEG 2: the state home is the READ-ONLY mount — it degrades, not dies ────
# This is the pre-fix location, forced back on deliberately: with the store
# unwritable the run must still reach its close-out, warning instead of throwing.

say 'leg degraded — forcing the state home onto the READ-ONLY credential mount'
export MOTIR_STATE_HOME="${MOTIR_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}"
[ -w "$CONFIG_DIR" ] && fail "the credential dir $CONFIG_DIR is WRITABLE — this leg asserts nothing unless the documented read-only mount is in place"

run_leg 'degraded'

refute_store_in_config_dir
grep -qi 'could not write the session exclude list' "$WORKSPACE/.failure-run-degraded/auto.log" \
    || fail 'an unwritable store must SAY so once — no warning was printed'
unset MOTIR_STATE_HOME

say 'failure smoke PASSED — a failed agent never costs the run its pull request'
