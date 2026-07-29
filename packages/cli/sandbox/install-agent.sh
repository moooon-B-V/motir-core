#!/usr/bin/env bash
#
# The PER-AGENT LAYER SEAM of the Motir sandbox image (Subtask 7.9.7a).
#
# The Dockerfile's `--build-arg AGENT=<profile>` selector calls this script with
# the requested profile id. This slice ships the SELECTOR and the seam; the
# install layers themselves are 7.9.7b's (MOTIR-1506) and land as case arms
# below — one per profile id in `packages/cli/src/agentProfiles.ts`, each using
# that profile's recorded `installSource`.
#
# It is a script rather than a chain of `FROM base AS agent-<id>` stages on
# purpose: the seam is then one readable case block, an unknown profile fails
# with a sentence a human can act on instead of a BuildKit "target not found",
# and the base image needs no per-agent stage to exist before 7.9.7b lands.
set -euo pipefail

AGENT="${1:-base}"

# Kept in sync with AGENT_PROFILES in packages/cli/src/agentProfiles.ts — the
# sandbox test asserts every profile id there is named here, so adding an agent
# to the CLI's profile table cannot silently skip this seam.
KNOWN_PROFILES='claude codex opencode kimi antigravity cursor aider goose'

case "$AGENT" in
    base | none)
        # The no-op default. A base image ships NO coding agent: it is what the
        # CI build/version matrix builds, and it is enough for `motir next
        # --print` workflows where the agent runs outside the container.
        echo "motir-sandbox: base image — no coding agent installed (AGENT=${AGENT})." >&2
        ;;

    # ── 7.9.7b (MOTIR-1506) FILLS THE SEAM HERE ─────────────────────────────
    # One arm per profile, e.g.:
    #
    #   claude)
    #       npm install -g @anthropic-ai/claude-code
    #       ;;
    #
    # Each arm installs from the profile's `installSource` and 7.9.7b adds the
    # matching read-only credential mount to docker-compose.yml / the
    # devcontainer template. Until then a known profile is REFUSED rather than
    # half-built — an image that claims an agent it does not have would fail
    # much later, inside an unattended run.
    claude | codex | opencode | kimi | antigravity | cursor | aider | goose)
        echo "motir-sandbox: '${AGENT}' is a known agent profile, but its install layer has not landed yet (7.9.7b / MOTIR-1506)." >&2
        echo "motir-sandbox: build the base instead — omit --build-arg AGENT, or pass AGENT=base." >&2
        exit 1
        ;;

    *)
        echo "motir-sandbox: unknown AGENT '${AGENT}'." >&2
        echo "motir-sandbox: known profiles: base ${KNOWN_PROFILES}." >&2
        exit 1
        ;;
esac
