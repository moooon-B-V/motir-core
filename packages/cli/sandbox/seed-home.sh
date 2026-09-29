#!/usr/bin/env bash
#
# SEED A PERSISTENT HOME FROM THE IMAGE'S OWN (MOTIR-6887).
#
# A user agent instance mounts a Fly volume over `/home/node`, the image's HOME
# (`docs/decisions/agent-instances.md` §1). The image WRITES into that directory
# at build time — the agent config home `$HOME/.motir-sandbox/agent-config`, the
# `.bashrc` hook that sources the agent-config profile, `$HOME/.config/motir` —
# and an empty volume mounted over it hides every byte. So the Dockerfile keeps a
# copy of the build-time home at `/opt/motir-home-seed`, and this script, run by
# the entrypoint before anything reads `$HOME`, adds back whatever is MISSING.
#
# ⚠️ IT NEVER OVERWRITES AND IT NEVER TOUCHES WHAT EXISTS. Both halves matter:
#
#   - A file already in the home is the user's, whatever its contents: a
#     `.bashrc` they edited, a sign-in the agent wrote. It is left byte-for-byte.
#     So a first boot gets the whole seed, and a later image adds its NEW
#     dotfiles without rewriting the user's old ones.
#   - A DIRECTORY that already exists is not re-chmodded or re-timestamped. That
#     is why this walks the seed entry by entry rather than calling
#     `cp -a --no-clobber` on the whole tree: a recursive copy still applies the
#     seed's attributes to every directory it descends into, and one of those is
#     `$HOME/.config/motir`, which the documented recipe mounts READ-ONLY — the
#     attribute write fails with EROFS and takes the boot down with it.
#
# With no volume — an ordinary `docker run` — the home IS the seed's source, so
# every entry exists and this is a no-op.
#
# Usage: seed-home.sh [<seed dir> [<home dir>]]   (defaults: the image's paths)
# Exit 0 on every path that leaves the home usable. A failure to copy ONE entry
# is reported on stderr and the rest continue: a half-seeded home still boots,
# and a boot that dies here leaves the user with no shell to repair it from.
set -uo pipefail

SEED="${1:-${MOTIR_HOME_SEED:-/opt/motir-home-seed}}"
TARGET="${2:-$HOME}"

# No seed is a normal state for an image built before this script existed, or
# for a test harness that runs the entrypoint elsewhere. Nothing to do.
[ -d "$SEED" ] || exit 0
[ -d "$TARGET" ] || exit 0

status=0
# `find -mindepth 1` yields parents before children, so a missing directory is
# created (with the seed's mode) before any entry inside it is copied. `-print0`
# keeps a filename with a space or a newline one entry.
while IFS= read -r -d '' src; do
    rel="${src#"$SEED"/}"
    dest="$TARGET/$rel"
    # `-e` follows symlinks, so test `-L` too: a dangling symlink the user left
    # is still the user's.
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        continue
    fi
    if [ -d "$src" ] && [ ! -L "$src" ]; then
        # The directory ALONE — its contents arrive as their own entries, each
        # checked for existence first.
        mkdir -p "$dest" && chmod --reference="$src" "$dest" 2>/dev/null
    else
        cp -a "$src" "$dest"
    fi || {
        echo "motir-sandbox: could not seed $dest from the image's home." >&2
        status=1
    }
done < <(find "$SEED" -mindepth 1 -print0)

if [ "$status" -ne 0 ]; then
    echo "motir-sandbox: the home was seeded partially; the entries above are missing." >&2
fi
exit 0
