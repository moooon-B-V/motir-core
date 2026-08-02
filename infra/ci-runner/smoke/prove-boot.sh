#!/usr/bin/env bash
#
# Boot proof for the Motir CI runner image (MOTIR-1978, acceptance criterion 5).
#
#   ./prove-boot.sh --image motir-ci-runner:smoke
#
# ── The fidelity ladder, and where it honestly stops ─────────────────────────
#
# The criterion asks for "the runner registers, takes exactly one job,
# de-registers and exits, proven at the highest fidelity reachable in CI". The
# highest fidelity reachable in CI is NOT the full loop, and the reason is not
# effort: registering requires a JIT config minted against a real runner group by
# an org token with `Self-hosted runners: write`, and BOTH are MOTIR-1919's
# manual deliverables, which have not landed. There is nothing to register
# against yet.
#
# What IS proven here, all of it against the real image:
#
#   1. The ENTRYPOINT's dockerd path works — dockerd starts and becomes ready
#      inside the container, through the same code a Fly Machine will run.
#   2. `run.sh` is actually EXEC'd, as the unprivileged `runner` user, with the
#      JIT config — i.e. the entrypoint → setpriv → run.sh wiring is real and not
#      a missing file or a permission error. Only GitHub's acceptance of the
#      config remains unproven.
#   3. A `services:` container works: `postgres:16-alpine` with a published port,
#      reachable from the runner host on `localhost:5432` — the exact shape of
#      the starters' test / e2e / acceptance jobs, and the single riskiest thing
#      about a fleet runner that is a container rather than a VM image.
#
# What is HANDED TO MOTIR-1928, explicitly rather than implied:
#
#   - Live registration against a real runner group with a real JIT config.
#   - "Takes exactly ONE job, de-registers, exits" observed end to end.
#   - The container being NON-RESIDENT afterwards (Fly `auto_destroy`), which is
#      a Machine-lifecycle property this image cannot demonstrate at all.
#   - Real p50/p95 boot latency against §6, including this image's pull time.

set -euo pipefail

IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?--image needs a reference}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "${IMAGE}" ] || { echo "--image is required" >&2; exit 2; }

fails=0
ok()   { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; fails=$((fails + 1)); }

cleanup() { docker rm -f motir-runner-boot motir-runner-svc >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# ─────────────────────────────────────────────────────────────────────────────
# 1 + 2 — the real entrypoint: dockerd up, then run.sh exec'd with the JIT config
# ─────────────────────────────────────────────────────────────────────────────
# `--privileged` is what a container needs to run dockerd on a GitHub-hosted
# runner. On Fly it is not needed and not used: a Machine is a Firecracker
# microVM whose kernel the image already owns (see the Dockerfile's §7.6 note).
#
# The JIT config is deliberate garbage. It gets far enough to prove the wiring;
# GitHub rejecting it is the expected outcome and is the line where CI stops.
echo "== 1/2 · entrypoint: dockerd, then run.sh as the runner user =="
docker run -d --name motir-runner-boot --privileged \
  -e ACTIONS_RUNNER_INPUT_JITCONFIG="$(printf 'motir-ci-not-a-real-jit-config' | base64 -w0)" \
  -e MOTIR_INTENT_ID=smoke-intent \
  -e MOTIR_WORKFLOW_JOB_ID=0 \
  -e MOTIR_RUNNER_LABEL=motir-smoke \
  -e ACTIONS_RUNNER_CONFIG_ARGS=--no-default-labels \
  "${IMAGE}" >/dev/null

# The container is short-lived by design — it execs run.sh, which fails on the
# garbage config and exits. Wait for it either way rather than racing its logs.
timeout 120 docker wait motir-runner-boot >/dev/null 2>&1 || true
boot_log="$(docker logs motir-runner-boot 2>&1 || true)"
printf '%s\n' "${boot_log}" | sed 's/^/    | /'

grep -q 'starting dockerd'                   <<<"${boot_log}" && ok "dockerd was started by the entrypoint" || fail "the entrypoint never started dockerd"
grep -q 'dockerd ready'                      <<<"${boot_log}" && ok "dockerd became ready inside the container" || fail "dockerd never became ready"
grep -q 'exec run.sh'                        <<<"${boot_log}" && ok "the entrypoint reached the run.sh exec" || fail "the entrypoint never reached run.sh"
grep -q 'No such file or directory'           <<<"${boot_log}" && fail "run.sh could not be executed (missing file)" || ok "run.sh was found and executed"
grep -qi 'permission denied'                  <<<"${boot_log}" && fail "run.sh hit a permission error as the runner user" || ok "no permission error dropping to the runner user"
grep -qi 'must not run with sudo\|as root'    <<<"${boot_log}" && fail "the runner refused the user it was given" || ok "the runner accepted the unprivileged user"

echo "  note  live registration / one-job / de-register is NOT proven here — MOTIR-1928 owns it (see this file's header)"

# ─────────────────────────────────────────────────────────────────────────────
# 3 — a `services:` container, the way the starters' workflows use one
# ─────────────────────────────────────────────────────────────────────────────
# S ci.yml:81-92 + :311 — `postgres:16-alpine`, `ports: - 5432:5432`, and a
# DATABASE_URL pointed at `localhost:5432`. The assertion is the one that
# matters for those jobs: is the published port reachable FROM THE RUNNER HOST.
# bash's /dev/tcp is used rather than a postgres client because adding
# `pg_isready` to the image would be a toolchain entry with no evidence behind
# it (Dockerfile header, "NOT installed").
echo
echo "== 3 · a services: container reachable on localhost:5432 =="
docker run -d --name motir-runner-svc --privileged --entrypoint '' "${IMAGE}" \
  bash -c 'dockerd >/var/log/dockerd.log 2>&1 & sleep infinity' >/dev/null

svc_ok=1
docker exec motir-runner-svc bash -c '
  set -e
  for _ in $(seq 1 30); do docker version >/dev/null 2>&1 && break; sleep 1; done
  docker version >/dev/null
  docker run -d --name pg -p 5432:5432 \
    -e POSTGRES_USER=nextjs_prisma_vercel_starter \
    -e POSTGRES_PASSWORD=nextjs_prisma_vercel_starter \
    -e POSTGRES_DB=nextjs_prisma_vercel_starter \
    postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do
    if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then exit 0; fi
    sleep 1
  done
  echo "postgres:16-alpine never became reachable on localhost:5432" >&2
  docker logs pg 2>&1 | tail -30 >&2
  exit 1
' || svc_ok=0

if [ "${svc_ok}" -eq 1 ]; then
  ok "postgres:16-alpine ran and its published port is reachable on localhost:5432"
else
  fail "a services: container is NOT usable — four of the starter's six jobs cannot run on this image"
fi

echo
[ "${fails}" -eq 0 ] && { echo "boot proof passed"; exit 0; }
echo "${fails} check(s) failed" >&2
exit 1
