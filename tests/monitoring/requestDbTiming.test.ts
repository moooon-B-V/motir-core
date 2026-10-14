import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordTransactionMeasurement,
  registerRequestDbTimingListener,
  REQUEST_DB_TIMING_METRICS as M,
  requestDbTimingRegistry,
  resetRequestDbTimingForTests,
} from '@/lib/monitoring/requestDbTiming';
import { registerKnownMcpTool, withRequestLabel } from '@/lib/monitoring/requestLabel';
import {
  clearTransactionStallPools,
  registerTransactionStallPool,
  type PoolOccupancy,
} from '@/lib/monitoring/transactionStall';
import {
  measureTransactionAttempt,
  type TransactionMeasurement,
} from '@/lib/monitoring/transactionSpan';

// MOTIR-8553 — the every-request recorder, with no database and no Sentry. A
// measurement is produced the way production produces one — through
// `measureTransactionAttempt`, which emits to every `onTransactionMeasured`
// listener — so what is proven is the listener's path, not a direct call.

type Labels = Record<string, string>;

async function metricValues(name: string) {
  const metric = requestDbTimingRegistry().getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  return (await metric.get()).values as { labels: Labels; value: number; metricName?: string }[];
}

/** The `_count` of a histogram (or a counter's value) for exactly these labels. */
async function countOf(name: string, labels: Labels): Promise<number> {
  const values = await metricValues(name);
  const matches = values.filter(
    (v) =>
      (v.metricName === undefined || v.metricName === `${name}_count`) &&
      Object.entries(labels).every(([k, want]) => v.labels[k] === want),
  );
  return matches.reduce((sum, v) => sum + v.value, 0);
}

