import { describe, expect, it } from 'vitest';
import { normalizeRunUsage, type MeteredJob } from '@/lib/ciMetering/normalize';

// The metering arithmetic (Story MOTIR-1775 · MOTIR-1896) —
// `docs/decisions/ci-minutes-allowance.md` §3 + §5.8. Pure: no DB, no clock.

const COMPLETED_AT = new Date('2026-07-30T12:00:00.000Z');

// NB: `in` rather than `??` for the timestamps — an explicit `null` is exactly
// what these cases are testing, and `null ?? default` would silently restore it.
function job(overrides: Partial<MeteredJob> & { id: string }): MeteredJob {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    startedAt:
      'startedAt' in overrides ? overrides.startedAt! : new Date('2026-07-30T11:00:00.000Z'),
    completedAt:
      'completedAt' in overrides ? overrides.completedAt! : new Date('2026-07-30T11:03:00.000Z'),
    labels: overrides.labels ?? ['ubuntu-latest'],
  };
}

/** A job of exactly `minutes` wall clock, starting at a fixed instant. */
function jobOfMinutes(id: string, minutes: number, labels = ['ubuntu-latest']): MeteredJob {
  const startedAt = new Date('2026-07-30T11:00:00.000Z');
  return {
    id,
    name: id,
    startedAt,
    completedAt: new Date(startedAt.getTime() + minutes * 60_000),
    labels,
  };
}

describe('normalizeRunUsage — per-JOB rounding up (§5.8)', () => {
  it('rounds each job UP to the minute, the way GitHub bills', () => {
    // 5 seconds of compute still bills a full minute.
    const usage = normalizeRunUsage(
      [
        {
          id: '1',
          name: 'lint',
          startedAt: new Date('2026-07-30T11:00:00.000Z'),
          completedAt: new Date('2026-07-30T11:00:05.000Z'),
          labels: ['ubuntu-latest'],
        },
      ],
      COMPLETED_AT,
    );
    expect(usage.billableMinutes).toBe(1);
    expect(usage.rawWallClockSeconds).toBe(5);
  });

  it('rounds PER JOB, never on the total — 4 x 90s bills 8 minutes, not 6', () => {
    // This is the whole point of §5.8: ceil(90s)=2 four times over is 8, while
    // ceil(360s) on the summed total would be 6. Rounding at the wrong level
    // under-bills every multi-job suite.
    const jobs = ['a', 'b', 'c', 'd'].map((id) => jobOfMinutes(id, 1.5));
    const usage = normalizeRunUsage(jobs, COMPLETED_AT);
    expect(usage.billableMinutes).toBe(8);
  });

  it('SUMS parallel jobs rather than taking the critical path', () => {
    // Every job here runs in the same wall-clock window; GitHub bills each one.
    // Taking the run's own elapsed time would report 8 instead of 19.
    const startedAt = new Date('2026-07-30T11:00:00.000Z');
    const jobs: MeteredJob[] = [
      {
        id: 'lint',
        name: 'lint',
        startedAt,
        completedAt: new Date(startedAt.getTime() + 3 * 60_000),
        labels: ['ubuntu-latest'],
      },
      {
        id: 'typecheck',
        name: 'typecheck',
        startedAt,
        completedAt: new Date(startedAt.getTime() + 3 * 60_000),
        labels: ['ubuntu-latest'],
      },
      {
        id: 'build',
        name: 'build',
        startedAt,
        completedAt: new Date(startedAt.getTime() + 5 * 60_000),
        labels: ['ubuntu-latest'],
      },
      {
        id: 'e2e',
        name: 'e2e',
        startedAt,
        completedAt: new Date(startedAt.getTime() + 8 * 60_000),
        labels: ['ubuntu-latest'],
      },
    ];
    const usage = normalizeRunUsage(jobs, COMPLETED_AT);
    // The starter's own CI shape (ADR §Context): 3+3+5+8.
    expect(usage.billableMinutes).toBe(19);
    expect(usage.jobCount).toBe(4);
  });
});

