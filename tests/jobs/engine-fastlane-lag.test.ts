import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAST_LANE_CONSUMER_IDS } from '@/lib/jobs/latencyBudget';
import * as probe from '@/scripts/experiments/engine-fastlane-lag.mjs';

// THE ENGINE'S FAST-LANE LATENCY PROBE (Story MOTIR-3415 · Subtask MOTIR-3457).
//
// ⚠️ THE EXPECTED VALUES BELOW ARE COMPUTED BY HAND, never by the function under
// test. A percentile test whose expectations come from the implementation
// asserts only that the code is deterministic — it would pass just as happily
// against an off-by-one rank, which is the single most likely defect in a
// nearest-rank quantile and the one that would silently make the epic's
// before/after comparison meaningless.

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'experiments', 'engine-fastlane-lag.mjs');

describe('the percentile arithmetic', () => {
  // Ten values, ascending, so every rank is checkable by counting.
  //   n = 10
  //   median → ceil(0.5 * 10) - 1 = 4  → the 5th value  = 500
  //   p95    → ceil(0.95 * 10) - 1 = 9 → the 10th value = 1000
  const TEN = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

  it('takes the nearest RANK, with no interpolation', () => {
    expect(probe.quantile(TEN, 0.5)).toBe(500);
    expect(probe.quantile(TEN, 0.95)).toBe(1000);
    // An interpolating implementation would return 550 and 955 here, so these
    // two assertions are what distinguish the methods.
    expect(probe.quantile(TEN, 0.5)).not.toBe(550);
  });

  it('clamps both ends rather than reading out of range', () => {
    expect(probe.quantile(TEN, 0)).toBe(100);
    expect(probe.quantile(TEN, 1)).toBe(1000);
    expect(probe.quantile([42], 0.95)).toBe(42);
  });

  it('returns NaN on an empty set rather than 0', () => {
    // 0 would be a LATENCY. NaN forces the caller to decide, and `summarise`
    // turns it into `samples: 0` with null figures.
    expect(Number.isNaN(probe.quantile([], 0.95))).toBe(true);
  });

  it('agrees with the PREDECESSOR on the same inputs', () => {
    // The comparison the budget rests on is 29.4s (Inngest) against whatever the
    // engine returns. Two p95s computed differently are not a before and an
    // after, so the two implementations are asserted to be the same function.
    const predecessor = readFileSync(
      join(REPO_ROOT, 'scripts', 'experiments', 'inngest-fastlane-lag.mjs'),
      'utf8',
    );
    const match = predecessor.match(/const quantile = \(sorted, q\) => \{[\s\S]*?\n\};/);
    expect(
      match,
      'the predecessor no longer defines `quantile` in the expected shape',
    ).not.toBeNull();
    // Reading the predecessor's OWN source is the point: a copy retyped here
    // could drift from it silently, and then the two lanes' p95s would quietly
    // stop being the same statistic.
    const theirs = new Function(`${match![0]} return quantile;`)() as (
      s: number[],
      q: number,
    ) => number;

    for (const q of [0, 0.25, 0.5, 0.9, 0.95, 0.99, 1]) {
      for (const set of [TEN, [1, 2, 3], [7], [5, 5, 5, 5]]) {
        expect(probe.quantile(set, q), `q=${q} over ${set.length} values`).toBe(theirs(set, q));
      }
    }
  });
});

describe('the six reported fields', () => {
  const WINDOW = { measuredOn: '2026-08-25', windowHours: 72 };

  it('reports the arithmetically correct median, p95 and max', () => {
    // Lags in ms, deliberately unsorted on the way in.
    //   sorted: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], n = 10
    //   median = 5th  = 500   ·   p95 = 10th = 1000   ·   max = 1000
    const lags = [500, 100, 900, 300, 1000, 200, 800, 400, 700, 600];
    expect(probe.summarise(lags, WINDOW)).toEqual({
      measuredOn: '2026-08-25',
      windowHours: 72,
      samples: 10,
      medianMs: 500,
      p95Ms: 1000,
      maxMs: 1000,
    });
  });

  it('reports samples: 0 with NULL figures on an empty window — never zeros, never NaN', () => {
    const summary = probe.summarise([], WINDOW);
    expect(summary).toEqual({
      measuredOn: '2026-08-25',
      windowHours: 72,
      samples: 0,
      medianMs: null,
      p95Ms: null,
      maxMs: null,
    });
    // An empty read defaulting to 0 would read as a PERFECT latency — the
    // opposite of what it means.
    expect(summary.medianMs).not.toBe(0);
    expect(JSON.stringify(summary)).not.toContain('null,"p95Ms":0');
    expect(Object.values(summary).some((v) => typeof v === 'number' && Number.isNaN(v))).toBe(
      false,
    );
  });
});

