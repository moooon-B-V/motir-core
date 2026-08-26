import { defineJob } from '../defineJob';
import { dispatchSystemEvent } from '../sendEvent';
import { ciRunnerBootEvent } from '@/lib/ciFleet/bootDispatch';

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
// THE SWEEP STAYS, load-bearing, as the RECOVERY path — for an intent whose
// dispatch was dropped (a transport blip a sender swallows rather than 500s on).
// The triggers race by design; `claimPending`'s compare-and-set means one of them
// wins and the other gets `already_claimed`.
//
// ⚠️ AND IT IS NO LONGER "the retry loop every gate DEFERRAL depends on" — that
// clause stood here until MOTIR-2852 and is what made a minute cadence look
// mandatory. A deferred intent is now dispatched by the admission WAKE the moment
// the slot it was waiting for is released
// (`ciRunnerBootService.dispatchNextPendingForProject`, called from the one
// funnel every terminal transition goes through). A slot freeing is an event this
// service already observes; rediscovering it on a timer was the poll.
//
// MOTIR-1922's ADMISSION GATE sits inside `runIntent` either way — so a sweep
// that fans out 25 boots does not fan out 25 containers, and a faster trigger
// cannot outrun a cap.
//
// System-scoped, like every `system.*` job: the fleet spans tenants because
// Motir's infrastructure bill does.

/**
 * Every minute. The floor Inngest cron granularity allows, which is also the
 * honest statement of what this trigger can and cannot promise (§6).
 *
 * ⚠️ WHO OWNS ADMISSION LATENCY, AS OF MOTIR-2852: NOT THIS. A queued job is
 * dispatched by the `workflow_job` webhook (MOTIR-1996) and a DEFERRED one by the
 * admission WAKE the moment its project's slot is released
 * (`ciRunnerBootService.dispatchNextPendingForProject`). Both are events the
 * service already observes, so neither waits on a cron minute. **This cadence is
 * now purely a BACKSTOP** — the cover for a dispatch that was dropped in transit
 * — and the module header above is the older framing, corrected in place.
 *
 * ⚠️ AND IT IS UNCHANGED — NOW ON A MEASUREMENT RATHER THAN PENDING ONE
 * (MOTIR-2853, 2026-08-21). The paragraph that stood here deferred the cadence
 * question to a measurement taken after the wake shipped. That measurement is
 * done, and it says **this line is not the lever**.
 *
 * The Neon compute was sampled from the control plane every 5 minutes for 6 h 12 m
 * against release v96 — 76 samples, `current_state: "active"` in every one, duty
 * cycle **100%** (100.8% over the cleanest 3 h 16 m sub-window, which contains no
 * deploy and no merge; the >100% is refresh-boundary jitter on a counter that
 * batches every ~90–105 min). The database never suspended once.
 *
 * **And lengthening this cron could not have changed that, even set to never.**
 * Delete this schedule outright and the remaining `system.*` crons still wake the
 * compute at minutes {0,7,10,17,20,22,27,30,37,40,47,50,52,57} — a longest quiet
 * gap of **7 minutes**, under the ~9 min suspend delay measured on 2026-08-20
 * (`docs/decisions/application-hosting.md` §21). Every one of those ticks is a
 * guaranteed database WRITE, not a possible read: `defineJob` records a `job_run`
 * row before the handler body runs and flips it after, so no early return in any
 * job can avoid it.
 *
 * So the cost is the SHAPE of the schedule, not the frequency of its loudest
 * member — see the reaper's cron below, where that is now argued out.
 */
export const CI_RUNNER_PROVISION_SWEEP_CRON = '* * * * *';

