import type { JobHandler } from '../defineJob';
import type { RetryPolicyName } from '../retries';

// The ENGINE-SIDE job registry (Story MOTIR-3414 · Subtask MOTIR-3421).
//
// `lib/jobs/registry.ts` holds the built INNGEST FUNCTION OBJECTS the serve route
// mounts. The Postgres engine cannot use those: an Inngest function is an opaque
// SDK object, and what the engine needs is the raw handler plus the options it
// was declared with. So `defineJob` registers BOTH — it keeps returning the
// Inngest function exactly as before, and additionally records the definition
// here.
//
// ⚠️ THIS IS THE SAME LIST, NOT A SECOND ONE. `lib/jobs/schedules.ts` already
// establishes the pattern and the reason: a hand-maintained array is a second
// source of truth that a new job forgets to join. Registering from inside
// `defineJob` — the single choke point every job passes through — makes this
// table complete BY CONSTRUCTION. A job cannot exist without appearing in it,
// which is exactly the property the dispatcher's subscriber derivation depends
// on (MOTIR-3423's "the subscriber set is derived from the registry, not from a
// second hand-maintained list. Two lists drift.").
//
// COMPLETENESS DEPENDS ON IMPORT, identically to `schedules.ts`: the table holds
// only jobs whose definition module has been evaluated. `lib/jobs/registry.ts`
// imports all of them, so any consumer MUST import that module first. The worker
// entrypoint does, deliberately and with a comment saying why.

export interface EngineJobDefinition {
  /** The `defineJob` id — also the `job_queue.job_id` a run carries. */
  id: string;
  /** The event this job subscribes to, or `undefined` for a cron-only job. */
  trigger: string | undefined;
  /** The cron expression, when this is a scheduled job. */
  cron: string | undefined;
  /** Total attempts INCLUDING the first — resolved from the named policy at declaration. */
  maxAttempts: number;
  /** The named policy, kept for the operator surface and the ledger. */
  retryPolicy: RetryPolicyName | undefined;
  /** The raw handler, invoked by the engine's runner with a synthesized context. */
  handler: JobHandler;
}

const definitions = new Map<string, EngineJobDefinition>();

/**
 * Record one job. Called by `defineJob`; not part of the public job-authoring
 * surface. Idempotent — a re-registration under the same id (module
 * re-evaluation under HMR or a test harness) overwrites rather than duplicating,
 * exactly as `registerSchedule` does.
 */
export function registerEngineJob(def: EngineJobDefinition): void {
  definitions.set(def.id, def);
}

/** One job by id, or undefined when nothing with that id has been registered. */
export function engineJob(id: string): EngineJobDefinition | undefined {
  return definitions.get(id);
}

/** Every registered job, sorted by id for a stable report. */
export function engineJobs(): ReadonlyArray<EngineJobDefinition> {
  return [...definitions.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Every job SUBSCRIBING to one event name — the fan-out set.
 *
 * This is the derivation MOTIR-3423 builds on, and it lives here rather than in
 * the dispatcher for the reason the header gives: derived from the one registry,
 * it cannot drift from what `defineJob` actually declared.
 */
export function engineSubscribers(eventName: string): ReadonlyArray<EngineJobDefinition> {
  return engineJobs().filter((d) => d.trigger === eventName);
}

/** Every job declaring a cron. The scheduled story (MOTIR-3416) consumes this. */
export function engineScheduledJobs(): ReadonlyArray<EngineJobDefinition> {
  return engineJobs().filter((d) => d.cron !== undefined);
}

/** Drop every registration. TEST ONLY — a suite that registers throwaway jobs must not leak them into the next file. */
export function resetEngineRegistryForTests(): void {
  definitions.clear();
}
