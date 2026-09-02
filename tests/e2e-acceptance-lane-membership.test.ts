import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectLaneMembers,
  fetchApprovedStories,
  judgeLane,
  LaneGuardReadError,
  parseDeclaredStory,
  resolveStatusSource,
  type StatusSource,
} from './helpers/acceptanceLaneGuard';

// THE LANE-MEMBERSHIP GUARD (Story MOTIR-2765 · Subtask MOTIR-2770).
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

describe('the acceptance lane holds only IN-FLIGHT stories (MOTIR-2770)', () => {
  it('no spec in the lane has an approved receipt, and every one declares its story', async () => {
    const members = collectLaneMembers();
    if (members.length === 0) {
      // A legitimate and, after a triage, common state: no story is in review.
      // Not a skip — an empty lane genuinely satisfies the rule.
      expect(members).toEqual([]);
      return;
    }

    const source = resolveStatusSource(process.env);
    if (!source) {
      // The stated degradation. Never a silent pass: the reason is printed, and
      // the undeclared-story half of the rule is checked anyway because it needs
      // no credential at all.
      const verdict = judgeLane(members, new Set());
      expect(
        verdict.ok,
        `${verdict.message}\n\n(The approved-receipt half of this guard was SKIPPED: no ` +
          'MOTIR_GUARD_TOKEN/MOTIR_UPLOAD_TOKEN + MOTIR_BASE_URL in this environment, so the ' +
          'product could not be asked which receipts are approved. It runs in CI.)',
      ).toBe(true);
      return;
    }

    const keys = members.map((m) => m.storyKey).filter((k): k is string => k !== null);
    const verdict = judgeLane(members, await fetchApprovedStories(keys, source));
    expect(verdict.ok, verdict.message).toBe(true);
  });
});

// ── THE GUARD CAN FAIL ──────────────────────────────────────────────────────
//
// A guard nobody has watched fail is a guard nobody knows works. These drive the
// same judgement the check above runs, on fixtures.

const SOURCE: StatusSource = { baseUrl: 'https://motir.test', token: 't', authMode: 'bearer' };

describe('the guard itself', () => {
  it('FAILS a spec whose story is already approved, naming it and both remedies', () => {
    const verdict = judgeLane(
      [
        { file: 'acceptance-cadence.spec.ts', storyKey: 'MOTIR-813' },
        { file: 'acceptance-in-flight.spec.ts', storyKey: 'MOTIR-9999' },
      ],
      new Set(['MOTIR-813']),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('tests/e2e/acceptance-cadence.spec.ts');
    expect(verdict.message).toContain('MOTIR-813');
    expect(verdict.message).toContain('PROMOTE');
    expect(verdict.message).toContain('RETIRE');
    // The one instruction that reverses the original incident's reflex.
    expect(verdict.message).toContain('Do NOT edit the spec');
    // …and it does NOT drag in the spec whose story is still in flight.
    expect(verdict.message).not.toContain('acceptance-in-flight.spec.ts');
  });

  it('PASSES a spec whose story is in review — the lane’s legitimate member', () => {
    expect(judgeLane([{ file: 'acceptance-x.spec.ts', storyKey: 'MOTIR-1' }], new Set()).ok).toBe(
      true,
    );
  });

  it('fails a spec with NO acceptanceStory() DISTINCTLY — a different defect', () => {
    const verdict = judgeLane([{ file: 'acceptance-orphan.spec.ts', storyKey: null }], new Set());
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('declare NO story');
    expect(verdict.message).toContain('acceptance-orphan.spec.ts');
    // Not conflated with the discharged case.
    expect(verdict.message).not.toContain('APPROVED receipt');
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