async function sumOf(name: string, labels: Labels): Promise<number> {
  const values = await metricValues(name);
  return values
    .filter(
      (v) =>
        v.metricName === `${name}_sum` &&
        Object.entries(labels).every(([k, want]) => v.labels[k] === want),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

async function totalCount(name: string): Promise<number> {
  const values = await metricValues(name);
  return values
    .filter((v) => v.metricName === undefined || v.metricName === `${name}_count`)
    .reduce((sum, v) => sum + v.value, 0);
}

/** A committed transaction, measured as a helper measures one. */
function committed(): Promise<number> {
  return measureTransactionAttempt(
    'workspace',
    1,
    (bodyStarted, settled) => settled(Promise.resolve(bodyStarted(() => 42))),
    () => {},
  );
}

/** An attempt that failed before its body — `holdMs` is null. */
function failedBeforeBody(): Promise<unknown> {
  return measureTransactionAttempt(
    'system',
    1,
    () => Promise.reject(new Error('no connection')),
    () => {},
  ).catch(() => undefined);
}

const POOL: PoolOccupancy & { options: { max: number } } = {
  totalCount: 6,
  idleCount: 1,
  waitingCount: 5,
  options: { max: 10 },
};

beforeEach(() => {
  resetRequestDbTimingForTests();
  clearTransactionStallPools();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRequestDbTimingForTests();
  clearTransactionStallPools();
});

describe('a measurement lands in the right series', () => {
  it('under a label: one wait and one hold observation with every label', async () => {
    registerRequestDbTimingListener();
    registerTransactionStallPool(POOL);
    await withRequestLabel({ route: 'plan_get' }, committed);

    const labels = {
      route: 'plan_get',
      tool: '',
      context: 'workspace',
      outcome: 'committed',
      attempt: '1',
    };
    expect(await countOf(M.wait, labels)).toBe(1);
    expect(await countOf(M.hold, labels)).toBe(1);
    expect(await totalCount(M.wait)).toBe(1);
    expect(await totalCount(M.hold)).toBe(1);
  });

  it('with no label: route="unlabelled"', async () => {
    registerRequestDbTimingListener();
    await committed();
    expect(await countOf(M.wait, { route: 'unlabelled', tool: '' })).toBe(1);
  });

  it('a P2028-before-body attempt (holdMs null) records wait only', async () => {
    registerRequestDbTimingListener();
    await failedBeforeBody();
    expect(await countOf(M.wait, { route: 'unlabelled', outcome: 'error_before_body' })).toBe(1);
    expect(await totalCount(M.hold)).toBe(0);
  });

  it('records the seconds, not the milliseconds', async () => {
    registerRequestDbTimingListener();
    const m: TransactionMeasurement = {
      context: 'org',
      attempt: 2,
      waitMs: 250,
      holdMs: 1500,
      outcome: 'committed',
      pool: 'unmeasured',
    };
    withRequestLabel({ route: 'workbench' }, () => recordTransactionMeasurement(m));
    expect(await sumOf(M.wait, { route: 'workbench', attempt: '2' })).toBeCloseTo(0.25);
    expect(await sumOf(M.hold, { route: 'workbench', attempt: '2' })).toBeCloseTo(1.5);
  });
});

describe('pool occupancy at acquire', () => {
  it('is observed per route and tool, with the max and count gauges', async () => {
    registerRequestDbTimingListener();
    registerTransactionStallPool(POOL);
    await withRequestLabel({ route: 'workbench' }, committed);

    expect(await countOf(M.poolWaiting, { route: 'workbench', tool: '' })).toBe(1);
    expect(await sumOf(M.poolWaiting, { route: 'workbench' })).toBe(5);
    expect(await sumOf(M.poolIdle, { route: 'workbench' })).toBe(1);
    expect((await metricValues(M.poolMax))[0]!.value).toBe(10);
    expect((await metricValues(M.poolCount))[0]!.value).toBe(1);
    expect(await totalCount(M.poolUnmeasured)).toBe(0);
  });

  it("an 'unmeasured' pool increments the counter and records no zero", async () => {
    registerRequestDbTimingListener();
    await withRequestLabel({ route: 'workbench_stream' }, committed);

    expect(await countOf(M.poolUnmeasured, { route: 'workbench_stream', tool: '' })).toBe(1);
    expect(await totalCount(M.poolWaiting)).toBe(0);
    expect(await totalCount(M.poolIdle)).toBe(0);
  });
});

describe('the tool label', () => {
  it('a registered tool is recorded by name, an unregistered one as "other"', async () => {
    registerRequestDbTimingListener();
    registerKnownMcpTool('move_to_parent');
    await withRequestLabel({ route: 'mcp', tool: 'move_to_parent' }, committed);
    await withRequestLabel({ route: 'mcp', tool: 'not_a_registered_tool_8553' }, committed);

    expect(await countOf(M.wait, { route: 'mcp', tool: 'move_to_parent' })).toBe(1);
    expect(await countOf(M.wait, { route: 'mcp', tool: 'other' })).toBe(1);
  });
});

describe('the listener never fails the caller', () => {
  it('a throwing registry does not reject the transaction, and is logged once', async () => {
    registerRequestDbTimingListener();
    const wait = requestDbTimingRegistry().getSingleMetric(M.wait) as unknown as {
      observe: () => void;
    };
    vi.spyOn(wait, 'observe').mockImplementation(() => {
      throw new Error('registry broke');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(committed()).resolves.toBe(42);
    await expect(committed()).resolves.toBe(42);
    const ours = logged.mock.calls.filter((c) => String(c[0]).includes('[requestDbTiming]'));
    expect(ours).toHaveLength(1);
  });

  it('registering twice records once', async () => {
    registerRequestDbTimingListener();
    registerRequestDbTimingListener();
    await committed();
    expect(await totalCount(M.wait)).toBe(1);
  });
});

describe('across module instances (MOTIR-7007)', () => {
  it('a label set through one copy of requestLabel is read by another, into one registry', async () => {
    registerRequestDbTimingListener();
    const registryBefore = requestDbTimingRegistry();

    vi.resetModules();
    const otherLabel = await import('@/lib/monitoring/requestLabel');
    const otherTiming = await import('@/lib/monitoring/requestDbTiming');
    const otherSpan = await import('@/lib/monitoring/transactionSpan');
    // A second copy registering is still one listener.
    otherTiming.registerRequestDbTimingListener();
    expect(otherTiming.requestDbTimingRegistry()).toBe(registryBefore);

    // The label goes in through the OTHER copy; the transaction is measured
    // through the other copy of the seam; the listener registered by the FIRST
    // copy reads it.
    await otherLabel.withRequestLabel({ route: 'plan_get' }, () =>
      otherSpan.measureTransactionAttempt(
        'workspace_service',
        1,
        (bodyStarted, settled) => settled(Promise.resolve(bodyStarted(() => 1))),
        () => {},
      ),
    );
    // And unlabelled through this copy.
    await committed();

    expect(await countOf(M.wait, { route: 'plan_get', context: 'workspace_service' })).toBe(1);
    expect(await countOf(M.wait, { route: 'unlabelled' })).toBe(1);
    expect(await totalCount(M.wait)).toBe(2);
  });
});
