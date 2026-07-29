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

cd "$WORKSPACE"
exec "$@"
