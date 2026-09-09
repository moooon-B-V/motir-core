#!/usr/bin/env bash
#
# The Motir sandbox ENTRYPOINT (Subtask 7.9.7a).
#
# Drops into /workspace and hands over to the requested command, so a full
# unattended run is a one-liner:
#
#   docker run --rm -it \
#     -v "$PWD:/workspace" \
#     -e MOTIR_TOKEN -e MOTIR_SERVER \
#     motir-sandbox:base motir auto --agent "<cmd>"
#
# The CREDENTIAL MOUNT IS OPTIONAL (MOTIR-1877). `MOTIR_TOKEN` / `MOTIR_SERVER`
# are read by every command (the resolution ladder, MOTIR-1876), so a fresh
# machine, a CI runner, or any box that never ran a host login gets in with two
# environment variables and no host state at all. Mounting a host credential
# still works and is still read-only:
#
#   docker run --rm -it \
#     -v "$PWD:/workspace" \
#     -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
#     motir-sandbox:base motir auto --agent "<cmd>"
#
# And with NO mount, `$HOME/.config/motir` inside the container is writable, so
# `motir login` — a device grant, headless by construction — runs in here.
#
# EVERY message this script prints goes to STDERR. The CLI's delivery contract
# reserves stdout for the prompt alone (`motir next --print | pbcopy`), so an
# entrypoint banner on stdout would corrupt a pipe that is expected to be clean.
set -euo pipefail

WORKSPACE=/workspace
CONFIG_DIR="${MOTIR_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}/motir"

# /workspace is the ONLY writable host surface in this container. If it is not
# writable, nothing the agent is about to be asked to do can succeed — fail here
# with a sentence that names the fix rather than deep inside a dispatched item.
if [ ! -w "$WORKSPACE" ]; then
    echo "motir-sandbox: $WORKSPACE is not writable." >&2
    echo "motir-sandbox: mount your workspace root read-write, e.g. -v \"\$PWD:$WORKSPACE\"." >&2
    exit 1
fi

# THREE ways a credential gets in here, and the message names all three
# (MOTIR-1877). It used to name one — mount a host credential, read-only — which
# is a correct instruction only on the machine you already logged in on; a fresh
# box, a CI runner and a container started from a published image had no path at
# all. The order below is the order to TRY them: the environment tier needs no
# state anywhere, `motir login` needs only a browser on some other device, and
# the mount needs a prior host login.
#
# `MOTIR_TOKEN` counts as a credential, so a run that carries one says nothing:
# a warning that fires on a working configuration teaches people to ignore it.

# Can `motir login` write the credential from in here? The mount is the reason
# it usually cannot — but the dir may not exist yet, in which case the CLI
# creates it, so the question is really about the nearest EXISTING ancestor.
config_dir_writable() {
    local dir="$CONFIG_DIR"
    while [ ! -e "$dir" ] && [ "$dir" != "/" ]; do
        dir=$(dirname "$dir")
    done
    [ -w "$dir" ]
}

if [ -z "${MOTIR_TOKEN:-}" ] && [ ! -f "$CONFIG_DIR/config.json" ]; then
    echo "motir-sandbox: no Motir credential — MOTIR_TOKEN is unset and there is no $CONFIG_DIR/config.json." >&2
    echo "motir-sandbox: three ways in, in the order worth trying:" >&2
    echo "motir-sandbox:   1. pass one from the host env:  -e MOTIR_TOKEN -e MOTIR_SERVER" >&2
    if config_dir_writable; then
        echo "motir-sandbox:   2. log in from in here:        \`motir login\` (prints a code; approve it in a browser anywhere)" >&2
    else
        echo "motir-sandbox:   2. \`motir login\` in here needs a WRITABLE $CONFIG_DIR — drop the :ro mount to use it" >&2
    fi
    echo "motir-sandbox:   3. mount a host credential:     -v \"\$HOME/.config/motir:$CONFIG_DIR:ro\"" >&2
fi

# A workspace with no project link still works (`motir link` can create one),
# but it is far more often a mis-pointed mount — worth one line.
if [ ! -f "$WORKSPACE/.motir.json" ]; then
    echo "motir-sandbox: no .motir.json in $WORKSPACE — run \`motir link\`, or check that the mount points at your workspace root." >&2
fi

# ── The agent-config setup — now its OWN script (MOTIR-4959 / MOTIR-4956) ────
#
# Redirecting an agent's config away from its read-only credential mount, seeding
# the redirected directory so it stays signed in, wiring the codegraph MCP server
# and indexing the workspace all used to happen inline HERE. They now live in
# `agent-config.sh`, installed on PATH as `motir-sandbox-agent-config`.
#
# The reason is MOTIR-4956. A Dev Containers session sets `"overrideCommand":
# true`, which replaces this ENTRYPOINT as well as the CMD — so on that route
# none of the work below ever ran, `CLAUDE_CONFIG_DIR` stayed unset, and the
# agent fell back to a `~/.claude` that is read-only and (on a macOS host) holds
# no credential at all. Moving the work onto PATH is what lets a login shell, a
# `postStartCommand` or a `docker exec` reach it. This is simply its first
# caller, and the `docker run` route it serves is unchanged.
#
# Run as a CHILD, never sourced: its failure must not fail the run. A code graph
# is an ENHANCEMENT to how well the agent reads the repo, never a precondition
# for doing the work.
if command -v motir-sandbox-agent-config >/dev/null 2>&1; then
    motir-sandbox-agent-config || true
else
    echo "motir-sandbox: motir-sandbox-agent-config is not on PATH — the agent runs without its config redirect and without a code graph." >&2
fi

# The config home the IMAGE owns — under $HOME but outside every credential
# mount, so nothing bind-mounted `:ro` can shadow a file written here. Kept in
# sync with install-agent.sh's SANDBOX_AGENT_HOME, with agent-config.sh's, and
# with `sandboxAgentConfigHome()` in packages/cli/src/agentProfiles.ts.
SANDBOX_AGENT_HOME="$HOME/.motir-sandbox/agent-config"

# Take the environment the child computed. `export` in a child process does not
# reach this one, and CLAUDE_CONFIG_DIR / CODEX_HOME / OPENCODE_CONFIG must reach
# the command `exec`d below exactly as they did when this code ran inline — so
# the script WRITES them here and we source them back. That file is the whole
# mechanism, and it is the same file the image's login-shell hook reads.
if [ -r "$SANDBOX_AGENT_HOME/env.sh" ]; then
    # shellcheck source=/dev/null
    . "$SANDBOX_AGENT_HOME/env.sh"
fi

cd "$WORKSPACE"
exec "$@"
