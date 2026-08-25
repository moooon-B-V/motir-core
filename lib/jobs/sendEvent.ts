import { inngest } from './client';
import type {
  WorkspaceScopedEventName,
  SystemEventName,
  JobEventName,
  JobEventData,
} from './types';
import { dispatchEventToEngine, hasInngestSubscribers } from './engine/dispatcher';

// The canonical way to emit a background-job event (Story 1.6 · Subtask
// 1.6.2, extended in 1.6.3). Routes and services call THIS — never
// `inngest.send()` directly — so the workspace-scoping invariant is enforced
// in one place. It accepts only WORKSPACE-SCOPED events (the `system.*`
// namespace is excluded at the type level — system jobs are cron/harness
// triggered, never enqueued here).
//
// DURABLE INVARIANT: every dispatched event carries an EXPLICIT `workspaceId`.
// The field is required by each event's payload type, so an event that simply
// forgot it is a compile error. The value is normally a real workspace id;
// the ONE event whose type permits `null` is `email.send`, where `null` means
// a genuinely cross-workspace / system email (a password reset is
// identity-scoped, not workspace-scoped). The runtime guard rejects the two
// shapes the type system can't catch at an untyped boundary — `undefined`
// (missing) and `''` (empty) — while allowing an explicit `null`. So no event
// is *accidentally* untenanted, but a *deliberately* cross-workspace email is
// still expressible.
export async function sendEvent<N extends WorkspaceScopedEventName>(
  name: N,
  data: JobEventData<N>,
): Promise<void> {
  const workspaceId = (data as { workspaceId?: string | null }).workspaceId;
  if (workspaceId === undefined || workspaceId === '') {
    throw new Error(
      `sendEvent("${name}") requires an explicit workspaceId — a workspace id, ` +
        `or null for a cross-workspace/system event.`,
    );
  }
  // BEST-EFFORT transport. `sendEvent` is ALWAYS called POST-COMMIT (every call
  // site emits after its `$transaction` has committed — see the call-site
  // comments). The enqueue is a NOTIFICATION side-effect, never part of the
  // mutation's success contract, so a transport failure (Inngest unreachable or
  // unconfigured — a local `pnpm dev` with no dev server, or a deploy missing
  // INNGEST_EVENT_KEY) must NOT propagate: it would turn an already-committed
  // mutation into a 500, and the caller's optimistic UI would then REVERT a
  // change the database actually kept (the board-drag / status inline-edit
  // "snaps back but a refresh shows it moved" bug — PROD-443). Drop + log the
  // event instead; the durable state stands. The argument validation above
  // still throws — that's a programming error, not a transport one.
  // ── THE CUTOVER SWITCH (MOTIR-3423) ────────────────────────────────────────
  // Read in exactly two places — here (where to ENQUEUE) and `defineJob`'s
  // Inngest handler (which declines to run a job that has moved). Not one call
  // site of `sendEvent` knows this exists. The dispatch itself is
  // `dispatchToLanes` below, shared with the system doors so there is ONE
  // description of what emitting an event means.
  await dispatchToLanes(name, data, {
    caller: 'sendEvent',
    context: `workspaceId=${String(workspaceId)}`,
    strict: false,
  });
}

/**
 * Emit a SYSTEM event (`system.*`), best-effort — the untenanted sibling of
 * {@link sendEvent} (Story MOTIR-3415 · MOTIR-3456).
 *
 * ⚠️ IT EXISTS SO THE CUTOVER SWITCH IS REACHABLE FOR SYSTEM JOBS, and for no
 * other reason. Four emitters used to call `inngest.send()` directly — the seat
 * sync, both code-graph enqueues and the runner boot — and for those events the
 * per-job switch simply did not exist: `MOTIR_POSTGRES_JOB_IDS` could name the
 * job and nothing would consult it. An emitter that bypasses this module is an
 * emitter the switch cannot route.
 *
 * ⚠️ IT IS A SIBLING RATHER THAN A WIDENING OF `sendEvent`, deliberately.
 * `sendEvent` asserts an EXPLICIT `workspaceId` on every event, which is a real
 * invariant protecting real tenancy; a system payload's workspace id is optional
 * by design, so teaching one function to accept both would mean dropping that
 * assertion for the workspace-scoped events too. Two doors keep the invariant at
 * full strength and still put every emitter through the switch.
 *
 * BEST-EFFORT, exactly like `sendEvent`: every caller emits POST-COMMIT, so a
 * transport failure is swallowed + logged rather than turning an already
 * committed mutation into a 500. A caller that needs to OBSERVE the failure —
 * because it reports an outcome, or because it wants the retry a thrown error
 * buys inside a job step — uses {@link dispatchSystemEvent} instead.
 */
