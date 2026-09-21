import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectLaneMembers,
  fetchApprovedStories,
  GUARD_REQUIRED_VAR,
  judgeLane,
  LaneGuardReadError,
  LaneGuardUnboundError,
  parseDeclaredStory,
  requireStatusSource,
  resolveStatusSource,
  statusSourceRequired,
  type StatusSource,
} from './helpers/acceptanceLaneGuard';

// THE LANE-MEMBERSHIP GUARD (Story MOTIR-2765 · Subtask MOTIR-2770).
//
// ⚠️ RE-KEYED BY MOTIR-5872 — READ THIS BEFORE THE HISTORY BELOW. The live check
// no longer asks the product whether a story's receipt is `approved`, and it no
// longer evicts a spec for it. That half tied a TEST's lane to whether a RECORD
// had been signed: MOTIR-5799's receipt was approved while its pull request sat
// in the merge queue, the queue ejected it, the story came back to be reworked —
// and this guard, which runs in the MAIN suite, turned every pull request in the
// repository red demanding the spec of a still-live feature leave the lane. A
// spec's lane is a PLACEMENT, decided once when the spec is written
// (`docs/decisions/acceptance-receipt-lifecycle.md` AMENDMENT 1). What the live
// check keeps is the half that is true of the FILE: a spec declaring no story can
// never publish a receipt. The status-read machinery and its unit tests below are
// kept only until MOTIR-5874 retires them with the credential they need.
//
// An acceptance spec exists to record ONE receipt. Once that receipt is
// `approved` the spec has discharged its purpose and must leave the lane — by
// PROMOTION into a lane that runs on every PR, or by RETIREMENT
// (`docs/decisions/acceptance-receipt-lifecycle.md` §3). Nothing enforced that,
// so nothing happened: the lane accumulated 26 specs, none of which ever left,
// and this story exists because that convention decayed.
//
// This is the layer that FORCES the decision. The service refusal (MOTIR-2764)
// makes the data undestroyable and the publisher skip (MOTIR-2768) makes the
// refusal legible — but neither can ask anyone to triage a spec. Only a red
// check reaches a developer at the one moment they can act.
//
// ── WHERE THE STATUS COMES FROM, AND WHY ────────────────────────────────────
//
// DECIDED: query the PRODUCT; skip cleanly when it is unreachable.
//
// REJECTED: a committed manifest of the lane's specs and their stories'
// dispositions. It runs everywhere with no credential and it is greppable in a
// diff — and it is a repo-side COPY of a fact the product owns, which is the
// exact shape of the defect this whole story is fixing. Enforcing a rule about
// drift by introducing a second source of drift is a bad trade, and the copy
// would be wrong in the one direction that matters: a story approved after the
// manifest was written reads as still-in-flight forever.
//
// The cost of that choice is honest and stated here: with no credential the
// guard SKIPS, so it fires in CI and not on a laptop. It is never silent about
// which of the two it did.
//
// ⚠️ AND THAT SENTENCE WAS FALSE FOR ELEVEN WEEKS (MOTIR-4093). No job set
// either variable, so the guard took its degraded branch on every run it ever
// had — printing "It runs in CI" while measuring nothing. The degradation is
// still the design; what it now needs is an environment that DECLARES it must
// bind (`MOTIR_GUARD_REQUIRED`), and `requireStatusSource` FAILS there instead
// of degrading. `tests/ci-acceptance-lane-credential.test.ts` is what keeps the
// declaration attached to the job that runs this guard.
//
// ── WHAT A DEVELOPER SEES ───────────────────────────────────────────────────
//
// This will fire months from now, on someone who has never read this story, in
// the middle of an unrelated PR — the same situation that produced the original
// incident, where a developer inherited a red they had no context for and fixed
// it the wrong way because the wrong way was the obvious one. So the message
// names the spec, the story, and BOTH legal remedies with the rule for choosing.

