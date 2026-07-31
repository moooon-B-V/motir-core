import { defineJob } from '../defineJob';

// The CI-Actions gate's CONVERGENCE + RESUME pass (Story MOTIR-1775 ·
// MOTIR-1907) — `docs/decisions/ci-minutes-allowance.md` §6.5.
//
// It does two jobs that look like one, and both are load-bearing:
//
//   1. CONVERGE. The disable fan-out is N GitHub calls with no transaction over
//      them, so a run where half of them fail leaves those rows with their intent
//      ahead of their applied stamp. This finishes them. That is what makes the
//      "half the calls fail" case self-healing rather than a silently
//      half-enforced org.
//
//   2. RESUME — and this is the one with a DEADLINE. A top-up or the calendar
//      month's pool reset both make an exhausted org solvent again, and neither
//      fires a webhook Motir listens to: the balance lives in motir-ai's ledger,
//      and the period boundary is not an event at all. Without this pass an org
//      that paid would stay disabled until it happened to meter another run —
//      which it cannot do, because its Actions are off. That is a DEADLOCK, and
//      it is the reason this job recomputes the entitlement state rather than
//      only re-asserting stored intent.
//
// ⚠️ WHY HOURLY. GitHub drops a queued job that finds no runner after 24h. The
// resume must beat that, so the window between "the user tops up" and "their
// queued work can run" has to be well inside it. Hourly leaves a wide margin at a
// cost of one entitlement read per affected org per hour — and only for orgs that
// are actually disabled, which is a set that is empty almost always.
//
// System-scoped, like every `system.*` job: it spans tenants because Motir's
// GitHub bill does.
//
// `retryPolicy: 'idempotent'`: every operation here is a set-state PUT and a
// derived-predicate read, so a re-run recomputes the same answer and re-issues at
// most the calls that had not landed.

/** Every hour, on the half hour — clear of the other `system.*` schedules. */
export const CI_ACTIONS_GATE_SWEEP_CRON = '30 * * * *';

export const ciActionsGateSweep = defineJob(
  {
    id: 'system.ci-actions-gate-sweep',
    cron: CI_ACTIONS_GATE_SWEEP_CRON,
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    // Step 1 — RESUME. Re-derive the entitlement for every org this gate is
    // currently holding disabled, which flips the intent back to enabled the
    // moment the balance recovers or the period rolls.
    const resumed = await ctx.step.run('resync-disabled-orgs', async () => {
      const organizationIds = await services.ciActionsGate.listDisabledOrganizationIds();
      let synced = 0;
      for (const organizationId of organizationIds) {
        await services.ciActionsGate.syncForOrganization(organizationId);
        synced += 1;
      }
      return { organizations: organizationIds.length, synced };
    });

    // Step 2 — CONVERGE. Anything still unasserted, including whatever step 1
    // just changed its mind about and any row a previous pass could not reach.
    const converged = await ctx.step.run('assert-pending', async () =>
      services.ciActionsGate.sweep(),
    );

    return { resumed, converged };
  },
);
