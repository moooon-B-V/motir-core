import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { ciContainerUsageRepository } from '@/lib/repositories/ciContainerUsageRepository';
import { containerWorkloadFor, FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import { buildContainerAccrual } from '@/lib/orchestrator/usage';
import { recordContainerAccrual, recordContainerUsage } from '@/lib/orchestrator/usageSink';
import { withSystemContext } from '@/lib/workspaces/context';
import type { ContainerAccrual, ContainerUsage } from '@/lib/orchestrator/types';
import { truncateAuthTables } from '../helpers/db';
import { randomToken, randomInt } from '../helpers/random';

// THE FLEET COST METER against real Postgres (Story MOTIR-1916 · MOTIR-1924 ·
// MOTIR-1995) — `docs/decisions/ci-minutes-allowance.md` §P, `ci-runner-fleet.md`
// §5 and `code-graph-index-fleet.md` §2.
//
// Everything here is real: the tables, the RLS contexts the writes run under,
// the unique index and the row lock that make the record idempotent per container,
// and the rollup the margin readout reads. Nothing is stubbed but the environment
// flags, which ARE the bypasses under test.
//
// What MOTIR-1924 was measured against, and still is:
//   * per-container rows, idempotent, attributed repo → project → workspace → org;
//   * cost per org per period queryable, margin derivable from STORED values;
//   * nothing debits a ledger;
//   * `MOTIR_CLOUD=false` bypasses.
//
// What MOTIR-1995 adds, and where each lives below:
//   * the three-value workload axis (`ci` / `index` / `agent`), separable in the
//     rollup and never merged into one figure;
//   * INCREMENTAL accrual — a running container has recorded seconds before it
//     stops, and teardown reconciles to the true total;
//   * idempotency UNDER CHECKPOINTING — a replayed accrual adds nothing, and a
//     crashed container's partial accrual reconciles rather than duplicating;
//   * `isMeta` orgs are METERED (the bypass is gone), with their cost readable as
//     its own line, and nothing debits a ledger for ANYONE;
//   * ONE write path — a test that fails if a second writer can reach the record.

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
  const email = `fleet-cost-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
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

/** The money a container of `seconds` costs, at the shipped `iad` rate — computed
 *  the way production computes it (`Prisma.Decimal`, never a float), so an
 *  assertion on the stored value is an assertion about the real arithmetic. */
function costFor(seconds: number): string {
  return new Prisma.Decimal(IAD_USD_PER_SECOND).mul(seconds).toFixed();
}

/** One container-seconds record, exactly as `buildContainerUsage` emits it. */
function usageFor(fx: Fixture, overrides: Partial<ContainerUsage> = {}): ContainerUsage {
  const billableSeconds = overrides.billableSeconds ?? 240;
  const stoppedAt = overrides.stoppedAt ?? STOPPED_AT;
  return {
    handleId: `m-${randomToken(8)}`,
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
    createdAt: new Date(stoppedAt.getTime() - 300_000),
    startedAt: new Date(stoppedAt.getTime() - billableSeconds * 1000),
    stoppedAt,
    billableSeconds,
    usdPerSecond: IAD_USD_PER_SECOND,
    costUsd: costFor(billableSeconds),
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    terminalState: 'destroyed',
    teardownReason: 'job_completed',
    ...overrides,
  };
}

/**
 * One CHECKPOINT on a still-running container, exactly as `buildContainerAccrual`
 * emits it (MOTIR-1995).
 *
 * Defaulted to the INDEX workload rather than CI, because that is the workload that
 * actually reaches this seam today: `codeGraphIndexDispatchService`'s poll is the
 * one supervision loop wired to it, and an index container is the first thing the
 * shared fleet org runs that MOTIR-1924's meter could not see.
 */
function accrualFor(fx: Fixture, overrides: Partial<ContainerAccrual> = {}): ContainerAccrual {
  const accruedSeconds = overrides.accruedSeconds ?? 90;
  const observedAt = overrides.observedAt ?? STOPPED_AT;
  return {
    handleId: `m-${randomToken(8)}`,
    provider: 'fake',
    region: 'iad',
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName: fx.repoFullName,
    workload: 'code_graph_index',
    workflowJobId: null,
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    createdAt: new Date(observedAt.getTime() - 300_000),
    startedAt: new Date(observedAt.getTime() - accruedSeconds * 1000),
    observedAt,
    accruedSeconds,
    usdPerSecond: IAD_USD_PER_SECOND,
    costUsd: costFor(accruedSeconds),
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
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

  it('is IDEMPOTENT per container — the second teardown of a handle changes nothing', async () => {
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

  it('the ROW LOCK is the guard, not the pre-check — two concurrent settles count once', async () => {
    // Mutation check (MOTIR-1995 replaces MOTIR-1924's unique-index argument with a
    // lock, because the write is no longer a single insert: it READS what the
    // container already contributed and increments the rollup by the difference,
    // which is a read-derived write — `notes.html` #35).
    //
    // Firing both at once is what proves the serialization. Without the
    // `createIfAbsent` → `FOR UPDATE` ordering, both callers would find no prior
    // contribution and each add the container's whole 240 s, and the rollup would
    // say 480 for one container.
    const fx = await seedTenant();
    const usage = usageFor(fx);

    const outcomes = await Promise.all([
      ciFleetCostMeterService.recordContainerUsage(usage),
      ciFleetCostMeterService.recordContainerUsage(usage),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['duplicate', 'recorded']);
    expect(await db.ciContainerUsage.count()).toBe(1);
    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(240);
    expect(rollup.containerCount).toBe(1);
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

describe('the bypasses — one survives, one does NOT (§8.5; MOTIR-1995 vs §4.4)', () => {
  it('is INERT off-cloud — MOTIR_CLOUD unset writes nothing', async () => {
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_CLOUD', '');

    expect(await ciFleetCostMeterService.recordContainerUsage(usageFor(fx))).toEqual({
      outcome: 'disabled',
    });
    expect(await db.ciContainerUsage.count()).toBe(0);
  });

  it('the off-cloud bypass covers the CHECKPOINT path too', async () => {
    // Same claim, same reason: off-cloud there is no fleet, so there is nothing to
    // accrue either. A bypass that covered only the settle would write partial rows
    // on a self-hosted install for containers that do not exist.
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_CLOUD', '');

    expect(await ciFleetCostMeterService.recordContainerAccrual(accrualFor(fx))).toEqual({
      outcome: 'disabled',
    });
    expect(await db.ciContainerUsage.count()).toBe(0);
  });

  it('METERS the meta org — the §4.4 bypass is GONE, because meta runs on the fleet', async () => {
    // ⚠️ THE INVERSION THIS CARD IS FOR. MOTIR-1924 bypassed meta entirely and was
    // right to: meta CI never runs on the fleet (MOTIR-1915), so there was nothing
    // to record. Meta INDEXING does run on it (`code-graph-index-fleet.md` decision
    // 7 — the circularity test passes for indexing, unlike CI), so the same bypass
    // would produce real Fly spend with NO ROW: dogfooding unbounded and invisible,
    // the shape MOTIR-1935 was filed over.
    const fx = await seedTenant({ isMeta: true });

    const outcome = await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null }),
    );

    expect(outcome).toMatchObject({
      outcome: 'recorded',
      organizationId: fx.organizationId,
      workload: 'index',
      billableSeconds: 240,
    });
    expect(await db.ciContainerUsage.count()).toBe(1);
    expect(await db.ciContainerPeriodCost.count()).toBe(1);
  });

  it('meta cost is queryable as ITS OWN LINE — never folded into per-customer margin', async () => {
    // The other half of removing the bypass. Metering meta creates the opposite
    // hazard to skipping it — its cost silently inside the per-customer figure — so
    // the same rows have to be readable as two populations.
    const meta = await seedTenant({ isMeta: true });
    const tenant = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(meta, { workload: 'code_graph_index', workflowJobId: null, billableSeconds: 300 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(usageFor(tenant, { billableSeconds: 120 }));

    const split = await ciFleetCostMeterService.getMetaPeriodCostSplit(STOPPED_AT);

    expect(split).toEqual([
      {
        isMeta: false,
        workload: 'ci',
        containerSeconds: 120,
        costUsd: expect.any(String),
        containerCount: 1,
      },
      {
        isMeta: true,
        workload: 'index',
        containerSeconds: 300,
        costUsd: expect.any(String),
        containerCount: 1,
      },
    ]);
  });

  it('DEBITS NOTHING FOR ANYONE — meta included, no ledger row either way', async () => {
    // `isMeta` suppresses only a CHARGE, and this meter charges nobody — which is
    // exactly why it needs no `isMeta` branch. Asserted for both populations rather
    // than argued: `ci_period_charge` is the entitlement half's only durable state.
    const meta = await seedTenant({ isMeta: true });
    const tenant = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(meta));
    await ciFleetCostMeterService.recordContainerUsage(usageFor(tenant));
    await ciFleetCostMeterService.recordContainerAccrual(accrualFor(tenant));

    expect(await db.ciPeriodCharge.count()).toBe(0);
    expect(await db.ciPeriodUsage.count()).toBe(0);
  });
});

describe('the WORKLOAD axis — three lines in one shared fleet org (MOTIR-1995)', () => {
  it('records each workload under its own cost line', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'ci_runner', billableSeconds: 100 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null, billableSeconds: 200 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'hosted_agent', workflowJobId: null, billableSeconds: 400 }),
    );

    const rows = await db.ciContainerUsage.findMany({ orderBy: { billableSeconds: 'asc' } });
    expect(rows.map((r) => r.workload)).toEqual(['ci', 'index', 'agent']);
  });

  it('keeps the three SEPARABLE in the rollup — they never merge into one figure', async () => {
    // The acceptance in one test. A rollup keyed only by (workspace, period) would
    // answer 700 s here and make "what did indexing cost us?" a scan over
    // per-container rows — the scan the rollup exists to avoid.
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'ci_runner', billableSeconds: 100 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null, billableSeconds: 200 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'hosted_agent', workflowJobId: null, billableSeconds: 400 }),
    );

    const byWorkload = await ciFleetCostMeterService.getOrgPeriodCostByWorkload(
      fx.organizationId,
      STOPPED_AT,
    );
    expect(byWorkload).toEqual([
      { workload: 'agent', containerSeconds: 400, costUsd: expect.any(String), containerCount: 1 },
      { workload: 'ci', containerSeconds: 100, costUsd: expect.any(String), containerCount: 1 },
      { workload: 'index', containerSeconds: 200, costUsd: expect.any(String), containerCount: 1 },
    ]);
    // And each line is independently readable by the same indexed read.
    expect(
      (await ciFleetCostMeterService.getOrgPeriodCost(fx.organizationId, STOPPED_AT, 'index'))
        .containerSeconds,
    ).toBe(200);
    expect(
      (await ciFleetCostMeterService.getOrgPeriodCost(fx.organizationId, STOPPED_AT, 'ci'))
        .containerSeconds,
    ).toBe(100);
  });

  it('the MARGIN readout uses the `ci` line ONLY — index spend never inflates cost-per-minute', async () => {
    // §Q.2's phantom drift as a RATIO: the denominator is metered CI minutes, so
    // folding index seconds into the numerator produces a cost-per-CI-minute figure
    // that overstates by whatever else the org ran — quietly, and worse as indexing
    // grows. The one number §M's estimate is supposed to be checkable against.
    const fx = await seedTenant();
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
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'ci_runner', billableSeconds: 600 }),
    );
    // A big index container in the same period, which must NOT move the ratio.
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null, billableSeconds: 9000 }),
    );

    const basis = await ciFleetCostMeterService.getOrgPeriodCostBasis(
      fx.organizationId,
      STOPPED_AT,
    );

    expect(basis.containerSeconds).toBe(600);
    expect(Number(basis.costPerLinearEquivalentMinute)).toBeCloseTo(
      (600 * Number(IAD_USD_PER_SECOND)) / 10,
      12,
    );
  });

  it('a new fleet workload cannot be recorded without declaring its cost line', async () => {
    // The totality guard as a runtime assertion of a COMPILE-time property: the
    // registry's union and the cost axis are mapped by a total `Record`, so a fourth
    // workload that names no line fails to build rather than recording spend under
    // whatever value a writer passed. Asserted here because a type-level guarantee
    // that nothing reads is a guarantee nobody notices being weakened to a
    // `Partial` or a lookup-with-fallback.
    expect(FLEET_WORKLOAD_KINDS.map((kind) => containerWorkloadFor(kind)).sort()).toEqual([
      'agent',
      'ci',
      'index',
    ]);
    for (const kind of FLEET_WORKLOAD_KINDS) {
      expect(containerWorkloadFor(kind)).toBeDefined();
    }
  });
});

describe('INCREMENTAL accrual — a running container is visible before it stops (MOTIR-1995)', () => {
  it('records seconds for a STILL-RUNNING container, with no stop instant', async () => {
    // The card's headline: an Epic 9 agent container spans hours, so under
    // teardown-only costing its whole life is spend with no row, against an account
    // Fly gives neither a cap nor an alert for. This is the partial figure read
    // MID-RUN.
    const fx = await seedTenant();

    const outcome = await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { accruedSeconds: 90 }),
    );

    expect(outcome).toMatchObject({
      outcome: 'accrued',
      workload: 'index',
      billableSeconds: 90,
      accruedSecondsDelta: 90,
    });
    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(90);
    // The three fields that say "still running" — and the reason the columns were
    // relaxed to nullable ahead of this card.
    expect(row.containerStoppedAt).toBeNull();
    expect(row.terminalState).toBeNull();
    expect(row.teardownReason).toBeNull();
    // The partial cost is already in the rollup, which is the whole point: the
    // figure exists before the money is gone.
    expect((await db.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(90);
  });

  it('ADVANCES on each checkpoint by the DIFFERENCE, never by the whole figure again', async () => {
    const fx = await seedTenant();
    const handleId = 'm-accruing';

    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 60 }),
    );
    const second = await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 150 }),
    );

    expect(second).toMatchObject({ billableSeconds: 150, accruedSecondsDelta: 90 });
    expect(await db.ciContainerUsage.count()).toBe(1);
    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    // 150, not 60 + 150. The rollup always equals the sum of the per-container rows.
    expect(rollup.containerSeconds).toBe(150);
    // And ONE container, not one per observation.
    expect(rollup.containerCount).toBe(1);
  });

  it('TEARDOWN RECONCILES to the true total — the settle is not the only write', async () => {
    const fx = await seedTenant();
    const handleId = 'm-settling';

    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 100 }),
    );
    const settled = await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 240,
      }),
    );

    expect(settled).toMatchObject({
      outcome: 'recorded',
      billableSeconds: 240,
      accruedSecondsDelta: 140,
    });
    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(240);
    expect(row.containerStoppedAt).toEqual(STOPPED_AT);
    expect(row.teardownReason).toBe('job_completed');
    expect((await db.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(240);
  });

  it('reconciles DOWNWARD when the container stopped between two observations', async () => {
    // The case a clamp-at-zero delta would get wrong, permanently: the last poll
    // saw a container that had in fact already stopped, so the final figure is
    // SMALLER than what the rollup already holds. Overstating a container that has
    // finished is the one direction a COGS meter must never drift.
    const fx = await seedTenant();
    const handleId = 'm-overshot';

    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 300 }),
    );
    const settled = await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 250,
      }),
    );

    expect(settled).toMatchObject({ accruedSecondsDelta: -50 });
    expect((await db.ciContainerUsage.findFirstOrThrow()).billableSeconds).toBe(250);
    expect((await db.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(250);
  });

  it('a REPLAYED checkpoint adds NOTHING — idempotent under checkpointing', async () => {
    // ⚠️ THE CASE THE ABSOLUTE-NOT-DELTA CONTRACT EXISTS FOR. Supervision runs as
    // durable Inngest steps, which RE-EXECUTE on replay, so this is the normal path
    // rather than an edge one. A delta-shaped report would double-count every
    // replayed poll — silently, and in the direction that overstates Motir's cost.
    const fx = await seedTenant();
    const handleId = 'm-replayed';
    const accrual = accrualFor(fx, { handleId, accruedSeconds: 120 });

    await ciFleetCostMeterService.recordContainerAccrual(accrual);
    const replay = await ciFleetCostMeterService.recordContainerAccrual(accrual);

    expect(replay).toMatchObject({ billableSeconds: 120, accruedSecondsDelta: 0 });
    expect(await db.ciContainerUsage.count()).toBe(1);
    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(120);
    expect(rollup.containerCount).toBe(1);
  });

  it('CONCURRENT checkpoints on one container cannot double-count it', async () => {
    // Mutation check on the lock (`notes.html` #35). Both callers read "what has
    // this container contributed?" and write the difference — remove the
    // `createIfAbsent` → `FOR UPDATE` ordering and both see no prior, both add their
    // whole figure, and one container reads as two.
    const fx = await seedTenant();
    const handleId = 'm-raced';

    await Promise.all([
      ciFleetCostMeterService.recordContainerAccrual(
        accrualFor(fx, { handleId, accruedSeconds: 200 }),
      ),
      ciFleetCostMeterService.recordContainerAccrual(
        accrualFor(fx, { handleId, accruedSeconds: 200 }),
      ),
    ]);

    expect(await db.ciContainerUsage.count()).toBe(1);
    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(200);
    expect(rollup.containerCount).toBe(1);
  });

  it('a LATE checkpoint on an already-settled container changes nothing', async () => {
    // The poll and the teardown race by construction — this is the normal outcome of
    // that race, and it is named as a late observation rather than an error. A
    // settled row is FINAL: re-opening it would make a finished container look live.
    const fx = await seedTenant();
    const handleId = 'm-late';
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 240,
      }),
    );

    const late = await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 9999 }),
    );

    expect(late).toEqual({
      outcome: 'already_settled',
      containerProvider: 'fake',
      handleId,
    });
    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(240);
    expect(row.containerStoppedAt).not.toBeNull();
    expect((await db.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(240);
  });

  it('a CRASHED container keeps its partial accrual — reconciled by the reaper, not duplicated', async () => {
    // The orchestrator died mid-run, so no settle ever came from the supervision
    // path; the reaper reaches the container later and settles the SAME handle. The
    // partial row must be completed, never joined by a second row for one container.
    const fx = await seedTenant();
    const handleId = 'm-crashed';

    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 400 }),
    );
    // The reaper's settle — a different teardown reason, the same container.
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 520,
        teardownReason: 'reaped',
      }),
    );

    expect(await db.ciContainerUsage.count()).toBe(1);
    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(520);
    expect(row.teardownReason).toBe('reaped');
    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(520);
    expect(rollup.containerCount).toBe(1);
  });

  it('keeps the FIRST period when a container runs across a month boundary', async () => {
    // A container that accrued into August must reconcile INTO August, whatever
    // period its stop instant falls in — the rollup it was already added to is the
    // one the settle's delta has to reach. Re-bucketing would leave August's rollup
    // permanently overstating a container that finished, with no row pointing at why.
    const fx = await seedTenant();
    const handleId = 'm-straddling';
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, {
        handleId,
        accruedSeconds: 600,
        observedAt: new Date('2026-08-31T23:50:00.000Z'),
      }),
    );

    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 1200,
        stoppedAt: new Date('2026-09-01T00:10:00.000Z'),
      }),
    );

    const rollups = await db.ciContainerPeriodCost.findMany();
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ periodStart: AUGUST_2026, containerSeconds: 1200 });
    expect((await db.ciContainerUsage.findFirstOrThrow()).periodStart).toEqual(AUGUST_2026);
  });

  it('carries money as DECIMAL through a checkpoint and its settle, never a float', async () => {
    // The rounding error is invisible per row and systematic across a month, which
    // is the shape a reconciliation is worst at catching — and a delta-based rollup
    // gives it two chances per container instead of one.
    const fx = await seedTenant();
    const handleId = 'm-decimal';
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 100 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 240,
      }),
    );

    const row = await db.ciContainerUsage.findFirstOrThrow();
    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    // 240 s × $0.000031636049, to the column's full 12 decimal places — the row and
    // the rollup agreeing EXACTLY is what a signed-delta rollup has to prove.
    expect(row.costUsd.toFixed(12)).toBe('0.007592651760');
    expect(rollup.costUsd.toFixed(12)).toBe('0.007592651760');
  });
});

describe('the CHECKPOINT seam the supervision loop actually calls (MOTIR-1995)', () => {
  it('`recordContainerAccrual` from the sink PERSISTS the partial row', async () => {
    // The sink is what the poll calls; the persist has to happen through THAT path,
    // not only through the service directly — the same argument the settle seam's
    // test makes one function over.
    const fx = await seedTenant();

    await recordContainerAccrual(accrualFor(fx, { accruedSeconds: 45 }));

    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(45);
    expect(row.containerStoppedAt).toBeNull();
  });

  it('an UNPRICED checkpoint is recorded at zero AND logged — the earliest warning there is', async () => {
    // The unpriced case on the accrual path. It matters MORE here than at teardown:
    // this log line fires while the container is still running, so a rate row
    // someone forgot is noticed before the spend is sunk rather than after. A build
    // that only warned at teardown would report the gap once the money was gone.
    const fx = await seedTenant();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await recordContainerAccrual(
      accrualFor(fx, {
        accruedSeconds: 120,
        // A region no rate row covers, so `resolveContainerRate` returns null — the
        // real resolver, not a stubbed one.
        region: 'syd',
        usdPerSecond: '0',
        costUsd: '0',
        rateEffectiveFrom: null,
      }),
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no rate row covers this container'),
      // The instant the missing rate was looked for is the OBSERVATION, not a stop —
      // a running container has none, and reporting one would be a lie about when.
      expect.objectContaining({ region: 'syd', at: STOPPED_AT.toISOString() }),
    );
    const row = await db.ciContainerUsage.findFirstOrThrow();
    expect(row.rateEffectiveFrom).toBeNull();
    expect(row.costUsd.toNumber()).toBe(0);
    // Distinguishable from a genuine zero-second row by the seconds beside it.
    expect(row.billableSeconds).toBe(120);
  });

  it('`buildContainerAccrual` prices a running container through the REAL rate table', async () => {
    // The record the seam consumes, built by production's own function rather than
    // hand-assembled — so the arithmetic under every assertion above is the shipped
    // arithmetic. `billableSecondsFor` is REUSED by it, which is what stops a
    // checkpoint and a settle computing the same span two ways.
    const startedAt = new Date(STOPPED_AT.getTime() - 150_000);
    const accrual = buildContainerAccrual({
      handle: { provider: 'fake', id: 'm-built', region: 'iad', createdAt: startedAt },
      attribution: {
        orgId: 'org',
        workspaceId: 'ws',
        projectId: 'proj',
        repoFullName: 'motir-projects/acme-web',
        workload: 'code_graph_index',
        workflowJobId: null,
        size: { cpuKind: 'performance', cpus: 2, memoryMb: 8192 },
        observedStartedAt: startedAt,
      },
      createdAt: startedAt,
      startedAt,
      observedAt: STOPPED_AT,
    });

    expect(accrual.accruedSeconds).toBe(150);
    expect(accrual.usdPerSecond).toBe(IAD_USD_PER_SECOND);
    expect(accrual.costUsd).toBe(costFor(150));
    expect(accrual.rateEffectiveFrom).not.toBeNull();
    // No stop instant exists on this shape at all — the type is what keeps a
    // checkpoint from ever claiming a container ended.
    expect('stoppedAt' in accrual).toBe(false);
  });

  it('an UNPRICED region resolves to a zero rate and a null effective-from', async () => {
    const startedAt = new Date(STOPPED_AT.getTime() - 60_000);
    const accrual = buildContainerAccrual({
      handle: { provider: 'fake', id: 'm-unpriced', region: 'syd', createdAt: startedAt },
      attribution: {
        orgId: 'org',
        workspaceId: 'ws',
        projectId: 'proj',
        repoFullName: 'motir-projects/acme-web',
        workload: 'code_graph_index',
        workflowJobId: null,
        size: { cpuKind: 'performance', cpus: 2, memoryMb: 8192 },
        observedStartedAt: startedAt,
      },
      createdAt: startedAt,
      startedAt,
      observedAt: STOPPED_AT,
    });

    // Under-reporting Motir's own cost is the safe direction — it never over-bills
    // anyone — and the null is what makes "cost unknown" distinguishable from zero.
    expect(accrual.usdPerSecond).toBe('0');
    expect(accrual.costUsd).toBe('0');
    expect(accrual.rateEffectiveFrom).toBeNull();
    expect(accrual.accruedSeconds).toBe(60);
  });
});

describe('ONE write path over the shared record (MOTIR-1995)', () => {
  it('locking an UNKNOWN handle reports nothing rather than inventing a prior', async () => {
    // The defensive branch in the write path. A delta derived from a row we cannot
    // see would be a guess, so the absence is reported as such — and the write is
    // skipped rather than made against an assumed zero.
    const state = await withSystemContext((tx) =>
      ciContainerUsageRepository.lockAccruedState('fake', 'm-never-existed', tx),
    );
    expect(state).toBeNull();
  });

  it('the removed pre-check is really gone — no unlocked read of the same row', async () => {
    // MOTIR-1924's `findByHandle` was an unlocked read of exactly the value the
    // delta is derived from, and it was documented as "NOT the correctness guard".
    // With the lock doing that read on every write it saves nothing and can only
    // tempt a caller into answering the one question that needs the lock.
    expect('findByHandle' in ciContainerUsageRepository).toBe(false);
  });

  it('the repository exposes NO second writer that could reach the record unlocked', async () => {
    // ⚠️ THE TEST THE CARD ASKS FOR: "one write path, proven by a test that fails if
    // a second meter writes the same record." MOTIR-1924's settle-time `create` was
    // REMOVED rather than left beside the accrual path — an unlocked insert that
    // skips the delta arithmetic is exactly how the rollup and the rows would drift
    // apart, and a writer that exists will eventually be called.
    expect('create' in ciContainerUsageRepository).toBe(false);
    // What remains is the three-op sequence, in the order the lock argument needs.
    expect(typeof ciContainerUsageRepository.createIfAbsent).toBe('function');
    expect(typeof ciContainerUsageRepository.lockAccruedState).toBe('function');
    expect(typeof ciContainerUsageRepository.accrue).toBe('function');
  });

  it('both seams land on ONE row and ONE rollup for one container', async () => {
    // The settle and the checkpoint are two entry points, not two records.
    const fx = await seedTenant();
    const handleId = 'm-single';
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 50 }),
    );
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 80 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 95,
      }),
    );

    expect(await db.ciContainerUsage.count()).toBe(1);
    expect(await db.ciContainerPeriodCost.count()).toBe(1);
    const rollup = await db.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(95);
    expect(rollup.containerCount).toBe(1);
    expect(rollup.workload).toBe('index');
  });
});

describe('the margin readout', () => {
  it('answers cost per org per period from the ROLLUP, in one read', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 600 }));

    const cost = await ciFleetCostMeterService.getOrgPeriodCost(
      fx.organizationId,
      STOPPED_AT,
      'ci',
    );

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
    const cost = await ciFleetCostMeterService.getOrgPeriodCost(
      fx.organizationId,
      STOPPED_AT,
      'ci',
    );
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
