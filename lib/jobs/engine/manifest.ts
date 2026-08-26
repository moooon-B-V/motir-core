import type { RetryPolicyName } from '../retries';
import type { DebounceOption } from './debounce';

// THE SUBSCRIBER MANIFEST (Story MOTIR-3415 · Subtask MOTIR-3458).
// Decided in `docs/decisions/job-queue-foundation.md` §12.
//
// ===========================================================================
// What it is, and why it is not `engine/registry.ts`
// ===========================================================================
// The engine's registry holds a job's HANDLER. This holds everything about a job
// EXCEPT the handler — `{ id, trigger, cron, maxAttempts, retryPolicy }` — and
// that single omission is the whole point.
//
// The emit path never runs a job; it only decides who would. `dispatchEventToEngine`
// reads `sub.id` and `sub.maxAttempts`; `hasInngestSubscribers` reads `id` and
// `trigger`. Not one emit-path caller touches `handler`, and `handler` is the one
// field that drags the service graph in behind it. So this is not a new
// abstraction — it is the split the existing call sites already implied.
//
// ===========================================================================
// ⚠️ COMPLETE BY CONSTRUCTION, exactly like the registry beside it
// ===========================================================================
// `registerJobManifest` is called from `defineJob`, the single choke point every
// job passes through, on the same line as `registerEngineJob`. A job cannot be
// defined without appearing here. This is deliberately NOT a hand-authored list:
// `engine/registry.ts`'s header refuses one for the reason MOTIR-3423 already
// recorded — two lists drift, and drift here means an event that reaches
// neither lane.
//
// ===========================================================================
// ⚠️ IT IS STILL POPULATED BY MODULE EVALUATION — and that is now SAFE
// ===========================================================================
// Registration happens as each definition module is evaluated, so the table is
// complete only in a process that has evaluated them. That was the DEFECT this
// card fixes, and what changed is not the mechanism but its COST: `defineJob` no
// longer imports the service bag or the run-ledger service at module scope (both
// are lazy, inside the run paths), so evaluating all 37 definition modules
// reaches no service, closes no import cycle, and is something an emitting
// request can afford.
//
// `lib/jobs/engine/subscribers.ts` is the module that performs that evaluation
// and is what `sendEvent` imports. The guard that this actually holds — built
// from two DIFFERENT module graphs, because a guard built from one cannot fail —
// is `tests/jobs/engine-subscriber-reachability.test.ts`.

/** One job, as the EMIT path needs to know it. No handler, by design. */
export interface JobManifestEntry {
  /** The `defineJob` id — also the `job_queue.job_id` a run carries. */
  id: string;
  /** The event this job subscribes to, or `undefined` for a cron-only job. */
  trigger: string | undefined;
  /** The cron expression, when this is a scheduled job. */
  cron: string | undefined;
  /** Total attempts INCLUDING the first. */
  maxAttempts: number;
  /** The named policy, kept for the operator surface and the ledger. */
  retryPolicy: RetryPolicyName | undefined;
  /** The `idempotency` template the job declared, or `undefined`. The emit path
   *  needs it: the dedup key is resolved and denormalised onto the queue row at
   *  ENQUEUE, which is the only moment the event payload is in hand. */
  idempotency: string | undefined;
  /** The `debounce` the job declared, or `undefined` (MOTIR-3483). On the emit
   *  path for exactly the reason `idempotency` is: the coalescing key is resolved
   *  from the event payload, and `run_at` is decided, at ENQUEUE. This is the
   *  table the dispatcher actually reads — the registry beside it carries the
   *  handler and is therefore unreachable from a request. */
  debounce: DebounceOption | undefined;
}

const manifest = new Map<string, JobManifestEntry>();

/**
 * Record one job's data-only entry. Called by `defineJob`; not part of the
 * public job-authoring surface. Idempotent — a re-registration under the same id
 * (module re-evaluation under HMR or a test harness) overwrites rather than
 * duplicating, exactly as `registerEngineJob` and `registerSchedule` do.
 */
export function registerJobManifest(entry: JobManifestEntry): void {
  manifest.set(entry.id, entry);
}

/** Every job registered so far, sorted by id for a stable report. */
export function manifestJobs(): ReadonlyArray<JobManifestEntry> {
  return [...manifest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Every job SUBSCRIBING to one event name — the fan-out set, handler-free. */
export function manifestSubscribers(eventName: string): ReadonlyArray<JobManifestEntry> {
  return manifestJobs().filter((d) => d.trigger === eventName);
}

/**
 * Every job declaring a cron — the manifest's own partition helper.
 *
 * ⚠️ NOT THE SCHEDULER'S SOURCE, and deliberately so. `JobScheduler`
 * (MOTIR-3416) reads `engineScheduledJobs()` off the full registry, because it
 * runs inside the WORKER, which imports the registry for its handlers anyway —
 * so it never had the reachability problem this table exists to fix. That
 * problem belongs to the EMIT PATH, and a scheduler is not on one. Used here by
 * the story gate, which asserts the cron and event-triggered halves partition
 * the manifest (ADR §12).
 */
export function manifestScheduledJobs(): ReadonlyArray<JobManifestEntry> {
  return manifestJobs().filter((d) => d.cron !== undefined);
}
