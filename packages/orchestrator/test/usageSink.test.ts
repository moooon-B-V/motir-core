import { describe, expect, it, vi } from 'vitest';
import {
  buildContainerAccrual,
  createUsageSink,
  FLEET_CONTAINER_SIZE,
  isUnpriced,
  type ContainerAccrual,
  type ContainerHandle,
  type ContainerUsage,
  type UsageMeter,
  type UsageAttribution,
} from '../src/index';

// THE USAGE SINK and the CHECKPOINT record (Story MOTIR-1916 · MOTIR-1921 →
// MOTIR-1924 → MOTIR-1995), written by MOTIR-4300 against the port MOTIR-4299
// inverted.
//
// ⚠️ THESE ASSERTIONS WERE NOT WRITEABLE BEFORE THE EXTRACTION, and that is the
// clearest single argument for it. The sink used to import
// `ciFleetCostMeterService` directly, so the only way to observe its two
// contracts was through a database: a test for "it swallows a meter failure" had
// to make the meter fail, which meant making Postgres fail. Now the meter is an
// argument, so the contracts are unit-testable with a stub, and the DB-backed
// seam test asserts the OTHER thing — that the composition root binds the real
// service (`tests/ciFleet/orchestratorUsageSeam.test.ts`).
//
// The two contracts, and neither is decoration:
//
//   * **NEVER THROWS.** Both seams are called from the `finally` that guarantees
//     teardown and from the supervision path. A throw from a bookkeeping write
//     would turn "the container was destroyed and we could not record it" into
//     "the container may not have been destroyed" — trading a bookkeeping gap
//     for a billing leak, against a Fly account with neither a spending cap nor
//     a billing alert (`ci-runner-fleet.md` §9).
//   * **AN UNPRICED ROW WARNS.** A fleet running unpriced is a rate row somebody
//     forgot, and the log line is the only thing that ever prompts anyone to add
//     it.

