import { describe, expect, it } from 'vitest';
import {
  cpuCandidate,
  onsetOf,
  rankCandidates,
  readCandidates,
  type BottleneckContext,
} from '@/loadtest/report/bottleneck';
import { ok, unmeasured } from '@/loadtest/report/inputs';
import { createPromClient } from '@/loadtest/report/prometheus';
import {
  APP,
  STEADY_START,
  T0,
  TOKEN,
  healthyProm,
  promStub,
  runRecord,
  withHandlers,
  type Handler,
} from './reportFixture';

// The first-bottleneck ranking (Story MOTIR-8538 · MOTIR-8679): five candidates read
// as time series, a 30 s hold, the earliest onset first, ties in the listed order,
// and a missing series that makes its own candidate unmeasured without stopping the
// ranking. The steady window here is 600 s from STEADY_START.

const S = STEADY_START / 1000;
const CONFIG = {
  holdSeconds: 30,
  proxyHardLimitFraction: 1,
  cpuBusyFraction: 0.9,
  cpuThrottleMax: 0.05,
  memoryAvailableMin: 0.1,
  poolWaitingMean: 1,
  poolWaitP95Seconds: 0.25,
  dbActiveFraction: 0.9,
  dbLockWaiting: 5,
};

function ctx(handlers: Handler[]): BottleneckContext {
  const stub = promStub(handlers);
  return {
    prom: createPromClient({
      app: APP,
      env: { LOADTEST_FLY_PROM_TOKEN: TOKEN },
      exec: async () => ({ code: 1, stdout: '', stderr: '' }),
      fetchImpl: stub.fetchImpl,
    }),
    steady: { start: STEADY_START, end: STEADY_START + 600_000 },
    machines: runRecord(1).app.machines as never,
    hardLimit: 1200,
    config: CONFIG,
    dbSamples: ok(
      Array.from({ length: 60 }, (_, i) => ({
        at: new Date(STEADY_START + i * 10_000).toISOString(),
        backends: 10,
        active: 3,
        idle_in_transaction: 0,
        lock_waiting: 0,
        max_connections: 100,
      })),
    ),
    endpointStart: unmeasured('not read'),
    endpointEnd: unmeasured('not read'),
    readerStreamsPerInstance: 6,
    proxyShedSummary: 'platform 503 0, log codes 0, client http_503 0',
  };
}

/** `fly_app_concurrency` at the hard limit between `from` and `to` seconds into steady. */
const proxyAt = (from: number, to = Infinity): Handler => [
  /fly_app_concurrency/,
  (t) => [{ labels: { instance: 'm1' }, value: t >= S + from && t <= S + to ? 1200 : 40 }],
];

