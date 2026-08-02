import { defineJob } from '../defineJob';
import { inngest } from '../client';
import { ciRunnerBootEvent } from '@/lib/ciFleet/bootDispatch';
import {
  FLEET_TIME_BUDGETS,
  INITIAL_POLL_STATE,
  pollWaitMs,
  type PollResult,
} from '@/lib/services/ciRunnerBootService';

// The runner FLEET's background jobs (Story MOTIR-1916 · MOTIR-1921) — the
// trigger, the boot, and the backstop.
//
// Three functions, and the third is the one that matters most:
//
//   * `system.ci-runner-provision-sweep` — finds pending intents and fans out one
//     boot event each. THE RECOVERY TRIGGER (see below).
//   * `system.ci-runner-boot` — one intent, one runner, supervised to its end.
//   * `system.ci-runner-reap` — destroys containers nothing is supervising.
//
// ⚠️ THE SWEEP IS NO LONGER THE PRIMARY TRIGGER, AND NEVER COULD BE.
// `docs/decisions/ci-runner-fleet.md` §6 budgets p50 ≤ 30s from the
// `workflow_job.queued` webhook to the job starting, and a minute-granularity
// cron cannot meet that — it adds up to 60s before the admission gate is even
// consulted. MOTIR-1996 moved the fast path where it belongs: the webhook
// dispatches `system.ci-runner-boot` itself, in the same request that records the
// intent (`lib/ciFleet/bootDispatch.ts`).
//
// THE SWEEP STAYS, unchanged and load-bearing, as the RECOVERY path — for an
// intent whose hot dispatch was dropped (a transport blip the webhook swallows
// rather than 500s on), and as the retry loop every gate DEFERRAL depends on: a
// project at its in-flight cap leaves its intent pending, and this is what comes
// back for it. The two triggers race by design; `claimPending`'s compare-and-set
// means one of them wins and the other gets `already_claimed`.
//
// MOTIR-1922's ADMISSION GATE sits inside `runIntent` either way — so a sweep
// that fans out 25 boots does not fan out 25 containers, and a faster trigger
// cannot outrun a cap.
//
// System-scoped, like every `system.*` job: the fleet spans tenants because
// Motir's infrastructure bill does.

/** Every minute. The floor Inngest cron granularity allows, which is also the
 *  honest statement of what this trigger can and cannot promise (§6). */
export const CI_RUNNER_PROVISION_SWEEP_CRON = '* * * * *';

/** Every 10 minutes, offset off the hour so it never lines up with the other
 *  `system.*` schedules. The reaper only ever finds something when a supervisor
 *  died, so it is almost always a single provider list call that returns nothing
 *  actionable — cheap enough to run often, and running often is the point: the
 *  window between an orphan appearing and being destroyed is billed. */
export const CI_RUNNER_REAP_CRON = '7,17,27,37,47,57 * * * *';

/** How many pending intents one sweep will fan out. A ceiling rather than
 *  "everything", so a backlog drains at a predictable rate instead of firing
 *  hundreds of concurrent boots at GitHub's registration limit — and it is
 *  LOGGED when it binds (never a silent truncation). */
const SWEEP_BATCH = 25;

export const ciRunnerProvisionSweep = defineJob(
  {
    id: 'system.ci-runner-provision-sweep',
    cron: CI_RUNNER_PROVISION_SWEEP_CRON,
    // `idempotent`: the sweep only READS pending intents and fans out events;
    // the claim that follows is a compare-and-set, so a duplicate event costs one
    // losing claim and nothing else.
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const intentIds = await ctx.step.run('list-pending-intents', async () =>
      services.ciRunnerBoot.listRunnableIntentIds(SWEEP_BATCH),
    );

    if (intentIds.length === 0) return { dispatched: 0 };

    if (intentIds.length === SWEEP_BATCH) {
      // The batch ceiling bound. Say so — a sweep that silently drops the tail
      // reads exactly like one that had nothing left to do.
      console.warn('[ciRunnerProvisionSweep] the batch ceiling bound; more intents remain', {
        batch: SWEEP_BATCH,
      });
    }

    await ctx.step.run('dispatch-boots', async () => {
      for (const intentId of intentIds) {
        // `inngest.send` directly, not `sendEvent`: this is a `system.*` event
        // and carries no acting workspace of its own. The handler re-reads the
        // intent for everything, so the payload is deliberately just the id —
        // built by the SHARED `ciRunnerBootEvent` so the recovery path and the
        // webhook's hot path cannot emit two different events for one intent.
        //
        // Sent BARE, not through `dispatchCiRunnerBoot`: a failure here belongs
        // to the step, and letting it propagate buys a free Inngest retry. The
        // webhook has no such retry, which is why only it swallows.
        await inngest.send(ciRunnerBootEvent(intentId));
      }
      return { dispatched: intentIds.length };
    });

    return { dispatched: intentIds.length };
  },
);