describe('one sample per EVENT, from the earliest consumer', () => {
  it('takes the MINIMUM start across an event fan-out', () => {
    // One event, four consumers starting 1s/2s/5s/9s after receipt. A stale
    // tracker is about the first thing to react, so the lag is 1000 — taking the
    // max would measure the slowest consumer's own work instead of the queue.
    const lags = probe.lagsPerEvent([
      { eventId: 'e1', receivedAt: 1_000, startedAt: 10_000 },
      { eventId: 'e1', receivedAt: 1_000, startedAt: 2_000 },
      { eventId: 'e1', receivedAt: 1_000, startedAt: 6_000 },
      { eventId: 'e1', receivedAt: 1_000, startedAt: 3_000 },
    ]);
    expect(lags).toEqual([1_000]);
  });

  it('yields one lag per distinct event', () => {
    const lags = probe.lagsPerEvent([
      { eventId: 'e1', receivedAt: 0, startedAt: 500 },
      { eventId: 'e2', receivedAt: 0, startedAt: 1_500 },
    ]);
    expect(lags.sort((a: number, b: number) => a - b)).toEqual([500, 1_500]);
  });

  it('DISCARDS a negative lag as clock skew rather than clamping it to zero', () => {
    // Clamping would manufacture a perfect sample out of a broken one and pull
    // the median down.
    expect(probe.lagsPerEvent([{ eventId: 'e1', receivedAt: 5_000, startedAt: 4_000 }])).toEqual(
      [],
    );
  });
});

describe('the script itself', () => {
  it('covers exactly the budget’s consumer set', () => {
    // The script is `.mjs` and cannot import the `.ts` constant, so this is what
    // stops the duplicated list becoming a second source of truth. A fifth
    // consumer added to the lane fails here.
    expect([...probe.FAST_LANE_CONSUMER_IDS].sort()).toEqual([...FAST_LANE_CONSUMER_IDS].sort());
  });

  it('performs NO write — asserted by reading the file', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    // Strip the header prose, which legitimately NAMES these statements while
    // promising not to perform them. Counting the word rather than the statement
    // is the mistake the sibling emit-seam guard exists to avoid.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const write of ['INSERT', 'UPDATE ', 'DELETE', 'TRUNCATE', 'DROP ', 'ALTER ']) {
      expect(code.toUpperCase(), `the script must not ${write.trim()}`).not.toContain(write);
    }
  });

  it('states the exact pair of columns it reports the difference of, and cites where', () => {
    const header = readFileSync(SCRIPT, 'utf8').slice(0, 4_000);
    expect(header).toContain('job_run.started_at');
    expect(header).toContain('job_event.received_at');
    expect(header).toContain('job_event.id = job_run.event_id');
    // The citation the card asks for — the join was read off the code, not
    // inferred from the column names.
    expect(header).toContain('lib/jobs/engine/ledger.ts');
    expect(header).toContain('ledgerIdentity');
  });

  it('does not EDIT the budget constant — that is the re-measurement card', () => {
    // The header legitimately NAMES `lib/jobs/latencyBudget.ts` (it says the
    // result drops into `baseline`), so the assertion is about writing, not
    // mentioning: the script touches no file at all.
    const source = readFileSync(SCRIPT, 'utf8');
    for (const write of ['writeFileSync', 'appendFileSync', 'createWriteStream', 'fs.write']) {
      expect(source, `the script must not ${write}`).not.toContain(write);
    }
    expect(source).not.toContain('FAST_LANE_LATENCY_BUDGET =');
  });
});
