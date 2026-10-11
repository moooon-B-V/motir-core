import { PerformanceObserver } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROCESS_PRESSURE_TAG,
  processPressureTags,
  rollProcessPressureWindow,
  setProcessPressureReadersForTest,
  startProcessPressure,
  stopProcessPressure,
} from '@/lib/monitoring/processPressure';
import {
  startTransactionStallMonitor,
  stopTransactionStallMonitor,
  transactionStallTags,
} from '@/lib/monitoring/transactionStall';

// WHAT HELD THE CPU — GC, HEAP, CGROUP THROTTLE, STEAL (MOTIR-8264).
//
// The readings that separate three of MOTIR-8262's stall causes without a stack.
// The CPU counters are driven by FIXTURE text through the reader seam, so the
// delta arithmetic and every `unmeasured` arm are asserted on any host — the
// suite's own runner may have no cgroup v2 file and macOS has no `/proc` at all.

const P2028 = () =>
  Object.assign(
    new Error('Transaction API error: Unable to start a transaction in the given time.'),
    {
      code: 'P2028',
    },
  );

const CPU_KEYS = [
  PROCESS_PRESSURE_TAG.cgroupNrThrottled,
  PROCESS_PRESSURE_TAG.cgroupThrottledMs,
  PROCESS_PRESSURE_TAG.cpuStealMs,
];

function cpuStat(nrThrottled: number | null, throttledUsec: number): string {
  return [
    'usage_usec 9000000',
    'user_usec 6000000',
    'system_usec 3000000',
    'nr_periods 400',
    ...(nrThrottled === null ? [] : [`nr_throttled ${nrThrottled}`]),
    `throttled_usec ${throttledUsec}`,
  ].join('\n');
}

/** `/proc/stat` with `steal` (the 8th number of the `cpu` line) set. */
function procStat(stealTicks: number): string {
  return [
    `cpu  100 0 50 1000 5 0 2 ${stealTicks} 0 0`,
    `cpu0 50 0 25 500 2 0 1 ${stealTicks} 0 0`,
    'intr 12345',
  ].join('\n');
}

/** Readers that hand out `texts` one per read, repeating the last. */
function sequence(texts: (string | null)[]): () => string | null {
  let index = 0;
  return () => texts[Math.min(index++, texts.length - 1)] ?? null;
}

function numeric(tags: Record<string, string>, key: string): number {
  expect(tags[key], `${key} should be a number, got ${tags[key]}`).toMatch(/^\d+$/);
  return Number(tags[key]);
}

/** A major collection, on demand, then one turn for the observer's callback. */
async function forceMajorGc(): Promise<void> {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  stopTransactionStallMonitor();
  stopProcessPressure();
  setProcessPressureReadersForTest(null);
});

