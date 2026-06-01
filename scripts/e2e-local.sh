#!/usr/bin/env bash
# Run the Playwright E2E suite on a no-root dev container.
#
# Ensures Chromium's system libraries are present (via e2e-browser-deps.sh,
# idempotent), loads the resulting LD_LIBRARY_PATH, then runs the same
# `pnpm test:e2e` CI uses. Any extra args are forwarded to Playwright, e.g.:
#     pnpm test:e2e:local shell.spec.ts
#     pnpm test:e2e:local --ui
#
# On a machine that already has the libs system-wide (or root), this is just a
# thin pass-through to `pnpm test:e2e`.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${PRODECT_E2E_DEPS_DIR:-$HOME/.cache/prodect-e2e-deps}/env.sh"

scripts/e2e-browser-deps.sh
# shellcheck source=/dev/null
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

exec pnpm test:e2e "$@"
