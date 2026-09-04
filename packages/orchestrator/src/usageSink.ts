import { isUnpriced } from './usage';
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
 * WHERE THE COST RECORD IS PERSISTED — the port (MOTIR-4299).
 *
 * The sink used to import `ciFleetCostMeterService` directly, which is the app's
 * service layer and therefore the one import a package may not have. It is now
 * INJECTED: `createUsageSink(meter)` closes over whatever the composition root
 * binds, and `lib/orchestrator/index.ts` binds the real service.
 *
 * The inversion changes nothing about the split `ci-runner-fleet.md` §5 fixes —
 * the FIELDS are the port's and the SCHEMA is the meter's — it only makes that
 * split a type rather than a convention. A second meter (a test double, a
 * second deployment's) is now expressible, which it was not.
 */
export interface UsageMeter {
  // ⚠️ `Promise<unknown>`, not `Promise<void>`, and the width is deliberate. The
  // sink AWAITS and DISCARDS — its whole contract is that it never throws — so
  // what the meter answers is the meter's business. The app's
  // `ciFleetCostMeterService` returns a rich outcome its own callers read;
  // narrowing the port to `void` would make that implementation unassignable to
  // the port it already satisfies, which is the port describing the caller
  // rather than the requirement.
  recordContainerUsage(usage: ContainerUsage): Promise<unknown>;
  recordContainerAccrual(accrual: ContainerAccrual): Promise<unknown>;
}

/** The two never-throwing seams, bound to one meter. */
export interface UsageSink {
  recordContainerUsage(usage: ContainerUsage): Promise<void>;
  recordContainerAccrual(accrual: ContainerAccrual): Promise<void>;
}

export function createUsageSink(meter: UsageMeter): UsageSink {
  return { recordContainerUsage, recordContainerAccrual };

  /**
   * Emit one container's cost record.
   *
   * NEVER THROWS. It is called from the `finally` that guarantees teardown and
   * from the reaper, and a sink failure that propagated from there would turn
   * "the container was destroyed and we could not record it" into "the container
   * may not have been destroyed" — trading a bookkeeping gap for a billing leak,
   * which is the wrong direction every time. A failure here is logged and
   * swallowed; the container is already gone, which is the property that
   * actually costs money.
   */
  async function recordContainerUsage(usage: ContainerUsage): Promise<void> {
    try {
      warnIfUnpriced(usage);
      await meter.recordContainerUsage(usage);
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
   * NEVER THROWS, for a reason as strong as the settle's: this is called from
   * the SUPERVISION path, which is documented to never throw because in a
   * stepped world teardown cannot be reached from a `catch`. A throw from a
   * bookkeeping write would therefore not merely lose a row — it would abandon a
   * running container.
   */
  async function recordContainerAccrual(accrual: ContainerAccrual): Promise<void> {
    try {
      warnIfUnpriced(accrual);
      await meter.recordContainerAccrual(accrual);
    } catch (err) {
      console.error('[containerUsage] could not record a container accrual', {
        handleId: accrual.handleId,
        err,
      });
    }
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
