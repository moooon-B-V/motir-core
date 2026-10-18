#!/usr/bin/env bash
#
# Start dockerd on a runner Machine and PROVE it can unpack an image (MOTIR-8821).
#
# Called by `entrypoint.sh`, and by `smoke/prove-boot.sh`, so the smoke exercises
# the code a Fly Machine runs and not a bare `dockerd` of its own.
#
# ── Why this is not just `dockerd &` ─────────────────────────────────────────
# `docker version` answering says the daemon is up; it does not say the daemon can
# UNPACK A LAYER. On the first production ON window (MOTIR-8709) dockerd with no
# storage options came up, logged a storage driver, and then failed every
# `services:` pull and every buildx step with
#
#   failed to convert whiteout file "etc/alternatives/.wh.pager.1.gz": operation not permitted
#
# A layer that deletes a file is applied as an overlay WHITEOUT — a 0/0 character
# device made with mknod, or an xattr — and the Machine refused it. Which setting
# lifts the refusal depends on what the Machine's filesystem and capability set
# permit, so this script does not guess one: it starts dockerd, loads a two-layer
# image whose second layer deletes a file the first created, creates a container
# from it (which unpacks both and mounts the snapshot), and moves to the next
# candidate when that fails. A boot that cannot find a working candidate FAILS,
# once, on Motir's side, rather than inside a customer's build.
#
# Candidates, in order (the first is exactly what the image did before):
#
#   default    the containerd image store with the overlayfs snapshotter
#   overlay2   the classic graph driver (`containerd-snapshotter=false`)
#   vfs        no overlay at all — whiteouts are applied by deleting, so no mknod
#              and no overlay mount. Slow and disk-hungry; the last resort, chosen
#              only when both overlay forms are refused.
#
# MOTIR_RUNNER_DOCKER_STORAGE=<candidate> forces one candidate and skips the
# others. It is the measurement lever for MOTIR-8821 ("repeat with each candidate
# setting"), not a production setting; the orchestrator never sets it.
#
# ── Container DNS (MOTIR-8899) ───────────────────────────────────────────────
# dockerd copies the Machine's /etc/resolv.conf into every container and every
# build step. A Fly Machine's resolver is Fly's internal one (an fdaa:: IPv6
# address), which dockerd drops for a container on its IPv4-only bridge, so the
# containers `flyctl deploy --local-only` builds in were left with no nameserver
# they could reach: `apt-get` in the Dockerfile died on
# "Temporary failure resolving 'deb.debian.org'" (motir-ai run 39078660841).
# `--dns` hands every container, and so every `RUN` step of the daemon's own
# builder, public resolvers the Machine can reach outbound. The host's own
# resolver is untouched. MOTIR_RUNNER_DOCKER_DNS="<ip> <ip>" overrides the list
# (an empty value keeps dockerd's default); the orchestrator never sets it.
DOCKER_DNS="${MOTIR_RUNNER_DOCKER_DNS-1.1.1.1 8.8.8.8}"

dns_args() {
  local ip out=""
  for ip in ${DOCKER_DNS}; do out="${out} --dns=${ip}"; done
  echo "${out# }"
}

# The outcome is written to /run/motir-ci-runner-docker-storage, which the runner's
# job-started hook prints into the JOB LOG, so a failure of this kind is readable
# from GitHub and not only from the Machine console.

set -euo pipefail

DOCKER_ROOT=/var/lib/docker
SOCK=/var/run/docker.sock
STATE_FILE=/run/motir-ci-runner-docker-storage
READY_TIMEOUT=30
PROBE_TIMEOUT=90

log() { printf '[motir-ci-runner] %s\n' "$*"; }
die() { printf '[motir-ci-runner] FATAL: %s\n' "$*" >&2; exit 1; }

candidate_args() {
  case "$1" in
    default)  echo "" ;;
    overlay2) echo "--feature containerd-snapshotter=false --storage-driver=overlay2" ;;
    vfs)      echo "--feature containerd-snapshotter=false --storage-driver=vfs" ;;
    *)        return 1 ;;
  esac
}

DOCKERD_PID=""

start_dockerd() {
  local name="$1" args
  args="$(candidate_args "${name}")"
  log "starting dockerd (storage candidate: ${name})"
  # shellcheck disable=SC2086 # the candidate's and the dns flags are word-split on purpose
  dockerd --host=unix://${SOCK} $(dns_args) ${args} >/var/log/dockerd.log 2>&1 &
  DOCKERD_PID=$!
  local started_at="${SECONDS}" deadline=$((SECONDS + READY_TIMEOUT))
  until docker version >/dev/null 2>&1; do
    if ! kill -0 "${DOCKERD_PID}" 2>/dev/null; then
      log "--- dockerd.log ---"; cat /var/log/dockerd.log >&2 || true
      return 1
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      log "--- dockerd.log ---"; cat /var/log/dockerd.log >&2 || true
      return 1
    fi
    sleep 1
  done
  log "dockerd ready after $((SECONDS - started_at))s (storage driver: $(docker info --format '{{.Driver}}' 2>/dev/null || echo unknown), candidate: ${name})"
}

