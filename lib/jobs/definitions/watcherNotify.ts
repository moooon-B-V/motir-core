import { defineJob } from '../defineJob';
import type { WorkItemCommentCreatedData, WorkItemTransitionedData } from '../types';

// Watcher → email notification jobs (Story 5.4 · Subtask 5.4.5). Two thin
// event consumers over ONE fan-out service (watcherNotificationsService), the
// 5.1.6 mentionNotify shape: comments ride `work-item/comment.created`
// (emitted by commentsService, 5.1.2 — the SAME emit the mention job
// consumes; no new emit path), transitions ride `work-item/transitioned`
// (emitted post-commit by workItemsService.updateStatus AND
// boardsService.moveCard, this subtask).
//
// `work-item/comment.created` already has a consumer under the 1:1 id
// (mentionNotifyOnCommentCreated), so this job is the first ADDITIONAL
// consumer: it takes a distinct id and names the shared event via defineJob's
// explicit `trigger`. The transition consumer keeps the same id family for
// symmetry — both ledger rows read as the watcher feature's.
//
// The handlers are deliberately tiny (the emailSend shape): narrow the
// payload, run the fan-out in a single durable step. The fan-out walks the
// watcher roster in bounded pages, excludes the actor (never self-notified)
// and — on comments — the mentioned users (they get the 5.1.6 mention email;
// one email per person per event), re-validates view access per watcher at
// SEND time, and enqueues one `email.send` per survivor with a
// `watcher-<kind>:<sourceId>:<userId>` idempotency key — so a replay/retry of
// either job (or a comment-edit re-fire of the same commentId) never
// double-mails.
//
// `retryPolicy: 'transient'`: the fan-out's failures are DB/network blips; a
// few attempts with backoff, then the DLQ per the 1.6.4 contract.

export const watcherNotifyOnCommentCreated = defineJob(
  {
    id: 'watcher-notify/comment.created',
    trigger: 'work-item/comment.created',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCommentCreatedData;
    return ctx.step.run('watcher-fan-out', () =>
      services.watcherNotifications.fanOut({
        kind: 'comment',
        workspaceId: payload.workspaceId,
        workItemId: payload.workItemId,
        actorId: payload.authorId,
        commentId: payload.commentId,
        mentionedUserIds: payload.mentionedUserIds,
      }),
    );
  },
);

export const watcherNotifyOnTransitioned = defineJob(
  {
    id: 'watcher-notify/transitioned',
    trigger: 'work-item/transitioned',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemTransitionedData;
    return ctx.step.run('watcher-fan-out', () =>
      services.watcherNotifications.fanOut({
        kind: 'transition',
        workspaceId: payload.workspaceId,
        workItemId: payload.workItemId,
        actorId: payload.actorId,
        revisionId: payload.revisionId,
        fromStatusKey: payload.fromStatusKey,
        toStatusKey: payload.toStatusKey,
      }),
    );
  },
);
