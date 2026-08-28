import type {
  WorkspaceScopedEventName,
  SystemEventName,
  JobEventName,
  JobEventData,
} from './types';
import { dispatchEventToEngine } from './engine/dispatcher';

// The canonical way to emit a background-job event (Story 1.6 · Subtask
// 1.6.2, extended in 1.6.3). Routes and services call THIS — never the engine's
// dispatcher directly — so the workspace-scoping invariant is enforced
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
export interface SendEventOptions {
  /**
   * Whether the CALLER finds out that the enqueue failed.
   *
   * `false` — the DEFAULT, and the contract every pre-existing call site was
   * written against: a transport failure is swallowed + logged. Do not change
   * it. Those callers emit POST-COMMIT, and a throw would turn a saved change
   * into a 500 (PROD-443, spelled out below).
   *
   * `true` — the failure PROPAGATES. For the AUTHENTICATION emails only
   * (MOTIR-3583), where the reasoning behind the default inverts: an auth mail
   * is the whole operation rather than a notification about one, so there is no
   * committed mutation for the swallow to protect and the user is told to check
   * an inbox nothing will arrive in. The opt-in is per CALL rather than per
   * event so that opting three call sites in leaves every other emitter's
   * contract byte-identical — which is the property that makes this safe to
   * change at all. Reach for it through `lib/auth/authMail.ts`, which is where
   * the three of them live and where the failure is turned into something a
   * surface can report.
   */
  strict?: boolean;
}

export async function sendEvent<N extends WorkspaceScopedEventName>(
  name: N,
  data: JobEventData<N>,
  opts: SendEventOptions = {},
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
  // mutation's success contract, so a transport failure (the queue write losing
  // its connection, a database that has gone away) must NOT propagate: it would turn an already-committed
  // mutation into a 500, and the caller's optimistic UI would then REVERT a
  // change the database actually kept (the board-drag / status inline-edit
  // "snaps back but a refresh shows it moved" bug — PROD-443). Drop + log the
  // event instead; the durable state stands. The argument validation above
  // still throws — that's a programming error, not a transport one.
  //
  // ⚠️ EXCEPT WHERE THE CALLER ASKS OTHERWISE (MOTIR-3583). `opts.strict`
  // re-opens exactly this decision for the AUTHENTICATION emails, where the
  // premise of the paragraph above is false: there is no committed mutation to
  // preserve, so swallowing preserves nothing and hides everything. It is an
  // argument rather than a new default because the default is right for every
  // caller that has one.
  // The enqueue itself is `dispatchToEngine` below, shared with the system doors
  // so there is ONE description of what emitting an event means.
  await dispatchToEngine(name, data, {
    caller: 'sendEvent',
    context: `workspaceId=${String(workspaceId)}`,
    // Passed THROUGH, never flipped here: the default is the post-commit
    // contract above, and the one class of caller that needs the other answer
    // asks for it by argument (see {@link SendEventOptions.strict}).
    strict: opts.strict ?? false,
  });
}

/**
 * Emit a SYSTEM event (`system.*`), best-effort — the untenanted sibling of
 * {@link sendEvent} (Story MOTIR-3415 · MOTIR-3456).
 *
 * ⚠️ IT EXISTS SO EVERY SYSTEM EMITTER GOES THROUGH ONE DOOR, and for no other
 * reason. Four emitters used to reach the queue directly — the seat sync, both
 * code-graph enqueues and the runner boot — so a change to what emitting means
 * (at the time, the per-job cutover switch; today, the engine's idempotency and
 * debounce) simply did not reach them. An emitter that bypasses this module is an
 * emitter no such change can reach.
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
  await dispatchToEngine(name, data, { caller: 'sendSystemEvent', strict: false });
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
 * door is what lets them keep behaving that way while still going through the one
 * emit seam — the point of MOTIR-3456 is to move WHERE the event is dispatched,
 * never to change WHETHER a caller finds out that it failed.
 */
export async function dispatchSystemEvent<N extends SystemEventName>(
  name: N,
  data: JobEventData<N>,
): Promise<void> {
  await dispatchToEngine(name, data, { caller: 'dispatchSystemEvent', strict: true });
}

interface DispatchOptions {
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
 * THE ONE PLACE THAT DESCRIBES WHAT EMITTING AN EVENT MEANS.
 *
 * ⚠️ IT USED TO BE `dispatchToLanes`, AND THE PLURAL WAS LOAD-BEARING (Story
 * MOTIR-3418 removed it). While two substrates ran side by side this function
 * attempted BOTH — the engine for the subscribers that had moved, the vendor's
 * transport for the ones that had not — because an event's subscriber set could
 * be SPLIT mid-migration, and giving up on the second because the first failed
 * would have dropped the jobs that had not moved. `work-item/transitioned` has
 * four subscribers and moving one of them had to move exactly one.
 *
 * There is one lane now, so there is one write, and the fan-out that used to be
 * split across two engines is entirely inside `dispatchEventToEngine`: it
 * enqueues one `job_queue` row per subscriber of the event, from the registry
 * rather than from a hand-maintained list.
 */
async function dispatchToEngine<N extends JobEventName>(
  name: N,
  data: JobEventData<N>,
  opts: DispatchOptions,
): Promise<void> {
  try {
    await dispatchEventToEngine(name, data, {
      idempotencyKey: (data as { idempotencyKey?: string }).idempotencyKey ?? null,
    });
  } catch (err) {
    if (opts.strict) throw err;
    // The best-effort contract: the caller emits POST-COMMIT, so a failure here
    // must not turn an already-committed mutation into a 500.
    const where = opts.context === undefined ? '' : ` (${opts.context})`;
    console.error(
      `${opts.caller}("${name}") failed to enqueue${where}; ` +
        `the mutation committed but the event was dropped:`,
      err,
    );
  }
}
