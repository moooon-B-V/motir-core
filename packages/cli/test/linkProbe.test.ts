import { describe, expect, it } from 'vitest';
import { assertProjectAccessible, type ProjectProbeClient } from '../src/commands/link.js';
import {
  AuthError,
  CliError,
  IncompatibleServerError,
  NotFoundError,
  PermissionError,
} from '../src/errors.js';

// `motir link`'s ACCESS PROBE, at the one seam that matters: what it does with
// the error the probe raises (MOTIR-2492).
//
// The defect these tests pin was not that the probe asked the wrong question —
// `list_ready` is a fine way to prove a project is reachable — but that its
// catch answered a different one. `if (err instanceof CliError)` matches every
// failure the CLI can produce, so a version skew, a revoked token, a missing
// scope and an unreachable host all left `motir link` saying "Project X is not
// accessible with this token. Check the project key, or your token's
// workspace." — a specific, confident, wrong diagnosis, with the correct one
// already formed and then discarded.
//
// The stub is the point. Driving this through the HTTP test server would prove
// the 404 arm and nothing else: the skew verdict comes from a probe of
// `/api/openapi/v1.json`, so the interesting inputs are not reachable by
// scripting a `/api/v1` route. Handing `assertProjectAccessible` one error at a
// time asserts the rule itself — WHICH errors are re-worded — rather than one
// server's ability to produce them.

/** A client whose probe read fails with exactly `err`. */
const probeFailingWith = (err: unknown): ProjectProbeClient => ({
  listReady: () => Promise.reject(err),
});

/**
 * The `CliError` a probe call raised — or a failure saying it raised nothing.
 *
 * `.catch((e) => e)` would type the result as `void | unknown` and force a cast
 * at every assertion, which is exactly the shape that hides a test asserting on
 * a resolved value it thought was an error.
 */
async function cliErrorFrom(probe: Promise<void>): Promise<CliError> {
  try {
    await probe;
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error('expected the access probe to reject, but it resolved');
}

/** The real message a server behind this CLI's contract floor produces. */
const versionSkew = (): IncompatibleServerError =>
  new IncompatibleServerError(
    'This CLI needs Motir API >= 1.8.0; https://app.motir.co serves 1.2.0.',
    'Upgrade your Motir server, or install a CLI built for it.',
  );

describe('assertProjectAccessible', () => {
  it('passes when the probe read succeeds — an EMPTY ready set is a reachable project', async () => {
    const calls: unknown[] = [];
    const client: ProjectProbeClient = {
      listReady: (args) => {
        calls.push(args);
        return Promise.resolve({ items: [], nextCursor: null });
      },
    };

    await expect(assertProjectAccessible(client, 'PROD')).resolves.toBeUndefined();
    // One row is all the probe needs; it is proving reachability, not reading work.
    expect(calls).toEqual([{ projectKey: 'PROD', limit: 1 }]);
  });

  it('lets a VERSION SKEW through verbatim — the same error object, message and hint', async () => {
    const skew = versionSkew();

    // `toBe`, not a message match: the error must arrive UNTOUCHED, so nothing
    // it carries (the served version, the required one, the upgrade hint) can
    // be lost to a re-wording downstream.
    await expect(assertProjectAccessible(probeFailingWith(skew), 'MOTIR')).rejects.toBe(skew);
  });

  it('still reports a genuinely unreachable project key as inaccessible — and keeps the original as `cause`', async () => {
    const notFound = new NotFoundError('no project "NOPE".');

    const err = await cliErrorFrom(assertProjectAccessible(probeFailingWith(notFound), 'NOPE'));

    expect(err.message).toBe('Project "NOPE" is not accessible with this token.');
    expect(err.hint).toBe('Check the project key, or your token’s workspace.');
    // Re-worded, not replaced: the server's own sentence is still reachable.
    expect(err.cause).toBe(notFound);
  });

  it('gives the skew and the missing project DIFFERENT messages — the assertion the old catch failed', async () => {
    const skew = await cliErrorFrom(
      assertProjectAccessible(probeFailingWith(versionSkew()), 'MOTIR'),
    );
    const missing = await cliErrorFrom(
      assertProjectAccessible(probeFailingWith(new NotFoundError('no project "NOPE".')), 'NOPE'),
    );

    expect(skew.message).not.toBe(missing.message);
    expect(skew.message).toMatch(/needs Motir API >= 1\.8\.0/);
    expect(skew.hint).toMatch(/Upgrade your Motir server/);
    expect(missing.message).toMatch(/not accessible with this token/);
  });

  it.each([
    ['an auth failure', new AuthError()],
    ['a missing permission', new PermissionError('project:browse', 'getProjectReadySet')],
    [
      'a transport failure',
      new CliError('Could not reach https://app.motir.co: fetch failed.', {
        hint: 'Check the server URL and run `motir doctor`.',
      }),
    ],
  ])(
    'lets %s through untouched too — each already says more than "inaccessible"',
    async (_label, original) => {
      await expect(assertProjectAccessible(probeFailingWith(original), 'MOTIR')).rejects.toBe(
        original,
      );
    },
  );

  it('does not swallow a non-CliError — a programming bug still bubbles as a crash', async () => {
    const bug = new TypeError('client.listReady is not a function');

    await expect(assertProjectAccessible(probeFailingWith(bug), 'MOTIR')).rejects.toBe(bug);
  });
});