afterEach(() => {
  stopTransactionStallMonitor();
  stopProcessPressure();
  setProcessPressureReadersForTest(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('on a P2028, with the monitor started', () => {
  it('carries GC and heap readings as numbers, the heap below its limit', () => {
    startTransactionStallMonitor();
    const tags = transactionStallTags(P2028())!;
    numeric(tags, PROCESS_PRESSURE_TAG.gcPauseMaxMs);
    numeric(tags, PROCESS_PRESSURE_TAG.gcPauseTotalMs);
    numeric(tags, PROCESS_PRESSURE_TAG.gcMajorCount);
    const used = numeric(tags, PROCESS_PRESSURE_TAG.heapUsedMb);
    const limit = numeric(tags, PROCESS_PRESSURE_TAG.heapLimitMb);
    expect(used).toBeGreaterThan(0);
    expect(limit).toBeGreaterThan(used);
  });

  it('still returns null for an error that is not a transaction timeout', () => {
    startTransactionStallMonitor();
    expect(transactionStallTags(new Error('boom'))).toBeNull();
  });
});

describe('GC over the two-window span', () => {
  it('counts a forced major collection, keeps it across one roll, and forgets it after two', async () => {
    startProcessPressure();
    await forceMajorGc();

    const after = processPressureTags();
    expect(numeric(after, PROCESS_PRESSURE_TAG.gcMajorCount)).toBeGreaterThanOrEqual(1);
    numeric(after, PROCESS_PRESSURE_TAG.gcPauseMaxMs);

    rollProcessPressureWindow();
    expect(
      numeric(processPressureTags(), PROCESS_PRESSURE_TAG.gcMajorCount),
    ).toBeGreaterThanOrEqual(1);

    // Two rolls with no collection between them: the span holds none, and that
    // zero was measured — so it reads `0`, not `unmeasured`.
    rollProcessPressureWindow();
    expect(processPressureTags()[PROCESS_PRESSURE_TAG.gcMajorCount]).toBe('0');
  });
});

describe('the CPU counters (cgroup throttle + steal)', () => {
  it('read `unmeasured` when neither file can be read', () => {
    setProcessPressureReadersForTest({ readCgroupCpuStat: () => null, readProcStat: () => null });
    startProcessPressure();
    const tags = processPressureTags();
    for (const key of CPU_KEYS) expect(tags[key]).toBe('unmeasured');
  });

  it('read `unmeasured` for a counter whose key the cgroup file lacks', () => {
    setProcessPressureReadersForTest({
      readCgroupCpuStat: () => cpuStat(null, 1_000_000),
      readProcStat: () => procStat(40),
    });
    startProcessPressure();
    const tags = processPressureTags();
    expect(tags[PROCESS_PRESSURE_TAG.cgroupNrThrottled]).toBe('unmeasured');
    expect(tags[PROCESS_PRESSURE_TAG.cgroupThrottledMs]).toBe('0');
  });

  it('report the DELTA from the start reading before any roll, not the absolute counters', () => {
    setProcessPressureReadersForTest({
      readCgroupCpuStat: sequence([cpuStat(10, 1_000_000), cpuStat(13, 1_600_000)]),
      readProcStat: sequence([procStat(40), procStat(65)]),
    });
    startProcessPressure();
    const tags = processPressureTags();
    expect(tags[PROCESS_PRESSURE_TAG.cgroupNrThrottled]).toBe('3');
    expect(tags[PROCESS_PRESSURE_TAG.cgroupThrottledMs]).toBe('600');
    expect(tags[PROCESS_PRESSURE_TAG.cpuStealMs]).toBe('250');
  });

  it('measure from the start of the PREVIOUS window after a roll', () => {
    // start → first roll → tag time → second roll → tag time.
    setProcessPressureReadersForTest({
      readCgroupCpuStat: sequence([
        cpuStat(10, 1_000_000),
        cpuStat(12, 2_000_000),
        cpuStat(17, 3_500_000),
        cpuStat(20, 4_000_000),
        cpuStat(21, 4_250_000),
      ]),
      readProcStat: sequence([
        procStat(40),
        procStat(90),
        procStat(140),
        procStat(150),
        procStat(170),
      ]),
    });
    startProcessPressure();
    rollProcessPressureWindow();

    const afterOne = processPressureTags();
    expect(afterOne[PROCESS_PRESSURE_TAG.cgroupThrottledMs]).toBe('2500');
    expect(afterOne[PROCESS_PRESSURE_TAG.cgroupNrThrottled]).toBe('7');
    expect(afterOne[PROCESS_PRESSURE_TAG.cpuStealMs]).toBe('1000');

    // The second roll moves the baseline to the first roll's reading.
    rollProcessPressureWindow();
    const afterTwo = processPressureTags();
    expect(afterTwo[PROCESS_PRESSURE_TAG.cgroupThrottledMs]).toBe('2250');
    expect(afterTwo[PROCESS_PRESSURE_TAG.cgroupNrThrottled]).toBe('9');
    expect(afterTwo[PROCESS_PRESSURE_TAG.cpuStealMs]).toBe('800');
  });

  it('roll on the event-loop monitor’s existing 30 s timer — no clock of their own', () => {
    vi.useFakeTimers();
    const cgroupReads = vi.fn(() => cpuStat(1, 1_000));
    setProcessPressureReadersForTest({ readCgroupCpuStat: cgroupReads, readProcStat: () => null });
    startTransactionStallMonitor();
    expect(cgroupReads).toHaveBeenCalledTimes(1); // the start reading
    vi.advanceTimersByTime(30_000);
    expect(cgroupReads).toHaveBeenCalledTimes(2); // the roll's reading
  });
});

describe('with the monitor not running', () => {
  it('reads every new tag as `unmeasured`, never a zero', () => {
    const tags = transactionStallTags(P2028())!;
    for (const key of Object.values(PROCESS_PRESSURE_TAG)) expect(tags[key]).toBe('unmeasured');
  });

  it('is torn down by stopTransactionStallMonitor, which disconnects the GC observer', () => {
    const disconnect = vi.spyOn(PerformanceObserver.prototype, 'disconnect');
    startTransactionStallMonitor();
    stopTransactionStallMonitor();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(processPressureTags()[PROCESS_PRESSURE_TAG.heapUsedMb]).toBe('unmeasured');
  });
});
