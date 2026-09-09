#!/usr/bin/env bash
#
# The Motir sandbox AGENT-CONFIG setup (MOTIR-4959).
#
# Everything the image does to make an agent's config usable in this container:
# redirect a config path that would otherwise land inside a READ-ONLY credential
# mount, seed the redirected directory so the agent stays signed in, reconcile
# the one file codegraph and Claude Code disagree about, index the workspace,
# and install the git hooks that keep the graph fresh.
#
# ── WHY THIS IS ITS OWN FILE (MOTIR-4956) ───────────────────────────────────
#
# All of it used to live in `entrypoint.sh`, and the image reaches the entrypoint
# only through `ENTRYPOINT ["motir-sandbox-entrypoint"]`. A shell that starts any
# OTHER way gets none of it:
#
#   - a Dev Containers session, which sets `"overrideCommand": true` and thereby
#     replaces the container's ENTRYPOINT as well as its CMD with `/bin/sh`;
#   - a `docker exec` into a running container;
#   - a `docker run --entrypoint …`.
#
# For the `claude` profile that is not a degraded sandbox, it is an unusable one:
# with CLAUDE_CONFIG_DIR unset the agent falls back to `~/.claude`, which on this
# image is the read-only mount — no credential to read on a macOS host (the OAuth
# token lives in the login Keychain, so there is nothing on disk to bind) and no
# write permission to sign in with. Both doors shut, with no error naming the
# cause.
#
# So the work lives HERE, installed on PATH as `motir-sandbox-agent-config`, and
# has three callers: the entrypoint (the `docker run` route, unchanged), the
# login-shell hook the Dockerfile installs (which repairs a devcontainer.json
# already copied onto somebody's disk), and a `postStartCommand` in the recipes.
#
# ── THE TWO PROPERTIES THAT MAKE THAT SAFE ──────────────────────────────────
#
# 1. RE-RUNNABLE. Three callers means it runs more than once, and a container
#    RESTART runs it again. The seeding arms below therefore never wipe a
#    directory that holds a credential the mount cannot replace — see
#    `private_credential_would_be_lost`.
# 2. IT EMITS ITS ENVIRONMENT. `export` reaches this process and its children and
#    nothing else, which is no use to a terminal opened later by a `postStart`
#    hook. So the assignments are also WRITTEN to $AGENT_CONFIG_ENV_FILE, which
#    the shell hook sources.
#
# NONE of this is allowed to fail the run. A code graph is an ENHANCEMENT to how
# well the agent reads the repo, never a precondition for doing the work — so
# every step warns to stderr and carries on. `set -e` is on, hence the explicit
# guards on each call.
#
# EVERY message this script prints goes to STDERR. The CLI's delivery contract
# reserves stdout for the prompt alone (`motir next --print | pbcopy`), so a line
# on stdout would corrupt a pipe that is expected to be clean.
set -euo pipefail

# The entrypoint sets this too, and the two must agree — a guard in
# packages/cli/test/sandbox.test.ts pins them together. Defaulted rather than
# inherited because this script's other two callers are shells, not the
# entrypoint, and they export nothing.
WORKSPACE="${WORKSPACE:-/workspace}"

# ── CodeGraph: index the workspace, keep it fresh (7.9.7d / MOTIR-1513) ──────
#
# The image ships the codegraph binary and (for the five profiles codegraph has
# a target for) the agent-side MCP wiring. What can only happen HERE is
# everything that depends on the MOUNT: the graph itself, and the git hooks that
# keep it current as the branch advances.
#
# NONE of this is allowed to fail the run. A code graph is an ENHANCEMENT to how
# well the agent reads the repo, never a precondition for doing the work — so
# every step warns to stderr and carries on. `set -e` is on, hence the explicit
# guards on each call.
#
# Set MOTIR_SANDBOX_CODEGRAPH=0 to skip the whole block (a `--print` workflow or
# a build-matrix smoke test has nothing to gain from indexing).
CODEGRAPH_TARGET_FILE=/usr/local/lib/motir-sandbox/codegraph-target

# The config home the IMAGE owns — under $HOME but outside every credential
# mount, so nothing bind-mounted `:ro` can shadow a file written here. Kept in
# sync with install-agent.sh's SANDBOX_AGENT_HOME and with
# `sandboxAgentConfigHome()` in packages/cli/src/agentProfiles.ts.
SANDBOX_AGENT_HOME="$HOME/.motir-sandbox/agent-config"

