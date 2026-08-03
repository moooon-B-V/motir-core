import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { recordContainerUsage } from '@/lib/orchestrator/usageSink';
import { withSystemContext } from '@/lib/workspaces/context';
import type { ContainerUsage } from '@/lib/orchestrator/types';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET COST METER against real Postgres (Story MOTIR-1916 · MOTIR-1924) —
// `docs/decisions/ci-minutes-allowance.md` §P and `ci-runner-fleet.md` §5.
//
// Everything here is real: the tables, the RLS contexts the writes run under,
// the unique index that makes the record idempotent per runner, and the rollup
// the margin readout reads. Nothing is stubbed but the environment flags, which
// ARE the bypasses under test.
//
// What the card is measured against, and where each lives below:
//   * per-runner rows, idempotent, attributed repo → project → workspace → org;
//   * cost per org per period queryable, margin derivable from STORED values;
//   * nothing debits a ledger;
//   * `isMeta` and `MOTIR_CLOUD=false` bypass.

const PASSWORD = 'hunter2hunter2';
const STOPPED_AT = new Date('2026-08-15T12:00:00.000Z');
const AUGUST_2026 = new Date('2026-08-01T00:00:00.000Z');
/** The shipped `fly`/`iad` rate (`lib/orchestrator/rates.ts`), which is also
 *  what the `fake` adapter prices at — so the arithmetic below is production's,
 *  not a test constant. */
const IAD_USD_PER_SECOND = '0.000031636049';

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  repoFullName: string;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_container_usage", "ci_container_period_cost", "ci_period_usage" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  // The meter is a CLOUD meter (§8.5). Every test that expects a write says so;
  // the two that expect the bypass override it.
  vi.stubEnv('MOTIR_CLOUD', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function seedTenant(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  const email = `fleet-cost-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${Math.floor(Math.random() * 900 + 100)}`,
  });
  if (options.isMeta) {
    await db.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    repoFullName: 'motir-projects/acme-web',
  };
}

/** One container-seconds record, exactly as `buildContainerUsage` emits it. */
function usageFor(fx: Fixture, overrides: Partial<ContainerUsage> = {}): ContainerUsage {
  const billableSeconds = overrides.billableSeconds ?? 240;
  return {
    handleId: `m-${Math.random().toString(36).slice(2, 10)}`,
    provider: 'fake',
    region: 'iad',
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName: fx.repoFullName,
    workload: 'ci_runner',
    workflowJobId: 44001,
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    createdAt: new Date(STOPPED_AT.getTime() - 300_000),
    startedAt: new Date(STOPPED_AT.getTime() - billableSeconds * 1000),
    stoppedAt: STOPPED_AT,
    billableSeconds,
    usdPerSecond: IAD_USD_PER_SECOND,
    costUsd: (Number(IAD_USD_PER_SECOND) * billableSeconds).toFixed(12),
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    terminalState: 'destroyed',
    teardownReason: 'job_completed',
    ...overrides,
  };
}

