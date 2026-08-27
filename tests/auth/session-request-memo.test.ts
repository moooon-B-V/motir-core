import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MOTIR-2453 — an authenticated page render validates the session ONCE.
 *
 * Before this card it did so four times (five on `/dashboard`): `app/layout.tsx`
 * for the applied appearance, `app/(authed)/layout.tsx` for the shell,
 * `getWorkspaceContext()` from inside that same layout, and the page's own read.
 * Each was its own database round-trip on the hottest path in the product.
 *
 * The count here is MEASURED, not read off the source: the probe renders a
 * three-deep async server-component tree through the real RSC Flight renderer
 * and counts calls that reach Better-Auth's `auth.api.getSession`. See
 * `tests/auth/sessionRenderProbe.ts` for why that has to happen in a child
 * process under `--conditions=react-server` (short version: React's `cache()`
 * is a pass-through in the client build, so an in-worker test would pass with
 * or without the fix).
 */

const PROBE = resolve(__dirname, 'sessionRenderProbe.ts');

/**
 * A DATABASE_URL that points at nothing. Two jobs: it keeps the counting modes
 * hermetic (they never need Postgres), and it is the instrument the
 * unauthenticated modes read — see the probe's own docstring.
 */
const UNREACHABLE_DATABASE_URL = 'postgresql://probe:probe@127.0.0.1:1/nonexistent';

/**
 * ── THE TWO BUDGETS, AND THE ORDER BETWEEN THEM (MOTIR-3708) ────────────────
 *
 * Every case below spawns a FRESH Node subprocess — `--conditions=react-server
 * --import tsx` — which compiles the probe and its `@/lib/auth` graph from cold
 * and renders a three-deep RSC tree. That cost is paid once PER CASE: there is
 * no warm-the-graph-once hook to hoist it into, the way
 * `tests/platform/adminRouteGate.test.ts` and
 * `tests/components/two-factor-required-page.test.tsx` do for an in-process
 * import, because a fresh module registry per mode is the measurement.
 *
 * ── What it costs ───────────────────────────────────────────────────────────
 * Quiet box, `--reporter=verbose`: 4022 / 4056 / 4052 ms for the three counting
 * modes, 733 ms for the db-control (a smaller graph, not a cheaper mechanism).
 * The SAME file on this branch with sibling sessions on the box: **53 887 /
 * 16 813 / 38 493 / 3 822 ms** — a 13.4x multiplier on the worst case, and this
 * repository has recorded above 14x on a loaded runner and above 19x on a
 * sharded CI job (`vitest.guards.config.ts` carries that measurement).
 *
 * Under the repo's 15 000 ms `testTimeout` — a budget written for an in-process
 * query — that is a 3.7x quiet-box margin, so the file failed on any contended
 * run, with a DIFFERENT case each time and no assertion failure in either
 * direction: `Error: Test timed out in 15000ms`, green in isolation on the same
 * commit. Three of the four loaded numbers above are over that wall.
 *
 * ── Why BOTH numbers moved ──────────────────────────────────────────────────
 * The card that filed this proposed raising only the test budget, on the
 * reasoning that the subprocess already declared 60 000 ms. The measurement
 * above amends that: 53 887 ms is 90% of 60 000, and 19x the quiet cost is
 * 76 000 — so `execFileSync`'s own timeout was a second cliff, one the test
 * budget had been hiding. Both are sized for a cold graph on a contended
 * runner, at the 180 000 ms this repository already uses for exactly that
 * (`adminRouteGate`, `two-factor-required-page`).
 *
 * ── Why the ORDER is the load-bearing part ──────────────────────────────────
 * A case that awaits a subprocess must not promise less time than it gives that
 * subprocess. While the test's budget is the smaller one, `execFileSync`'s
 * timeout is unreachable, so a genuinely hung probe can only ever surface as
 * Vitest's opaque timeout instead of the child's error and its partial stdout.
 * The headroom is the spawn and teardown that sit outside the child's own
 * clock; it costs nothing in the hang case, where the child is killed at its own
 * budget and the case fails immediately after. The order is asserted below
 * rather than left to this comment, so the two cannot be moved independently.
 */
const PROBE_SUBPROCESS_TIMEOUT_MS = 180_000;
const PROBE_TEST_TIMEOUT_MS = PROBE_SUBPROCESS_TIMEOUT_MS + 30_000;

function runProbe(mode: string): Record<string, unknown> {
  const stdout = execFileSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', PROBE, mode],
    {
      cwd: resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: UNREACHABLE_DATABASE_URL },
      timeout: PROBE_SUBPROCESS_TIMEOUT_MS,
    },
  );
  const line = stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  if (!line) throw new Error(`Probe "${mode}" produced no result. stdout:\n${stdout}`);
  return JSON.parse(line.slice('PROBE_RESULT '.length));
}

