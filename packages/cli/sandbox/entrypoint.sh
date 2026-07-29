#!/usr/bin/env bash
#
# The Motir sandbox ENTRYPOINT (Subtask 7.9.7a).
#
# Drops into /workspace and hands over to the requested command, so a full
# unattended run is a one-liner:
#
#   docker run --rm -it \
#     -v "$PWD:/workspace" \
#     -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
#     motir-sandbox:base motir auto --agent "<cmd>"
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

# The PAT lives in a READ-ONLY mount by design: the container consumes the
# credential, it never mints or rotates one. `motir auth login` therefore has to
# be run on the HOST — say so up front instead of letting it fail on a read-only
# filesystem mid-run.
if [ ! -f "$CONFIG_DIR/config.json" ]; then
    echo "motir-sandbox: no Motir credential at $CONFIG_DIR/config.json." >&2
    echo "motir-sandbox: run \`motir auth login\` on the HOST, then mount it read-only:" >&2
    echo "motir-sandbox:   -v \"\$HOME/.config/motir:$CONFIG_DIR:ro\"" >&2
fi

# A workspace with no project link still works (`motir link` can create one),
# but it is far more often a mis-pointed mount — worth one line.
if [ ! -f "$WORKSPACE/.motir.json" ]; then
    echo "motir-sandbox: no .motir.json in $WORKSPACE — run \`motir link\`, or check that the mount points at your workspace root." >&2
fi

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
    # Re-run the agent wiring the image already did. It is idempotent and cheap,
    # and it is the only way to tell a shadowed config apart from a live one: a
    # credential directory bind-mounted READ-ONLY (compose mounts ~/.codex and
    # ~/.config/opencode that way) masks the config file the build wrote, and the
    # failure here is what turns that into a sentence instead of an agent that
    # quietly has no code-graph tools.
    codegraph_target=none
    if [ -r "$CODEGRAPH_TARGET_FILE" ]; then
        codegraph_target=$(cat "$CODEGRAPH_TARGET_FILE" 2>/dev/null || echo none)
    fi
    if [ -n "$codegraph_target" ] && [ "$codegraph_target" != "none" ]; then
        if ! codegraph install --target "$codegraph_target" --location global --yes >/dev/null 2>&1; then
            echo "motir-sandbox: could not refresh the codegraph MCP wiring for '${codegraph_target}'." >&2
            echo "motir-sandbox: its config path is most likely a READ-ONLY credential mount, which masks the copy the image built in." >&2
            echo "motir-sandbox: the codegraph CLI still works; the agent just won't see the MCP tools. Drop that agent's :ro mount to restore them." >&2
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

cd "$WORKSPACE"
exec "$@"
