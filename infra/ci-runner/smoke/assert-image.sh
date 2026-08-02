#!/usr/bin/env bash
#
# Mechanical assertions for the Motir CI runner image (MOTIR-1978).
#
# The card's acceptance criteria say "assert by grep, not by eye" and "asserted
# mechanically" — this is that assertion, run by `runner-image.yml` on every pull
# request AND on the release lane before anything is pushed.
#
#   ./assert-image.sh --sources                 static checks, no Docker needed
#   ./assert-image.sh --image motir-ci-runner:x  the above plus runtime checks
#
# ── On scope, so the comment-stripping is not read as a loophole ─────────────
#
# The §7.4 criterion is that `config.sh` and `registration` appear nowhere in THE
# IMAGE or ITS ENTRYPOINT. Two different objects, checked two different ways:
#
#   - THE IMAGE — checked on the built filesystem (`--image`): no `config.*`
#     anywhere under the runner directory. That is the real guarantee and it is
#     checked against bytes, not against source.
#   - THE ENTRYPOINT — checked on its EXECUTABLE lines, comments stripped. The
#     Dockerfile has to name `config.sh` in order to `rm` it, and both files have
#     to explain WHY the registration path is absent; a check that failed on the
#     explanation would force the code to stop documenting its own security
#     property. So comments are excluded and the exclusion is asserted narrowly:
#     the only `config.sh` permitted in a non-comment Dockerfile line is on an
#     `rm` line, and `registration` is permitted nowhere at all.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "${HERE}")"
DOCKERFILE="${ROOT}/Dockerfile"
ENTRYPOINT="${ROOT}/entrypoint.sh"

IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sources) shift ;;
    --image) IMAGE="${2:?--image needs a reference}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fails=0
ok()   { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; fails=$((fails + 1)); }