stop_dockerd() {
  if [ -n "${DOCKERD_PID}" ] && kill -0 "${DOCKERD_PID}" 2>/dev/null; then
    kill "${DOCKERD_PID}" 2>/dev/null || true
    local deadline=$((SECONDS + 20))
    while kill -0 "${DOCKERD_PID}" 2>/dev/null && [ "${SECONDS}" -lt "${deadline}" ]; do sleep 1; done
    kill -9 "${DOCKERD_PID}" 2>/dev/null || true
  fi
  DOCKERD_PID=""
  rm -f "${SOCK}" /var/run/docker.pid
  # A failed candidate leaves a half-built store the next one would trip over.
  # This Machine runs one job and has nothing worth keeping in here yet.
  find "${DOCKER_ROOT}" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
}

# Two layers: the first creates d/gone, the second deletes it with a whiteout
# marker. Loading and creating a container from the image makes dockerd convert
# that marker, which is the operation the Machine refused.
build_probe_archive() {
  local dir="$1"
  mkdir -p "${dir}/l1/d" "${dir}/l2/d"
  echo base >"${dir}/l1/d/gone"
  : >"${dir}/l2/d/.wh.gone"
  local t=(--sort=name --owner=0 --group=0 --numeric-owner --mtime=@0)
  tar "${t[@]}" -C "${dir}/l1" -cf "${dir}/l1.tar" d
  tar "${t[@]}" -C "${dir}/l2" -cf "${dir}/l2.tar" d
  local d1 d2
  d1="$(sha256sum "${dir}/l1.tar" | cut -d' ' -f1)"
  d2="$(sha256sum "${dir}/l2.tar" | cut -d' ' -f1)"
  cat >"${dir}/config.json" <<JSON
{"architecture":"amd64","os":"linux","config":{"Cmd":["/d/gone"]},"rootfs":{"type":"layers","diff_ids":["sha256:${d1}","sha256:${d2}"]}}
JSON
  cat >"${dir}/manifest.json" <<JSON
[{"Config":"config.json","RepoTags":["motir-whiteout-probe:latest"],"Layers":["l1.tar","l2.tar"]}]
JSON
  tar "${t[@]}" -C "${dir}" -cf "${dir}/probe.tar" manifest.json config.json l1.tar l2.tar
}

probe_unpack() {
  local dir out status=0
  dir="$(mktemp -d)"
  build_probe_archive "${dir}"
  out="$(timeout "${PROBE_TIMEOUT}" bash -c '
    set -e
    docker load -i "$1/probe.tar"
    docker create --name motir-whiteout-probe motir-whiteout-probe:latest
  ' _ "${dir}" 2>&1)" || status=$?
  docker rm -f motir-whiteout-probe >/dev/null 2>&1 || true
  docker rmi -f motir-whiteout-probe:latest >/dev/null 2>&1 || true
  rm -rf "${dir}"
  if [ "${status}" -ne 0 ]; then
    printf '%s\n' "${out}"
    return 1
  fi
}

if [ -n "${MOTIR_RUNNER_DOCKER_STORAGE:-}" ]; then
  candidate_args "${MOTIR_RUNNER_DOCKER_STORAGE}" >/dev/null \
    || die "MOTIR_RUNNER_DOCKER_STORAGE='${MOTIR_RUNNER_DOCKER_STORAGE}' is not one of: default overlay2 vfs"
  candidates=("${MOTIR_RUNNER_DOCKER_STORAGE}")
else
  candidates=(default overlay2 vfs)
fi

failed=""
for name in "${candidates[@]}"; do
  if start_dockerd "${name}"; then
    if probe_out="$(probe_unpack)"; then
      driver="$(docker info --format '{{.Driver}}' 2>/dev/null || echo unknown)"
      summary="dockerd storage: candidate=${name} driver=${driver} (layer whiteout unpack verified); container dns: ${DOCKER_DNS:-<dockerd default>}"
      [ -z "${failed}" ] || summary="${summary}; refused earlier: ${failed# }"
      log "${summary}"
      printf '%s\n' "${summary}" >"${STATE_FILE}"
      chmod 0644 "${STATE_FILE}"
      exit 0
    fi
    log "storage candidate '${name}' cannot unpack a layer that deletes a file:"
    printf '%s\n' "${probe_out}" | sed 's/^/    | /' >&2
    log "--- dockerd.log (tail) ---"; tail -n 20 /var/log/dockerd.log >&2 || true
  fi
  failed="${failed} ${name}"
  stop_dockerd
done

die "no dockerd storage candidate could unpack a layer (tried:${failed}) — every services: and buildx step would fail"
