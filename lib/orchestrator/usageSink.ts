import { isUnpriced } from './usage';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import type { ContainerAccrual, ContainerUsage } from './types';

// WHERE THE CONTAINER-SECONDS RECORD GOES (Story MOTIR-1916 · MOTIR-1921 →
// MOTIR-1924) — the single seam between destroying a container and knowing what
// it cost.
//
// MOTIR-1921 emitted the record and stopped at a log; MOTIR-1924 persists it,
// exactly as this module's own header predicted ("the body becomes a repository
// write inside the caller's unit of work and nothing above it changes"). It did:
// the two call sites — the `finally` that guarantees teardown, and the reaper —
// are untouched, and `ci-runner-fleet.md` §5's split still holds, with the FIELDS
// fixed by the port and the SCHEMA owned by `ciFleetCostMeterService`.
//
// The module survives the persist rather than dissolving into it, because it
// owns two things the service must not: the never-throw contract below (the
// service is free to fail; this is called from a `finally`), and the unpriced
// WARNING, which is the one condition a human has to act on. A usage row that
// never reached the database still has to be visible, and §5's invariant ("for
// every provisioned handle, exactly one usage row") is only auditable against a
// signal that survives the write failing.

/**
 * Emit one container's cost record.
 *
 * NEVER THROWS. It is called from the `finally` that guarantees teardown and
 * from the reaper, and a sink failure that propagated from there would turn "the
 * container was destroyed and we could not record it" into "the container may
 * not have been destroyed" — trading a bookkeeping gap for a billing leak, which
 * is the wrong direction every time. A failure here is logged and swallowed;
 * the container is already gone, which is the property that actually costs
 * money.
 */
export async function recordContainerUsage(usage: ContainerUsage): Promise<void> {
  try {
    warnIfUnpriced(usage);

    // THE PERSIST (MOTIR-1924, extended by MOTIR-1995). Idempotent per container,
    // attributed repo → project → workspace → org, recorded under the container's
    // own WORKLOAD line, and bypassed off-cloud — all inside the service, so this
    // seam stays the one place a container's cost is handed off and the port keeps
    // knowing nothing about tenancy.
    //
    // ⚠️ THE RECORD ITSELF IS STILL NOT LOGGED, AND THAT IS STILL DELIBERATE. It
    // travels in the CALLER's return value, which for both callers is a job's
    // result — and `defineJob` writes that to the `job_run` ledger. The ledger
    // remains the per-run operational trail (the 1.6.5 dashboard reads it); the
    // table this writes is the QUERYABLE, aggregated, tenant-attributed record the
    // margin readout and the fleet reconciliation read. Two records with two jobs,
    // neither redundant.
    await ciFleetCostMeterService.recordContainerUsage(usage);
  } catch (err) {
    console.error('[containerUsage] could not record a container-seconds row', {
      handleId: usage.handleId,
      err,
    });
  }
}

/**
 * Emit a CHECKPOINT on a container that is still running (MOTIR-1995).
 *
 * ⚠️ WHY THIS SEAM EXISTS BESIDE THE ONE ABOVE, when the port's whole point is that
 * teardown produces the record. Because "teardown produces it" also means nothing
 * exists until teardown, and that is only safe while containers are short. Epic 9's
 * agent container spans a whole `motir run <story>` — hours — so under teardown-only
 * costing its spend accrues with no row at all, against a Fly account that offers
 * NEITHER a spending cap NOR a billing alert (`ci-runner-fleet.md` §9). The port's
 * guarantee is that a container cannot be destroyed without its cost being known;
 * this is the weaker but earlier guarantee that a container cannot RUN for hours
 * without its cost being known.
 *
 * NEVER THROWS, for a reason as strong as the settle's: this is called from the
 * SUPERVISION path, which is documented to never throw because in a stepped world
 * teardown cannot be reached from a `catch`. A throw from a bookkeeping write would
 * therefore not merely lose a row — it would abandon a running container.
 */
export async function recordContainerAccrual(accrual: ContainerAccrual): Promise<void> {
  try {
    warnIfUnpriced(accrual);
    await ciFleetCostMeterService.recordContainerAccrual(accrual);
  } catch (err) {
    console.error('[containerUsage] could not record a container accrual', {
      handleId: accrual.handleId,
      err,
    });
  }
}

/** The unpriced WARNING, shared by both seams — a fleet running unpriced is a rate
 *  row someone forgot, and the log line is the only thing that ever prompts anyone
 *  to add it. It fires on a CHECKPOINT too, deliberately: that is the same missing
 *  row noticed while the container is still running rather than after its spend is
 *  already sunk. */
function warnIfUnpriced(usage: ContainerUsage | ContainerAccrual): void {
  if (!isUnpriced(usage)) return;
  // §3.4's posture one domain over: an unpriced family is metered at the safe end
  // AND logged, because the log line is the only thing that ever prompts someone
  // to add the rate row.
  console.warn('[containerUsage] no rate row covers this container — recorded with a zero cost', {
    provider: usage.provider,
    region: usage.region,
    cpuKind: usage.cpuKind,
    cpus: usage.cpus,
    memoryMb: usage.memoryMb,
    // The instant the missing rate was looked for — a stop for a settled record, the
    // observation for a checkpoint. Both are what `resolveContainerRate` was asked
    // about, which is the fact an operator needs to add the right dated row.
    at: ('stoppedAt' in usage ? usage.stoppedAt : usage.observedAt).toISOString(),
  });
}
