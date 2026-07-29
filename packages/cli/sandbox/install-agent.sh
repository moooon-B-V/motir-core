#!/usr/bin/env bash
#
# The PER-AGENT LAYER SEAM of the Motir sandbox image (seam: 7.9.7a / MOTIR-1505,
# layers: 7.9.7b / MOTIR-1506).
#
# The Dockerfile's `--build-arg AGENT=<profile>` selector calls this script with
# the requested profile id, and the matching case arm installs exactly that
# agent — one arm per profile id in `packages/cli/src/agentProfiles.ts`, each
# from that profile's recorded `installSource`.
#
# It is a script rather than a chain of `FROM base AS agent-<id>` stages on
# purpose: the seam is then one readable case block, an unknown profile fails
# with a sentence a human can act on instead of a BuildKit "target not found",
# and a new agent is one arm rather than a new stage.
#
# Motir does NOT redistribute any coding agent. Every arm fetches the
# third-party CLI from its OFFICIAL source at build time, under that project's
# own licence; the image only decides which one to fetch.
#
# TWO INVARIANTS every arm upholds:
#
#   1. The binary lands on the GLOBAL PATH. This script runs as root, BEFORE the
#      Dockerfile's `USER node`, so an installer that defaults to
#      `$HOME/.local/bin` would drop the agent into /root — invisible to the
#      user that actually runs it. Installers that hard-code $HOME are therefore
#      pointed at $AGENT_PREFIX, or staged and relocated into it.
#   2. The arm SMOKE-TESTS the binary it just installed. A profile that claims
#      an agent it cannot execute must fail the BUILD, not the first unattended
#      `motir auto` run — the same rule the base applies to `motir --version`.
#
# The per-agent CREDENTIAL MOUNT and the VERIFIED auto-approve flag for each
# profile live in ./README.md's profile matrix, and the mounts are wired in
# ./docker-compose.yml + ./devcontainer/<profile>/devcontainer.json.
set -euo pipefail

AGENT="${1:-base}"

# Kept in sync with AGENT_PROFILES in packages/cli/src/agentProfiles.ts — the
# sandbox test asserts every profile id there has a real arm here, so adding an
# agent to the CLI's profile table cannot silently skip this seam.
KNOWN_PROFILES='claude codex opencode kimi antigravity cursor aider goose'

# Where non-npm agents get installed. /usr/local/bin is on PATH for every user
# in the node base image — root at build time, `node` at run time.
AGENT_PREFIX=/usr/local/bin

# Staging HOME for an installer that insists on writing under $HOME. Its payload
# is relocated into a stable location afterwards and the staging tree is
# discarded, so it can never be mistaken for a runtime credential directory.
AGENT_STAGE=/tmp/motir-agent-install

# The RUNTIME user's home. This script runs as root, so anything written to the
# root's own $HOME would be invisible to the `node` user that actually runs the
# agent — the same trap invariant 1 above describes for binaries, one directory
# up. The Dockerfile chowns this home to node:node after the layer runs.
RUNTIME_HOME=/home/node

# Where the resolved codegraph target is recorded for the entrypoint to re-read.
# The profile -> target mapping lives in the case arms below and NOWHERE else;
# the entrypoint reads this file rather than carrying a second copy that could
# drift out of agreement with the arm that actually did the install.
CODEGRAPH_TARGET_FILE=/usr/local/lib/motir-sandbox/codegraph-target

# Install an npm-published agent globally. `--no-fund --no-audit` keeps the
# build log down to the failure that actually matters.
npm_agent() {
    npm install -g --no-fund --no-audit "$1"
}

# Wire the codegraph MCP server into the agent just installed (7.9.7d).
#
# The argument is codegraph's OWN target id, which is not always the profile id
# and is not guessable: the set it accepts is
# `claude, cursor, codex, opencode, hermes, gemini, antigravity, kiro`, so five
# of the eight profiles here have one and three (kimi, aider, goose) have none.
# An arm without a target calls `no_codegraph` instead of inventing a near-miss
# id — the same "leave it UNKNOWN rather than guess" rule the profile table
# applies to credential paths.
#
# `--yes` is what makes this non-interactive AND turns the auto-allow permission
# list on, which is the half that lets an unattended agent actually CALL the
# tools rather than stopping to ask. `--location global` writes into
# $RUNTIME_HOME so the wiring is the image's, not a file dropped in the user's
# repo.
wire_codegraph() {
    HOME="$RUNTIME_HOME" codegraph install --target "$1" --location global --yes
    mkdir -p "$(dirname "$CODEGRAPH_TARGET_FILE")"
    printf '%s\n' "$1" > "$CODEGRAPH_TARGET_FILE"
}

# Record that this profile has NO codegraph MCP wiring. Written explicitly
# rather than left absent so the entrypoint can tell "no target for this agent"
# apart from "the build never got this far".
no_codegraph() {
    mkdir -p "$(dirname "$CODEGRAPH_TARGET_FILE")"
    printf 'none\n' > "$CODEGRAPH_TARGET_FILE"
}

