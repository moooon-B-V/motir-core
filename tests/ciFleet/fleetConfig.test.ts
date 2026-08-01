import { describe, expect, it } from 'vitest';
import { MOTIR_RUNNER_LABEL, isMotirFleetJob } from '@/lib/ciFleet/config';
import { classifyRunner } from '@/lib/ciMetering/runnerRates';

// The fleet's §O label gate, in isolation (Story MOTIR-1916 · MOTIR-1920). Pure
// module, no DB — this is the one decision that separates "boot a machine" from
// "do nothing", and it is worth pinning at the unit level as well as through the
// service, because both of its failure directions are silent:
//
//   * too permissive → Motir's own 141-job-minute CI matrix migrates onto
//     infrastructure Motir is still building (`ci-minutes-allowance.md` §J);
//   * too strict → a job that genuinely asked for a Motir runner never gets one
//     and queues until GitHub expires it 24 hours later, which reads to the user
//     as "Motir handed me a repo whose CI is broken" (§N).

describe('MOTIR_RUNNER_LABEL — the §M naming constraints', () => {
  // §M is emphatic that the label VALUE is load-bearing, not cosmetic: the
  // shipped meter's classifier returns on the first substring match, so a label
  // containing `linux` would be metered as GitHub's own `linux_x64` family
  // (right number, wrong attribution) and one matching `N-core`/`large` would
  // trip §3.4's "unpriced" warning on every fleet job forever. Asserting the
  // constraint here makes a future rename fail a test rather than silently
  // corrupt a year of billing attribution.
  it('contains none of the OS/arch substrings the classifier matches on', () => {
    for (const forbidden of ['ubuntu', 'linux', 'arm', 'windows', 'macos', 'osx']) {
      expect(MOTIR_RUNNER_LABEL).not.toContain(forbidden);
    }
  });

  it('does not match the larger-runner pattern (`N-core` / `large` / `xlarge`)', () => {
    expect(MOTIR_RUNNER_LABEL).not.toMatch(/\d+-?core|xlarge|large/i);
  });

  it('classifies as `unknown` today — MOTIR-1923 is what gives it its own family', () => {
    // The CURRENT, honest state: with no fleet row in the rate table yet, a
    // fleet job falls to §3.4's ×1.00 fallback. Pinning it proves the label does
    // not accidentally land in a GitHub family (the failure §M actually fears),
    // and MOTIR-1923 flips this expectation to `motir_fleet` when it adds the
    // classification rule and the priced row.
    expect(classifyRunner([MOTIR_RUNNER_LABEL])).toBe('unknown');
  });
});

describe('isMotirFleetJob — the §O gate', () => {
  it('accepts a job whose sole requested label is the fleet label', () => {
    expect(isMotirFleetJob([MOTIR_RUNNER_LABEL])).toBe(true);
  });

  it('accepts the fleet label alongside others — a job needs ALL its labels', () => {
    // GitHub dispatches a job to a runner carrying every label it lists, so
    // `runs-on: [self-hosted, motir-runner]` is unambiguously asking for the
    // fleet. Requiring the fleet label to be the SOLE entry would refuse it.
    expect(isMotirFleetJob(['self-hosted', MOTIR_RUNNER_LABEL])).toBe(true);
  });

  it('matches case-insensitively, as GitHub matches runner labels', () => {
    expect(isMotirFleetJob(['MOTIR-RUNNER'])).toBe(true);
    expect(isMotirFleetJob(['  Motir-Runner  '])).toBe(true);
  });

  it('REJECTS every GitHub-hosted label — the §J exclusion', () => {
    for (const hosted of [
      ['ubuntu-latest'],
      ['ubuntu-24.04'],
      ['windows-latest'],
      ['macos-14'],
      ['ubuntu-latest-4-core'],
      ['self-hosted'],
    ]) {
      expect(isMotirFleetJob(hosted)).toBe(false);
    }
  });

  it('rejects a job with no labels at all', () => {
    expect(isMotirFleetJob([])).toBe(false);
  });

  it('rejects a label that merely CONTAINS the fleet label', () => {
    // The match is exact-per-label, not substring: a runner registered as
    // `motir-runner-staging` is a different runner group, and `runs-on` selects
    // by whole label. A substring gate would provision Motir's production fleet
    // for someone else's queue.
    expect(isMotirFleetJob(['motir-runner-staging'])).toBe(false);
    expect(isMotirFleetJob(['not-motir-runner'])).toBe(false);
  });
});
