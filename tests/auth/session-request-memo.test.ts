import { execFileSync } from 'node:child_process';
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

function runProbe(mode: string): Record<string, unknown> {
  const stdout = execFileSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', PROBE, mode],
    {
      cwd: resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: UNREACHABLE_DATABASE_URL },
      timeout: 60_000,
    },
  );
  const line = stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  if (!line) throw new Error(`Probe "${mode}" produced no result. stdout:\n${stdout}`);
  return JSON.parse(line.slice('PROBE_RESULT '.length));
}

describe('session lookups per authed page render (MOTIR-2453)', () => {
  it('reaches Better-Auth THREE times when each layer calls it directly', () => {
    // The control. It fixes the harness's sensitivity before the real assertion
    // relies on it: three call sites that bypass the memoised helper must show
    // up as three, or a "1" below would be measuring a broken probe rather than
    // a working cache.
    expect(runProbe('direct')).toEqual({ mode: 'direct', sessionApiCalls: 3 });
  });

  it('reaches Better-Auth ONCE when the same three layers call getSession()', () => {
    expect(runProbe('memoized')).toEqual({ mode: 'memoized', sessionApiCalls: 1 });
  });
});

describe('the unauthenticated path still costs no database round-trip', () => {
  it('resolves to null with no session cookie, against an unreachable database', () => {
    expect(runProbe('anonymous')).toEqual({ mode: 'anonymous', outcome: 'null' });
  });

  it('control: a query that DOES need the database fails against that same URL', () => {
    // Without this, the test above proves nothing — a `null` could just as well
    // mean the database was reachable all along and simply had no rows.
    const result = runProbe('db-control');
    expect(result['mode']).toBe('db-control');
    expect(result['outcome']).toBe('threw');
  });
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
