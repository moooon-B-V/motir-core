#!/usr/bin/env bash
#
# THE PERSISTENT-HOME SEED (MOTIR-6887).
#
# Runs INSIDE a sandbox container started with a host directory mounted at
# /home/node — the shape a user agent instance boots in, with its Fly volume
# over the image's HOME (`docs/decisions/agent-instances.md` §1). The entrypoint
# has already run by the time this does, so what it asserts is what the
# entrypoint left behind.
#
# WHY THIS IS ITS OWN CONTAINER RUN. Whether HOME is a mount is a property of
# how the container was LAUNCHED, like the credential tiers: it cannot be
# simulated from inside a container whose home is the image's own. So the
# driver starts two more containers with a mount, and this script asserts the
# mount FIRST — otherwise the image's own home would satisfy every check below.
#
# Usage:  home-seed-smoke.sh empty
#         home-seed-smoke.sh populated <expected sha256 of .bashrc> <expected sha256 of user file>
set -euo pipefail

say() { echo "== $*" >&2; }
fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }

MODE="${1:?usage: home-seed-smoke.sh empty|populated …}"
SEED=/opt/motir-home-seed

say "home-seed smoke — $MODE home mounted at $HOME"

# ── the precondition that makes the leg mean anything ───────────────────────
grep -q " $HOME " /proc/self/mounts ||
    fail "$HOME is not a mount — the container was started without a home volume, so the seed is not what would be under test"
[ -d "$SEED" ] || fail "the image carries no seed at $SEED"

# ── every leg: the seed is complete, owned by node, and not writable by others ─
while IFS= read -r -d '' src; do
    rel="${src#"$SEED"/}"
    [ -e "$HOME/$rel" ] || [ -L "$HOME/$rel" ] || fail "the seed entry $rel is missing from the home"
done < <(find "$SEED" -mindepth 1 -print0)
[ "$(stat -c %U "$SEED")" = node ] || fail "the seed is not owned by node"
if find "$SEED" -perm /022 ! -type l | grep -q .; then
    fail 'part of the seed is writable by group or others'
fi

case "$MODE" in
    empty)
        # The two things an EMPTY volume used to hide, by name.
        grep -q 'motir-sandbox-agent-config.sh' "$HOME/.bashrc" ||
            fail '.bashrc lacks the agent-config hook'
        [ -r "$HOME/.motir-sandbox/agent-config/env.sh" ] ||
            fail 'the agent config env.sh the entrypoint sources is missing'
        for path in .bashrc .motir-sandbox/agent-config/env.sh; do
            [ "$(stat -c %U "$HOME/$path")" = node ] || fail "$path is not owned by node"
        done
        ;;
    populated)
        want_rc="${2:?expected .bashrc sha256}"
        want_user="${3:?expected user-file sha256}"
        [ "$(sha256sum < "$HOME/.bashrc" | cut -d' ' -f1)" = "$want_rc" ] ||
            fail 'the seed OVERWROTE the modified .bashrc'
        [ "$(sha256sum < "$HOME/user-notes.txt" | cut -d' ' -f1)" = "$want_user" ] ||
            fail 'the seed changed the user file'
        ;;
    *) fail "unknown mode $MODE" ;;
esac

say 'home-seed smoke PASSED'
