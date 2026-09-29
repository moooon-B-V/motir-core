import { defineJob } from '../defineJob';

// CERTIFICATE STATE COMES HOME — Story MOTIR-3878 · Subtask MOTIR-4219.
//
// A customer domain's certificate changes on the PLATFORM, not in our database.
// Fly validates and issues asynchronously after the lifecycle requests a
// certificate, renews on its own, and a domain can stop resolving because a
// customer edited DNS nobody told us about. Nothing in the request path can
// observe any of that — so without this job the settings pane shows whatever it
// last wrote, which is a permanent "pending" for a domain that went live an hour
// ago and a confident "live" for one that expired last week.
//
// ── THE CADENCE IS THE CARD'S RECOMMENDATION ─────────────────────────────
//
// MOTIR-4219 recommends "every 5 minutes for pending_certificate / verifying,
// hourly for issued", and since MOTIR-6932 that is what runs: the sweep fires
// every 5 minutes, the in-flight statuses are re-checked on every sweep and
// `issued` hourly (the staleness windows in `publicAddressCertificatesService`).
// Until then it sat on the :00/:30 cluster, which existed so a suspend-when-idle
// database could sleep between ticks; MOTIR-6893 retired that constraint, because
// the database is always on (`docs/decisions/always-on-database-job-cadence.md`).
//
// So a domain reaches `issued` within five minutes of the platform issuing it.
// The pane's *Check again* control (MOTIR-4229) still drives the lifecycle's own
// verify path on demand, so a customer watching their domain does not wait for
// this sweep at all. This job is the BACKSTOP — for the customer who closed the
// tab, and for the renewal and expiry nobody is watching.
//
// ── One cadence, not two ─────────────────────────────────────────────────
//
// The card splits the statuses across two cadences. With one schedule that
// split buys nothing, so the job sweeps every status it owns on
// one schedule and the `staleness` window per status is what separates them:
// a `pending_certificate` row is re-checked whenever it is older than the
// sweep interval, an `issued` row only hourly. The cost is one query per status,
// not one wake per cadence.

/** Every 5 minutes — the recommended cadence for the in-flight statuses. */
export const PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON = '*/5 * * * *';

export const publicAddressCertificateRefresh = defineJob(
  {
    id: 'system.public-address-certificate-refresh',
    cron: PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON,
    // `latest`: a missed sweep has nothing to catch up ON. The platform holds
    // the current state and this job reads it, so replaying yesterday's skipped
    // run would ask the same question and get today's answer twice.
    catchUp: 'latest',
    // Converges on re-run by construction — every write is derived from what the
    // platform just said, so a transient failure costs a delay and nothing else.
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('refresh-certificates', () =>
      services.publicAddressCertificates.refreshDueAddresses(),
    );
  },
);
