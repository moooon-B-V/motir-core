import { describe, expect, it } from 'vitest';
import {
  classifyRunner,
  LINUX_EQUIVALENT_MULTIPLIER,
  multiplierForLabels,
  resolveRunnerRate,
  RUNNER_RATES,
} from '@/lib/ciMetering/runnerRates';

// Runner normalization (Story MOTIR-1775 · MOTIR-1896) —
// `docs/decisions/ci-minutes-allowance.md` §3. Pure unit tests: no DB, no clock.

const AFTER_REPRICING = new Date('2026-07-30T12:00:00.000Z');
const BEFORE_REPRICING = new Date('2025-06-01T00:00:00.000Z');

describe('classifyRunner', () => {
  it.each([
    ['ubuntu-latest', 'linux_x64'],
    ['ubuntu-24.04', 'linux_x64'],
    ['windows-latest', 'windows_x64'],
    ['windows-2022', 'windows_x64'],
    ['macos-latest', 'macos'],
    ['macos-14', 'macos'],
    ['ubuntu-24.04-arm', 'linux_arm64'],
  ] as const)('classifies %s as %s', (label, family) => {
    expect(classifyRunner([label])).toBe(family);
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(classifyRunner(['  Ubuntu-Latest '])).toBe('linux_x64');
    expect(classifyRunner(['MACOS-14'])).toBe('macos');
  });

  it('classifies a LARGER hosted runner as unknown, not as its OS', () => {
    // The ADR prices the four standard 2-core runners. A larger runner is still
    // Linux, but it is NOT the Linux the x1.00 rate prices — charging it as one
    // would be a priced guess, so it takes the safe x1.00 fallback WITH a log.
    expect(classifyRunner(['ubuntu-latest-4-core'])).toBe('unknown');
    expect(classifyRunner(['windows-latest-8-core'])).toBe('unknown');
    expect(classifyRunner(['ubuntu-latest-xlarge'])).toBe('unknown');
  });

  it('classifies an empty / unrecognised label set as unknown', () => {
    expect(classifyRunner([])).toBe('unknown');
    expect(classifyRunner(['', '   '])).toBe('unknown');
    expect(classifyRunner(['self-hosted-tpu'])).toBe('unknown');
  });

  it('takes the FIRST recognisable label when several are present', () => {
    // GitHub reports `["self-hosted", "linux", "x64"]` style label sets; the
    // first match wins so the classification is deterministic.
    expect(classifyRunner(['macos-14', 'ubuntu-latest'])).toBe('macos');
  });
});

describe('resolveRunnerRate — effective dating (§3.3)', () => {
  it('resolves each priced family to its cost-proportional multiplier', () => {
    // The ratios are the runner's own GitHub price over the Linux 2-core x64
    // price (the numeraire) — NOT GitHub's included-minutes drain multipliers,
    // which §3.2 records as the wrong basis.
    expect(resolveRunnerRate('linux_x64', AFTER_REPRICING)?.multiplier).toBe(1.0);
    expect(resolveRunnerRate('linux_arm64', AFTER_REPRICING)?.multiplier).toBe(0.83);
    expect(resolveRunnerRate('windows_x64', AFTER_REPRICING)?.multiplier).toBe(1.67);
    expect(resolveRunnerRate('macos', AFTER_REPRICING)?.multiplier).toBe(10.33);
  });

  it('does NOT use GitHub’s included-minutes multipliers (the §3.2 correction)', () => {
    // Adopting Windows x2 / macOS x10 would overcharge Windows by 20% and
    // undercharge macOS by 3%. This test is the guard against re-introducing them.
    expect(resolveRunnerRate('windows_x64', AFTER_REPRICING)?.multiplier).not.toBe(2);
    expect(resolveRunnerRate('macos', AFTER_REPRICING)?.multiplier).not.toBe(10);
  });

  it('each multiplier equals the rate’s own price divided by the Linux x64 price', () => {
    const linux = RUNNER_RATES.find((r) => r.family === 'linux_x64');
    expect(linux).toBeDefined();
    for (const rate of RUNNER_RATES) {
      // The ratio is what makes a single blended overage rate honest (§2.3).
      expect(rate.multiplier).toBeCloseTo(rate.usdPerMinute / linux!.usdPerMinute, 2);
    }
  });

  it('returns null for a run that PREDATES every entry — history never re-prices', () => {
    // A rate is in force from its `effectiveFrom`, so a run older than the table
    // takes the x1.00 fallback rather than silently borrowing today's price.
    expect(resolveRunnerRate('macos', BEFORE_REPRICING)).toBeNull();
  });

  it('returns null for an unpriced family', () => {
    expect(resolveRunnerRate('unknown', AFTER_REPRICING)).toBeNull();
  });
});

describe('multiplierForLabels', () => {
  it('prices a known runner and reports it as priced', () => {
    expect(multiplierForLabels(['macos-14'], AFTER_REPRICING)).toEqual({
      family: 'macos',
      multiplier: 10.33,
      priced: true,
    });
  });

  it('falls back to x1.00 and flags an unpriced runner (§3.4)', () => {
    // Under-counting a runner Motir has not priced is the SAFE direction: it
    // never over-bills a user for a rate nobody decided. `priced: false` is what
    // the service logs on — the signal to add a rate.
    expect(multiplierForLabels(['self-hosted-tpu'], AFTER_REPRICING)).toEqual({
      family: 'unknown',
      multiplier: LINUX_EQUIVALENT_MULTIPLIER,
      priced: false,
    });
  });

  it('falls back for a priced FAMILY whose rate is not yet in force', () => {
    expect(multiplierForLabels(['windows-latest'], BEFORE_REPRICING)).toEqual({
      family: 'windows_x64',
      multiplier: LINUX_EQUIVALENT_MULTIPLIER,
      priced: false,
    });
  });
});
