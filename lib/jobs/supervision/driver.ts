import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { deferRun } from '../engine/defer';

// THE SUPERVISION DRIVER (Story MOTIR-3778 · Subtask MOTIR-3827) — one shared
// advance-once state machine, and the only place either container supervisor's
// loop lives after the conversions.
//
// ===========================================================================
// What it does, in one sentence
// ===========================================================================
// Read the supervision's row, do EXACTLY ONE poll, and then either write the
// advanced state and DEFER the run (`lib/jobs/engine/defer.ts`), or take a
// terminal transition and settle. `docs/decisions/job-queue-foundation.md` §16
// is the decision it implements.
//
// ===========================================================================
// ⚠️ THE SUSPENSION INVARIANT, AND WHY IT IS STRUCTURAL RATHER THAN A GUARD
// ===========================================================================
// **A DEFER IS A SUSPENSION, NOT A PATH OUT OF SUPERVISION.** Teardown is
// reachable from exactly THREE named transitions and from nothing else:
//
//   1. the poll returned a `done` verdict — the container ended;
//   2. a DEADLINE fired — either the wall clock measured from the SESSION's
//      `bootedAt`, or the total-poll ceiling. Two triggers, one transition:
//      both mean "this supervision may not continue", and each carries its own
//      reason and its own test;
//   3. the poll THREW — a failure settles FIRST and re-throws after, which is
//      the arm a stepped loop could never cover.
//
// **There is no `try`/`finally` in this file, and that absence is the
// mechanism.** §15.4 recorded what a `finally` costs a shape that suspends by
// throwing: *"a yielding poll loop would have called `settleIndexContainer` on
// its first suspension and torn down the container it was watching."* A defer is
// a throw too. A guard that says "unless it is a defer" is one edit from being
// wrong for ever; a file with nothing to unwind through cannot make the mistake.
// The defer is thrown from the tail, outside every `try` here, and
// `settles no container on the defer path` asserts the negative directly.
//
// ===========================================================================
// ⚠️ THE POLL CEILING IS A TOTAL BOUND AGAIN — a property REGAINED
// ===========================================================================
// §13.3(a) accepted that `maxPollIterations` had become a per-PASS runaway
// guard rather than a bound on total polls, because a worker restart reset the
// in-memory counter and the wall clock anchored on `session.bootedAt` was the
// bound that actually mattered. **The count lives in `job_supervision` now**, so
// a supervision resumed across a hundred passes reaches the ceiling at the same
// cumulative number it would have reached in one. That is a property coming
// back, not a behaviour change hidden in a refactor — and §16.5's disposition
// table says so at the call site.
//
// ===========================================================================
// What this module is NOT allowed to know
// ===========================================================================
//   * **No timing constant appears here.** `waitMs`, `maxPolls` and `timeoutMs`
//     are all supplied by the caller — `indexPollWaitMs` /
//     `INDEX_FLEET_TIME_BUDGETS` for one supervisor, `pollWaitMs` /
//     `FLEET_TIME_BUDGETS` for the other — precisely so this file cannot become
//     a second place a cadence lives. §16.6 forbids changing any of them.
//   * **No container, no orchestrator, no admission slot.** It calls the
//     `settle` hook it was given. The caller wraps that hook in its own memoized
//     `step.run`, which is what makes a teardown idempotent across passes.
//   * **No BOOT DEADLINE.** The deadline this file evaluates is the OVERALL one,
//     measured from `bootedAt` — a quantity that depends on no in-memory
//     observation and is therefore safe to evaluate on a failed read. The
//     boot-deadline verdict stays inside the caller's `poll`, where §13.3(b)'s
//     requirement can be met: it may only be reached from a SUCCESSFUL provider
//     read, because after the collapse *"we have not seen it start"* and *"we
//     have forgotten that we saw it start"* are indistinguishable. Every pass
//     now begins with `startedAt` unknown until the row is read, so that
//     requirement binds harder here than it did in the loop.

/**
 * True when a thrown value is Prisma's unique-constraint violation.
 *
 * A local copy, exactly as `lib/jobs/engine/step.ts` carries one: the check is
 * two lines, and importing it would make a shared helper out of a predicate
 * whose only correct consumers are the two places that RACE on a write.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** Which supervision, and the session instant its clock is anchored to. */
export interface SupervisionKey {
  /** Which supervisor — `index` / `ci-runner`. Recorded on the row for the sweep's attribution. */
  kind: string;
  /**
   * WHAT is being supervised, within this run: the `projectId` for the index
   * fleet, the intent id for the CI fleet. It is the second half of the row's
   * identity and the string the caller's step ids are built from, so it names
   * the UNIT OF WORK and never a loop position (§13.1 limb 4).
   */
  subject: string;
  workspaceId: string | null;
  /**
   * When the container was booted — from the caller's MEMOIZED boot, never from
   * this pass. The wall clock is anchored to the SESSION rather than to the
   * loop, which is the property §13.2 records and the reason a resumed pass
   * settles a container already past its timeout instead of watching it afresh.
   */
  bootedAt: Date;
}