// ── WHERE THE LOGIC LIVES ───────────────────────────────────────────────────
//
// The guard's own functions are in `tests/helpers/acceptanceLaneGuard.ts`, not
// in this file (MOTIR-4144). They moved for one reason: the criterion that would
// have caught the missing route is a test that drives `fetchApprovedStories`
// against the REAL handler, and that test needs a database — so it lives in
// `tests/acceptance-evidence-status-route.test.ts`, which cannot import a spec
// file without re-running its suite. One implementation, two callers.

describe('every spec in the acceptance lane declares its story (MOTIR-2770, re-keyed by MOTIR-5872)', () => {
  // ⚠️ NO NETWORK, NO CREDENTIAL, AND THAT IS THE FIX. The retired half asked the
  // product which receipts were approved and failed the run on each one; a
  // receipt's status says nothing about where its TEST belongs. What is checked
  // here is a property of the spec file alone, so it runs identically on a laptop,
  // a fork and the merge queue.
  it('no spec in the lane is missing its acceptanceStory() declaration', () => {
    const verdict = judgeLane(collectLaneMembers());
    expect(verdict.ok, verdict.message).toBe(true);
  });
});

// ── THE GUARD CAN FAIL ──────────────────────────────────────────────────────
//
// A guard nobody has watched fail is a guard nobody knows works. These drive the
// same judgement the check above runs, on fixtures.

const SOURCE: StatusSource = { baseUrl: 'https://motir.test', token: 't', authMode: 'bearer' };

