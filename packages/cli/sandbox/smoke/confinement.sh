#!/usr/bin/env bash
#
# The FILESYSTEM-CONFINEMENT ASSERTIONS (Subtask 7.9.7c / MOTIR-885).
#
# Run INSIDE the sandbox container, with the documented mounts, this asserts the
# blast radius the image's header promises — that an unattended `motir auto` can
# reach the workspace you gave it and essentially nothing else.
#
# ── BE PRECISE ABOUT WHAT "CONFINED" MEANS HERE ─────────────────────────────
# Two different claims get muddled, and only one of them is about the container's
# own filesystem:
#
#   (a) The HOST blast radius — the real claim. The ONLY host surfaces inside are
#       the writable /workspace bind and the READ-ONLY credential binds. Nothing
#       an agent writes anywhere else can reach the host: it lands in the
#       container's ephemeral upper layer and dies with `docker run --rm`. This
#       is asserted from the MOUNT TABLE, which is the ground truth.
#   (b) The IN-CONTAINER filesystem. The image runs as the unprivileged `node`
#       user, so /usr, /etc, /opt and / are NOT writable — asserted below. But
#       $HOME and /tmp deliberately ARE: every coding agent writes caches, logs
#       and sessions there, and an image that forbade it would run no agent at
#       all. Those writes are confined by (a), not by permissions.
#
# So "writes outside /workspace fail" is asserted here in its true form: the
# credential mount is read-only, the system tree is not writable by the user the
# agent runs as, and NO other host path is mounted at all. Claiming more than
# that — e.g. that a read-only rootfs is in play — would be a lie the tests would
# have to be written around.
#
# Also asserted: no docker socket. A container that can drive the host daemon is
# not confined by anything; it can start a privileged sibling in one command.
set -uo pipefail

CONFIG_DIR="${MOTIR_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}/motir"

failures=0
pass() { echo "  ok   — $*"; }
fail() {
    echo "  FAIL — $*"
    failures=$((failures + 1))
}

# Assert a path is NOT writable by the current user. Uses a real write, because
# `test -w` reports the permission bits and misses a read-only FILESYSTEM.
refute_write() {
    local path="$1" label="$2" probe
    probe="$path/.motir-confinement-probe"
    if (echo probe > "$probe") 2>/dev/null; then
        rm -f "$probe" 2>/dev/null
        fail "$label: a write to $path SUCCEEDED — the blast radius is wider than documented"
    else
        pass "$label: $path is not writable"
    fi
}

echo "== confinement — running as uid $(id -u) ($(id -un)), pwd $PWD"

# ── the user ────────────────────────────────────────────────────────────────

if [ "$(id -u)" -eq 0 ]; then
    fail 'the container runs as ROOT — the image must drop to the unprivileged node user'
else
    pass "runs unprivileged (uid $(id -u))"
fi

# ── the one writable host surface ───────────────────────────────────────────

if (echo probe > /workspace/.motir-confinement-probe) 2>/dev/null; then
    rm -f /workspace/.motir-confinement-probe
    pass '/workspace is writable — the run has somewhere to work'
else
    fail '/workspace is NOT writable; nothing a dispatched item does can succeed'
fi

# ── the read-only credential mount ──────────────────────────────────────────

if [ -f "$CONFIG_DIR/config.json" ]; then
    pass "the Motir credential is mounted at $CONFIG_DIR"
else
    fail "no credential at $CONFIG_DIR/config.json — the mount recipe was not followed"
fi
refute_write "$CONFIG_DIR" 'credential mount'

# ── the system tree ─────────────────────────────────────────────────────────
# Not writable because the agent runs as an unprivileged user — the reason an
# installer that dropped a binary in /root would have been invisible (7.9.7b).

for dir in / /etc /usr/local/bin /usr/local/lib /opt /var; do
    refute_write "$dir" 'system tree'
done

# ── no docker socket, no docker client ──────────────────────────────────────

for socket in /var/run/docker.sock /run/docker.sock; do
    if [ -S "$socket" ]; then
        fail "a docker socket is present at $socket — the container can drive the host daemon"
    else
        pass "no docker socket at $socket"
    fi
done

if command -v docker >/dev/null 2>&1; then
    fail 'a `docker` client is on PATH — the image must not ship one'
else
    pass 'no docker client on PATH'
fi

# ── the mount table is the ground truth ─────────────────────────────────────
# Every remaining entry after the container runtime's own pseudo-filesystems and
# per-container files must be one of the documented binds. A second writable host
# bind added later shows up HERE, whatever the docs say.

echo '== host binds visible in /proc/self/mounts:'
mounts="$(
    awk '
      $3 ~ /^(proc|sysfs|tmpfs|devpts|mqueue|cgroup|cgroup2|overlay|devtmpfs|securityfs|nsfs|fuse.*|ramfs|bpf|tracefs|debugfs|pstore|configfs|autofs|binfmt_misc)$/ { next }
      $2 ~ /^\/(proc|sys|dev)(\/|$)/ { next }
      # Per-container files docker always injects; not host directories.
      $2 == "/etc/resolv.conf" || $2 == "/etc/hostname" || $2 == "/etc/hosts" { next }
      { print $2, $4 }
    ' /proc/self/mounts
)"
echo "$mounts" | sed 's/^/     /'

while read -r target options; do
    [ -z "$target" ] && continue
    case "$target" in
        /workspace)
            pass "/workspace is a host bind ($options)"
            ;;
        "$CONFIG_DIR" | "$HOME"/*)
            # A credential bind. It MUST be read-only: the container consumes
            # credentials, it never mints or rotates one.
            case ",$options," in
                *,ro,*) pass "credential bind $target is read-only" ;;
                *) fail "credential bind $target is READ-WRITE ($options) — mount it :ro" ;;
            esac
            ;;
        *)
            fail "undocumented host bind at $target ($options) — the blast radius grew"
            ;;
    esac
done <<< "$mounts"

# ── verdict ─────────────────────────────────────────────────────────────────

if [ "$failures" -gt 0 ]; then
    echo "CONFINEMENT FAILED — $failures assertion(s) did not hold." >&2
    exit 1
fi
echo '== confinement PASSED'
