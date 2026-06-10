import { defineJob } from '../defineJob';
import type { WorkItemCommentCreatedData, WorkItemMentionedData } from '../types';

// Mention → email notification jobs (Story 5.1 · Subtask 5.1.6). Two thin
// event consumers over ONE fan-out service (mentionNotificationsService):
// comment mentions ride `work-item/comment.created` (emitted by
// commentsService, 5.1.2), description mentions ride `work-item/mentioned`
// (emitted by workItemsService's create/update paths, this subtask). The
// defineJob 1:1 convention (job id === triggering event name) is why these
// are two registered functions rather than one with two triggers — the shared
// behaviour lives in the service, the same way emailSend owns no email logic.
//
// The handlers are deliberately tiny (the emailSend shape): narrow the
// payload, run the fan-out in a single durable step. The fan-out re-validates
// view access per mentioned user at SEND time, skips the author, and enqueues
// one `email.send` per surviving recipient with a `mention:<sourceId>:<userId>`
// idempotency key — so a replay/retry of either job, or an overlapping
// comment-edit event, never double-mails (Inngest dedups same-key email.send
// events; see the service header for why the dedup lives THERE and not on a
// commentId-scoped job-level idempotency, which would drop edit events).
//
// `retryPolicy: 'transient'`: the fan-out's failures are DB/network blips; a
// few attempts with backoff, then the DLQ per the 1.6.4 contract.
//
// NOTE on `work-item/comment.created`: the event fires for EVERY comment
// (Story 5.4 watchers / 5.7 in-app fan in off the same events later); this
// consumer no-ops fast when the write carried no mentions.

export const mentionNotifyOnCommentCreated = defineJob(
  { id: 'work-item/comment.created', retryPolicy: 'transient' },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCommentCreatedData;
    return ctx.step.run('mention-fan-out', () =>
      services.mentionNotifications.fanOut({
        workspaceId: payload.workspaceId,
        workItemId: payload.workItemId,
        authorId: payload.authorId,
        mentionedUserIds: payload.mentionedUserIds,
        source: { kind: 'comment', commentId: payload.commentId },
      }),
    );
  },
);

export const mentionNotifyOnWorkItemMentioned = defineJob(
  { id: 'work-item/mentioned', retryPolicy: 'transient' },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemMentionedData;
    return ctx.step.run('mention-fan-out', () =>
      services.mentionNotifications.fanOut({
        workspaceId: payload.workspaceId,
        workItemId: payload.workItemId,
        authorId: payload.authorId,
        mentionedUserIds: payload.mentionedUserIds,
        source: { kind: 'description', revisionId: payload.revisionId },
      }),
    );
  },
);
