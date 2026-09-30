import { defineJob } from '../defineJob';

// The OAuth sweep (Story MOTIR-6973 · Subtask MOTIR-6984) — the daily delete of
// OAuth rows nothing can use any more: expired authorization codes, expired or
// unbound access and refresh tokens, and dynamically registered clients older
// than 30 days that never received a connection. The deletes and why each is
// safe live in `oauthSweepService`.
//
// System-scoped (the tables are identity-scoped, no workspace), so the ledger row
// is untenanted — which is why the id is `system.oauth-sweep` rather than the
// `oauth.sweep` the card named: a job id outside the `system.*` namespace is read
// as WORKSPACE-scoped (`WorkspaceScopedEventName`), which this is not. `retryPolicy: 'idempotent'`: every predicate is the row's own
// expiry or age, so a re-run converges and a missed day is caught up by the next;
// there is no run-level state and no ordering between runs to protect.

/** 08:00 every day — a clustered minute (`SCHEDULE_CLUSTER_MINUTES`), after the
 *  nightly table-walk cascade has finished. */
export const OAUTH_SWEEP_CRON = '0 8 * * *';

export const oauthSweep = defineJob(
  {
    id: 'system.oauth-sweep',
    cron: OAUTH_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('sweep-oauth-leftovers', () => services.oauthSweep.sweep());
  },
);
