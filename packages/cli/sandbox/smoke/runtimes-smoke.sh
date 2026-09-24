#!/usr/bin/env bash
#
# THE THREE RUNTIMES, ASSERTED AS THE UNPRIVILEGED USER (MOTIR-6204).
#
# Run INSIDE the sandbox container: Python, the debugging Postgres and the
# browser are present, and present FOR THE USER THE AGENT ACTUALLY IS.
#
# ── WHY `node` AND NOT root IS THE WHOLE POINT ──────────────────────────────
# The build layers run as ROOT, and each already smoke-tests its own install
# there (`python3 --version`, the initdb probe, `playwright install`). Every one
# of those can pass on a runtime the container's own user cannot reach — a
# binary in a root-only directory, a cluster owned by the wrong uid, a browser
# under /root. That is not hypothetical: it is precisely the defect MOTIR-6183
# was filed for one layer over, where every agent was installed where `node`
# could not write. So this suite runs where the agent stands.
#
# ── WHY THE POSTGRES CHECK IS NOT `--version` ───────────────────────────────
# A version string proves a package is installed. What a debugging database has
# to be is USABLE and HONEST, and there are exactly three ways it can be neither
# while answering `--version` perfectly:
#
#   it does not start                  → nothing to debug against;
#   `CREATE EXTENSION vector` fails    → motir-core's and motir-ai's migrations
#                                        fail, so NO database test runs at all;
#   it collates by dictionary          → `'Zz' < 'a0'` goes false, and the
#                                        fractional-index ordering tests invent
#                                        eleven failures that are about the
#                                        cluster rather than about the code.
#
# The last one is the reason this file exists rather than a one-line `which`
# check: a database that LIES is worse than one that is absent, because the
# agent believes it.
set -uo pipefail

failures=0
pass() { echo "  ok   — $*"; }
fail() {
    echo "  FAIL — $*"
    failures=$((failures + 1))
}

echo "== the three runtimes, as $(id -un) (uid $(id -u))"

# ── Python ──────────────────────────────────────────────────────────────────
# The consumer is motir-meta's corpus guards and the two sweep doors, which are
# stdlib-only scripts — so the interpreter is the whole requirement, and `-m
# json.tool` is a cheap proof the stdlib came with it rather than just the
# binary.
if python_version="$(python3 --version 2>&1)"; then
    pass "python3 runs — $python_version"
    if echo '{"motir":1}' | python3 -m json.tool >/dev/null 2>&1; then
        pass 'python3 carries its standard library (json.tool)'
    else
        fail 'python3 cannot run `-m json.tool` — the stdlib is incomplete'
    fi
else
    fail "python3 is not runnable as $(id -un): $python_version"
fi

