#!/usr/bin/env bash
#
# The Motir CI runner ENTRYPOINT (MOTIR-1978).
#
# Runs as PID 1, as root, for exactly one job:
#
#   1. start dockerd, because `services:` containers are Docker containers the
#      runner starts on the runner host (Dockerfile header, Docker row);
#   2. drop to the unprivileged `runner` user and exec `run.sh --jitconfig`.
#
# When `run.sh` exits — which a JIT-config runner does after ONE job — this
# script exits, the container exits, and Fly's `auto_destroy: true` +
# `restart: { policy: 'no' }` destroy the Machine (§7.1). Nothing here restarts,
# retries, or keeps the container resident: an exiting process IS the teardown.
#
# ⚠️ §7.4 — JIT CONFIG ONLY. There is no path in this script that takes a
# registration token, and `config.sh` does not exist in the image (the Dockerfile
# deletes it). The credential this reads names one runner in one runner group and
# is spent by the runner it boots.
#
# The env contract is `lib/services/ciRunnerBootService.ts` → `buildSpec()`,
# which is what the orchestrator puts on the Machine:
#
#   ACTIONS_RUNNER_INPUT_JITCONFIG  (required) the base64 JIT config
#   ACTIONS_RUNNER_CONFIG_ARGS      `--no-default-labels` — see the note below
#   MOTIR_RUNNER_LABEL              the single §M-compliant fleet label
#   MOTIR_INTENT_ID                 attribution, echoed into the log
#   MOTIR_WORKFLOW_JOB_ID           attribution, echoed into the log

set -euo pipefail

log() { printf '[motir-ci-runner] %s\n' "$*"; }
die() { printf '[motir-ci-runner] FATAL: %s\n' "$*" >&2; exit 1; }

log "intent=${MOTIR_INTENT_ID:-<unset>} workflow_job=${MOTIR_WORKFLOW_JOB_ID:-<unset>} label=${MOTIR_RUNNER_LABEL:-<unset>}"

# ── The credential ───────────────────────────────────────────────────────────
# Checked FIRST. A Machine booted without it would otherwise start dockerd, wait
# out its timeout, and only then fail — turning a one-line configuration mistake
# into a slow, expensive boot failure that reads like an infrastructure problem.
: "${ACTIONS_RUNNER_INPUT_JITCONFIG:?ACTIONS_RUNNER_INPUT_JITCONFIG is required — the orchestrator mints it per boot (lib/services/ciRunnerBootService.ts buildSpec)}"
JITCONFIG="${ACTIONS_RUNNER_INPUT_JITCONFIG}"

# ⚠️ `ACTIONS_RUNNER_CONFIG_ARGS=--no-default-labels` is set by `buildSpec()` and
# is deliberately NOT forwarded here: it is a `config.sh` flag, and this image has
# no `config.sh`. That is not a dropped requirement — a JIT config's `labels`
# array IS the runner's complete label set and GitHub adds no defaults to a JIT
# runner, so the guarantee holds at mint time. `buildSpec()` says as much: the
# flag is "the second, independent statement of the same requirement", the one
# that would matter only if the image ever fell back to a registration path. It
# cannot; this file and the deleted `config.sh` are why.
if [ -n "${ACTIONS_RUNNER_CONFIG_ARGS:-}" ]; then
  # ⚠️ The message deliberately does not name the script it would have been
  # passed to: `assert-image.sh` greps the entrypoint's EXECUTABLE lines for it,
  # and a log string is an executable line. Naming it belongs in the comment
  # above, which the check excludes.
  log "ACTIONS_RUNNER_CONFIG_ARGS=${ACTIONS_RUNNER_CONFIG_ARGS} — not forwarded; the JIT config's labels are authoritative"
fi

# ── dockerd ──────────────────────────────────────────────────────────────────
# FATAL if it does not come up. An image that silently cannot start service
# containers fails every `services:` job with an obscure connection error inside
# the customer's build, minutes in and on their metered clock. Failing the BOOT
# instead surfaces it once, on Motir's side, as a boot failure the intent record
# names.
#
# MOTIR_RUNNER_SKIP_DOCKER=1 exists for the image's own CI assertions, which run
# the container without the privileges dockerd needs. It is not a production
# setting and the orchestrator never sets it.
if [ "${MOTIR_RUNNER_SKIP_DOCKER:-0}" = "1" ]; then
  log "MOTIR_RUNNER_SKIP_DOCKER=1 — not starting dockerd (image self-test only; \`services:\` jobs WILL fail)"
else
  log "starting dockerd"
  dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &
  DOCKERD_PID=$!

  started_at="${SECONDS}"
  deadline=$((started_at + 30))
  until docker version >/dev/null 2>&1; do
    if ! kill -0 "${DOCKERD_PID}" 2>/dev/null; then
      log "--- dockerd.log ---"; cat /var/log/dockerd.log >&2 || true
      die "dockerd exited during startup"
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      log "--- dockerd.log ---"; cat /var/log/dockerd.log >&2 || true
      die "dockerd did not become ready within 30s"
    fi
    sleep 1
  done
  # The storage driver, logged because `docker version` answering is NOT the
  # same claim as "this daemon can create a container". A daemon whose data dir
  # cannot support its snapshotter answers happily and then fails the first
  # `services:` container with an opaque mount error, mid-job, on the tenant's
  # metered clock. One cheap line here is the difference between diagnosing that
  # from the boot log and diagnosing it from a customer's failed build.
  log "dockerd ready after $((SECONDS - started_at))s (storage driver: $(docker info --format '{{.Driver}}' 2>/dev/null || echo unknown))"
fi

# ── The runner ───────────────────────────────────────────────────────────────
# `env -u ACTIONS_RUNNER_INPUT_JITCONFIG` strips the credential from the
# environment the runner — and therefore every job STEP the runner spawns —
# inherits. The JIT config is spent by the time a step runs, but a spent
# credential still in `env` is a credential in every `printenv` in the customer's
# workflow, and there is no reason for it to be there.
#
# `exec` and `setpriv`, not a background process: the runner must be what PID 1
# waits on, so its exit is the container's exit (§7.1). `setpriv` over `su`/`sudo`
# because it neither forks nor leaves a supervising parent between PID 1 and the
# runner — a signal Fly sends the container reaches the runner directly.
log "exec run.sh (JIT config, one job, then de-register and exit)"
exec setpriv --reuid=runner --regid=runner --init-groups \
  env -u ACTIONS_RUNNER_INPUT_JITCONFIG \
  /home/runner/actions-runner/run.sh --jitconfig "${JITCONFIG}"