export async function sendSystemEvent<N extends SystemEventName>(
  name: N,
  data: JobEventData<N>,
): Promise<void> {
  await dispatchToLanes(name, data, { caller: 'sendSystemEvent', strict: false });
}

/**
 * Emit a SYSTEM event and let a transport failure PROPAGATE.
 *
 * The strict arm of {@link sendSystemEvent}, for the two callers whose existing
 * error policy is not "swallow and continue" and must not silently become it:
 *
 *   - `ciRunnerFleet`'s provision sweep sends from inside a `step.run`, where a
 *     thrown error buys a free retry of the step. Swallowing there would convert
 *     a retryable enqueue failure into a boot that never happens.
 *   - `dispatchCiRunnerBoot` REPORTS its outcome (`'send_failed'`) to its caller
 *     rather than only logging it, so it needs to catch the failure itself.
 *
 * Both behaved this way before they were routed through this module, and this
 * door is what lets them keep behaving that way while still consulting the
 * cutover switch — the point of MOTIR-3456 is to move WHERE the event is
 * dispatched, never to change WHETHER a caller finds out that it failed.
 */
export async function dispatchSystemEvent<N extends SystemEventName>(
  name: N,
  data: JobEventData<N>,
): Promise<void> {
  await dispatchToLanes(name, data, { caller: 'dispatchSystemEvent', strict: true });
}

interface DispatchLaneOptions {
  /** Names the door in the log line, so a reader can tell which one emitted. */
  caller: string;
  /** Extra log context (the workspace id, for a workspace-scoped event). */
  context?: string;
  /**
   * `false` — swallow + log a transport failure (the POST-COMMIT contract).
   * `true` — rethrow it, for a caller that reports or retries on it.
   */
  strict: boolean;
}

/**
 * BOTH LANES, in the one place that describes what emitting an event means.
 *
 * Attempting both is not redundancy: an event's subscribers can be SPLIT across
 * engines mid-migration. `work-item/transitioned` has four subscribers, and
 * moving one of them must move exactly one — so the Postgres dispatcher enqueues
 * the subscribers that have moved, `inngest.send()` still delivers to the ones
 * that have not, and each job runs exactly once on its own lane. The half that
 * prevents a DOUBLE run is in `defineJob`: a migrated job's Inngest handler
 * returns without executing.
 *
 * Ordering is deliberate. The engine dispatch goes FIRST because it is the lane
 * we are moving TO: if the process dies between the two, an event that reached
 * the new engine and not the old one is the recoverable direction (the run is a
 * durable row), whereas the reverse loses it entirely.
 *
 * ⚠️ AN ENGINE FAILURE DOES NOT SKIP THE INNGEST SEND in the non-strict arm. The
 * two lanes carry different subscribers, so giving up on the second because the
 * first failed would drop the jobs that have not moved — which are, for most of
 * the migration, most of them.
 */
async function dispatchToLanes<N extends JobEventName>(
  name: N,
  data: JobEventData<N>,
  opts: DispatchLaneOptions,
): Promise<void> {
  const where = opts.context === undefined ? '' : ` (${opts.context})`;

  try {
    await dispatchEventToEngine(name, data, {
      idempotencyKey: (data as { idempotencyKey?: string }).idempotencyKey ?? null,
    });
  } catch (err) {
    if (opts.strict) throw err;
    // Same best-effort contract as the transport below, and for the same reason:
    // the caller emits POST-COMMIT, so a failure here must not turn an
    // already-committed mutation into a 500.
    console.error(
      `${opts.caller}("${name}") failed to dispatch to the Postgres engine${where}:`,
      err,
    );
  }

  // Still on Inngest for every subscriber that has not moved. Skipped entirely
  // once they all have — which is what makes the retirement story a deletion
  // rather than a rewrite.
  if (!hasInngestSubscribers(name)) return;

  try {
    await inngest.send({ name, data });
  } catch (err) {
    if (opts.strict) throw err;
    console.error(
      `${opts.caller}("${name}") failed to enqueue${where}; ` +
        `the mutation committed but the event was dropped:`,
      err,
    );
  }
}