/** Every 10 minutes. The reaper only ever finds something when a supervisor died,
 *  so it is almost always a single provider list call that returns nothing
 *  actionable — cheap enough to run often, and running often is the point: the
 *  window between an orphan appearing and being destroyed is billed.
 *
 *  ⚠️ THE OFFSET RATIONALE IS SUPERSEDED, AND DELIBERATELY LEFT AS A CORRECTION
 *  RATHER THAN DELETED (MOTIR-2853, 2026-08-21). This comment used to read
 *  "offset off the hour so it never lines up with the other `system.*` schedules".
 *  That is textbook load-spreading and it is correct on a machine that is always
 *  on. On a compute that SUSPENDS WHEN IDLE it is exactly inverted: the only
 *  quantity billed is how often the thing wakes, and every distinct offset is
 *  another wake. Ten jobs on ten offsets wake it ten times; the same ten aligned
 *  onto shared minutes wake it once.
 *
 *  Measured (MOTIR-2853): the schedule's fourteen distinct wake-minutes leave a
 *  longest gap of 7 minutes, under the ~9 min suspend delay, so the compute never
 *  sleeps — 100% duty cycle over 6 h 12 m. The spreading is what costs the money.
 *
 *  **This cron is NOT changed here.** Re-timing the schedule is a coordinated
 *  change across every `system.*` job and belongs to its own work item, with the
 *  contention argument this comment used to make weighed against the wake count
 *  rather than assumed away. What is fixed here is the REASON, so the next reader
 *  does not re-derive the tension from scratch and reach the old answer. */
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
    // The ONLY `skip` among the fourteen (`docs/decisions/job-queue-foundation.md`
    // §11.4). At `* * * * *` the next fire is under a minute away, so replaying a
    // missed one saves less than the claim loop's own poll interval — while after
    // a six-hour outage it would enqueue 360 rows fanning out against the batch
    // ceiling below, which exists to protect GitHub's registration limit. Note
    // that its sibling `system.ci-runner-reap` is `latest` despite a comparable
    // cadence: the dispositions differ because the COSTS do, not the schedules.
    catchUp: 'skip',
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
        // `dispatchSystemEvent`, not `sendEvent`: this is a `system.*` event and
        // carries no acting workspace of its own. The handler re-reads the
        // intent for everything, so the payload is deliberately just the id —
        // built by the SHARED `ciRunnerBootEvent` so the recovery path and the
        // webhook's hot path cannot emit two different events for one intent.
        //
        // Sent BARE, not through `dispatchCiRunnerBoot`: a failure here belongs
        // to the step, and letting it propagate buys a free Inngest retry. The
        // webhook has no such retry, which is why only it swallows. That is why
        // this is the STRICT door and not `sendSystemEvent` — the throw IS the
        // retry (MOTIR-3456).
        const bootEvent = ciRunnerBootEvent(intentId);
        await dispatchSystemEvent(bootEvent.name, bootEvent.data);
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
    // boot sits inside a MEMOIZED step, so a replay pass never re-runs it. The
    // collapse (MOTIR-3485) keeps both: the claim is untouched and inside
    // `bootIntent`, and `boot-runner` is still a step.
    //
    // ⚠️ AND A WORKER RESTART DOES NOT SPEND THIS BUDGET — VERIFIED against the
    // worker rather than assumed, because with a budget of exactly ONE the
    // difference between a reclaim and a failure is the difference between
    // resuming and dead-lettering a CI job that was fine.
    // `jobQueueRepository.reclaimExpiredLeases` and `releaseClaims` both write
    // `"attempts" = GREATEST("attempts" - 1, 0)`, so a dead worker and a graceful
    // drain each REFUND the attempt `claimDueRuns` spent at the claim
    // (`lib/jobs/engine/worker.ts`: *"a reclaim and a drain both refund the
    // attempt"*). A genuine handler failure is counted on the failure path, where
    // there is something to record. `tests/jobs/ci-runner-fleet.test.ts` asserts
    // it against the real reclaim rather than citing this comment.
    retryPolicy: 'none',
  },
  async (ctx, services) => {
    const { intentId } = ctx.event.data as { intentId: string };

    // ⚠️ THE DURABLE POLL LOOP IS GONE, AND MOTIR-2007'S FINDING IS NOT REVERSED
    // — only its remedy (MOTIR-3485). This block used to read: *"Supervising a
    // container takes up to an hour; ONE INVOCATION of
    // `app/api/inngest/route.ts` gets `maxDuration = 300` (MOTIR-1974). Doing it
    // synchronously … meant every CI job over ~5 minutes had its supervisor
    // killed with `FUNCTION_INVOCATION_TIMEOUT`: no teardown, no usage row, a
    // dead-lettered run for a job that had actually passed, and an intent left
    // holding a fleet slot against the fail-closed ceiling until the reaper aged
    // it out 70 minutes later."*
    //
    // Every word of that incident is still true, and the constraint that caused
    // it has gone: `Dockerfile` ends `CMD ["node", "server.js"]` and motir-core
    // has run as a long-lived Fly process since MOTIR-2384, so there is no
    // invocation to be killed. The supervision is an ordinary loop again, and it
    // lives in `ciRunnerBootService.runIntent` — which already carried it, marked
    // "not the production path" for exactly this reason.
    //
    // ⚠️ WHAT THE STEPS ARE FOR NOW. Not an invocation ceiling: a WORKER RESTART.
    // `docs/decisions/job-queue-foundation.md` §13 keeps a step around the
    // operations that PROVISION, CLAIM or TEAR DOWN — `bootIntent` admits, claims
    // the intent, mints a JIT runner registration and provisions a machine, and
    // `settleSupervision` destroys it, de-registers the runner, meters it and
    // settles the intent. The waiting and the polling are ordinary calls, because
    // forgetting them costs nothing.
    //
    // ⚠️ AND IT STILL RETIRES MOTIR-2002's MEMO, for the same reason it always
    // did: the boot executes on the first pass and replays from `job_step` on
    // every later one, so `supervision_key` / `supervision_outcome` stay dropped.
    // That property is a property of the STEP, and the step is still here.
    return services.ciRunnerBoot.runIntent(intentId, {
      steps: {
        run: <T>(id: string, fn: () => T | Promise<T>): Promise<T> =>
          // ONE cast, at the boundary — the same shape and reason as
          // `lib/jobs/engine/runner.ts`'s single cast. Inngest types a step's
          // result as `Jsonify<T>`, and every value crossing this seam
          // (`SupervisionSession`, `RunIntentOutcome`) is declared
          // JSON-serializable by contract and says so at its definition.
          ctx.step.run(id, fn as () => Promise<T>) as unknown as Promise<T>,
      },
    });
  },
);

export const ciRunnerReap = defineJob(
  {
    id: 'system.ci-runner-reap',
    cron: CI_RUNNER_REAP_CRON,
    // `latest`, not `skip` like the provision sweep above, and the ten-minute
    // cadence is not what decides it: an orphaned container bills for every
    // minute it survives, so an immediate reap on restart reclaims spend the next
    // fire would not. One pass suffices — it reads the CURRENT orphan set.
    catchUp: 'latest',
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
