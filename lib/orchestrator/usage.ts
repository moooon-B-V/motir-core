import { Prisma } from '@prisma/client';
import { resolveContainerRate, UNPRICED_USD_PER_SECOND } from './rates';
import type {
  ContainerAccrual,
  ContainerHandle,
  ContainerUsage,
  TeardownReason,
  UsageAttribution,
} from './types';

// Building the CONTAINER-SECONDS RECORD (§5) — the one place a `ContainerUsage`
// is constructed, shared by every adapter.
//
// It lives above the adapters rather than inside each of them for the reason §5
// gives for fixing the fields at all: two adapters that each build their own row
// are two chances to compute `billableSeconds` differently, and the difference
// would only ever surface in the monthly reconciliation, months later, as drift
// nobody can attribute. The adapter's job is to report what the PROVIDER says
// (`state`, the three timestamps); the arithmetic and the commercial mapping are
// the same everywhere and happen here.
//
// ⚠️ MONEY IS DECIMAL, NEVER FLOAT. `usdPerSecond` is ~3×10⁻⁵ and the second
// counts run to five digits; in binary floating point that product's error is
// invisible per row and systematic across a month — exactly the error a
// reconciliation is worst at catching. `Prisma.Decimal` is already the repo's
// money type (`ciWorkflowRunUsageRepository`), so this uses it rather than
// introducing a second convention.

/** The provider-reported facts a usage row is built from. */
export interface ObservedContainerLifecycle {
  readonly createdAt: Date;
  /** Null iff the container never started — a `provision_failed` row. */
  readonly startedAt: Date | null;
  readonly stoppedAt: Date;
  /** The provider's own terminal state string, for diagnostics. */
  readonly terminalState: string;
}

/**
 * Billable seconds: `ceil(stoppedAt - startedAt)`, and ZERO when the container
 * never started.
 *
 * ⚠️ ZERO IS THE CORRECT ANSWER FOR A FAILED BOOT, and it is a deliberate choice
 * rather than an absence. A container that was created and destroyed without
 * ever starting is not free to Motir in principle, but Fly bills a Machine on
 * its RUNNING seconds — so charging ourselves for it in this record would make
 * the reconciliation against Fly's invoice disagree by construction, which is
 * the one property §5 exists to give. The row is still WRITTEN (§5: "a container
 * with no usage row is a bug with a name"); it simply costs nothing.
 *
 * A negative or non-finite span is a malformed provider payload rather than a
 * credit, and clamps to zero — the same posture `ciMetering/normalize.ts` takes
 * for a job with impossible timestamps.
 */
export function billableSecondsFor(startedAt: Date | null, stoppedAt: Date): number {
  if (!startedAt) return 0;
  const ms = stoppedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 1000);
}

/**
 * Assemble the §5 record.
 *
 * The rate is resolved AT `stoppedAt`, not at "now": a container that ran across
 * a repricing boundary is costed at the rate in force while it was running,
 * which is what makes the dated table mean anything.
 *
 * An UNPRICED triple (no row for this provider/size/region at that instant) does
 * not throw and does not guess. It produces a row with a zero rate and a null
 * `rateEffectiveFrom` — the two together being the unambiguous signal "this
 * container's cost is not known", distinguishable from a genuine zero-second row
 * by the `billableSeconds` beside it — and the caller logs it.
 */
