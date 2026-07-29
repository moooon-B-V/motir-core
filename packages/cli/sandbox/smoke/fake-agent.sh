#!/usr/bin/env bash
#
# The FAKE CODING AGENT of the sandbox smoke test (Subtask 7.9.7c / MOTIR-885).
#
# `motir auto` is agent-agnostic by design: it launches a command, hands it the
# server's prompt, and reports the exit code. This script is the smallest thing
# that satisfies that contract — so the loop can be exercised end to end with NO
# LLM, no API key, and no network. That is what makes the smoke test runnable on
# every pull request.
#
# It does the three things a real agent does, and nothing else:
#
#   1. RECEIVES the prompt — on BOTH channels agentRun.ts delivers it on (stdin
#      AND $MOTIR_PROMPT_FILE), and FAILS if they disagree. An agent that got a
#      truncated or empty prompt is the failure mode this smoke test exists to
#      catch, and it is invisible if you only assert the exit code.
#   2. INTEGRATES onto the session branch the prompt names — the same
#      branch-from-origin, commit, push the real GIT WORKFLOW section instructs.
#   3. EXITS 0, which is the loop's signal to call `mark_integrated`.
#
# It never opens a pull request: that is the CLI's end-of-run job (ONE per repo),
# and an agent that opened its own would break the session-lineage contract.
set -euo pipefail

say() { echo "fake-agent: $*" >&2; }

# ── 1. the prompt, on both channels ─────────────────────────────────────────

stdin_prompt="$(cat || true)"

if [ -z "${MOTIR_PROMPT_FILE:-}" ]; then
    say "MOTIR_PROMPT_FILE is not set — the CLI must deliver the prompt on disk too."
    exit 1
fi
if [ ! -f "$MOTIR_PROMPT_FILE" ]; then
    say "MOTIR_PROMPT_FILE points at $MOTIR_PROMPT_FILE, which does not exist."
    exit 1
fi
file_prompt="$(cat "$MOTIR_PROMPT_FILE")"

if [ -z "$file_prompt" ]; then
    say "the prompt file is EMPTY — nothing to work from."
    exit 1
fi
if [ "$stdin_prompt" != "$file_prompt" ]; then
    say "the stdin prompt and \$MOTIR_PROMPT_FILE disagree — one of the two delivery channels is broken."
    exit 1
fi

# The stub server plants these markers in the prompt body; reading them back HERE
# is what proves the server's prompt — not a CLI-assembled one — reached the
# agent intact.
item="$(sed -n 's/^MOTIR_SMOKE_ITEM=//p' "$MOTIR_PROMPT_FILE" | head -1)"
branch="$(sed -n 's/^MOTIR_SMOKE_BRANCH=//p' "$MOTIR_PROMPT_FILE" | head -1)"

if [ -z "$item" ]; then
    say "no MOTIR_SMOKE_ITEM marker in the prompt — the prompt did not come from the smoke stub."
    exit 1
fi
if [ -z "$branch" ]; then
    say "no MOTIR_SMOKE_BRANCH marker — the CLI did not seed a session branch for $item."
    exit 1
fi

say "$item — integrating into $branch (cwd: $PWD)"

# ── 2. integrate onto the session branch ────────────────────────────────────
# The CLI created the branch on ORIGIN before launching us and never checks out,
# so the first item creates the local tracking branch and later ones fast-forward
# onto it — exactly the sequence the real GIT WORKFLOW section describes.

git fetch --quiet origin
if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
    git checkout --quiet "$branch"
    git merge --quiet --ff-only "origin/$branch"
else
    git checkout --quiet -b "$branch" "origin/$branch"
fi

mkdir -p .smoke-work
printf '%s integrated by the fake agent\n' "$item" > ".smoke-work/${item}.txt"

git add ".smoke-work/${item}.txt"
git -c user.name='Smoke Agent' -c user.email='smoke@example.invalid' \
    commit --quiet -m "chore(smoke): integrate ${item}"
git push --quiet origin "$branch"

say "$item — pushed to origin/$branch"