# Where this script WRITES the environment it computes, for a shell that did not
# inherit it. Inside $SANDBOX_AGENT_HOME on purpose: that directory is in the
# container's writable layer and is mounted over by nothing, which is the same
# property that makes it a safe home for the redirected config.
AGENT_CONFIG_ENV_FILE="$SANDBOX_AGENT_HOME/env.sh"

# Written once the setup has completed, so the login-shell hook the Dockerfile
# installs runs the work on the FIRST shell of a container and only sources
# $AGENT_CONFIG_ENV_FILE on every shell after it. It lives in the writable layer
# rather than in a mount, so a fresh container always starts without it — which
# is what "once per container" means here.
AGENT_CONFIG_SENTINEL="$SANDBOX_AGENT_HOME/.setup-done"

# What the claude redirect below copies out of the read-only ~/.claude mount:
# the CONFIG surface and nothing else — the credential, the state file holding
# the user's own MCP servers, their settings, their memory, and the three small
# customization dirs.
#
# Deliberately NOT carried: projects/, file-history/, sessions/, history.jsonl,
# shell-snapshots/, cache/, backups/, telemetry/ and the rest. That is
# per-machine session state, not configuration; it is regenerated inside the
# container, and it is the bulk of the directory (~850 MB against ~50 MB of
# config on a working machine), so copying it would tax every container start
# for nothing. plugins/ IS carried — a plugin can change how the agent behaves.
CLAUDE_SEED_ENTRIES='.credentials.json .claude.json settings.json settings.local.json CLAUDE.md agents commands skills plugins'

# Is there a credential in the private dir that the mount cannot put back?
#
# THE RE-RUNNABILITY GUARD (MOTIR-4959). Both seeding arms below used to open
# with an unconditional `rm -rf "$private"`. Under the entrypoint that ran
# exactly once per container and was harmless. This script runs from a shell
# hook and from a `postStartCommand` as well, so it runs again on every restart
# — and on a macOS host the private dir is the ONLY place a credential can live
# (Claude Code keeps its OAuth token in the login Keychain, so there is no
# ~/.claude/.credentials.json to mount, and the mount is read-only anyway). A
# second run that wiped it would silently sign the user out, which is a worse
# version of the defect this file exists to fix.
#
# So the wipe is skipped exactly when the private copy is the only copy. When
# the mount DOES carry the credential the wipe still happens and the seeding
# loop restores it, so the host stays authoritative wherever it can be.
private_credential_would_be_lost() {
    local private_credential="$1" mounted_credential="$2"
    [ -f "$private_credential" ] && [ ! -f "$mounted_credential" ]
}