case "$AGENT" in
    base | none)
        # The no-op default. A base image ships NO coding agent: it is what the
        # CI build/version matrix builds, and it is enough for `motir next
        # --print` workflows where the agent runs outside the container.
        echo "motir-sandbox: base image — no coding agent installed (AGENT=${AGENT})." >&2
        # codegraph itself IS in the base image; there is simply no agent to
        # wire it into. The binary and its CLI subcommands still work.
        no_codegraph
        ;;

    # ── Tier 1 — first-class, tested profiles ────────────────────────────────
    claude)
        # Anthropic Claude Code. Credential dir: ~/.claude (plus the
        # ~/.claude.json project file). Unattended flag:
        # --dangerously-skip-permissions.
        npm_agent '@anthropic-ai/claude-code'
        claude --version
        wire_codegraph claude
        ;;

    codex)
        # OpenAI Codex CLI (Apache-2.0). Credential dir: ~/.codex. Unattended:
        # `codex exec` with --sandbox/--ask-for-approval — NOT --full-auto,
        # which upstream has deprecated (see the README matrix).
        npm_agent '@openai/codex'
        codex --version
        wire_codegraph codex
        ;;

    opencode)
        # OpenCode (MIT, model-agnostic). Installed from npm rather than the
        # install script: the script unpacks a release under $HOME and would
        # land in /root here, while the npm package resolves the same
        # platform binary straight onto the global PATH.
        npm_agent 'opencode-ai'
        opencode --version
        wire_codegraph opencode
        ;;

    kimi)
        # Moonshot Kimi Code CLI (MIT). The published package is
        # @moonshot-ai/kimi-code; its engines floor is Node >= 22.19, which the
        # base image's asserted >= 24.15 already clears.
        npm_agent '@moonshot-ai/kimi-code'
        kimi --version
        # codegraph has no `kimi` target (checked against the shipped version's
        # own target list), so this profile gets no MCP wiring.
        no_codegraph
        ;;

    # ── Tier 2 — also-supported profiles ─────────────────────────────────────
    antigravity)
        # Google Antigravity CLI — the replacement for the retired Gemini CLI.
        # NO Gemini CLI profile ships anywhere in this image: the sunset tool is
        # deliberately absent, not merely un-defaulted. The installer takes an
        # explicit target directory, so the `agy` binary goes straight onto the
        # global PATH with nothing to relocate.
        curl -fsSL https://antigravity.google/cli/install.sh \
            | bash -s -- --dir "$AGENT_PREFIX"
        agy --version
        # codegraph's `antigravity` target writes ~/.gemini/antigravity/mcp_config.json.
        wire_codegraph antigravity
        ;;

    cursor)
        # Cursor CLI (Anysphere). Its installer hard-codes $HOME/.local, so it
        # runs against a staging HOME and the payload is relocated to /opt; the
        # installer's own symlinks point back into the staging tree, so they are
        # re-created against the relocated copy rather than copied.
        # NOTE the binary is `agent` (with `cursor-agent` as the legacy alias),
        # NOT `cursor` — both names are linked so either command works.
        mkdir -p "$AGENT_STAGE"
        HOME="$AGENT_STAGE" bash -c 'curl https://cursor.com/install -fsS | bash'
        mkdir -p /opt/cursor-agent
        cp -a "$AGENT_STAGE/.local/share/cursor-agent/." /opt/cursor-agent/
        cursor_bin="$(find /opt/cursor-agent/versions -maxdepth 2 -type f -name cursor-agent | head -1)"
        if [ -z "$cursor_bin" ]; then
            echo "motir-sandbox: the Cursor installer produced no agent binary." >&2
            exit 1
        fi
        ln -sf "$cursor_bin" "$AGENT_PREFIX/agent"
        ln -sf "$cursor_bin" "$AGENT_PREFIX/cursor-agent"
        rm -rf "$AGENT_STAGE"
        agent --version
        wire_codegraph cursor
        ;;

    aider)
        # Aider (Apache-2.0) is the one PYTHON agent, so the thin Python layer
        # is installed HERE and not in the base — no other profile pays for it.
        # A venv keeps pip off Debian's externally-managed system Python
        # (PEP 668) without resorting to --break-system-packages.
        apt-get update
        apt-get install -y --no-install-recommends python3 python3-venv
        rm -rf /var/lib/apt/lists/*
        python3 -m venv /opt/aider
        /opt/aider/bin/pip install --no-cache-dir --upgrade pip
        /opt/aider/bin/pip install --no-cache-dir aider-chat
        ln -sf /opt/aider/bin/aider "$AGENT_PREFIX/aider"
        aider --version
        # Aider is not an MCP client and codegraph has no target for it.
        no_codegraph
        ;;

    goose)
        # Goose (Block, Apache-2.0, model-agnostic). The install script takes
        # GOOSE_BIN_DIR, and CONFIGURE=false is REQUIRED: it otherwise finishes
        # by running `goose configure` interactively, which has no TTY to answer
        # it and would hang the build.
        curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh \
            | CONFIGURE=false GOOSE_BIN_DIR="$AGENT_PREFIX" bash
        goose --version
        # Goose speaks MCP via its own extension config, but codegraph ships no
        # `goose` target — wiring it would mean hand-writing a config format
        # nothing here verifies, so the profile goes without.
        no_codegraph
        ;;

    *)
        echo "motir-sandbox: unknown AGENT '${AGENT}'." >&2
        echo "motir-sandbox: known profiles: base ${KNOWN_PROFILES}." >&2
        exit 1
        ;;
esac