describe('the probe budgets (MOTIR-3708)', () => {
  it('gives a case strictly more time than it gives the subprocess it awaits', () => {
    // The defect this file carried, stated as the assertion that falsifies it:
    // the cases ran on the repo default of 15 000 ms while handing their child
    // 60 000 ms — and 53 887 ms of that child was observed. Strictly greater,
    // not equal: the headroom is the spawn and
    // teardown that sit outside the child's own clock, and it is what lets
    // `execFileSync`'s timeout be the thing that fires on a real hang.
    expect(PROBE_TEST_TIMEOUT_MS).toBeGreaterThan(PROBE_SUBPROCESS_TIMEOUT_MS);
  });

  it('declares that budget on EVERY case that spawns a probe', () => {
    // The rule rather than the four edits: a fifth probe case written later
    // would otherwise inherit the 15 s default and rediscover this bug on
    // somebody else's pull request. One bounded read of THIS file — not a tree
    // walk, so it stays out of the structural-guard lane's candidate set.
    //
    // ⚠️ The two tokens are assembled at run time on purpose. Written out, they
    // would appear in this case's OWN source and make it match itself, which is
    // the fixture-in-a-scanner trap `tests/helpers/structuralGuardLane.ts`
    // records against `storeDeadline`.
    const PROBE_CALL = 'runProbe' + '(';
    const BUDGET = '{ timeout: PROBE_TEST_' + 'TIMEOUT_MS }';

    const cases = readFileSync(__filename, 'utf8')
      .split(/^ {2}it\(/m)
      .slice(1);
    expect(cases.length, 'the split found no cases — the shape moved').toBeGreaterThanOrEqual(5);

    const unbudgeted = cases
      .filter((body) => body.includes(PROBE_CALL) && !body.includes(BUDGET))
      .map((body) => body.slice(0, body.indexOf('\n')).trim());
    expect(
      unbudgeted,
      `these cases spawn a probe on the suite default — give each ${BUDGET}`,
    ).toEqual([]);
  });
});

describe('session lookups per authed page render (MOTIR-2453)', () => {
  it(
    'reaches Better-Auth THREE times when each layer calls it directly',
    { timeout: PROBE_TEST_TIMEOUT_MS },
    () => {
      // The control. It fixes the harness's sensitivity before the real assertion
      // relies on it: three call sites that bypass the memoised helper must show
      // up as three, or a "1" below would be measuring a broken probe rather than
      // a working cache.
      expect(runProbe('direct')).toEqual({ mode: 'direct', sessionApiCalls: 3 });
    },
  );

  it(
    'reaches Better-Auth ONCE when the same three layers call getSession()',
    { timeout: PROBE_TEST_TIMEOUT_MS },
    () => {
      expect(runProbe('memoized')).toEqual({ mode: 'memoized', sessionApiCalls: 1 });
    },
  );
});

describe('the unauthenticated path still costs no database round-trip', () => {
  it(
    'resolves to null with no session cookie, against an unreachable database',
    { timeout: PROBE_TEST_TIMEOUT_MS },
    () => {
      expect(runProbe('anonymous')).toEqual({ mode: 'anonymous', outcome: 'null' });
    },
  );

  it(
    'control: a query that DOES need the database fails against that same URL',
    { timeout: PROBE_TEST_TIMEOUT_MS },
    () => {
      // Without this, the test above proves nothing — a `null` could just as well
      // mean the database was reachable all along and simply had no rows.
      const result = runProbe('db-control');
      expect(result['mode']).toBe('db-control');
      expect(result['outcome']).toBe('threw');
    },
  );
});

/**
 * The measurement above proves the helper memoises. This proves the helper is
 * what the app actually calls — the other half, and the one that rots.
 *
 * `getWorkspaceContext()` was the third lookup on every authed page precisely
 * because it reached past `getSession()` to Better-Auth, in the same
 * `next/headers` context, for the identical call. Nothing flagged it. A new
 * caller written the same way would silently restore the duplicate the
 * measurement can no longer see, because the measurement renders a tree of its
 * own making.
 */
describe('every next/headers session read routes through the memoised helper', () => {
  /**
   * `lib/auth/index.ts` IS the helper. `lib/workspaces/middleware.ts` takes an
   * explicit `Request` (it serves the proxy and route handlers, which have no
   * render scope to share), so it legitimately calls Better-Auth directly.
   *
   * Adding an entry here means accepting an extra session round-trip. Say why
   * beside the call, the way `middleware.ts` does.
   */
  const SANCTIONED_DIRECT_CALLERS = ['lib/auth/index.ts', 'lib/workspaces/middleware.ts'];

  it('has no unsanctioned auth.api.getSession call site under app/ or lib/', () => {
    // The trailing `(` matches a CALL, not a mention — the docstrings that
    // explain this rule name the method too, and a bare-name grep would flag
    // the very comments telling you not to call it.
    const stdout = execFileSync(
      'git',
      ['grep', '-l', '-e', 'auth\\.api\\.getSession(', '--', 'app', 'lib'],
      { cwd: resolve(__dirname, '..', '..'), encoding: 'utf8' },
    );
    const callers = stdout.split('\n').filter(Boolean).sort();
    expect(callers).toEqual([...SANCTIONED_DIRECT_CALLERS].sort());
  });
});