export function buildContainerUsage(input: {
  handle: ContainerHandle;
  attribution: UsageAttribution;
  lifecycle: ObservedContainerLifecycle;
  reason: TeardownReason;
}): ContainerUsage {
  const { handle, attribution, lifecycle, reason } = input;
  const billableSeconds = billableSecondsFor(lifecycle.startedAt, lifecycle.stoppedAt);
  const rate = resolveContainerRate(
    handle.provider,
    attribution.size,
    handle.region,
    lifecycle.stoppedAt,
  );

  const usdPerSecond = rate?.usdPerSecond ?? UNPRICED_USD_PER_SECOND;
  const costUsd = new Prisma.Decimal(usdPerSecond).mul(billableSeconds).toFixed();

  return {
    handleId: handle.id,
    provider: handle.provider,
    region: handle.region,

    orgId: attribution.orgId,
    workspaceId: attribution.workspaceId,
    projectId: attribution.projectId,
    repoFullName: attribution.repoFullName,
    workload: attribution.workload,
    workflowJobId: attribution.workflowJobId,

    cpuKind: attribution.size.cpuKind,
    cpus: attribution.size.cpus,
    memoryMb: attribution.size.memoryMb,

    createdAt: lifecycle.createdAt,
    startedAt: lifecycle.startedAt,
    stoppedAt: lifecycle.stoppedAt,
    billableSeconds,

    usdPerSecond,
    costUsd,
    rateEffectiveFrom: rate?.effectiveFrom ?? null,

    terminalState: lifecycle.terminalState,
    teardownReason: reason,
  };
}

/**
 * Assemble a CHECKPOINT on a container that is still running (MOTIR-1995) — the
 * same arithmetic as {@link buildContainerUsage}, taken at `observedAt` instead of
 * at a stop.
 *
 * ⚠️ `billableSecondsFor` IS REUSED RATHER THAN MIRRORED, and the reuse is the
 * point: `usage.ts`'s own header gives the reason the computation lives in one
 * place at all — two constructions of the same figure are two chances to compute
 * it differently, and the difference would only ever surface months later in a
 * reconciliation as drift nobody can attribute. A checkpoint is that risk again,
 * one axis over (the same container, two moments), so it computes seconds through
 * the SAME function and prices through the SAME resolver.
 *
 * The rate resolves at `observedAt`, mirroring the settle's resolve-at-`stoppedAt`:
 * a container observed before a repricing is costed at the rate that was in force
 * while it was running. A container running ACROSS a repricing therefore has its
 * whole accrual re-priced at the newer rate on the next checkpoint, which is the
 * same answer the settle would have produced on its own — the alternative, pricing
 * each interval separately, would need a per-interval table this row has no room
 * for and cannot be reconstructed from a single `usd_per_second`.
 */
export function buildContainerAccrual(input: {
  handle: ContainerHandle;
  attribution: UsageAttribution;
  createdAt: Date;
  startedAt: Date;
  observedAt: Date;
}): ContainerAccrual {
  const { handle, attribution, createdAt, startedAt, observedAt } = input;
  const accruedSeconds = billableSecondsFor(startedAt, observedAt);
  const rate = resolveContainerRate(handle.provider, attribution.size, handle.region, observedAt);

  const usdPerSecond = rate?.usdPerSecond ?? UNPRICED_USD_PER_SECOND;

  return {
    handleId: handle.id,
    provider: handle.provider,
    region: handle.region,

    orgId: attribution.orgId,
    workspaceId: attribution.workspaceId,
    projectId: attribution.projectId,
    repoFullName: attribution.repoFullName,
    workload: attribution.workload,
    workflowJobId: attribution.workflowJobId,

    cpuKind: attribution.size.cpuKind,
    cpus: attribution.size.cpus,
    memoryMb: attribution.size.memoryMb,

    createdAt,
    startedAt,
    observedAt,
    accruedSeconds,

    usdPerSecond,
    costUsd: new Prisma.Decimal(usdPerSecond).mul(accruedSeconds).toFixed(),
    rateEffectiveFrom: rate?.effectiveFrom ?? null,
  };
}

/** Did this row fall through to the unpriced fallback? The caller logs on true —
 *  a fleet running unpriced is a rate row someone forgot, and it is only ever
 *  noticed if it says so. Total over both record shapes, because an unpriced
 *  CHECKPOINT is the same forgotten rate row and has to say so at the same volume
 *  (it is in fact the EARLIER warning — it fires while the container is still
 *  running, rather than after the spend is already sunk). */
export function isUnpriced(usage: ContainerUsage | ContainerAccrual): boolean {
  return usage.rateEffectiveFrom === null;
}