# Point an agent whose codegraph config would land inside its own READ-ONLY
# credential mount at the image-owned home instead (7.9.7f / MOTIR-1835), and
# set CODEGRAPH_INSTALL_HOME to the HOME `codegraph install` must run with so
# the stanza lands where the agent will now look. Anything else keeps its
# default location.
#
# The result comes back through a GLOBAL rather than stdout on purpose: this
# function EXPORTS the agent's config env var, and a `$(…)` capture would run it
# in a subshell where that export dies with the subshell.
#
# Every mechanism below was VERIFIED against the real CLIs (claude 2.1.220,
# codex 0.146.0, opencode 1.18.9, codegraph 1.5.0) rather than read off their
# docs — the 7.9.7b rule is to leave an unverified third-party path UNKNOWN, so
# an unverified env var could not have been used here.
redirect_codegraph_config() {
    case "$1" in
        claude)
            # Claude Code resolves its WHOLE config from CLAUDE_CONFIG_DIR —
            # verified against 2.1.220: the state file it reads MCP servers from
            # (<dir>/.claude.json), the user settings carrying codegraph's
            # auto-allow list and prompt hook (<dir>/settings.json), the user
            # memory (<dir>/CLAUDE.md) and the CREDENTIAL (<dir>/.credentials.json)
            # all move together. So, exactly like codex, the redirected dir is
            # SEEDED from the read-only mount first or the agent would trade "no
            # code-graph tools" for "not signed in".
            #
            # Only the CONFIG surface is copied — see CLAUDE_SEED_ENTRIES. A
            # blanket `cp -a` would drag the session archives along, which run to
            # hundreds of MB on a real machine and are per-machine state the
            # container has no use for.
            #
            # Copying the credential to another path INSIDE the container widens
            # nothing: the container could always read the mounted file. What the
            # mount guarantees — that the container cannot WRITE the host's copy —
            # still holds.
            local mounted="$HOME/.claude" private="$SANDBOX_AGENT_HOME/.claude" entry
            if ! private_credential_would_be_lost \
                "$private/.credentials.json" "$mounted/.credentials.json"; then
                rm -rf "$private" 2>/dev/null || true
            fi
            mkdir -p "$private" 2>/dev/null || return 1
            if [ -d "$mounted" ]; then
                for entry in $CLAUDE_SEED_ENTRIES; do
                    [ -e "$mounted/$entry" ] || continue
                    cp -a "$mounted/$entry" "$private/" 2>/dev/null || true
                done
                # The copy inherits the source's mode bits; the mount's
                # read-only-ness does not follow it, but a 0444 file would.
                chmod -R u+w "$private" 2>/dev/null || true
            fi
            export CLAUDE_CONFIG_DIR="$private"
            CODEGRAPH_INSTALL_HOME="$SANDBOX_AGENT_HOME"
            ;;
        codex)
            # codex resolves BOTH config.toml and auth.json from CODEX_HOME, so
            # redirecting it alone would leave the agent unauthenticated. The
            # redirected home is therefore SEEDED from the read-only mount
            # first — the credential and the user's own config.toml come along —
            # and `codegraph install` then MERGES its stanza into that copy,
            # preserving whatever the user had. Copying the credential to
            # another path INSIDE the container widens nothing: the container
            # could always read it. What the mount guarantees — that the
            # container cannot WRITE the host's copy — still holds.
            # codex keeps its credential in auth.json under CODEX_HOME, so that is
            # the file the re-runnability guard asks about here.
            local mounted="$HOME/.codex" private="$SANDBOX_AGENT_HOME/.codex"
            if ! private_credential_would_be_lost \
                "$private/auth.json" "$mounted/auth.json"; then
                rm -rf "$private" 2>/dev/null || true
            fi
            # A home it cannot create is a home it must not point codex at:
            # leave CODEGRAPH_INSTALL_HOME alone and let the caller's warning
            # fire rather than sending the agent at an unauthenticated path.
            mkdir -p "$private" 2>/dev/null || return 1
            if [ -d "$mounted" ]; then
                cp -a "$mounted/." "$private/" 2>/dev/null || true
                # The copy inherits the source's mode bits; the mount's
                # read-only-ness does not follow it, but a 0444 file would.
                chmod -R u+w "$private" 2>/dev/null || true
            fi
            export CODEX_HOME="$private"
            CODEGRAPH_INSTALL_HOME="$SANDBOX_AGENT_HOME"
            ;;
        opencode)
            # opencode MERGES the file named by OPENCODE_CONFIG over its global
            # config rather than replacing it, so the image-owned copy adds the
            # codegraph stanza while the host's mounted ~/.config/opencode
            # keeps applying — and the credential, which lives in the XDG DATA
            # dir, is never touched. No copying, no credential handling at all.
            export OPENCODE_CONFIG="$SANDBOX_AGENT_HOME/.config/opencode/opencode.jsonc"
            CODEGRAPH_INSTALL_HOME="$SANDBOX_AGENT_HOME"
            ;;
        *)
            # cursor and antigravity keep their MCP server config outside their
            # mounted paths already, so nothing can shadow it.
            CODEGRAPH_INSTALL_HOME="$HOME"
            ;;
    esac
}