/** `fly_instance_cpu` (centiseconds) rising 30/s, then `rate`/s from `from` seconds into steady. */
const cpuFrom = (from: number, rate = 90): Handler => [
  /fly_instance_cpu\{/,
  (t) => {
    const base = (t - T0 / 1000) * 30;
    const extra = Math.max(0, t - (S + from)) * (rate - 30);
    return [
      { labels: { instance: 'm1', mode: 'user' }, value: base + extra },
      { labels: { instance: 'm1', mode: 'steal' }, value: (t - T0 / 1000) * 2 },
      { labels: { instance: 'm1', mode: 'idle' }, value: (t - T0 / 1000) * 50 },
    ];
  },
];

const FALLBACK = {
  worstRouteByP95: 'mcp get_work_item',
  worstWaitRoute: 'mcp',
  topStatement: 'SELECT 1',
};

describe('onsetOf', () => {
  const ticks = (sat: [number, boolean][]) =>
    sat.map(([t, saturated]) => ({ t: t * 1000, saturated }));

  it('needs an unbroken run spanning the hold', () => {
    expect(
      onsetOf(
        ticks([
          [0, true],
          [15, true],
          [30, true],
        ]),
        30,
      ),
    ).toBe(0);
    expect(
      onsetOf(
        ticks([
          [0, true],
          [10, true],
          [20, true],
        ]),
        30,
      ),
    ).toBeNull();
    expect(
      onsetOf(
        ticks([
          [0, true],
          [15, false],
          [30, true],
          [45, true],
          [60, true],
        ]),
        30,
      ),
    ).toBe(30_000);
  });

  it('any instance saturated at an instant saturates the candidate', () => {
    expect(
      onsetOf(
        [
          ...ticks([
            [0, true],
            [15, true],
            [30, true],
          ]),
          ...ticks([
            [0, false],
            [15, false],
            [30, false],
          ]),
        ],
        30,
      ),
    ).toBe(0);
  });
});

describe('the ranking', () => {
  it('the proxy at its hard limit from 120 s beats CPU ≥ 0.9 from 300 s', async () => {
    const cands = await readCandidates(
      ctx(withHandlers(healthyProm(1), proxyAt(120), cpuFrom(300))),
    );
    expect(cands.find((c) => c.name === 'cpu')!.state).toBe('saturated');
    const first = rankCandidates(cands, false, FALLBACK);
    expect(first).toEqual({
      kind: 'candidate',
      name: 'proxy',
      onset: new Date((S + 120) * 1000).toISOString(),
    });
  });

  it('CPU alone names app CPU', async () => {
    const cands = await readCandidates(ctx(withHandlers(healthyProm(1), cpuFrom(300))));
    expect(rankCandidates(cands, false, FALLBACK)).toMatchObject({
      kind: 'candidate',
      name: 'cpu',
    });
  });

  it('a predicate holding only 20 s does not count', async () => {
    const cands = await readCandidates(ctx(withHandlers(healthyProm(1), proxyAt(120, 140))));
    expect(cands.find((c) => c.name === 'proxy')!.state).toBe('not reached');
    expect(rankCandidates(cands, false, FALLBACK)).toEqual({ kind: 'none' });
  });

  it('nothing saturated with a FAIL is unattributed, with its three rows', async () => {
    const cands = await readCandidates(ctx(healthyProm(1)));
    expect(rankCandidates(cands, true, FALLBACK)).toEqual({ kind: 'unattributed', ...FALLBACK });
  });

  it('a missing Fly series makes that candidate unmeasured and the ranking goes on', async () => {
    const cands = await readCandidates(
      ctx(withHandlers(healthyProm(1), proxyAt(120), [/fly_instance_cpu\{/, () => []])),
    );
    expect(cands.find((c) => c.name === 'cpu')).toMatchObject({
      state: 'unmeasured',
      reason: 'fly_instance_cpu is absent for this app',
    });
    expect(rankCandidates(cands, false, FALLBACK)).toMatchObject({
      kind: 'candidate',
      name: 'proxy',
    });
  });

  it('a database with ≥ 5 backends waiting on a Lock saturates the database candidate', async () => {
    const c = ctx(healthyProm(1));
    c.dbSamples = ok(
      Array.from({ length: 60 }, (_, i) => ({
        at: new Date(STEADY_START + i * 10_000).toISOString(),
        backends: 10,
        active: 3,
        idle_in_transaction: 0,
        lock_waiting: i >= 20 ? 6 : 0,
        max_connections: 100,
      })),
    );
    const cands = await readCandidates(c);
    expect(rankCandidates(cands, false, FALLBACK)).toEqual({
      kind: 'candidate',
      name: 'database',
      onset: new Date(STEADY_START + 200_000).toISOString(),
    });
  });
});

describe('the CPU candidate', () => {
  it('reads busy CPUs from the centisecond counter: 90/s on a 1-cpu machine is 0.9', async () => {
    const c = await cpuCandidate(
      ctx(
        withHandlers(healthyProm(1), [
          /fly_instance_cpu\{/,
          (t) => [
            { labels: { instance: 'm1', mode: 'user' }, value: (t - T0 / 1000) * 90 },
            { labels: { instance: 'm1', mode: 'idle' }, value: (t - T0 / 1000) * 10 },
          ],
        ]),
      ),
    );
    expect(c.peak).toBe("0.9 of the machine's CPUs busy");
    expect(c.state).toBe('saturated');
  });

  it('counts steal as busy and prints its rate', async () => {
    const c = await cpuCandidate(ctx(withHandlers(healthyProm(1), cpuFrom(0, 88))));
    expect(c.peak).toBe("0.9 of the machine's CPUs busy");
    expect(c.beside[0]).toBe('steal peak 0.02 CPU-s/s');
  });

  it('prints the steal rate and the throttle rate beside it, and a throttled machine saturates', async () => {
    const c = await cpuCandidate(
      ctx(
        withHandlers(healthyProm(1), [
          /fly_instance_cpu_throttle/,
          (t) => [{ labels: { instance: 'm1' }, value: Math.max(0, t - (S + 60)) * 10 }],
        ]),
      ),
    );
    expect(c.beside).toEqual(['steal peak 0 CPU-s/s', 'throttle peak 0.1 CPU-s/s (limit 0.05)']);
    expect(c.state).toBe('saturated');
  });

  it('a missing fly_instance_cpu series is unmeasured', async () => {
    const c = await cpuCandidate(
      ctx(withHandlers(healthyProm(1), [/fly_instance_cpu\{/, () => []])),
    );
    expect(c.state).toBe('unmeasured');
  });
});
