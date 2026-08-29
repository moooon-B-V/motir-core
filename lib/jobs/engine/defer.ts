// THE DEFER SIGNAL (Story MOTIR-3778 · Subtask MOTIR-3825) — a handler asks for
// its own run back at an instant it names, and gets it.
//
// ===========================================================================
// What a DEFER is, in one sentence
// ===========================================================================
// The handler has done ONE unit of work, has written whatever it needs to
// remember into a durable row of its own, and wants the run again later. It
// throws {@link JobRunDefer}; the worker returns the `job_queue` row to
// `pending` at `resumeAt` with the claim released and the attempt refunded; a
// worker claims it later and `runQueuedJob` invokes the handler FROM THE TOP.
//
// It is the mechanism `docs/decisions/job-queue-foundation.md` §16.1 decides —
// the SAME queue row deferred forward, never a new run per poll — and it is what
// the supervision driver and both container-supervisor conversions stand on.
//
// ===========================================================================
// ⚠️ IT IS NOT `step.sleep`, AND THE DIFFERENCE IS THE WHOLE POINT
// ===========================================================================
// `step.sleep` throws `JobStepYield` (`./step.ts`). The two look identical at
// the worker — both release the claim, both refund the attempt, both move
// `run_at` — and they are opposite in what they promise the HANDLER:
//
//   | | `step.sleep` → `JobStepYield` | `deferRun` → `JobRunDefer` |
//   |---|---|---|
//   | writes to `job_step` | YES — a `sleep` checkpoint keyed by the step id | NOTHING |
//   | where the handler resumes | back INTO the same place in the same loop, because every step before the sleep replays from its memo and the sleep itself is re-found and skipped once elapsed | at the TOP, with no position remembered |
//   | who owns the state between passes | the step ledger | THE HANDLER, in a durable row of its own |
//   | what it costs per suspension | one `job_step` row, plus a replay of every earlier step, plus a re-execution of every un-memoized call before it | a replay of the memos the handler still reads, and nothing else |
//
// **So a deferring handler OWNS ITS OWN DURABLE STATE.** That is not a style
// note; it is the contract. Nothing about a defer remembers a loop counter, a
// cursor or an observation, and a handler that assumes otherwise silently
// restarts its work on every pass. `docs/decisions/job-queue-foundation.md`
// §16.2 is where the supervisors' own row is decided; §13.3(b) is why that state
// may not be a `step.run` memo instead (a memo freezes its FIRST answer for the
// life of the run, and per-pass state is precisely the state that must change).
//
// ⚠️ AND IT IS A SUSPENSION, NEVER A PATH OUT OF THE WORK (§16.4). A defer is a
// THROW, so it unwinds through every `finally` between the `deferRun` call and
// the worker — and §15.4 recorded what that costs a supervision: *"a yielding
// poll loop would have called `settleIndexContainer` on its first suspension and
// torn down the container it was watching."* A caller that tears anything down
// in a `finally` must not defer from inside it. The driver's answer is
// structural rather than a guard: it has no `finally` at all, and teardown is
// reachable only from an explicit terminal transition.
//
// ===========================================================================
// Why its own module, and not a second export from `step.ts`
// ===========================================================================
// `step.ts` implements INNGEST's step contract — its whole design constraint is
// to be indistinguishable from the vendor's, down to the JSON round trip, so
// that the 58 call sites written against that contract did not have to be
// edited. A defer is ours. Putting it there would make the shim's boundary a
// matter of memory rather than of file layout.

/** Reported through `JobWorkerOptions.onOutcome` when a pass deferred. */
export const DEFER_OUTCOME = 'deferred' as const;

/**
 * Thrown by {@link deferRun} to hand control back to the worker WITHOUT ending
 * the run's work.
 *
 * Not an error condition — the worker MUST distinguish it from a genuine
 * failure: a defer re-enqueues the run at `resumeAt` and REFUNDS the attempt,
 * while a failure consumes one. `system.ci-runner-boot` runs on
 * `retryPolicy: 'none'` (a budget of exactly ONE), so on that job the difference
 * between refunding and not is the difference between a supervision that can
 * poll a hundred times and one that dead-letters on its second.
 */
export class JobRunDefer extends Error {
  readonly code = 'JOB_RUN_DEFER' as const;
  /** When the run becomes claimable again. */
  readonly resumeAt: Date;
  /**
   * A short, human-readable why — for the worker's log line and for an
   * operator reading it, never for control flow. Deliberately a free string
   * rather than an enum: the vocabulary belongs to whichever handler deferred,
   * and the engine has no business knowing it.
   */
  readonly reason: string;

  constructor(resumeAt: Date, reason: string) {
    super(`Job run deferred until ${resumeAt.toISOString()} (${reason})`);
    this.name = 'JobRunDefer';
    this.resumeAt = resumeAt;
    this.reason = reason;
  }
}

/**
 * Narrow an unknown thrown value to the defer signal.
 *
 * Exported because the worker's `catch` is the only correct consumer — the same
 * shape and the same reason as `isJobStepYield`. A handler that catches its own
 * defer has swallowed a suspension and turned it into a completed pass.
 */
export function isJobRunDefer(err: unknown): err is JobRunDefer {
  return err instanceof JobRunDefer;
}

/**
 * Give this run back to the queue, due at `at`.
 *
 * ⚠️ IT NEVER RETURNS — the return type is `never`, so a caller that writes
 * `deferRun(...)` without `return`/`throw` in front of it still cannot fall
 * through to the next line, and TypeScript narrows the code after it as
 * unreachable.
 *
 * `at` is a `Date` and ONLY a `Date`, deliberately. A signature accepting
 * `Date | number` would have to guess whether `5000` means "in five seconds" or
 * "at 1970-01-01T00:00:05Z", and the two are five decades apart with no way for
 * a reader to tell which a call site meant. Callers computing a wait already
 * hold both halves (`new Date(now.getTime() + waitMs)`), so the ambiguity buys
 * nothing.
 *
 * An instant already in the PAST is legal and means *"give it back at once"* —
 * `claimDueRuns` takes any row whose `run_at <= now()`, so such a row is simply
 * due. What is refused is an INVALID date, because `rescheduleAt` would write it
 * and the row would never be claimable again.
 */
export function deferRun(at: Date, reason: string): never {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError(
      `deferRun: \`at\` must be a valid Date — a run deferred to an invalid instant is a run nothing can ever claim. Got: ${String(at)}`,
    );
  }
  throw new JobRunDefer(at, reason);
}
