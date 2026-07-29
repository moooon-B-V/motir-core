#!/usr/bin/env bash
#
# A CODING AGENT THAT FAILS ON ONE ITEM (Subtask MOTIR-1836).
#
# The loop's happy path is covered by fake-agent.sh. This wrapper covers the
# other half of the contract — "believe its exit code" when that code is
# NON-zero — by integrating every item normally EXCEPT the one named in
# $MOTIR_SMOKE_FAIL_ITEM, which it refuses.
#
# That asymmetry is the whole point: the run must have REAL integrated work
# behind it when the failure lands, because the defect this exercises
# (MOTIR-1836) did not lose the failed item — it lost everything that had
# already succeeded, by throwing on the way to the close-out.
#
# It reads the item from $MOTIR_PROMPT_FILE rather than stdin, and hands off
# with `exec`, so the delegate still receives the prompt on BOTH channels
# untouched — fake-agent.sh checks that they agree, and a wrapper that ate
# stdin would break that assertion instead of the thing under test.
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${MOTIR_PROMPT_FILE:-}" ] || [ ! -f "$MOTIR_PROMPT_FILE" ]; then
    echo "failing-agent: MOTIR_PROMPT_FILE is not set or missing." >&2
    exit 1
fi

item="$(sed -n 's/^MOTIR_SMOKE_ITEM=//p' "$MOTIR_PROMPT_FILE" | head -1)"

if [ -n "${MOTIR_SMOKE_FAIL_ITEM:-}" ] && [ "$item" = "$MOTIR_SMOKE_FAIL_ITEM" ]; then
    echo "failing-agent: $item — refusing, as scripted (exit 1)." >&2
    exit 1
fi

exec "$SMOKE_DIR/fake-agent.sh"
