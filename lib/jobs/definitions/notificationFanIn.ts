import { defineJob } from '../defineJob';
import type {
  WorkItemCommentCreatedData,
  WorkItemMentionedData,
  WorkItemTransitionedData,
} from '../types';

// In-app notification fan-in jobs (Story 5.7 · Subtasks 5.7.3 + 5.7.10). Three
// thin event consumers over ONE fan-in service (notificationFanInService) — the
// 5.1.6 mentionNotify / 5.4.5 watcherNotify shape. They are a SECOND consumer of
// the SAME channel-agnostic events the email jobs consume: comment mentions ride
// `work-item/comment.created` (emitted by commentsService, 5.1.2), description
// mentions ride `work-item/mentioned` (emitted by workItemsService, 5.1.6), and
// status transitions ride `work-item/transitioned` (emitted post-commit by
// workItemsService.applyStatusTransition / boardsService.moveCard, 5.4.5 — the
// `watching`-category in-app twin of the 5.4.5 watcher email, Subtask 5.7.10).
// No new emit path; no "also notify in-app" call beside any email send.
//
// Both events ALREADY have a 1:1-id consumer (the 5.1.6 mention jobs) and an
// additional consumer (the 5.4.5 watcher job), so these are FURTHER additional
// consumers: each takes a distinct id and names the shared event via defineJob's
// explicit `trigger` (an event carries one function per id; many functions per
// event). The ledger rows read as the in-app notification feature's.
//
// The handlers are deliberately tiny (the emailSend / watcherNotify shape):
// hand the event name + payload to the registry-driven fan-in in a single
// durable step. The service decides recipients, re-validates view access,
// consults the preference gate, and writes the `Notification` rows in one tx.
// The event NAME is passed explicitly so the service's registry dispatch needs
// no re-derivation from the Inngest context.
//
// `retryPolicy: 'transient'`: the fan-in's failures are DB blips; a few
// attempts with backoff, then the DLQ per the 1.6.4 contract. Idempotency lives
// on the write — createMany(skipDuplicates) against the 5.7.2
// `(dedupeKey, recipientUserId)` unique — so a replay / retry / comment-edit
// re-fire never double-writes a row.

export const notificationFanInOnCommentCreated = defineJob(
  {
    id: 'notification-fan-in/comment.created',
    trigger: 'work-item/comment.created',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCommentCreatedData;
    return ctx.step.run('notification-fan-in', () =>
      services.notificationFanIn.fanIn('work-item/comment.created', payload),
    );
  },
);

export const notificationFanInOnWorkItemMentioned = defineJob(
  {
    id: 'notification-fan-in/mentioned',
    trigger: 'work-item/mentioned',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemMentionedData;
    return ctx.step.run('notification-fan-in', () =>
      services.notificationFanIn.fanIn('work-item/mentioned', payload),
    );
  },
);

// The `watching`-category in-app twin of the 5.4.5 `watcher-notify/transitioned`
// email job (Subtask 5.7.10): same `work-item/transitioned` event, distinct id
// (one function per id, many functions per event). The fan-in service walks the
// watcher roster in bounded pages and gates each recipient on their
// `transitioned · in_app` preference — closing the seam that left the drawer's
// Watching tab empty in prod (notes.html #40).
export const notificationFanInOnTransitioned = defineJob(
  {
    id: 'notification-fan-in/transitioned',
    trigger: 'work-item/transitioned',
    retryPolicy: 'transient',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemTransitionedData;
    return ctx.step.run('notification-fan-in', () =>
      services.notificationFanIn.fanIn('work-item/transitioned', payload),
    );
  },
);
