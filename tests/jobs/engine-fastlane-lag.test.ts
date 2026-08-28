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

  // ⚠️ A TEST STOOD HERE AND ITS SOURCE OF TRUTH IS DELETED (MOTIR-3418). It read
  // `scripts/experiments/inngest-fastlane-lag.mjs` — the PREDECESSOR probe — out
  // of the tree, extracted its `quantile` with a regex, and asserted the two
  // implementations agreed over four sample sets and seven quantiles. The point
  // was that 29.4 s (the old substrate) and whatever this probe returns are only
  // a BEFORE and an AFTER if they are the same statistic, and a retyped copy would
  // drift silently.
  //
  // The predecessor went with the dependency it drove. The comparison it
  // protected is preserved where it is actually consumed: both readings live in
  // `FAST_LANE_LATENCY_BUDGET` (`inngestBaseline` and `engineBaseline`), and
  // `tests/jobs/fast-lane-latency-budget.test.ts` asserts both are present with
  // real sample counts — so the pair cannot quietly become one number. What can no
  // longer be re-derived is the equality of the two implementations, and that is a
  // real loss to state rather than paper over: the old figure is now a recorded
  // measurement rather than a reproducible one.
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

  // ── MOTIR-3593 ──────────────────────────────────────────────────────────────
  // The probe followed its own HOW TO RUN block onto the POOLED url, saw nothing
  // through FORCE ROW LEVEL SECURITY, and printed `samples: 0 — no fast-lane
  // engine runs in this window`. That is a false statement about the world
  // reached through a correct guard, and the guard it needed is on ABSENCE: what
  // the CONNECTION can see, asserted before the measuring query is issued.

  it('prefers the UNPOOLED url and treats an EMPTY variable as absent', () => {
    // `??` would hand `new pg.Client` the empty string; the empty variable is how
    // the pooled fallback (and so the refusal) is forced inside the machine, where
    // both variables are set.
    expect(probe.resolveConnection({ DATABASE_URL_UNPOOLED: 'u', DATABASE_URL: 'p' })).toEqual({
      name: 'DATABASE_URL_UNPOOLED',
      connectionString: 'u',
    });
    expect(probe.resolveConnection({ DATABASE_URL_UNPOOLED: '', DATABASE_URL: 'p' })).toEqual({
      name: 'DATABASE_URL',
      connectionString: 'p',
    });
    expect(probe.resolveConnection({ DATABASE_URL: 'p' })).toEqual({
      name: 'DATABASE_URL',
      connectionString: 'p',
    });
    expect(probe.resolveConnection({})).toBeNull();
  });

  const POOLED = {
    role: 'motir_app',
    bypasses_rls: false,
    system_admin: false,
    workspace_id: '',
    job_run_forced: true,
    job_event_forced: true,
    urlEnv: 'DATABASE_URL',
  };

  it('REFUSES a connection that cannot see the ledger, and admits the three that can', () => {
    // The observed production shape: motir_app, no bypass, no GUC, both tables
    // FORCE RLS. This is the case that produced `samples: 0` against 226 rows.
    expect(probe.canSeeLedger(POOLED)).toBe(false);

    // rolbypassrls (DATABASE_URL_UNPOOLED / neondb_owner).
    expect(probe.canSeeLedger({ ...POOLED, bypasses_rls: true })).toBe(true);
    // The policies' own first branch: current_setting('app.system_admin') = 'true'.
    expect(probe.canSeeLedger({ ...POOLED, system_admin: true })).toBe(true);
    // A database built without the RLS migrations — nothing to be blind to, so the
    // guard must not refuse an otherwise-legitimate local run.
    expect(probe.canSeeLedger({ ...POOLED, job_run_forced: false, job_event_forced: false })).toBe(
      true,
    );
    // ⚠️ One table still forced is still blind — the query JOINS them.
    expect(probe.canSeeLedger({ ...POOLED, job_event_forced: false })).toBe(false);
  });

  it('does NOT accept a workspace GUC as visibility — that is a different statistic', () => {
    // A tenant-scoped p95 is not the lane-wide p95 this script reports, and the
    // whole epic is judged on comparing two p95s. Narrowing silently is the shape
    // the refusal exists to prevent.
    const scoped = { ...POOLED, workspace_id: 'ws_123' };
    expect(probe.canSeeLedger(scoped)).toBe(false);
    expect(probe.formatBlindRead(scoped)).toContain('could see ONE tenant');
  });

  it('names the reason in the refusal — never a number, never a verdict about the world', () => {
    const text = probe.formatBlindRead(POOLED);
    expect(text).toContain('BLIND READ');
    expect(text).toContain('motir_app');
    expect(text).toContain('DATABASE_URL_UNPOOLED');
    // The two sentences the card is about: the refusal must deny both readings the
    // old output invited.
    expect(text).toContain('NOT a latency of zero');
    expect(text).toContain('no fast-lane engine runs');
    // …and it must not itself report a figure.
    expect(text).not.toContain('samples:');
    expect(probe.EXIT_BLIND_READ).toBe(3);
    expect(probe.EXIT_USAGE).toBe(2);
  });

  it('asks the visibility question with a READ, and about the tables it joins', () => {
    expect(probe.CONNECTION_SQL).toContain('rolbypassrls');
    expect(probe.CONNECTION_SQL).toContain('app.system_admin');
    expect(probe.CONNECTION_SQL).toContain('relforcerowsecurity');
    expect(probe.CONNECTION_SQL).toContain("to_regclass('job_run')");
    expect(probe.CONNECTION_SQL).toContain("to_regclass('job_event')");
    expect(probe.CONNECTION_SQL.trim().toUpperCase().startsWith('SELECT')).toBe(true);
  });

  it('documents a HOW TO RUN block that the deployed image can actually execute', () => {
    // Both halves of MOTIR-3593's second defect: `scripts/` is not in the standalone
    // image, and the direct-invocation guard means the upload must keep the basename.
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toContain('base64 -d > /app/engine-fastlane-lag.mjs');
    expect(source).toContain('KEEP THIS BASENAME');
    expect(source).toContain("endsWith('engine-fastlane-lag.mjs')");
    // The header must no longer prescribe the path that does not exist in the image.
    expect(source).not.toContain("'node scripts/experiments/engine-fastlane-lag.mjs --hours 72'");
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