const HANDLE: ContainerHandle = {
  provider: 'fly',
  id: 'machine-9',
  region: 'iad',
  createdAt: new Date('2026-08-02T10:00:00.000Z'),
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

/** A meter that records what it was handed, or fails on demand. */
function stubMeter(behaviour: 'resolve' | 'reject' = 'resolve') {
  const usages: ContainerUsage[] = [];
  const accruals: ContainerAccrual[] = [];
  const meter: UsageMeter = {
    async recordContainerUsage(usage) {
      usages.push(usage);
      if (behaviour === 'reject') throw new Error('the database said no');
      return { outcome: 'recorded' };
    },
    async recordContainerAccrual(accrual) {
      accruals.push(accrual);
      if (behaviour === 'reject') throw new Error('the database said no');
      return { outcome: 'recorded' };
    },
  };
  return { meter, usages, accruals };
}

const usageAt = (stoppedAt: string, region = 'iad'): ContainerUsage => ({
  handleId: HANDLE.id,
  provider: 'fly',
  region,
  orgId: ATTRIBUTION.orgId,
  workspaceId: ATTRIBUTION.workspaceId,
  projectId: ATTRIBUTION.projectId,
  repoFullName: ATTRIBUTION.repoFullName,
  workload: ATTRIBUTION.workload,
  workflowJobId: ATTRIBUTION.workflowJobId,
  cpuKind: FLEET_CONTAINER_SIZE.cpuKind,
  cpus: FLEET_CONTAINER_SIZE.cpus,
  memoryMb: FLEET_CONTAINER_SIZE.memoryMb,
  createdAt: HANDLE.createdAt,
  startedAt: new Date('2026-08-02T10:00:05.000Z'),
  stoppedAt: new Date(stoppedAt),
  billableSeconds: 100,
  usdPerSecond: '0.000031636049',
  costUsd: '0.0031636049',
  rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
  terminalState: 'destroyed',
  teardownReason: 'job_completed',
});

describe('createUsageSink — the seam between destroying a container and knowing what it cost', () => {
  it('hands the SETTLED record to the meter it was bound to', async () => {
    const { meter, usages } = stubMeter();
    const usage = usageAt('2026-08-02T10:01:45.000Z');

    await createUsageSink(meter).recordContainerUsage(usage);

    expect(usages).toEqual([usage]);
  });

  it('hands the CHECKPOINT to the meter’s other method — they are two records, not one', async () => {
    // §5's invariant is "for every provisioned handle, exactly one usage row".
    // A checkpoint is deliberately NOT that row (MOTIR-1995): it exists because
    // an Epic 9 agent container runs for hours, and teardown-only costing means
    // nothing exists until it stops. Routing one to the other method would
    // silently make an accrual look like a settle.
    const { meter, usages, accruals } = stubMeter();
    const accrual = buildContainerAccrual({
      handle: HANDLE,
      attribution: ATTRIBUTION,
      createdAt: HANDLE.createdAt,
      startedAt: new Date('2026-08-02T10:00:05.000Z'),
      observedAt: new Date('2026-08-02T10:30:05.000Z'),
    });

    await createUsageSink(meter).recordContainerAccrual(accrual);

    expect(accruals).toEqual([accrual]);
    expect(usages).toEqual([]);
  });

  it('NEVER THROWS when the meter fails — and says so on `console.error`', async () => {
    // The contract that matters most, and the one a caller cannot check: both
    // call sites are places a throw abandons a container rather than losing a
    // row.
    const { meter, usages } = stubMeter('reject');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      createUsageSink(meter).recordContainerUsage(usageAt('2026-08-02T10:01:45.000Z')),
    ).resolves.toBeUndefined();

    expect(usages).toHaveLength(1); // it did try
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0]).toContain('could not record a container-seconds row');
    errors.mockRestore();
  });

  it('NEVER THROWS on a failing CHECKPOINT either', async () => {
    // The supervision path is documented never to throw, because in a stepped
    // world teardown cannot be reached from a `catch`.
    const { meter } = stubMeter('reject');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      createUsageSink(meter).recordContainerAccrual(
        buildContainerAccrual({
          handle: HANDLE,
          attribution: ATTRIBUTION,
          createdAt: HANDLE.createdAt,
          startedAt: new Date('2026-08-02T10:00:05.000Z'),
          observedAt: new Date('2026-08-02T10:30:05.000Z'),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0]).toContain('could not record a container accrual');
    errors.mockRestore();
  });

  it('WARNS about an unpriced row — on the settle AND on the checkpoint', async () => {
    // The unpriced warning fires on a checkpoint too, deliberately: that is the
    // same missing rate row noticed while the container is still running rather
    // than after its spend is already sunk.
    const { meter } = stubMeter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // ⚠️ `isUnpriced` reads `rateEffectiveFrom === null`, NOT the rate string —
    // a real rate row could in principle price something at zero, and the
    // question the warning asks is "did any row cover this?" rather than "was it
    // free?". Zeroing `usdPerSecond` alone leaves the predicate false, which is
    // the predicate being right.
    const unpriced = {
      ...usageAt('2026-08-02T10:01:45.000Z'),
      usdPerSecond: '0',
      costUsd: '0',
      rateEffectiveFrom: null,
    };
    expect(isUnpriced(unpriced)).toBe(true);

    const sink = createUsageSink(meter);
    await sink.recordContainerUsage(unpriced);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('no rate row covers this container');

    const accrual = buildContainerAccrual({
      handle: { ...HANDLE, region: 'nowhere-1' },
      attribution: ATTRIBUTION,
      createdAt: HANDLE.createdAt,
      startedAt: new Date('2026-08-02T10:00:05.000Z'),
      observedAt: new Date('2026-08-02T10:30:05.000Z'),
    });
    expect(isUnpriced(accrual), 'an unknown region has no rate row').toBe(true);
    await sink.recordContainerAccrual(accrual);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('stays QUIET on a priced row', async () => {
    // The mirror assertion. A warning that fires on every row is one nobody
    // reads, which would retire the only signal that ever prompts a rate row.
    const { meter } = stubMeter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createUsageSink(meter).recordContainerUsage(usageAt('2026-08-02T10:01:45.000Z'));

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('buildContainerAccrual — the same arithmetic, taken at an observation', () => {
  it('prices the accrual through the SAME resolver and the same second count', () => {
    // The reuse is the point: two constructions of one figure are two chances to
    // compute it differently, and the difference surfaces months later in a
    // reconciliation as drift nobody can attribute.
    const accrual = buildContainerAccrual({
      handle: HANDLE,
      attribution: ATTRIBUTION,
      createdAt: HANDLE.createdAt,
      startedAt: new Date('2026-08-02T10:00:05.000Z'),
      observedAt: new Date('2026-08-02T10:30:05.000Z'),
    });

    expect(accrual.accruedSeconds).toBe(1800);
    expect(accrual.handleId).toBe('machine-9');
    expect(accrual.workload).toBe('ci_runner');
    expect(accrual.usdPerSecond).toMatch(/^0\.\d+$/);
    // Exact decimal arithmetic, not float: `decimal.js` is the same library
    // Prisma's `Decimal` is, which is why the string is exact rather than
    // 0.056945…0000004.
    expect(accrual.costUsd).toBe(
      (Number(accrual.usdPerSecond) * 1800).toFixed(12).replace(/0+$/, ''),
    );
    expect(accrual.rateEffectiveFrom).toBeInstanceOf(Date);
    expect(isUnpriced(accrual)).toBe(false);
  });

  it('falls through to the UNPRICED rate for a region no row covers', () => {
    const accrual = buildContainerAccrual({
      handle: { ...HANDLE, region: 'nowhere-1' },
      attribution: ATTRIBUTION,
      createdAt: HANDLE.createdAt,
      startedAt: new Date('2026-08-02T10:00:05.000Z'),
      observedAt: new Date('2026-08-02T10:00:35.000Z'),
    });

    expect(accrual.usdPerSecond).toBe('0');
    expect(accrual.costUsd).toBe('0');
    expect(accrual.rateEffectiveFrom).toBeNull();
    expect(isUnpriced(accrual)).toBe(true);
  });

  it('carries a container that has not billed a second yet, rather than refusing it', () => {
    // A checkpoint taken in the first second is a real observation: the point of
    // the record is that a long-running container is never invisible, and
    // "invisible until it has accrued something" is the same gap one second in.
    const startedAt = new Date('2026-08-02T10:00:05.000Z');
    const accrual = buildContainerAccrual({
      handle: HANDLE,
      attribution: ATTRIBUTION,
      createdAt: HANDLE.createdAt,
      startedAt,
      observedAt: startedAt,
    });

    expect(accrual.accruedSeconds).toBe(0);
    expect(accrual.costUsd).toBe('0');
    expect(accrual.observedAt).toEqual(startedAt);
  });
});