describe('recording one container', () => {
  it('persists the per-runner row and the period rollup, attributed to the org', async () => {
    const fx = await seedTenant();
    const usage = usageFor(fx);

    const outcome = await ciFleetCostMeterService.recordContainerUsage(usage);

    expect(outcome).toMatchObject({
      outcome: 'recorded',
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      periodStart: AUGUST_2026,
      billableSeconds: 240,
    });
    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({
      containerProvider: 'fake',
      handleId: usage.handleId,
      containerRegion: 'iad',
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      repoFullName: 'motir-projects/acme-web',
      // Stored as a STRING: GitHub's job ids are 64-bit and nothing does maths
      // on them, the same call the intent table makes.
      workflowJobId: '44001',
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 8192,
      billableSeconds: 240,
      terminalState: 'destroyed',
      teardownReason: 'job_completed',
    });
    // The period is a PURE function of the container's STOP instant (§4.5), so
    // it lands in the same monthly bucket the minute meter would use.
    expect(row.periodStart).toEqual(AUGUST_2026);

    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup).toMatchObject({
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      containerSeconds: 240,
      containerCount: 1,
    });
    // 240 s × $0.000031636049 — carried at full decimal precision, never floated.
    expect(rollup.costUsd.toFixed(12)).toBe('0.007592651760');
    expect(row.costUsd.toFixed(12)).toBe('0.007592651760');
    expect(row.usdPerSecond.toFixed(12)).toBe(IAD_USD_PER_SECOND);
  });

  it('a JOBLESS container stores a NULL job id, never the string "null" (MOTIR-2025)', async () => {
    // ⚠️ THE TRAP THIS CLOSES. The port's `workflowJobId` became nullable when
    // indexing joined the fleet, and the write was a bare `String(...)` —
    // `String(null)` is the four-character string `'null'`, which the column
    // accepts happily and which makes "this workload has no job" indistinguish-
    // able from a job actually called that. The column has been `String?` since
    // it was written, for exactly this row.
    const fx = await seedTenant();

    const outcome = await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null }),
    );

    expect(outcome).toMatchObject({ outcome: 'recorded' });
    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.workflowJobId).toBeNull();
    expect(row.workflowJobId).not.toBe('null');
    // Everything else about the row is written exactly as it always was — this
    // card widens the port, it does not re-shape the meter (MOTIR-1995 owns
    // teaching this column the workload it is now carried on the record).
    expect(row).toMatchObject({
      containerProvider: 'fake',
      repoFullName: 'motir-projects/acme-web',
      billableSeconds: 240,
      teardownReason: 'job_completed',
    });
  });

  it('is IDEMPOTENT per runner — the second teardown of a handle changes nothing', async () => {
    // The `finally` that guarantees teardown and the reaper can both reach the
    // same container, and `teardown` is required to be idempotent — so the
    // second arrival must cost nothing, INCLUDING in the rollup.
    const fx = await seedTenant();
    const usage = usageFor(fx);

    await ciFleetCostMeterService.recordContainerUsage(usage);
    const second = await ciFleetCostMeterService.recordContainerUsage(usage);

    expect(second).toEqual({
      outcome: 'duplicate',
      containerProvider: 'fake',
      handleId: usage.handleId,
    });
    expect(await db.ciContainerUsage.count()).toBe(1);
    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerCount).toBe(1);
    expect(rollup.containerSeconds).toBe(240);
  });

  it('the UNIQUE INDEX is the guard, not the pre-check — a concurrent duplicate rolls back whole', async () => {
    // Mutation check: the cheap `findByHandle` pre-check above would let two
    // concurrent callers through. Firing both at once proves the index is what
    // actually holds, and that the losing insert takes its rollup increment down
    // with it (they share one transaction).
    const fx = await seedTenant();
    const usage = usageFor(fx);

    const outcomes = await Promise.all([
      ciFleetCostMeterService.recordContainerUsage(usage),
      ciFleetCostMeterService.recordContainerUsage(usage),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['duplicate', 'recorded']);
    expect(await db.ciContainerUsage.count()).toBe(1);
    expect((await db.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(240);
  });

  it('sums SEVERAL containers into one (workspace, period) rollup row', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 100 }));
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 200 }));

    const rollups = await db.ciContainerPeriodCost.findMany();
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ containerSeconds: 300, containerCount: 2 });
  });

  it('records a FAILED BOOT at zero seconds — the row still exists', async () => {
    // §5: "a container with no usage row is a bug with a name". A container that
    // never started is not billed by the provider, so it costs nothing here —
    // but it is still recorded, and the null start instant is what says why.
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        startedAt: null,
        billableSeconds: 0,
        costUsd: '0',
        teardownReason: 'provision_failed',
        terminalState: 'created',
      }),
    );

    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.containerStartedAt).toBeNull();
    expect(row.billableSeconds).toBe(0);
    expect(row.costUsd.toNumber()).toBe(0);
    expect(row.teardownReason).toBe('provision_failed');
  });

  it('records an UNPRICED container with a null rate — "cost unknown", not a real zero', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { usdPerSecond: '0', costUsd: '0', rateEffectiveFrom: null, region: 'syd' }),
    );

    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.rateEffectiveFrom).toBeNull();
    expect(row.costUsd.toNumber()).toBe(0);
    // Distinguishable from a genuine zero-second row by the seconds beside it.
    expect(row.billableSeconds).toBe(240);
  });

  it('keeps the row when the PROJECT is deleted — real money, no longer attributable', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx));

    await db.project.delete({ where: { id: fx.projectId } });

    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.projectId).toBeNull();
    expect(row.organizationId).toBe(fx.organizationId);
  });

  it('DEBITS NOTHING — no credit ledger row, no charge row', async () => {
    // The card's hardest boundary: this is Motir's COGS, never a user-facing
    // charge. `ci_period_charge` is the entitlement half's only durable state,
    // and metering a container must not touch it.
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx));

    expect(await db.ciPeriodCharge.count()).toBe(0);
    expect(await db.ciPeriodUsage.count()).toBe(0);
  });
});

