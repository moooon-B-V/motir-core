import { defineJob } from '../defineJob';

// The weekly follower-digest TICK (Story 8.9 · Subtask 8.9.7 ·
// `docs/decisions/public-follow-and-changelog.md` §4).
//
// The `filterSubscriptionTick` shape: the cron SCANS and fans each due follower
// out as one `public-follow/digest` event, so a single follower's failure
// retries and dead-letters on its own rather than failing the whole sweep. The
// handler stays one durable step returning the summary for the run ledger.
//
// `retryPolicy: 'idempotent'`: the scan is read-only, and the per-occurrence key
// (`<followId>:<ISO week>`) collapses a re-enqueue inside the same week to one
// delivery — at the job runtime AND at the provider — so the full retry budget
// is safe on a transient database blip.
//
// System-scoped (it spans every public project, in every workspace), like every
// `system.*` job.

/**
 * Monday 09:00 UTC — the cadence 8.9.1 fixed, and the instant it names.
 *
 * ONE cadence, not a per-follower choice: a build-in-public project ships
 * continuously, so a daily mail is unsubscribe bait and a monthly one is not
 * "following the build". :00 is a clustered wake-minute (`lib/jobs/schedules.ts`)
 * and this job shares it deliberately — on a compute that suspends when idle,
 * every distinct wake-minute is billed, so sharing one is the goal.
 */
export const PUBLIC_FOLLOW_DIGEST_CRON = '0 9 * * 1';

export const publicFollowDigestTick = defineJob(
  {
    id: 'system.public-follow-digest-tick',
    cron: PUBLIC_FOLLOW_DIGEST_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  (ctx, services) =>
    ctx.step.run('enqueue-due-digests', () =>
      services.publicFollowDigest.enqueueDueDigests(new Date()),
    ),
);