// ── THE BATCH INSTRUMENT (MOTIR-4901) ───────────────────────────────────────
//
// A `fetchImpl` that answers NOTHING until every expected read has been ISSUED.
// It is the only shape that can separate a batch from a loop without measuring
// wall-clock time on a shared box: a serial implementation deadlocks against it
// by construction, because read 1 cannot resolve until read N has started and
// read N cannot start until read 1 resolves.
//
// The deadline is what turns that deadlock into a legible failure instead of a
// 15 s timeout: it rejects the pending read, the guard's own transport `catch`
// skips that key, and the assertions below then report `maxInFlight: 1` and an
// empty set rather than a bare "Test timed out".
function batchedFetch(
  expected: number,
  isApproved: (key: string) => boolean = () => false,
  deadlineMs = 2_000,
) {
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  let open!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    open = resolve;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `only ${started.length} of ${expected} reads had been issued after ${deadlineMs}ms — ` +
              'the reads are SERIAL',
          ),
        ),
      deadlineMs,
    );
  });
  // Losing a race is not an unhandled rejection.
  deadline.catch(() => {});

  const impl = (async (url: string) => {
    const key = /\/work-items\/([^/]+)\//.exec(url)?.[1];
    if (!key) throw new Error(`the batch stub could not read a story key out of ${url}`);
    started.push(key);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (started.length === expected) {
      clearTimeout(timer);
      open();
    }
    // ⚠️ `finally`, and it is load-bearing. Decrementing after the `await`
    // never runs when the deadline REJECTS, so a serial implementation left
    // every read counted as in flight for ever and `maxInFlight` climbed to N
    // — the instrument reported the property it was built to falsify. Measured:
    // the serial control passed both `maxInFlight` assertions before this line.
    try {
      await Promise.race([allStarted, deadline]);
    } finally {
      inFlight -= 1;
    }
    return {
      ok: true,
      json: async () => ({ evidence: isApproved(key) ? { status: 'approved' } : null }),
    };
  }) as unknown as typeof fetch;

  return {
    impl,
    get started() {
      return started;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const laneKeys = (n: number) => Array.from({ length: n }, (_, i) => `MOTIR-${5000 + i}`);

describe('the guard itself', () => {
  it('PASSES a declared spec WHATEVER its story’s receipt says — approval evicts nothing (MOTIR-5872)', () => {
    // The retired half failed `acceptance-cadence.spec.ts` here because MOTIR-813's
    // receipt was approved. A signed record says nothing about where its TEST
    // belongs, so the judgement no longer takes an approved set at all — and the
    // failure text can never name a receipt again.
    const verdict = judgeLane([
      { file: 'acceptance-cadence.spec.ts', storyKey: 'MOTIR-813' },
      { file: 'acceptance-in-flight.spec.ts', storyKey: 'MOTIR-9999' },
    ]);
    expect(verdict).toEqual({ ok: true, message: '' });
    expect(judgeLane.length).toBe(1);
  });

  it('FAILS a spec with NO acceptanceStory() — the half that stays', () => {
    const verdict = judgeLane([{ file: 'acceptance-orphan.spec.ts', storyKey: null }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('declare NO story');
    expect(verdict.message).toContain('acceptance-orphan.spec.ts');
    // It names the way out, and never a receipt's status.
    expect(verdict.message).toContain('promoted-regression');
    expect(verdict.message).not.toMatch(/approved/i);
  });

  it('reads the declaration from CODE, not from a header comment', () => {
    // `acceptance-shell-context-path.spec.ts` named its story only in a comment
    // and published against the uploader's PR fallback for its whole life.
    expect(parseDeclaredStory("// Story MOTIR-2554 — the shell's context path.")).toBeNull();
    expect(parseDeclaredStory("/* acceptanceStory('MOTIR-2554') */")).toBeNull();
    expect(parseDeclaredStory("  acceptanceStory('MOTIR-2554');")).toBe('MOTIR-2554');
    expect(parseDeclaredStory('  acceptanceStory( "MOTIR-2554" );')).toBe('MOTIR-2554');
  });

  it('enumerates from the FILESYSTEM — a spec added tomorrow needs no edit here', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-'));
    fs.writeFileSync(path.join(dir, 'acceptance-new.spec.ts'), "acceptanceStory('MOTIR-42');");
    fs.writeFileSync(path.join(dir, 'ordinary.spec.ts'), "acceptanceStory('MOTIR-43');");
    fs.writeFileSync(path.join(dir, 'acceptance-helper.ts'), "acceptanceStory('MOTIR-44');");

    expect(collectLaneMembers(dir)).toEqual([
      { file: 'acceptance-new.spec.ts', storyKey: 'MOTIR-42' },
    ]);
  });

  it('tolerates a TRANSPORT failure — a flaky hop is not evidence about a story', async () => {
    // The half of the old fail-open policy that is CORRECT and stays: a spec on
    // an unrelated PR must never go red because DNS wobbled.
    const approved = await fetchApprovedStories(['MOTIR-2', 'MOTIR-3'], SOURCE, (async (
      url: string,
    ) => {
      if (url.includes('MOTIR-2')) throw new Error('ECONNRESET');
      return { ok: true, json: async () => ({ evidence: { status: 'approved' } }) };
    }) as unknown as typeof fetch);
    expect([...approved]).toEqual(['MOTIR-3']);
  });

  it('reads a resolvable story with NO receipt as not approved — 200 + `evidence: null`', async () => {
    // The ordinary in-flight state, and the answer that makes every non-2xx
    // unambiguous enough to throw on.
    const approved = await fetchApprovedStories(['MOTIR-1'], SOURCE, (async () => ({
      ok: true,
      json: async () => ({ evidence: null }),
    })) as unknown as typeof fetch);
    expect([...approved]).toEqual([]);
  });

  it.each([
    [405, 'the route is not deployed — the MOTIR-4144 defect itself'],
    [404, 'the key did not resolve for this credential'],
    [401, 'the credential is missing or is the wrong arm'],
    [403, 'the credential lacks project:browse'],
  ])('THROWS on a route-level %i rather than folding it into "not approved"', async (status) => {
    // The half MOTIR-4144 adds. A 405 was absorbed as "no approved receipt" for
    // eleven weeks and the check stayed green the whole time.
    await expect(
      fetchApprovedStories(['MOTIR-1'], SOURCE, (async () => ({
        ok: false,
        status,
      })) as unknown as typeof fetch),
    ).rejects.toThrow(LaneGuardReadError);
  });

  it('names the story, the status and the URL when it throws — a reader can act', async () => {
    let err: unknown;
    try {
      await fetchApprovedStories(['MOTIR-813'], SOURCE, (async () => ({
        ok: false,
        status: 405,
      })) as unknown as typeof fetch);
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(LaneGuardReadError);
    const read = err as LaneGuardReadError;
    expect(read.storyKey).toBe('MOTIR-813');
    expect(read.status).toBe(405);
    expect(read.url).toBe('https://motir.test/api/work-items/MOTIR-813/acceptance-evidence');
    // The message has to reach a developer who has never read this story.
    expect(read.message).toContain("GUARD'S OWN WIRING");
    expect(read.message).toContain('the route is not deployed on this origin');
  });

  // ── THE COST MODEL (MOTIR-4901) ───────────────────────────────────────────
  //
  // The guard read one story at a time, each `await`ed before the next began,
  // against `https://app.motir.co` from a GitHub runner, under the root
  // config's 15 s default. Its runtime was therefore `N × round-trip` with `N`
  // = the number of acceptance specs — a number that only ever grows — and at
  // fourteen members it timed out in the merge queue. A timeout is the WORST
  // failure this guard has: it is the absence of a verdict wearing the same
  // colour as a dirty lane, and it arrives exactly when the lane is largest.

  it('issues every key in ONE batch — it cannot finish until all N reads have STARTED', async () => {
    // The proof a serial implementation can never satisfy: this `fetchImpl`
    // resolves nothing until all fourteen reads are in flight.
    const keys = laneKeys(14);
    const fetcher = batchedFetch(keys.length, (key) => key === 'MOTIR-5003');

    const approved = await fetchApprovedStories(keys, SOURCE, fetcher.impl);

    expect(fetcher.started).toHaveLength(keys.length);
    expect(fetcher.maxInFlight).toBe(keys.length);
    expect([...approved]).toEqual(['MOTIR-5003']);
  });

  it.each([14, 40])('is FLAT in N — %i members are still ONE batch, one round trip', async (n) => {
    // The lane's SIZE cannot silently re-create the defect: whatever N is, the
    // reads are issued together, so the cost is one round trip and the guard's
    // budget stops being consumed by arrivals.
    const fetcher = batchedFetch(n);

    await fetchApprovedStories(laneKeys(n), SOURCE, fetcher.impl);

    expect(fetcher.maxInFlight).toBe(n);
  });

  it('a rejecting key does NOT discard the batch — the trap `Promise.all` sets', async () => {
    // The concurrent form's own hazard, and the reason the transport `catch`
    // lives INSIDE the mapped read rather than around the aggregation: a bare
    // `Promise.all` over throwing reads loses every sibling to one flaky hop.
    // Survivors on BOTH sides of the rejection are kept, in input order.
    const approved = await fetchApprovedStories(['MOTIR-1', 'MOTIR-2', 'MOTIR-3'], SOURCE, (async (
      url: string,
    ) => {
      if (url.includes('MOTIR-2')) throw new Error('ECONNRESET');
      return { ok: true, json: async () => ({ evidence: { status: 'approved' } }) };
    }) as unknown as typeof fetch);

    expect([...approved]).toEqual(['MOTIR-1', 'MOTIR-3']);
  });

  it('returns EXACTLY the approved keys out of a mixed batch', async () => {
    // `approved` / a non-approved receipt / no receipt at all, answered in one
    // batch — the set the caller judges the lane against is unchanged.
    const approved = await fetchApprovedStories(
      ['MOTIR-1', 'MOTIR-2', 'MOTIR-3', 'MOTIR-4'],
      SOURCE,
      (async (url: string) => ({
        ok: true,
        json: async () => ({
          evidence: /MOTIR-(2|4)\//.test(url)
            ? { status: 'approved' }
            : url.includes('MOTIR-3')
              ? { status: 'pending' }
              : null,
        }),
      })) as unknown as typeof fetch,
    );

    expect([...approved].sort()).toEqual(['MOTIR-2', 'MOTIR-4']);
  });

  it('throws for the FIRST key in INPUT order, not the first response to land', async () => {
    // The serial loop's own choice, preserved. Under a batch every key is
    // requested, so WHICH failure surfaces would otherwise be decided by the
    // network — and a guard whose error message changes run to run is a guard
    // nobody can act on. `MOTIR-2` answers first here; `MOTIR-1` is reported.
    let err: unknown;
    try {
      await fetchApprovedStories(['MOTIR-1', 'MOTIR-2'], SOURCE, (async (url: string) => {
        if (url.includes('MOTIR-2')) return { ok: false, status: 403 };
        await Promise.resolve();
        return { ok: false, status: 405 };
      }) as unknown as typeof fetch);
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(LaneGuardReadError);
    expect((err as LaneGuardReadError).storyKey).toBe('MOTIR-1');
    expect((err as LaneGuardReadError).status).toBe(405);
  });

  it('sends the OIDC marker on the keyless arm, and only there', async () => {
    // `scripts/upload-acceptance-video.mjs` has sent `x-motir-auth: github-oidc`
    // since MOTIR-1650; this guard never did, so a keyless credential would have
    // met the PAT arm and 401'd. The route and the fetch had to change together.
    const seen: Array<Record<string, unknown>> = [];
    const spy = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return { ok: true, json: async () => ({ evidence: null }) };
    }) as unknown as typeof fetch;

    await fetchApprovedStories(['MOTIR-1'], { ...SOURCE, authMode: 'github-oidc' }, spy);
    await fetchApprovedStories(['MOTIR-1'], SOURCE, spy);

    expect(seen[0]).toEqual({ authorization: 'Bearer t', 'x-motir-auth': 'github-oidc' });
    expect(seen[1]).toEqual({ authorization: 'Bearer t' });
  });

  it('needs BOTH an origin and a token before it will claim to know anything', () => {
    expect(resolveStatusSource({})).toBeNull();
    expect(resolveStatusSource({ MOTIR_BASE_URL: 'https://x' })).toBeNull();
    expect(resolveStatusSource({ MOTIR_UPLOAD_TOKEN: 't' })).toBeNull();
    expect(resolveStatusSource({ MOTIR_BASE_URL: 'https://x/', MOTIR_UPLOAD_TOKEN: 't' })).toEqual({
      baseUrl: 'https://x',
      token: 't',
      authMode: 'bearer',
    });
  });

  it('reads the ORIGIN from the guard-specific name first, and the app’s own name second', () => {
    // The precedence that lets a job wire this guard without re-pointing
    // `lib/baseUrl.ts` for the other ~1360 files in the same lane.
    expect(
      resolveStatusSource({
        MOTIR_GUARD_BASE_URL: 'https://guard.test',
        MOTIR_BASE_URL: 'https://app.test',
        MOTIR_GUARD_TOKEN: 't',
      })?.baseUrl,
    ).toBe('https://guard.test');
    // An EMPTY guard-specific value is SET, so it wins and resolves to no
    // source — which is what makes `${{ secrets.MISSING }}` (which expands to
    // '') fail closed rather than silently fall through to the app's origin.
    expect(
      resolveStatusSource({
        MOTIR_GUARD_BASE_URL: '',
        MOTIR_BASE_URL: 'https://app.test',
        MOTIR_GUARD_TOKEN: 't',
      }),
    ).toBeNull();
  });

  it('takes the auth ARM from the environment, never from the token’s shape', () => {
    const env = { MOTIR_BASE_URL: 'https://x', MOTIR_GUARD_TOKEN: 'jwt.looking.token' };
    expect(resolveStatusSource(env)?.authMode).toBe('bearer');
    expect(resolveStatusSource({ ...env, MOTIR_GUARD_AUTH: 'github-oidc' })?.authMode).toBe(
      'github-oidc',
    );
    // Anything else is the PAT arm — an unrecognised value must not silently
    // become the keyless one.
    expect(resolveStatusSource({ ...env, MOTIR_GUARD_AUTH: 'oidc' })?.authMode).toBe('bearer');
  });
});

// ── THE HATCH IS SHUT WHERE IT COUNTS (MOTIR-4093) ──────────────────────────
//
// `resolveStatusSource` returning null is not by itself a verdict: it is the
// right answer on a laptop and on a fork's pull request, and it was the WRONG
// answer on every CI run for eleven weeks. What tells the two apart is the
// environment's own declaration, so these fixtures drive that decision directly
// — a guard nobody has watched fail is a guard nobody knows works.

describe('the binding requirement (MOTIR-4093)', () => {
  const SOURCED = { MOTIR_GUARD_BASE_URL: 'https://x', MOTIR_GUARD_TOKEN: 't' };

  it('reads the declaration from its own variable, exactly — never from `CI`', () => {
    // A fork's pull request sets CI and gets no secrets, so CI cannot be the
    // discriminator: keying on it would red-light exactly the runs whose
    // degradation is the stated design.
    expect(statusSourceRequired({ CI: 'true' })).toBe(false);
    expect(statusSourceRequired({})).toBe(false);
    expect(statusSourceRequired({ [GUARD_REQUIRED_VAR]: 'false' })).toBe(false);
    // GitHub renders a boolean expression as the bare word, and a job that
    // interpolates one into `env:` can leave whitespace around it.
    expect(statusSourceRequired({ [GUARD_REQUIRED_VAR]: 'true' })).toBe(true);
    expect(statusSourceRequired({ [GUARD_REQUIRED_VAR]: ' TRUE\n' })).toBe(true);
    // Anything else is NOT a declaration. An unrecognised value must not
    // silently become one, in either direction.
    expect(statusSourceRequired({ [GUARD_REQUIRED_VAR]: '1' })).toBe(false);
    expect(statusSourceRequired({ [GUARD_REQUIRED_VAR]: 'yes' })).toBe(false);
  });

  it('FAILS where the environment declares it must bind and nothing resolves', () => {
    expect(() => requireStatusSource({ [GUARD_REQUIRED_VAR]: 'true' })).toThrow(
      LaneGuardUnboundError,
    );
  });

  it('names what is missing, how to check it, and what NOT to do', () => {
    // It fires months from now on somebody who has never read this card, in the
    // middle of an unrelated pull request — the same situation the lane guard's
    // own message is written for.
    let err: unknown;
    try {
      requireStatusSource({ [GUARD_REQUIRED_VAR]: 'true' });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(LaneGuardUnboundError);
    const message = (err as Error).message;
    expect(message).toContain('MOTIR_GUARD_BASE_URL');
    expect(message).toContain('MOTIR_GUARD_TOKEN');
    expect(message).toContain('gh secret list');
    expect(message).toContain('MOTIR-4162');
    expect(message).toContain('Do NOT "fix" this by deleting the requirement');
  });

  it('DEGRADES where the environment has not declared it — the laptop and the fork', () => {
    expect(requireStatusSource({})).toBeNull();
    expect(requireStatusSource({ CI: 'true' })).toBeNull();
    expect(requireStatusSource({ [GUARD_REQUIRED_VAR]: 'false' })).toBeNull();
  });

  it('returns the source when one resolves, declared or not — the requirement gates only the NULL', () => {
    expect(requireStatusSource(SOURCED)).toEqual({
      baseUrl: 'https://x',
      token: 't',
      authMode: 'bearer',
    });
    expect(requireStatusSource({ ...SOURCED, [GUARD_REQUIRED_VAR]: 'true' })).toEqual({
      baseUrl: 'https://x',
      token: 't',
      authMode: 'bearer',
    });
  });

  it('is INDEPENDENT of lane membership — the property the live assertion needs', () => {
    // The defect this card is one level up from: an assertion placed after the
    // membership check's `members.length === 0` return is checked only when the
    // lane is non-empty, and the lane's steady state is empty. `collectLaneMembers`
    // is not in this call path at all, which is the point.
    expect(() => requireStatusSource({ [GUARD_REQUIRED_VAR]: 'true' })).toThrow();
    expect(collectLaneMembers()).toBeInstanceOf(Array);
  });
});