describe('the bypasses (§8.5, §4.4)', () => {
  it('is INERT off-cloud — MOTIR_CLOUD unset writes nothing', async () => {
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_CLOUD', '');

    expect(await ciFleetCostMeterService.recordContainerUsage(usageFor(fx))).toEqual({
      outcome: 'disabled',
    });
    expect(await db.ciContainerUsage.count()).toBe(0);
  });

  it('BYPASSES the meta org — moooon B.V. pays this bill directly', async () => {
    const fx = await seedTenant({ isMeta: true });

    expect(await ciFleetCostMeterService.recordContainerUsage(usageFor(fx))).toEqual({
      outcome: 'bypassed_meta',
      organizationId: fx.organizationId,
    });
    expect(await db.ciContainerUsage.count()).toBe(0);
    expect(await db.ciContainerPeriodCost.count()).toBe(0);
  });
});

describe('the margin readout', () => {
  it('answers cost per org per period from the ROLLUP, in one read', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 600 }));

    const cost = await ciFleetCostMeterService.getOrgPeriodCost(fx.organizationId, STOPPED_AT);

    expect(cost).toMatchObject({
      organizationId: fx.organizationId,
      periodStart: AUGUST_2026,
      containerSeconds: 600,
      containerCount: 1,
    });
    expect(Number(cost.costUsd)).toBeCloseTo(600 * Number(IAD_USD_PER_SECOND), 12);
  });

  it('derives margin against the metered ×1.00 minutes from STORED values only', async () => {
    // The acceptance in one test: both halves are rollup rows read by the same
    // key, so this is a subtraction over stored state — never a recomputation
    // from logs or a scan of per-run history.
    const fx = await seedTenant();
    // 10 metered Linux-equivalent minutes for the org (the customer's side).
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: fx.organizationId,
          periodStart: AUGUST_2026,
          billableMinutes: 10,
          rawWallClockSeconds: 600,
          linearEquivalentMinutes: 10,
        },
        tx,
      ),
    );
    // 600 container-seconds serving them (Motir's side).
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 600 }));

    const basis = await ciFleetCostMeterService.getOrgPeriodCostBasis(
      fx.organizationId,
      STOPPED_AT,
    );

    expect(basis).toMatchObject({
      organizationId: fx.organizationId,
      periodStart: AUGUST_2026,
      containerSeconds: 600,
      containerCount: 1,
      linearEquivalentMinutes: 10,
    });
    // $0.0189816 over 10 metered minutes ≈ $0.0019/min — which is what makes
    // §M's `usdPerMinute: 0.001` ESTIMATE checkable at last, and the reason this
    // number had to become a measurement.
    expect(Number(basis.costPerLinearEquivalentMinute)).toBeCloseTo(
      (600 * Number(IAD_USD_PER_SECOND)) / 10,
      12,
    );
  });

  it('reports a NULL ratio rather than dividing by zero when nothing was metered', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx));

    const basis = await ciFleetCostMeterService.getOrgPeriodCostBasis(
      fx.organizationId,
      STOPPED_AT,
    );

    expect(basis.linearEquivalentMinutes).toBe(0);
    expect(basis.costPerLinearEquivalentMinute).toBeNull();
    expect(basis.containerSeconds).toBe(240);
  });

  it('returns zeros for an org with no fleet activity — total, never null', async () => {
    const fx = await seedTenant();
    const cost = await ciFleetCostMeterService.getOrgPeriodCost(fx.organizationId, STOPPED_AT);
    expect(cost).toMatchObject({ containerSeconds: 0, containerCount: 0, costUsd: '0' });
  });
});

describe('the seam the orchestrator actually calls', () => {
  it('`recordContainerUsage` from the sink PERSISTS the row', async () => {
    // The sink is what the teardown `finally` and the reaper call; the persist
    // has to happen through THAT path, not only through the service directly.
    const fx = await seedTenant();
    const usage = usageFor(fx);

    await recordContainerUsage(usage);

    expect(await db.ciContainerUsage.count()).toBe(1);
    expect((await db.ciContainerUsage.findFirstOrThrow()).handleId).toBe(usage.handleId);
  });

  it('NEVER THROWS through the sink when the persist fails', async () => {
    // A sink failure propagating out of the teardown `finally` would turn "the
    // container is gone and we could not record it" into "the container may
    // still be running" — a billing leak traded for a bookkeeping gap.
    const fx = await seedTenant();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // An org id no row exists for: the FK refuses the insert, deep inside the
    // service, exactly as a real referential failure would.
    const usage = usageFor(fx, { orgId: 'org_does_not_exist' });

    await expect(recordContainerUsage(usage)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[containerUsage] could not record a container-seconds row',
      expect.objectContaining({ handleId: usage.handleId }),
    );
    expect(await db.ciContainerUsage.count()).toBe(0);
  });
});