# Reconcile the ONE file codegraph and the agent disagree about (7.9.7g /
# MOTIR-1840), after `codegraph install` has run.
#
# For the claude target codegraph writes its MCP server stanza to
# <HOME>/.claude.json, which is one level ABOVE the file Claude Code 2.1.220
# actually reads it from — <CLAUDE_CONFIG_DIR>/.claude.json. (Verified: the
# legacy ~/.claude.json is not read at all by the shipped CLI, redirect or no
# redirect, which is why this profile had no code-graph tools rather than merely
# no auto-allow list.) Its other two outputs — settings.json and CLAUDE.md —
# land under <HOME>/.claude, which IS the redirected config dir, so codegraph
# merges those into the seeded copies by itself and only this key is left over.
#
# Merging is deliberately a MERGE of one key: the seeded state file carries the
# user's own MCP servers and the rest of Claude Code's state, none of which may
# be dropped on the way past.
reconcile_codegraph_config() {
    [ "$1" = claude ] || return 0
    [ -n "${CLAUDE_CONFIG_DIR:-}" ] || return 0
    local written="$SANDBOX_AGENT_HOME/.claude.json"
    [ -f "$written" ] || return 0
    node -e '
const fs = require("node:fs");
const [src, dst] = process.argv.slice(1);
const servers = (JSON.parse(fs.readFileSync(src, "utf8")).mcpServers) || {};
if (Object.keys(servers).length === 0) process.exit(0);
// A state file that exists but will not parse is NOT overwritten: it is the
// user own config, and a clobber would cost them more than the missing tools.
const state = fs.existsSync(dst) ? JSON.parse(fs.readFileSync(dst, "utf8")) : {};
state.mcpServers = { ...(state.mcpServers || {}), ...servers };
fs.writeFileSync(dst, JSON.stringify(state, null, 2));
' "$written" "$CLAUDE_CONFIG_DIR/.claude.json" 2>/dev/null || return 1
}

# The marker that makes a hook OURS. A hook file without it belongs to the user
# and is never touched.
CODEGRAPH_HOOK_MARKER='motir-sandbox: codegraph incremental sync'

# The hook body. Deliberately POSIX `sh` and deliberately SELF-GUARDING: .git/hooks
# is untracked, so this file OUTLIVES the container inside the host's repo. On a
# machine with no codegraph it must be a silent no-op rather than an error on
# every merge, and it must never fail a merge or a checkout — hence `exit 0`
# on every path.
codegraph_hook_body() {
    cat <<HOOK
#!/bin/sh
# ${CODEGRAPH_HOOK_MARKER}
# Written by the Motir sandbox entrypoint. Delete this file to disable it.
command -v codegraph >/dev/null 2>&1 || exit 0
root=\$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
# Walk up to the nearest INDEXED project: the sandbox indexes the workspace
# root, which is usually one level above the repo this hook fires in.
dir=\$root
while [ -n "\$dir" ] && [ "\$dir" != "/" ]; do
    if [ -d "\$dir/.codegraph" ]; then
        codegraph sync --quiet "\$dir" >/dev/null 2>&1 || true
        break
    fi
    dir=\$(dirname "\$dir")
done
exit 0
HOOK
}

