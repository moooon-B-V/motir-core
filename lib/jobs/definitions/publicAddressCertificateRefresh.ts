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
// ── ⚠️ THE CADENCE IS NOT THE CARD'S RECOMMENDATION, AND THAT IS DELIBERATE ──
//
// MOTIR-4219 recommends "every 5 minutes for pending_certificate / verifying,
// hourly for issued". That is not available here, and the constraint is a
// shipped one rather than a preference: `lib/jobs/schedules.ts` clusters every
// `system.*` cron onto `SCHEDULE_CLUSTER_MINUTES` — [0, 30] — because this
// deployment's compute SUSPENDS WHEN IDLE, so each distinct wake-minute is a
// cost paid whether or not the handler does anything. Its own words: "A job
// needing finer granularity than 30 minutes is a decision to bring back to
// [`application-hosting.md`] §21, not a minute to pick." That decision is above
// this card, and `tests/jobs/schedule-cluster.test.ts` fails the build for
// anyone who takes it by accident.
//
// So: BOTH clustered minutes, which is the finest granularity the constraint
// allows — a domain reaches `issued` within thirty minutes of the platform
// issuing it, rather than five. The customer-visible cost is bounded and small:
// the pane's *Check again* control (MOTIR-4229) drives the lifecycle's own
// verify path on demand, so a customer watching their domain does not wait for
// this sweep at all. This job is the BACKSTOP — for the customer who closed the
// tab, and for the renewal and expiry nobody is watching.
//
// ── One cadence, not two ─────────────────────────────────────────────────
//
// The card splits the statuses across two cadences. With a single allowed
// granularity that split buys nothing, so the job sweeps every status it owns on
// one schedule and the `staleness` window per status is what separates them:
// a `pending_certificate` row is re-checked whenever it is older than the
// sweep interval, an `issued` row only hourly. The cost is one query per status,
// not one wake per cadence.

/** Both clustered minutes — the finest cadence `schedules.ts` permits. */
export const PUBLIC_ADDRESS_CERTIFICATE_REFRESH_CRON = '0,30 * * * *';

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
