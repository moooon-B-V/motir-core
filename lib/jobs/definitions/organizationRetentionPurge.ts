import { defineJob } from '../defineJob';

// THE ORGANIZATION RETENTION PURGE (Story MOTIR-6306 · MOTIR-6401) — the clock
// behind `docs/decisions/organization-deletion.md` §7: seven years after an
// organization was erased, its tombstone and billing record are removed from
// both repositories.
//
// The policy — motir-ai first, then the request rows and the org row in one
// transaction, never an org without `erasedAt` — is in
// `organizationRetentionPurgeService`. This file is the schedule and nothing else.
//
// SYSTEM-scoped, like the erasure sweep: the due set spans tenants and the ledger
// row is untenanted. `retryPolicy: 'idempotent'`: a purged org stops matching, and
// motir-ai's purge answers `{ purged: false }` for one it already removed.

/**
 * Daily at 07:30 — a clustered minute, so it opens no new wake-minute. Daily is
 * ample for a seven-year clock; the only thing a missed day costs is one day of
 * over-retention, and the next pass picks it up.
 */
export const ORGANIZATION_RETENTION_PURGE_CRON = '30 7 * * *';

export const organizationRetentionPurge = defineJob(
  {
    id: 'system.organization-retention-purge',
    cron: ORGANIZATION_RETENTION_PURGE_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('purge-retained-organizations', () =>
      services.organizationRetentionPurge.runDue(),
    );
  },
);