# Non-comment, non-blank lines of a shell/Dockerfile source.
code_of() { sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$1"; }

echo "== static assertions =="

# ── §7.2: nothing floats ─────────────────────────────────────────────────────
# The digest may be inline or reach FROM through an ARG (it does — so the value
# is bumpable in one place and overridable at build time). Either is digest
# form; what is forbidden is the TAG form, `FROM image:something`. The ARG's own
# value is checked to be 64 hex by the pin loop below, so the indirection loses
# nothing.
from_line=$(grep -E '^FROM[[:space:]]' "${DOCKERFILE}" | head -1)
if [[ "${from_line}" =~ @(sha256:[0-9a-f]{64}|\$\{[A-Z0-9_]+\})[[:space:]]*$ ]]; then
  ok "FROM is digest-pinned (${from_line})"
else
  fail "FROM is not digest-pinned (§7.2 requires a sha256 digest, not a tag): ${from_line}"
fi

if code_of "${DOCKERFILE}" | grep -nE ':latest|:stable|:edge|:main'; then
  fail "a floating tag appears in the Dockerfile"
else
  ok "no floating tag (:latest / :stable / :edge / :main) in the Dockerfile"
fi

# Every pin is a real pin: each *_SHA256 is 64 hex, each *_VERSION is numeric.
# ⚠️ `[A-Z0-9_]+`, WITH the digits — `RUNNER_SHA256` has one, and a name pattern
# without it silently skips every checksum ARG while still reporting green.
pins=0
while IFS= read -r line; do
  pins=$((pins + 1))
  name="${line%%=*}"; value="${line#*=}"
  case "${name}" in
    *_SHA256|UBUNTU_DIGEST)
      if [[ "${value}" =~ ^(sha256:)?[0-9a-f]{64}$ ]]; then ok "${name} is a 64-hex digest"
      else fail "${name}='${value}' is not a 64-hex digest"; fi ;;
    *_VERSION)
      if [[ "${value}" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then ok "${name}=${value} is an exact version"
      else fail "${name}='${value}' is not an exact version"; fi ;;
  esac
done < <(grep -oE '^ARG[[:space:]]+[A-Z0-9_]+=[^[:space:]]+' "${DOCKERFILE}" | sed -E 's/^ARG[[:space:]]+//')

# The count guard: without it every assertion above passes vacuously the moment
# the pattern stops matching, which is exactly how the digit bug hid.
if [ "${pins}" -ge 8 ]; then
  ok "found all ${pins} pinned ARGs"
else
  fail "only ${pins} pinned ARG(s) parsed — the pin checks above are passing vacuously"
fi

# Every download in the file is checksum-verified. A `curl` with no matching
# `sha256sum -c` in the same RUN is an unpinned artifact wearing a pinned file's
# clothes, which is exactly what §7.2 is about.
curls=$(code_of "${DOCKERFILE}" | grep -c 'curl -fsSLo' || true)
sums=$(code_of "${DOCKERFILE}" | grep -c 'sha256sum -c -' || true)
if [ "${curls}" -eq "${sums}" ] && [ "${curls}" -gt 0 ]; then
  ok "all ${curls} downloads are checksum-verified"
else
  fail "${curls} download(s) but ${sums} checksum check(s) — every download must be verified"
fi

# ── §7.4: no registration capability ─────────────────────────────────────────
# Two permitted shapes: the `rm` that deletes it, and the build-time `test ! -e`
# that fails the BUILD if the rm ever stops applying. Anything else is a use.
if code_of "${DOCKERFILE}" | grep 'config\.sh' | grep -qvE 'rm -f|test ! -e'; then
  fail "the Dockerfile USES config.sh rather than only removing it (§7.4)"
else
  ok "the Dockerfile only removes config.sh, never uses it"
fi

for f in "${DOCKERFILE}" "${ENTRYPOINT}"; do
  if code_of "${f}" | grep -qi 'registration'; then
    fail "$(basename "${f}") contains 'registration' in executable code (§7.4)"
  else
    ok "$(basename "${f}") has no 'registration' in executable code"
  fi
done

if code_of "${ENTRYPOINT}" | grep -q 'config\.sh'; then
  fail "the entrypoint references config.sh (§7.4)"
else
  ok "the entrypoint never references config.sh"
fi

if code_of "${ENTRYPOINT}" | grep -q 'ACTIONS_RUNNER_INPUT_JITCONFIG'; then
  ok "the entrypoint consumes ACTIONS_RUNNER_INPUT_JITCONFIG"
else
  fail "the entrypoint does not read ACTIONS_RUNNER_INPUT_JITCONFIG (the boot contract)"
fi

# The exec spans continuation lines, so the check is on the joined command, not
# on any single line. `exec` (not a background process) is the load-bearing part:
# run.sh exiting must BE the container exiting (§7.1).
entry_joined=$(code_of "${ENTRYPOINT}" | tr '\n' ' ' | sed 's/\\ / /g')
if grep -qE 'exec setpriv .*run\.sh --jitconfig' <<<"${entry_joined}"; then
  ok "the entrypoint execs run.sh --jitconfig as the unprivileged runner user"
else
  fail "the entrypoint does not exec run.sh --jitconfig"
fi

if code_of "${DOCKERFILE}" | grep -q 'RUNNER_ALLOW_RUNASROOT'; then
  fail "RUNNER_ALLOW_RUNASROOT is set — the runner must drop to the unprivileged 'runner' user"
else
  ok "RUNNER_ALLOW_RUNASROOT is never set"
fi

if [ -z "${IMAGE}" ]; then
  echo
  [ "${fails}" -eq 0 ] && { echo "static assertions passed"; exit 0; }
  echo "${fails} assertion(s) failed" >&2; exit 1
fi

echo
echo "== runtime assertions against ${IMAGE} =="

# `--entrypoint ''` because the image's entrypoint boots a runner; these checks
# interrogate the filesystem it boots FROM.
inspect() { docker run --rm --entrypoint '' "${IMAGE}" bash -lc "$1"; }

# §7.4, on the built filesystem rather than on source.
if inspect 'ls /home/runner/actions-runner/config.sh /home/runner/actions-runner/config.cmd' >/dev/null 2>&1; then
  fail "config.sh / config.cmd EXIST in the image (§7.4)"
else
  ok "no config.sh / config.cmd in the image"
fi

if inspect 'find / -xdev -name "config.sh" -o -xdev -name "config.cmd" 2>/dev/null | head -1' | grep -q .; then
  fail "a config.sh / config.cmd exists somewhere in the image (§7.4)"
else
  ok "no config.sh / config.cmd anywhere on the image filesystem"
fi

if inspect 'test -x /home/runner/actions-runner/run.sh'; then
  ok "run.sh is present and executable"
else
  fail "run.sh is missing — the JIT path has nothing to exec"
fi

# The derived toolchain, checked as present rather than assumed.
for bin in node npm npx corepack git jq curl unzip zip tar docker dockerd containerd runc setpriv sudo; do
  if inspect "command -v ${bin} >/dev/null"; then ok "${bin} on PATH"
  else fail "${bin} is missing from the image"; fi
done

if inspect 'node --version | grep -q "^v22\."'; then
  ok "node is v22 (setup-node's requested major)"
else
  fail "node is not v22 — every starter job asks for node-version: 22"
fi

# The tool cache is the difference between a setup-node cache hit and a download
# on every job, which is the parity cost this image exists to remove.
if inspect 'v=$(node -p "process.versions.node"); test -d "/opt/hostedtoolcache/node/${v}/x64" && test -f "/opt/hostedtoolcache/node/${v}.complete"'; then
  ok "node is registered in the hostedtoolcache with its .complete marker"
else
  fail "node is not a usable hostedtoolcache entry — setup-node will re-download it every job"
fi

if inspect 'id -u runner >/dev/null && id -nG runner | tr " " "\n" | grep -qx docker'; then
  ok "the runner user exists and is in the docker group"
else
  fail "the runner user is missing or cannot reach the docker socket"
fi

if inspect 'sudo -n -u runner true 2>/dev/null || grep -q "runner ALL=(ALL) NOPASSWD:ALL" /etc/sudoers.d/runner'; then
  ok "the runner user has passwordless sudo (ubuntu-latest parity)"
else
  fail "the runner user has no passwordless sudo — playwright install --with-deps will fail"
fi

# Fail-fast on a missing credential: the boot contract's one required variable.
if docker run --rm -e MOTIR_RUNNER_SKIP_DOCKER=1 "${IMAGE}" 2>&1 | grep -q 'ACTIONS_RUNNER_INPUT_JITCONFIG'; then
  ok "boot without a JIT config fails fast and names the missing variable"
else
  fail "boot without ACTIONS_RUNNER_INPUT_JITCONFIG did not fail with a named error"
fi

echo
[ "${fails}" -eq 0 ] && { echo "all assertions passed"; exit 0; }
echo "${fails} assertion(s) failed" >&2
exit 1
