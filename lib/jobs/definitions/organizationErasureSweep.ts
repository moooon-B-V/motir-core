import { defineJob } from '../defineJob';

// THE ORGANIZATION ERASURE SWEEP (Story MOTIR-6306 · MOTIR-6400) — the clock
// behind `docs/decisions/organization-deletion.md` §6: at the due date an
// organization's Git, workspaces, AI tenant and identity are erased, in that
// order, leaving a tombstone that holds only its billing record.
//
// The policy — the claim that a cancel races, the fixed step order, the resume
// from `erasureStep`, the tombstone, the closing reconcile — is all in
// `organizationErasureSweepService`. This file is the schedule and nothing else.
//
// SYSTEM-scoped, like the account-erasure sweep: the due set spans tenants and the
// ledger row is untenanted.
//
// `retryPolicy: 'idempotent'`: every step is idempotent and the claim is re-derived
// from the row, so a re-run converges. A per-org failure never reaches the retry
// budget — the service records it on the request and the org is resumed on the
// next tick, which is the same retry without re-visiting every org that finished.

/**
 * Hourly, on the hour — a clustered minute, so it opens no new wake-minute. Hourly
 * rather than nightly so an erasure lands within the hour of the date every member
 * was told, and so a step that failed (motir-ai unreachable, a GitHub 500) is
 * retried within the hour instead of the next day.
 */
export const ORGANIZATION_ERASURE_SWEEP_CRON = '0 * * * *';

export const organizationErasureSweep = defineJob(
  {
    id: 'system.organization-erasure-sweep',
    cron: ORGANIZATION_ERASURE_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('erase-due-organizations', () =>
      services.organizationErasureSweep.runDue(),
    );
  },
);
