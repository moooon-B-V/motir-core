import { defineJob } from '../defineJob';
import type { PullRequestHeadMovedData } from '../types';
import { BASE_MOVED_RETRY_WAITS_MS } from './pullRequestBaseMoved';

// THE HEAD-PUSH MERGEABILITY RE-READ (MOTIR-7063) — one run per `synchronize`. The
// base-branch re-read (`pull-request/base-moved`) asks about every pull request on a base
// that moved; this asks about the ONE pull request whose own head moved, because a head
// pushed onto a base that has already moved past it conflicts with no event on the base
// at all. The push marked the reading pending at the new head, and the CI promotion
// waits on it; this run is what answers.
//
// ⚠️ IT WAITS FOR THE SAME REASON AND ON THE SAME SCHEDULE AS THE BASE-BRANCH JOB. GitHub
// computes `mergeable` LAZILY after a push, so an immediate read mostly answers `null`;
// a reading still `null` after the last wait stays pending and is left to the
// `system.pull-request-reconcile` tick, which reads the host for every open delivering
// pull request and is this job's failure path.
//
// ⚠️ EVERY HOST READ IS INSIDE A `step.run`, for the base-branch job's reason: a resumed
// run re-executes the handler and serves completed steps from their memo.
//
// `idempotency` on `<pullRequestId>:<headSha>`: a redelivered push for the same head
// enqueues nothing new. `retryPolicy: 'idempotent'` because a pass is safe to repeat —
// a stored reading is overwritten with the same answer, a withdrawn gate matches
// nothing, a promoted card is no longer at Implemented, and the gate re-derivation
// raises only what is missing.

/** The waits between passes, in ms — the base-branch job's, for the same host. */
export const HEAD_MOVED_RETRY_WAITS_MS = BASE_MOVED_RETRY_WAITS_MS;

export const pullRequestHeadMoved = defineJob(
  {
    id: 'pull-request/head-moved',
    retryPolicy: 'idempotent',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as PullRequestHeadMovedData;
    const member = { pullRequestId: data.pullRequestId, number: data.number };
    let passes = 0;
    for (let pass = 0; pass <= HEAD_MOVED_RETRY_WAITS_MS.length; pass++) {
      if (pass > 0) await ctx.step.sleep(`head-wait-${pass}`, HEAD_MOVED_RETRY_WAITS_MS[pass - 1]!);
      const summary = await ctx.step.run(`head-settle-${pass}`, () =>
        services.pullRequestMergeability.settleHeadMember(data.workspaceId, member),
      );
      passes = pass + 1;
      if (summary.outcome !== 'unknown') return { ...summary, passes };
    }
    return {
      outcome: 'unknown' as const,
      withdrawn: 0,
      held: 0,
      promoted: 0,
      gatesRaised: 0,
      passes,
    };
  },
);