# Install both hooks into one repository, without ever clobbering a hook the
# user wrote.
install_codegraph_hooks() {
    local repo="$1" common hooks configured
    common=$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null) || return 0
    # --git-common-dir answers relative to the repo when it can.
    case "$common" in
        /*) ;;
        *) common="$repo/$common" ;;
    esac
    # A repo that redirects core.hooksPath would never run .git/hooks, so the
    # hook has to follow the redirect or it is decoration.
    configured=$(git -C "$repo" config --get core.hooksPath 2>/dev/null || true)
    if [ -n "$configured" ]; then
        case "$configured" in
            /*) hooks="$configured" ;;
            *) hooks="$repo/$configured" ;;
        esac
    else
        hooks="$common/hooks"
    fi
    mkdir -p "$hooks" 2>/dev/null || return 0
    for hook in post-merge post-checkout; do
        if [ -e "$hooks/$hook" ] && ! grep -qF "$CODEGRAPH_HOOK_MARKER" "$hooks/$hook" 2>/dev/null; then
            echo "motir-sandbox: $repo already has its own $hook hook — leaving it alone (no codegraph sync there)." >&2
            continue
        fi
        codegraph_hook_body > "$hooks/$hook" 2>/dev/null || continue
        chmod +x "$hooks/$hook" 2>/dev/null || true
    done
}

if [ "${MOTIR_SANDBOX_CODEGRAPH:-1}" != "0" ] && command -v codegraph >/dev/null 2>&1; then
    # Re-run the agent wiring the image already did — idempotent, cheap, and the
    # step that reconciles it with whatever the host actually mounted.
    #
    # A credential directory bind-mounted READ-ONLY (compose mounts ~/.codex and
    # ~/.config/opencode that way) used to MASK the config file the build wrote,
    # leaving those two agents with no code-graph tools at all. They are now
    # redirected to a config home the image owns, which no mount can shadow; the
    # install below writes into that home, merging with whatever the mount
    # brought in. The warning is kept as the backstop for any path that is still
    # unwritable — it should no longer fire for a supported profile.
    codegraph_target=none
    if [ -r "$CODEGRAPH_TARGET_FILE" ]; then
        codegraph_target=$(cat "$CODEGRAPH_TARGET_FILE" 2>/dev/null || echo none)
    fi
    if [ -n "$codegraph_target" ] && [ "$codegraph_target" != "none" ]; then
        CODEGRAPH_INSTALL_HOME="$HOME"
        redirect_codegraph_config "$codegraph_target" || true
        if ! HOME="$CODEGRAPH_INSTALL_HOME" codegraph install --target "$codegraph_target" --location global --yes >/dev/null 2>&1; then
            echo "motir-sandbox: could not refresh the codegraph MCP wiring for '${codegraph_target}'." >&2
            echo "motir-sandbox: its config path is most likely a READ-ONLY credential mount, which masks the copy the image built in." >&2
            echo "motir-sandbox: the codegraph CLI still works; the agent just won't see the MCP tools. Drop that agent's :ro mount to restore them." >&2
        elif ! reconcile_codegraph_config "$codegraph_target"; then
            echo "motir-sandbox: wired the codegraph MCP server but could not merge it into '${codegraph_target}'s own config file." >&2
            echo "motir-sandbox: that file is present and unparseable, and overwriting your config would cost more than the missing tools." >&2
            echo "motir-sandbox: the codegraph CLI still works; the agent just won't see the MCP tools." >&2
        fi
    fi

    # Index the workspace. Output goes to stderr like every other line here —
    # stdout belongs to the dispatched prompt alone.
    if [ -d "$WORKSPACE/.codegraph" ]; then
        codegraph sync --quiet "$WORKSPACE" >&2 ||
            echo "motir-sandbox: codegraph sync failed — the agent runs without a refreshed code graph." >&2
    else
        codegraph init "$WORKSPACE" >&2 ||
            echo "motir-sandbox: codegraph init failed — the agent runs without a code graph." >&2
    fi

    # Keep it fresh as the branch advances. /workspace is the workspace ROOT,
    # which may itself be a repo or may HOLD the checkouts, so both shapes are
    # covered; the depth stops at one level on purpose, so start-up cost does not
    # scale with how deep the tree happens to be. Worktrees `motir auto` creates
    # later are not hooked, but they are inside the indexed root, so the next
    # sync from any hooked repo still picks their changes up.
    for candidate in "$WORKSPACE" "$WORKSPACE"/*; do
        [ -d "$candidate" ] || continue
        [ -e "$candidate/.git" ] || continue
        install_codegraph_hooks "$candidate"
    done
fi

# ── Emit the environment, so a LATER shell can pick it up ────────────────────
#
# `export` reaches this process and its children and nothing else. A
# `postStartCommand` is one process and the terminal a human opens afterwards is
# a different one, so without this file the devcontainer route would still hand
# the agent an unset CLAUDE_CONFIG_DIR — which is MOTIR-4956 exactly.
#
# Only a variable this run actually SET gets a line. A profile with no redirect
# (cursor and antigravity, and every profile codegraph has no target for) leaves
# the file EMPTY rather than exporting an empty path over whatever the shell had.
shell_quote() {
    # Single-quote for `.`-sourcing. The only character that needs care inside
    # single quotes is the quote itself.
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

write_agent_config_env() {
    local var value
    mkdir -p "$SANDBOX_AGENT_HOME" 2>/dev/null || return 0
    : > "$AGENT_CONFIG_ENV_FILE" 2>/dev/null || return 0
    for var in CLAUDE_CONFIG_DIR CODEX_HOME OPENCODE_CONFIG; do
        eval "value=\${$var:-}"
        [ -n "$value" ] || continue
        printf 'export %s=%s\n' "$var" "$(shell_quote "$value")" >> "$AGENT_CONFIG_ENV_FILE"
    done
}

write_agent_config_env

# The shell hook reads this to decide whether the work above still has to run.
# It is written LAST and only on a clean pass, so a run that died half way
# through is retried by the next shell rather than skipped.
: > "$AGENT_CONFIG_SENTINEL" 2>/dev/null || true
