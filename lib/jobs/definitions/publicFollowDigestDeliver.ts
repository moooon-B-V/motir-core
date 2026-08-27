import { defineJob } from '../defineJob';
import type { PublicFollowDigestData } from '../types';

// One follower's DIGEST (Story 8.9 · Subtask 8.9.7) — the per-item half of the
// tick/deliver pair, enqueued by `system.public-follow-digest-tick`.
//
// ⚠️ IT RE-READS THE SHIPPED SET HERE, at send time, rather than receiving it
// from the tick. That is the whole reason this step exists as its own job: an
// epic made private on Wednesday must not appear in Monday's mail because it
// was public when the item shipped. The service composes the SAME changelog
// read the page and the feed use, live.
//
// A follow deleted between the tick and this delivery is not a failure — the
// person unsubscribed, which is exactly what should stop the mail — so the
// service returns `sent: false` rather than throwing.

export const publicFollowDigestDeliver = defineJob(
  { id: 'public-follow/digest', retryPolicy: 'idempotent' },
  (ctx, services) => {
    const payload = ctx.event.data as PublicFollowDigestData;
    return ctx.step.run('deliver-digest', () =>
      services.publicFollowDigest.deliverDigest({
        workspaceId: payload.workspaceId,
        followId: payload.followId,
        occurrenceKey: payload.occurrenceKey,
        now: new Date(),
      }),
    );
  },
);
