#!/usr/bin/env bash
#
# THE MOTIR-4956 REPRODUCTION, TURNED INTO A GUARD (MOTIR-4959).
#
# The defect: `https://motir.co/docs/sandbox` publishes two ways to start the
# sandbox and presents them as equivalent. The `docker run` one works. The
# `devcontainer.json` one carries `"overrideCommand": true`, which Dev Containers
# implements by replacing the container's ENTRYPOINT as well as its CMD — so
# `motir-sandbox-entrypoint` never ran, `CLAUDE_CONFIG_DIR` was never exported,
# and Claude Code fell back to `~/.claude`, which is the read-only mount: no
# credential to read on a macOS host, and no permission to sign in. Both doors
# shut, with no error naming the cause.
#
# `--entrypoint /bin/bash` is exactly what that recipe does to the container, so
# this is the real shape rather than a simulation of it. Everything the agent
# needs must survive it.
#
# WHY IT LIVES IN THE PROFILE MATRIX and not in run.sh: run.sh builds the `base`
# profile, which installs no agent and redirects nothing, so it has no config
# path to assert. The three redirected profiles only exist in the per-profile
# matrix legs.
#
# Usage:
#   entrypoint-bypass-smoke.sh --image <tag> --profile <id>
set -euo pipefail

IMAGE=''
PROFILE=''

while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="$2"; shift 2 ;;
        --profile) PROFILE="$2"; shift 2 ;;
        *) echo "entrypoint-bypass-smoke.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done

[ -n "$IMAGE" ] || { echo "entrypoint-bypass-smoke.sh: --image is required" >&2; exit 2; }
[ -n "$PROFILE" ] || { echo "entrypoint-bypass-smoke.sh: --profile is required" >&2; exit 2; }

# The three profiles whose config would otherwise land inside their own
# read-only credential mount, and the variable each one is redirected through.
# Anything else has nothing to assert here — cursor and antigravity keep their
# config outside the mount already, and three profiles have no codegraph target
# at all. Reported rather than skipped silently, so a profile that GAINS a
# redirect and is not added here is visible in the log.
case "$PROFILE" in
    claude) VAR=CLAUDE_CONFIG_DIR ;;
    codex) VAR=CODEX_HOME ;;
    opencode) VAR=OPENCODE_CONFIG ;;
    *)
        echo "== $PROFILE redirects no agent config — nothing for the bypass guard to assert"
        exit 0
        ;;
esac

# The config home the image owns, from Dockerfile `ENV HOME=/home/node` +
# SANDBOX_AGENT_HOME. Kept in sync by packages/cli/test/sandbox.test.ts.
EXPECTED_PREFIX=/home/node/.motir-sandbox/agent-config

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

check() {
    local what="$1" flags="$2" observed
    # `-i` keeps stdin open, which an interactive shell wants; no `-t`, because
    # a CI runner has no tty and bash does not need one to run `-c`.
    observed=$(docker run --rm -i --entrypoint /bin/bash "$IMAGE" "$flags" \
        "printf '%s' \"\${$VAR:-UNSET}\"")

    if [ "$observed" = UNSET ]; then
        fail "$what: $VAR is UNSET with the entrypoint bypassed — this is MOTIR-4956. The agent would fall back to its read-only mount and could neither read a credential nor write one."
    fi
    case "$observed" in
        "$EXPECTED_PREFIX"*) ;;
        *) fail "$what: $VAR is [$observed], which is not under the image-owned $EXPECTED_PREFIX." ;;
    esac
    echo "== $PROFILE / $what: $VAR=[$observed]"
}

# A LOGIN shell — `/etc/profile.d`. This is what `sh -lc` and the image's own
# `CMD ["bash", "-l"]` produce, and what `docker exec -lc` gives you.
check 'login shell' -lc

# An INTERACTIVE NON-LOGIN shell reads ~/.bashrc and NOT /etc/profile.d, and it
# is what a VS Code devcontainer terminal usually opens.
#
# ⚠️ IT MUST BE `bash -i`, NOT `bash -c '. ~/.bashrc; …'`. Debian's stock
# .bashrc opens with `case $- in *i*) ;; *) return;; esac`, so a NON-interactive
# shell sourcing it returns before reaching anything appended below — including
# the line the image adds. That reads as UNSET and blames the product for the
# check's own shape, which is exactly what it did on the first run of this
# guard: the login-shell arm passed with the right path while this one failed.
# `-i` needs no tty — it warns "no job control in this shell" on stderr and
# carries on, and stderr is not what is captured here.
check 'interactive non-login shell' -ic

echo "== $PROFILE: the agent config survives an entrypoint bypass"
