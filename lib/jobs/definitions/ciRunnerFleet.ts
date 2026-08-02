import { defineJob } from '../defineJob';
import { inngest } from '../client';

// The runner FLEET's background jobs (Story MOTIR-1916 · MOTIR-1921) — the
// trigger, the boot, and the backstop.
//
// Three functions, and the third is the one that matters most:
//
//   * `system.ci-runner-provision-sweep` — finds pending intents and fans out one
//     boot event each. THE INTERIM TRIGGER (see below).
//   * `system.ci-runner-boot` — one intent, one runner, supervised to its end.
//   * `system.ci-runner-reap` — destroys containers nothing is supervising.
//
// ⚠️ THE SWEEP IS AN INTERIM TRIGGER AND SAYS SO. `docs/decisions/
// ci-runner-fleet.md` §6 budgets p50 ≤ 30s from the `workflow_job.queued`
// webhook to the job starting, and a minute-granularity cron cannot meet that.
// It is here because MOTIR-1920 declared the seam between the webhook and the
// boot to be exactly one read — `listPending` — and MOTIR-1922 owns the
// admission gate that sits on the hot path between them ("consulted BEFORE this
// card provisions", §10). Until that gate lands, the sweep is what makes the
// fleet WORK; once it does, the sweep stays as the recovery path for an intent
// the hot call dropped, which is worth having regardless.
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
        // intent for everything, so the payload is deliberately just the id.
        await inngest.send({
          name: 'system.ci-runner-boot',
          data: { intentId, workspaceId: '' },
        });
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
    // NOT wrapped in `ctx.step.run`. A step memoizes its result and is replayed
    // across step boundaries, and this call SUPERVISES a live container for as
    // long as the job runs — memoizing it would mean a replay returning the old
    // outcome while the container it describes is still up. The whole operation
    // is one indivisible unit of work with its own internal guarantees.
    // The outcome — INCLUDING the container-seconds record on a settled run —
    // is the job's return value, which `defineJob` writes to the `job_run`
    // ledger: the per-run audit trail. Since MOTIR-1924 the record is ALSO
    // persisted to `ci_container_usage` inside `runIntent`'s teardown path, so
    // the ledger is no longer the only place a fleet run's cost is readable.
    return services.ciRunnerBoot.runIntent(intentId);
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