describe('normalizeRunUsage — cost normalization (§3.1)', () => {
  it('converts a macOS run at the price ratio, not at GitHub’s x10', () => {
    const usage = normalizeRunUsage([jobOfMinutes('mac', 10, ['macos-14'])], COMPLETED_AT);
    expect(usage.billableMinutes).toBe(10);
    expect(usage.linearEquivalentMinutes).toBe(103.3); // 10 x 10.33, not 100
  });

  it('normalizes each job at ITS OWN runner’s rate when a run mixes runners', () => {
    const usage = normalizeRunUsage(
      [
        jobOfMinutes('linux', 10, ['ubuntu-latest']), // 10 x 1.00    = 10
        jobOfMinutes('win', 10, ['windows-latest']), //  10 x 1.67    = 16.7
        jobOfMinutes('mac', 10, ['macos-latest']), //    10 x 10.33   = 103.3
        jobOfMinutes('arm', 10, ['ubuntu-24.04-arm']), // 10 x 0.83   = 8.3
      ],
      COMPLETED_AT,
    );
    expect(usage.billableMinutes).toBe(40);
    expect(usage.linearEquivalentMinutes).toBe(138.3);
  });

  it('meters an unpriced runner at x1.00 and NAMES it for the caller to log (§3.4)', () => {
    const usage = normalizeRunUsage(
      [jobOfMinutes('big', 10, ['ubuntu-latest-8-core'])],
      COMPLETED_AT,
    );
    expect(usage.linearEquivalentMinutes).toBe(10);
    expect(usage.unpricedFamilies).toEqual(['unknown']);
  });

  it('reports no unpriced families when every runner is priced', () => {
    const usage = normalizeRunUsage([jobOfMinutes('ok', 3)], COMPLETED_AT);
    expect(usage.unpricedFamilies).toEqual([]);
  });
});

describe('normalizeRunUsage — the audit trail (§3.3)', () => {
  it('retains raw wall clock, the runner label and the multiplier APPLIED', () => {
    // This is what makes a later repricing a recomputation rather than a
    // backfill — and what stops already-charged history from silently re-pricing.
    const usage = normalizeRunUsage(
      [jobOfMinutes('mac', 2, ['macos-14']), jobOfMinutes('linux', 3, ['ubuntu-latest'])],
      COMPLETED_AT,
    );
    expect(usage.breakdown).toEqual([
      {
        family: 'linux_x64',
        multiplier: 1,
        billableMinutes: 3,
        rawWallClockSeconds: 180,
        linearEquivalentMinutes: 3,
        jobCount: 1,
        unpriced: false,
      },
      {
        family: 'macos',
        multiplier: 10.33,
        billableMinutes: 2,
        rawWallClockSeconds: 120,
        linearEquivalentMinutes: 20.66,
        jobCount: 1,
        unpriced: false,
      },
    ]);
  });

  it('orders the breakdown deterministically (it is persisted and asserted on)', () => {
    const a = normalizeRunUsage(
      [jobOfMinutes('m', 1, ['macos-14']), jobOfMinutes('l', 1, ['ubuntu-latest'])],
      COMPLETED_AT,
    );
    const b = normalizeRunUsage(
      [jobOfMinutes('l', 1, ['ubuntu-latest']), jobOfMinutes('m', 1, ['macos-14'])],
      COMPLETED_AT,
    );
    expect(a.breakdown.map((e) => e.family)).toEqual(b.breakdown.map((e) => e.family));
  });

  it('prices the run at the rates in force WHEN IT RAN, not today’s', () => {
    // A run predating the rate table takes the x1.00 fallback for every family.
    const usage = normalizeRunUsage(
      [jobOfMinutes('mac', 10, ['macos-14'])],
      new Date('2025-06-01T00:00:00.000Z'),
    );
    expect(usage.linearEquivalentMinutes).toBe(10);
    expect(usage.unpricedFamilies).toEqual(['macos']);
  });
});

describe('normalizeRunUsage — malformed / incomplete jobs', () => {
  it('skips a job missing either timestamp', () => {
    const usage = normalizeRunUsage(
      [
        job({ id: 'no-start', startedAt: null }),
        job({ id: 'no-end', completedAt: null }),
        jobOfMinutes('ok', 4),
      ],
      COMPLETED_AT,
    );
    expect(usage.jobCount).toBe(1);
    expect(usage.billableMinutes).toBe(4);
  });

  it('skips a NEGATIVE span rather than letting it subtract from a real job', () => {
    const startedAt = new Date('2026-07-30T11:10:00.000Z');
    const usage = normalizeRunUsage(
      [
        {
          id: 'bad',
          name: 'bad',
          startedAt,
          completedAt: new Date(startedAt.getTime() - 60_000),
          labels: ['ubuntu-latest'],
        },
        jobOfMinutes('ok', 4),
      ],
      COMPLETED_AT,
    );
    expect(usage.billableMinutes).toBe(4);
    expect(usage.jobCount).toBe(1);
  });

  it('returns a zeroed usage for an empty job list', () => {
    const usage = normalizeRunUsage([], COMPLETED_AT);
    expect(usage).toEqual({
      billableMinutes: 0,
      rawWallClockSeconds: 0,
      linearEquivalentMinutes: 0,
      jobCount: 0,
      breakdown: [],
      unpricedFamilies: [],
    });
  });
});