# ── Postgres — the DEBUGGING contract, not a version string ─────────────────
if command -v motir-sandbox-postgres >/dev/null 2>&1; then
    pass 'motir-sandbox-postgres is on PATH'

    if start_output="$(motir-sandbox-postgres start 2>&1)"; then
        pass "the cluster starts — ${start_output##*$'\n'}"

        # 1. It accepts a connection on the URL the README documents, as the
        #    role and database every CI job in these repositories already uses.
        #    Asserted through DATABASE_URL itself, because the value an agent
        #    inherits is the thing that has to work — not a hand-built one.
        if psql "${DATABASE_URL:?DATABASE_URL is not set in this image}" -tAc 'SELECT 1' 2>/dev/null | grep -qx '1'; then
            pass "a connection on \$DATABASE_URL succeeds"
        else
            fail "\$DATABASE_URL ($DATABASE_URL) does not accept a connection"
        fi

        # 2. pgvector — motir-core's work_item_embedding and motir-ai's
        #    20260624000000_enable_pgvector both run this statement, so a NO
        #    here means every database test in both repositories is unrunnable.
        if psql "${DATABASE_URL}" -q -c 'CREATE EXTENSION IF NOT EXISTS vector' 2>/dev/null; then
            vector_version="$(psql "${DATABASE_URL}" -tAc "SELECT extversion FROM pg_extension WHERE extname = 'vector'" 2>/dev/null)"
            if [ -n "$vector_version" ]; then
                pass "pgvector is installed and loadable — $vector_version"
            else
                fail 'CREATE EXTENSION vector reported success but pg_extension has no row'
            fi
        else
            fail 'CREATE EXTENSION vector FAILED — the migrations of two repos cannot run'
        fi

        # 3. BYTE collation. The assertion is the OBSERVED ORDERING and not the
        #    locale NAME, for the reason tests/db-collation.test.ts gives: musl
        #    collates by byte whatever the locale string says, so the name can
        #    agree while the behaviour does not, and it is the behaviour the
        #    base-62 position keys depend on.
        if [ "$(psql "${DATABASE_URL}" -tAc "SELECT 'Zz' < 'a0'" 2>/dev/null)" = 't' ]; then
            pass "the cluster collates by BYTE — 'Zz' < 'a0'"
        else
            collation="$(psql "${DATABASE_URL}" -tAc 'SELECT datcollate FROM pg_database WHERE datname = current_database()' 2>/dev/null)"
            fail "the cluster collates by DICTIONARY (datcollate=$collation) — every fractional-index ordering test will go red for a reason that is not the code"
        fi

        motir-sandbox-postgres stop >/dev/null 2>&1 || true
    else
        fail "the cluster does not start as $(id -un): $start_output"
    fi
else
    fail 'motir-sandbox-postgres is not on PATH — the image ships no debugging database'
fi

# ── The browser ─────────────────────────────────────────────────────────────
# The binary alone proves nothing: chromium without its system libraries exists
# and refuses to launch, which is the failure this layer is mostly here to
# prevent. So LAUNCH it — `--version` on the real executable loads the shared
# objects, so a missing libnss3 / libgbm is a non-zero exit here rather than a
# mystery in somebody's first `playwright test` run.
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
    fail 'PLAYWRIGHT_BROWSERS_PATH is not set — a downloaded browser would land in a home the devcontainer mount can shadow'
else
    pass "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"
    # Playwright lays a build out as <browser>-<revision>/chrome-linux/<binary>,
    # and which binary depends on the build: the headless shell ships
    # `headless_shell`, the full browser `chrome`. Look for either rather than
    # pinning the layout, which is Playwright's to change.
    chrome_bin="$(find "$PLAYWRIGHT_BROWSERS_PATH" -maxdepth 3 -type f \
        \( -name 'headless_shell' -o -name 'chrome' \) 2>/dev/null | head -n 1)"
    if [ -z "$chrome_bin" ]; then
        fail "no chromium binary under $PLAYWRIGHT_BROWSERS_PATH — the image baked no browser"
    elif chrome_version="$("$chrome_bin" --version 2>&1)"; then
        pass "chromium launches — $chrome_version"
    else
        fail "the chromium binary is present but does NOT launch (its system libraries are missing): $chrome_version"
    fi
    # The path has to be WRITABLE too: a repository pinned to a Playwright this
    # image did not bake runs `playwright install` itself, and that download is
    # the one half of the browser story an unprivileged user CAN perform.
    probe="$PLAYWRIGHT_BROWSERS_PATH/.motir-writable-probe"
    if (echo probe > "$probe") 2>/dev/null; then
        rm -f "$probe" 2>/dev/null
        pass "$PLAYWRIGHT_BROWSERS_PATH is writable — another Playwright version can be installed"
    else
        fail "$PLAYWRIGHT_BROWSERS_PATH is not writable by $(id -un) — a repo on another Playwright version is stuck"
    fi
fi

if [ "$failures" -gt 0 ]; then
    echo "== runtimes smoke FAILED ($failures)"
    exit 1
fi
echo '== runtimes smoke passed'
