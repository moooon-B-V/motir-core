// THE EMIT PATH'S MANIFEST LOADER (Story MOTIR-3415 · Subtask MOTIR-3458).
// Decided in `docs/decisions/job-queue-foundation.md` §12.
//
// ===========================================================================
// Why the import below is DYNAMIC, and why that is the whole design
// ===========================================================================
// The manifest is populated by MODULE EVALUATION: `lib/jobs/registry.ts` imports
// all 37 definition modules, each calls `defineJob`, and `defineJob` registers
// the job. Nothing on a production emit path evaluated them, so
// `manifestSubscribers(name)` returned `[]` on every request — the switch could
// not move anything, and a routed job ran on NEITHER lane, silently.
//
// A STATIC `import '@/lib/jobs/registry'` here would fix that and is exactly what
// ADR §12 measured and rejected: the definitions reach `defineJob`, which imports
// the service bag, which reaches `workItemsService`, which imports `sendEvent`.
// That closes a cycle, and the cycle is not theoretical — `next build` FAILED
// with `ReferenceError: Cannot access 'e5' before initialization`, and
// `.next/server` grew 90%.
//
// ⚠️ A DYNAMIC IMPORT BREAKS THE CYCLE WITHOUT TOUCHING A SINGLE JOB. It is not
// a module-evaluation edge, so nothing is in a temporal dead zone and the
// bundler splits it rather than inlining 37 definition modules into every route
// that emits an event. The cost moves from every build to the first emit in a
// process, and is then cached for that process's lifetime.
//
// ⚠️ AND THE ALTERNATIVE WAS TRIED AND REJECTED ON EVIDENCE, which is worth
// recording so nobody re-attempts it. Deferring `defineJob`'s OWN service import
// instead — `await import('./services')` inside the handler — also breaks the
// cycle, and it broke the in-process test harness: four `system.daily-health-check` tests in
// `tests/jobs/schedule-health.test.ts` went red, the job returning `undefined`,
// because the harness cannot tolerate a dynamic import inside a job handler. It
// failed the same way with the import at the top of the handler and after the
// first `step.run`. So the deferral belongs HERE, on the emit path, where no job
// handler is involved at all — and `defineJob` is left byte-for-byte as it was.

import { manifestJobs, manifestSubscribers, manifestScheduledJobs } from './manifest';

/** Resolves once the definition modules have been evaluated. Cached: the import
 *  is idempotent, but memoising the PROMISE means concurrent first emits await
 *  one load rather than racing several. */
let loading: Promise<void> | null = null;
/** Set once `lib/jobs/registry.ts` has resolved in THIS module layer. */
let registryLoaded = false;

/**
 * Ensure the job manifest is populated in THIS process.
 *
 * Called by `dispatchEventToEngine` before it resolves subscribers. Callers on
 * the emit path must await this before reading the manifest, and
 * `tests/jobs/engine-subscriber-reachability.test.ts` asserts that ORDERING
 * against the dispatcher's own source — a synchronous read of an unloaded
 * manifest answers "no subscribers", which is indistinguishable from an event
 * nothing consumes.
 */
export async function ensureJobManifestLoaded(): Promise<void> {
  // ⚠️ SHORT-CIRCUIT ON THE REGISTRY HAVING LOADED — NEVER ON A NON-EMPTY
  // MANIFEST (Bug MOTIR-5716). "Some job is registered" is true the moment ANY
  // module imports ONE job definition — the Monitoring page imports a constant
  // from `monitorIssueReconcile` — and the old `manifestJobs().length > 0` test
  // then skipped the registry for the life of that module layer: every event
  // whose consumers had not been imported resolved to ZERO subscribers and was
  // dropped with no row, no log and no dead letter. A process that has already
  // imported the registry pays one microtask here, since the `import()`
  // resolves from the module cache.
  if (registryLoaded) return;
  loading ??= import('@/lib/jobs/registry').then(() => {
    registryLoaded = true;
  });
  await loading;
}

/** TEST SEAM — forget the cached load so a spec can prove the cold path. */
export function resetJobManifestLoadForTests(): void {
  loading = null;
  registryLoaded = false;
}

export { manifestJobs, manifestSubscribers, manifestScheduledJobs };
export type { JobManifestEntry } from './manifest';