/** The state one pass is handed. `pollNumber` is the number of the poll it is ABOUT to perform (1-based). */
export interface SupervisionPollState {
  pollNumber: number;
  /** The observed container start, or null while nothing has successfully read one. */
  startedAt: Date | null;
  consecutiveReadFailures: number;
}

/** What the caller's ONE provider read observed. `V` is the caller's own verdict type. */
export type SupervisionPollResult<V> =
  | {
      done: false;
      startedAt: Date | null;
      consecutiveReadFailures: number;
    }
  | { done: true; verdict: V };

/**
 * Why a terminal transition was entered. Three transitions (see the header);
 * `deadline` and `poll_ceiling` are the two triggers of the second one.
 */
export type SupervisionTerminalReason = 'completed' | 'deadline' | 'poll_ceiling' | 'failed';

/** The caller's half. `V` is its poll verdict; `O` is its settled outcome. */
export interface SupervisionHooks<V, O> {
  /**
   * ONE provider read. No loop, no sleep, no second call — the whole point of
   * the shape is that a pass costs one round trip.
   */
  poll(state: SupervisionPollState): Promise<SupervisionPollResult<V>>;
  /**
   * The caller's teardown. Invoked from exactly one place in this file, and
   * expected to be wrapped by the caller in its own memoized `step.run`
   * (`index-settle:<subject>` / `settle-runner`) so a replayed pass returns the
   * stored outcome rather than destroying a container twice.
   */
  settle(
    reason: SupervisionTerminalReason,
    state: SupervisionPollState,
    verdict: V | null,
  ): Promise<O>;
  /** The caller's existing backoff — `indexPollWaitMs` / `pollWaitMs`, unchanged. */
  waitMs(pollNumber: number): number;
  /** The caller's total-poll ceiling. */
  maxPolls: number;
  /** How long the supervision may run, measured from `bootedAt`. The caller's own budget. */
  timeoutMs: number;
  /** Injectable clock, for the tests. Production passes nothing. */
  now?: () => Date;
}

/** What a pass that SETTLED returns. A pass that suspended throws `JobRunDefer` instead and returns nothing. */
export interface SupervisionSettled<O> {
  status: 'settled';
  reason: SupervisionTerminalReason;
  outcome: O;
  /**
   * True when this pass found the row already `settling` / `settled` — a
   * concurrent pass (a lease reclaim overlapping the previous claimant) got
   * there first. The `settle` hook is still called, because the caller's memo is
   * what makes that free and correct; this flag is how a caller or a test can
   * SEE the race rather than infer it.
   */
  raced: boolean;
}

