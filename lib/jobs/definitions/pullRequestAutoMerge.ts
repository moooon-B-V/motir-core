import { defineJob } from '../defineJob';
import { resolveRetries } from '../retries';
import type { PullRequestAutoMergeRequestedData } from '../types';

// THE AUTO-MERGE JOB (Story MOTIR-4882 · MOTIR-5518) — one run per pull request per
// green head in an `auto` project, dispatched by the CI promotion after it commits.
// The policy is all in `pullRequestAutoMergeService`; this file is the trigger, the
// retry budget and the dedup key.
//
// `idempotency` on `(pull request, head)` — `event.data.idempotencyKey` is
// `<pullRequestId>:<headSha>` — so a redelivered green verdict for the same head
// enqueues nothing new, and a refusal for that head is reported once. A NEW head is a
// new key, and is attempted afresh.
//
// `retryPolicy: 'transient'`: a host that does not answer is a network failure, and a
// few attempts with backoff is the right intent. The FINAL attempt posts the
// could-not-reach comment before it throws into the dead-letter queue.

export const AUTO_MERGE_RETRY_POLICY = 'transient' as const;

/** Total attempts, first included — what `job_queue.max_attempts` stores. */
export const AUTO_MERGE_MAX_ATTEMPTS = resolveRetries({ retryPolicy: AUTO_MERGE_RETRY_POLICY }) + 1;

export const pullRequestAutoMerge = defineJob(
  {
    id: 'pull-request/auto-merge.requested',
    retryPolicy: AUTO_MERGE_RETRY_POLICY,
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) =>
    services.pullRequestAutoMerge.mergeOnGreen(
      ctx.event.data as PullRequestAutoMergeRequestedData,
      {
        // `attempt` is zero-indexed.
        finalAttempt: ctx.attempt + 1 >= AUTO_MERGE_MAX_ATTEMPTS,
      },
    ),
);
