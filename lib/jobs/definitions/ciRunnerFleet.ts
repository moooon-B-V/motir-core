import { defineJob } from '../defineJob';
import { inngest } from '../client';
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
    // is a correctness decision rather than a cost one. A retry would mint a
    // SECOND JIT config and boot a SECOND container for a job that can only ever
    // be taken by one runner; the loser would idle to its timeout, billed to the
    // tenant, having done nothing. `runIntent` is written to return typed
    // outcomes rather than throw for exactly this reason: the failures worth
    // retrying (an exhausted registration ceiling, an unconfigured deployment)
    // release the claim and come back through the next sweep, which is a retry
    // that costs nothing.
    retryPolicy: 'none',
  },
  async (ctx, services) => {
    const { intentId } = ctx.event.data as { intentId: string };
    // ⚠️ UN-STEPPED, AND REPLAY-AWARE BECAUSE OF IT (MOTIR-2002). Supervision
    // cannot be wrapped in a `ctx.step.run`: one step cannot outlive ONE
    // invocation of `app/api/inngest/route.ts`, whose declared budget is
    // `maxDuration = 300` (MOTIR-1974), while a supervised CI job is allowed
    // 3,600s — twelve times that ceiling. So it stays outside a step, where
    // Inngest's durable replay re-executes it on EVERY pass, and `superviseOnce`
    // is what makes that once per DISPATCH instead: the pass that supervises
    // records its outcome on the intent, and later passes read it back.
    //
    // The earlier rationale here — that memoizing would return a stale outcome
    // for a container still up — did not hold as written (a step does not
    // return until its callback resolves), and it described a handler that ran
    // once when the runtime ran it twice. The step CEILING is the real reason.
    //
    // ⚠️ THE KEY IS THE EVENT'S ID, not the run id: it is fixed for a run, and
    // it is the same identity `defineJob` correlates the `job_run` row by, so
    // the memo and the ledger agree on what "this run" means. The `ctx.runId`
    // fallback covers an event that carries no id (cron / harness events); the
    // boot is only ever event-triggered.
    //
    // The outcome — INCLUDING the container-seconds record on a settled run —
    // is the job's return value, which `defineJob` writes to the `job_run`
    // ledger: the per-run audit trail. It is now the SAME value on every pass,
    // so Inngest's reported run output and that row can no longer disagree.
    // Since MOTIR-1924 the record is ALSO persisted to `ci_container_usage`
    // inside `runIntent`'s teardown path, so the ledger is no longer the only
    // place a fleet run's cost is readable.
    return services.ciRunnerBoot.superviseOnce(intentId, ctx.event.id ?? ctx.runId);
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