export async function advanceSupervision<V, O>(
  runId: string,
  key: SupervisionKey,
  hooks: SupervisionHooks<V, O>,
): Promise<SupervisionSettled<O>> {
  const now = hooks.now ?? ((): Date => new Date());

  // ── 1 · OPEN OR RE-OPEN, AND READ WHAT THE LAST PASS LEFT ─────────────────
  // `open` is an upsert whose update arm is empty, so re-entering a LIVE
  // supervision does not reset a single observation. On the first pass
  // `next_poll_at` is now: the pass is here.
  //
  // ⚠️ IT IS ITS OWN TRANSACTION, AND A UNIQUE VIOLATION IS A NORMAL OUTCOME —
  // the same shape `lib/jobs/engine/step.ts` uses around `jobStepRepository`,
  // for the same reason. Two passes can legitimately reach the FIRST pass of one
  // supervision at once (a lease reclaim overlapping the previous claimant), and
  // an upsert with an empty update arm is a find-then-insert rather than one
  // atomic statement, so the loser's insert collides. The winner's row is the
  // one BOTH must go on to use — and the catch has to sit outside the
  // transaction, because a failed statement aborts the transaction it is in, so
  // reading the winner from inside the same one is not available.
  try {
    await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        {
          runId,
          subject: key.subject,
          kind: key.kind,
          nextPollAt: now(),
          workspaceId: key.workspaceId,
        },
        tx,
      ),
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const row = await withSystemContext((tx) =>
    jobSupervisionRepository.findByRunAndSubject(runId, key.subject, tx),
  );
  /* v8 ignore next -- `open` has just written the row (or lost the race to a
     pass that did), so the read cannot miss. The throw is here because the
     repository's type is honestly nullable and a silent `!` would turn a future
     regression into a `TypeError` three lines later. */
  if (!row) throw new Error(`job_supervision row for run ${runId} / ${key.subject} vanished`);

  const state: SupervisionPollState = {
    pollNumber: row.pollNumber + 1,
    startedAt: row.startedAt,
    consecutiveReadFailures: row.consecutiveReadFailures,
  };

  // ── 2 · THE DEADLINE TRANSITION, BEFORE THE POLL ──────────────────────────
  // Checked first so a resumed pass meeting a container that is already past its
  // timeout settles it at once rather than watching it for another N polls —
  // §13.3(a)'s property, which the session-anchored clock is what buys.
  const elapsed = now().getTime() - key.bootedAt.getTime();
  if (elapsed >= hooks.timeoutMs) {
    return terminate(runId, key.subject, 'deadline', state, null, hooks);
  }
  if (row.pollNumber >= hooks.maxPolls) {
    return terminate(runId, key.subject, 'poll_ceiling', state, null, hooks);
  }

  // ── 3 · ONE POLL, OUTSIDE EVERY TRANSACTION ───────────────────────────────
  // Outside, for the reason `lib/jobs/engine/worker.ts` gives about the claim: a
  // provider read takes seconds, Prisma cannot nest interactive transactions,
  // and holding one across it would pin a pooled connection for the duration.
  let polled: SupervisionPollResult<V>;
  try {
    polled = await hooks.poll(state);
  } catch (err) {
    // THE THIRD TRANSITION. Settle FIRST, then let the error propagate — a
    // container nothing tears down is the failure every guarantee in the two
    // supervisors exists to prevent, and this is the arm a step reachable only
    // from the loop's two normal exits could never cover (§13.4).
    await terminate(runId, key.subject, 'failed', state, null, hooks);
    throw err;
  }

  if (polled.done) {
    return terminate(runId, key.subject, 'completed', state, polled.verdict, hooks);
  }

  // ── 4 · ADVANCE AND DEFER ─────────────────────────────────────────────────
  // ⚠️ LOCK AND RE-READ BEFORE THE WRITE. The poll number this pass writes is
  // derived from the one it read, and two workers can legitimately hold one run
  // at once: `reclaimExpiredLeases` hands it to a second while the first is
  // still inside a provider call it has not returned from. Without the lock both
  // read N and both write N+1, so the ceiling silently stops bounding anything.
  // With it, the loser observes the winner's row and declines to advance —
  // its poll was a wasted read, which is the correct price.
  const nextPollAt = new Date(now().getTime() + hooks.waitMs(state.pollNumber));
  await withSystemContext(async (tx) => {
    const locked = await jobSupervisionRepository.findByRunAndSubjectForUpdate(
      runId,
      key.subject,
      tx,
    );
    if (!locked || locked.pollNumber !== row.pollNumber || locked.state !== 'watching') return;
    await jobSupervisionRepository.advance(
      runId,
      key.subject,
      {
        startedAt: polled.startedAt,
        consecutiveReadFailures: polled.consecutiveReadFailures,
        nextPollAt,
      },
      tx,
    );
  });

  // ⚠️ THE TAIL, OUTSIDE EVERY `try` IN THIS FILE. Nothing here can intercept
  // the throw and mistake a suspension for an exit — the invariant in the
  // header, expressed as the shape of the function rather than as a check.
  deferRun(nextPollAt, `${key.kind} supervision ${key.subject}: poll ${state.pollNumber} done`);
}

/**
 * THE TERMINAL TRANSITION — the only place `settle` is called, from the three
 * named entrances above and from nowhere else.
 *
 * It moves the row to `settling` BEFORE the teardown and to `settled` after,
 * which is what stops the abandoned-supervision sweep (MOTIR-3830) entering a
 * teardown a live pass is in the middle of. A pass that finds the row already
 * past `watching` lost that race: it still calls `settle`, because the caller
 * wraps it in a memoized step and the memo is what makes a second call free and
 * correct, and it reports `raced: true` so the fact is observable rather than
 * inferred.
 */
async function terminate<V, O>(
  runId: string,
  subject: string,
  reason: SupervisionTerminalReason,
  state: SupervisionPollState,
  verdict: V | null,
  hooks: SupervisionHooks<V, O>,
): Promise<SupervisionSettled<O>> {
  const won = await withSystemContext(async (tx) => {
    const locked = await jobSupervisionRepository.findByRunAndSubjectForUpdate(runId, subject, tx);
    if (!locked || locked.state !== 'watching') return false;
    await jobSupervisionRepository.markState(runId, subject, 'settling', tx);
    return true;
  });

  const outcome = await hooks.settle(reason, state, verdict);

  if (won) {
    await withSystemContext((tx) =>
      jobSupervisionRepository.markState(runId, subject, 'settled', tx),
    );
  }
  return { status: 'settled', reason, outcome, raced: !won };
}