export const ciRunnerBoot = defineJob(
  {
    id: 'system.ci-runner-boot',
    // ⚠️ `none` — ONE ATTEMPT, and this is the one retry policy in the fleet that
    // is a correctness decision rather than a cost one. A retry would re-enter
    // the handler from the top, and the failures worth retrying (an exhausted
    // registration ceiling, an unconfigured deployment) release the claim and
    // come back through the next sweep instead — a retry that costs nothing.
    // `bootIntent` returns typed outcomes rather than throwing for exactly that
    // reason.
    //
    // ⚠️ IT IS NOT WHAT STOPS A SECOND CONTAINER. That is `admit`'s atomic
    // `pending → provisioning` claim, and — since MOTIR-2007 — the fact that the
    // boot now sits inside a memoized step, so a replay pass never re-runs it.
    retryPolicy: 'none',
  },
  async (ctx, services) => {
    const { intentId } = ctx.event.data as { intentId: string };

    // ⚠️ THE DURABLE POLL LOOP (MOTIR-2007). Supervising a container takes up to
    // an hour; ONE INVOCATION of `app/api/inngest/route.ts` gets `maxDuration =
    // 300` (MOTIR-1974). Doing it synchronously — which is what this handler used
    // to do — meant every CI job over ~5 minutes had its supervisor killed with
    // `FUNCTION_INVOCATION_TIMEOUT`: no teardown, no usage row, a dead-lettered
    // run for a job that had actually passed, and an intent left holding a fleet
    // slot against the fail-closed ceiling until the reaper aged it out 70
    // minutes later.
    //
    // So the RUN spans the hour and no STEP does. Each step below is a fixed,
    // small piece of work; the waiting happens in `ctx.step.sleep`, which holds
    // no invocation at all. This is Inngest's canonical shape for long external
    // work and `lib/jobs/codeGraphSteps.ts` is the same move (MOTIR-1974).
    //
    // ⚠️ AND IT RETIRES MOTIR-2002's MEMO. With every phase inside a step,
    // Inngest's memoization gives once-per-RUN semantics for free: the boot (and
    // its admission claim) executes on the first pass and replays from the memo
    // on every later one. The `supervision_key` / `supervision_outcome` columns
    // that bought that property for the un-stepped body are dropped in this same
    // change — the shape fix subsumes the patch.
    const booted = await ctx.step.run('boot-runner', () =>
      services.ciRunnerBoot.bootIntent(intentId),
    );
    // Nothing was provisioned — no container, so nothing to supervise or tear
    // down. The outcome IS the run's result.
    if (booted.phase === 'terminal') return booted.outcome;

    const { session } = booted;
    let state = INITIAL_POLL_STATE;
    let verdict: Extract<PollResult, { done: true }> | null = null;

    for (let iteration = 1; iteration <= FLEET_TIME_BUDGETS.maxPollIterations; iteration += 1) {
      // Free waiting: Inngest schedules the resume, so the interval costs a
      // checkpoint rather than an invocation. `pollWaitMs` is PURE — a function
      // of the iteration, never of the clock — because a replay pass re-derives
      // every sleep in the loop and a wall-clock input would make two passes of
      // the same run disagree about how long to wait.
      await ctx.step.sleep(`supervise-wait:${iteration}`, pollWaitMs(iteration));
      // ONE provider read, then return. This is the step the card exists to
      // bound, and `pollOnce` never throws — a throw here would end the run
      // WITHOUT teardown, because a step scheduled from a catch is never
      // executed by the real executor (PRODECT_FINDINGS #39).
      const polled: PollResult = await ctx.step.run(`supervise-poll:${iteration}`, () =>
        services.ciRunnerBoot.pollOnce(session, state),
      );
      if (polled.done) {
        verdict = polled;
        break;
      }
      state = polled;
    }

    // ⚠️ TEARDOWN IS REACHED ON EVERY PATH OUT OF THE LOOP — the stepped form of
    // the `finally` this handler used to rely on, and the fleet's third teardown
    // guarantee. The loop can only exit with a `done` verdict or by exhausting
    // the static iteration ceiling, and both arrive here.
    return ctx.step.run('settle-runner', () =>
      services.ciRunnerBoot.settleSupervision(
        session,
        verdict ?? {
          done: true,
          reason: 'job_timed_out',
          startedAt: state.startedAt,
          bootLatencyMs: state.bootLatencyMs,
          failureDetail: `supervision hit the ${FLEET_TIME_BUDGETS.maxPollIterations}-poll ceiling`,
        },
      ),
    );
  },
);

export const ciRunnerReap = defineJob(
  {
    id: 'system.ci-runner-reap',
    cron: CI_RUNNER_REAP_CRON,
    // `idempotent`: destroying an already-destroyed container is a no-op at every
    // provider the port targets, and the port requires teardown to be idempotent
    // anyway.
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('reap-orphaned-containers', async () =>
      services.ciRunnerBoot.reapOrphans(),
    );
  },
);
