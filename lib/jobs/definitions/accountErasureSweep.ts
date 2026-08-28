import { defineJob } from '../defineJob';

// THE ACCOUNT-ERASURE SWEEP (Story 8.4 · Subtask MOTIR-3702) — the clock behind
// `content/legal/privacy.md` §6's *"we erase or anonymise within 30 days"*.
//
// MOTIR-3700 writes the request and starts the grace period; this is what runs
// when it expires. The policy — the three DECISION 3 groups, the lock and
// re-read that makes a day-29 cancel stick, the sole-membership workspaces that
// go through `workspacesService.deleteWorkspace` so the code-graph offboarding
// queue is fed — is all in `accountErasureSweepService`. This file is the
// schedule and nothing else.
//
// SYSTEM-scoped, like every other retention sweep here (`system.attachment-gc`,
// `system.automation-retention-sweep`, `system.code-graph-offboard-sweep`): the
// due set spans users and tenants, so the service opens `withSystemContext` for
// its SELECT and a per-user context for each erasure, and the ledger row is
// untenanted.
//
// `retryPolicy: 'idempotent'`: the sweep converges on re-run by construction —
// it re-derives everything it acts on rather than replaying a plan, so an
// already-erased account's `deleteMany`s match zero rows and its request no
// longer matches the due arm. A transient blip is worth Inngest's full 5-attempt
// budget.
//
// ⚠️ AND A PER-ACCOUNT FAILURE NEVER REACHES THAT BUDGET, DELIBERATELY. The
// service catches, counts and logs each one, so the job SUCCEEDS with a
// non-zero `failed` in its summary rather than failing the whole tick. Retrying
// the tick would re-visit every account that already succeeded to reach the one
// that did not; the failed request stays `scheduled` and is simply due again
// tomorrow, which is the same retry with none of the blast radius.

/**
 * 03:00 every day — a clustered minute (`lib/jobs/schedules.ts`'s
 * `SCHEDULE_CLUSTER_MINUTES`, so it opens no new wake-minute and the quiet gap
 * is untouched) and an hour of its own at the FRONT of the nightly cascade:
 * 03:00 here → 03:30 `system.attachment-gc` → 04:00 `system.rate-limit-sweep` →
 * 04:30 `system.automation-retention-sweep` → 05:00
 * `system.code-graph-offboard-sweep`.
 *
 * ⚠️ THE POSITION IS ORDERING, NOT LOAD-SPREADING. Erasing an account deletes
 * its sole-membership workspaces, and each of those enqueues an IMMEDIATE
 * `workspace_deleted` offboarding row (`isImmediate` — `dueAt` is `now`).
 * Running BEFORE the 05:00 offboard sweep means a night's erasures have their
 * derived code graphs removed the SAME night; running after it would leave them
 * standing for a further 24 hours, which is retention nobody decided on.
 */
export const ACCOUNT_ERASURE_SWEEP_CRON = '0 3 * * *';

export const accountErasureSweep = defineJob(
  {
    id: 'system.account-erasure-sweep',
    cron: ACCOUNT_ERASURE_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    // The per-run summary IS the return value, persisted on the run's `job_run`
    // ledger row. For this job that is the only durable record of a per-account
    // failure — `AccountDeletionStatus` has no `failed` member (it is
    // `scheduled` / `cancelled` / `completed`, all three of them states a
    // PERSON caused), so an erasure that threw is reported here and stays due,
    // rather than being written onto the request as a fourth state nobody asked
    // the product for.
    return ctx.step.run('erase-due-accounts', () => services.accountErasureSweep.sweep());
  },
);
