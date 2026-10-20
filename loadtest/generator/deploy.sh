#!/usr/bin/env bash
# Build and deploy the load-test generator (MOTIR-9116). Run from anywhere; needs `fly` signed in to
# the `moooon` org. Reads the k6 pins from loadtest/k6/versions.env, so there is one place to bump.
#
#   loadtest/generator/deploy.sh
#
# It deploys ONE machine and leaves it running; stop it afterwards (README §3.15).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../k6/versions.env
source "$here/../k6/versions.env"

cd "$here"
fly deploy --config fly.loadgen.toml --ha=false --yes \
  --build-arg "XK6_IMAGE_TAG=${XK6_IMAGE_TAG}" \
  --build-arg "K6_VERSION=${K6_VERSION}" \
  --build-arg "XK6_SSE_MODULE=${XK6_SSE_MODULE}" \
  --build-arg "XK6_SSE_VERSION=${XK6_SSE_VERSION}"
