#!/usr/bin/env bash
# Build the pinned, SSE-capable k6 binary (Story MOTIR-8538 · MOTIR-8677).
#
# Plain k6 cannot read Server-Sent Events: a held `http.get` blocks until it times
# out and never sees a frame, so it cannot tell a stream that OPENED from one that
# was refused and is waiting. The community extension xk6-sse can, so the reader
# scenario needs a k6 built with it.
#
# The binary is built ONCE (at provisioning, baked into the generator image) and
# never resolved at run time: k6's automatic extension resolution fetches a build
# from Grafana's builder service, which a load run must not depend on. The run
# command sets K6_AUTO_EXTENSION_RESOLUTION=false and checks `k6 version`.
#
#   loadtest/k6/build.sh                      -> loadtest/.out/k6
#   LOADTEST_K6_BINARY=/opt/k6 loadtest/k6/build.sh
#
# Uses the grafana/xk6 image when a Docker daemon answers; otherwise needs `go`
# and `xk6` on PATH (`go install go.k6.io/xk6/cmd/xk6@latest`, or `brew install xk6`).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"

out="${LOADTEST_K6_BINARY:-$here/../.out/k6}"
out_dir="$(dirname "$out")"
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
out_name="$(basename "$out")"
module="${XK6_SSE_MODULE}@${XK6_SSE_VERSION}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "building k6 ${K6_VERSION} with ${module} in grafana/xk6 -> ${out_dir}/${out_name}"
  (cd "$out_dir" && docker run --rm -u "$(id -u):$(id -g)" -v "${PWD}:/xk6" grafana/xk6 \
    build "${K6_VERSION}" --with "${module}" --output "${out_name}")
else
  missing=()
  command -v go >/dev/null 2>&1 || missing+=("go")
  command -v xk6 >/dev/null 2>&1 || missing+=("xk6")
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "loadtest/k6/build.sh: no Docker daemon, and missing on PATH: ${missing[*]}" >&2
    echo "  install Docker, or Go plus xk6 (go install go.k6.io/xk6/cmd/xk6@latest)" >&2
    exit 1
  fi
  echo "building k6 ${K6_VERSION} with ${module} using local xk6 -> ${out_dir}/${out_name}"
  (cd "$out_dir" && xk6 build "${K6_VERSION}" --with "${module}" --output "${out_name}")
fi

version="$("${out_dir}/${out_name}" version)"
echo "$version"
if ! grep -q "xk6-sse" <<<"$version"; then
  echo "loadtest/k6/build.sh: the built binary does not list xk6-sse" >&2
  exit 1
fi
