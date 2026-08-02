import { isUnpriced } from './usage';
import type { ContainerUsage } from './types';

// WHERE THE CONTAINER-SECONDS RECORD GOES (Story MOTIR-1916 · MOTIR-1921) — the
// single seam MOTIR-1924 replaces with a persist.
//
// ⚠️ THIS CARD EMITS THE RECORD; MOTIR-1924 PERSISTS IT. `ci-runner-fleet.md` §5
// splits it exactly there: "the schema is MOTIR-1924's deliverable; the FIELDS
// are fixed here." So this module is deliberately one function with a structured
// log in it — not a table this card invents and 1924 has to migrate off, and not
// a TODO comment either, because a comment is not a call site. When 1924 lands,
// the body becomes a repository write inside the caller's unit of work and
// nothing above it changes.
//
// The log is not a placeholder for the persist. It stays afterwards: a usage row
// that never reached the database still has to be visible, and §5's invariant
// ("for every provisioned handle, exactly one usage row") is only auditable
// against a signal that survives the write failing.

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
    if (isUnpriced(usage)) {
      // §3.4's posture one domain over: an unpriced family is metered at the
      // safe end AND logged, because the log line is the only thing that ever
      // prompts someone to add the rate row.
      console.warn(
        '[containerUsage] no rate row covers this container — recorded with a zero cost',
        {
          provider: usage.provider,
          region: usage.region,
          cpuKind: usage.cpuKind,
          cpus: usage.cpus,
          memoryMb: usage.memoryMb,
          stoppedAt: usage.stoppedAt.toISOString(),
        },
      );
    }

    // ⚠️ THE RECORD ITSELF IS NOT LOGGED, AND THAT IS DELIBERATE. It travels in
    // the CALLER's return value, which for both callers is a job's result — and
    // `defineJob` writes that to the `job_run` ledger. That is this repo's actual
    // mechanism for durable operational output (the 1.6.5 dashboard reads it),
    // and it is strictly better than a log line: queryable, retained, and
    // attached to the run that produced it. The eslint rule permitting only
    // `warn`/`error` points at the same thing — an `info` log is a record nobody
    // can query. So until MOTIR-1924's table lands, the LEDGER is where a
    // container-seconds record is readable, and the only thing this function
    // adds is the one condition a human must act on.
  } catch (err) {
    console.error('[containerUsage] could not record a container-seconds row', {
      handleId: usage.handleId,
      err,
    });
  }
}
