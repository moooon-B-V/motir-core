// The type surface for background-job events (Story 1.6 · Subtask 1.6.2).
//
// `JobEventDataMap` is the single source of truth for "which events exist and
// what payload each carries." It powers compile-time safety in two places:
//   - `sendEvent(name, data)` constrains `name` to a known key and `data` to
//     that key's payload shape — `sendEvent('typo.event', …)` is a type error.
//   - `defineJob({ id })` constrains `id` to a known key, and the handler's
//     `event.data` is typed to the matching payload.
//
// CONVENTION (per the Subtask card): a job's `id` and its triggering event
// name are the SAME string (1:1). So the keys of this map ARE both the event
// names and the job ids. `email.send` (1.6.3) and the rest land as new keys.
//
// WORKSPACE-SCOPING INVARIANT: business events carry a `workspaceId` that
// `sendEvent` requires to be EXPLICIT — no event slips through having simply
// forgotten the field. For most events that id is a real workspace (string).
// `email.send` is the deliberate carve-out: a transactional email can be
// genuinely cross-workspace (a password reset is identity-scoped — the user
// may belong to many workspaces or none), so its `workspaceId` is `string |
// null`, where `null` means "system / no single workspace". `null` is the
// value the job_run row stores (the workspace_id FK is nullable — see the
// 1.6.2 schema), NOT a `"system"` sentinel string (that would violate the FK).
//
// The OTHER untenanted path is SYSTEM events (the `system.*` namespace), which
// are NOT dispatched through `sendEvent` at all. They are CRON-triggered (1.6.4:
// `system.daily-health-check` runs on a schedule) or driven by the in-process
// test harness. A scheduled job has no real triggering event, so the wrapper
// synthesizes the ledger's `event_name` as `scheduled.{job_id}` (see
// defineJob); the payload type therefore makes `workspaceId` optional.

import type { TransactionalEmail } from '@/lib/services/emailService';

export interface SystemScheduledData {
  /**
   * System events are untenanted, so this is optional. When present it's
   * recorded on the job_run row; when absent the row's workspace_id is null.
   * Cron-triggered runs carry no payload, so this is typically absent.
   */
  workspaceId?: string;
}

/**
 * The `email.send` event payload. Composes the email domain's
 * `TransactionalEmail` (recipient + template + the template's typed data)
 * with the two background-job envelope fields every dispatched email needs:
 *   - `workspaceId` — the owning workspace, or `null` for a cross-workspace /
 *     system email (e.g. password reset). Stored on the job_run row.
 *   - `idempotencyKey` — a per-send unique key (the reset token, the invite
 *     token). Inngest dedups same-key events inside its window, so a retried
 *     Server Action that re-fires the same send becomes one delivery, not two.
 *
 * The intersection distributes over `TransactionalEmail`'s union, so each
 * template arm keeps its own `data` shape while gaining the envelope fields.
 */
export type EmailSendData = TransactionalEmail & {
  workspaceId: string | null;
  idempotencyKey: string;
};

/**
 * The `work-item/comment.created` event payload (Story 5.1 · Subtask 5.1.2) —
 * emitted AFTER a comment write commits (never inside the transaction: a
 * rollback must not have notified anyone). Deliberately CHANNEL-AGNOSTIC so
 * the 5.1.6 mention-email job, Story 5.4 (watchers) and Story 5.7 (the in-app
 * bell) all fan in off the same events without reshaping them.
 *
 * `mentionedUserIds` carries the validated, persisted mention set of the
 * write that fired the event. On a comment EDIT the same event re-fires with
 * ONLY the newly-added mention ids (no re-notify on unchanged mentions); the
 * consumer's idempotency key (comment × user) makes any overlap harmless.
 */
export interface WorkItemCommentCreatedData {
  workspaceId: string;
  workItemId: string;
  commentId: string;
  /** The actor whose write produced the mentions (comment author / editor). */
  authorId: string;
  mentionedUserIds: string[];
}

/**
 * The `work-item/mentioned` event payload (Story 5.1 · Subtask 5.1.6) — the
 * DESCRIPTION-mention sibling of `work-item/comment.created`. Emitted AFTER a
 * work-item create / description-changing update commits, carrying ONLY the
 * newly-added, view-validated mention ids (an edit never re-notifies mentions
 * the previous body already carried). Channel-agnostic like its sibling, for
 * the same 5.4 / 5.7 fan-in reasons.
 *
 * `revisionId` is the `work_item_revision` row written atomically with the
 * mutation that introduced the mentions — the consumer's idempotency scope
 * (revision × user), playing the role `commentId` plays on the comment event.
 */
export interface WorkItemMentionedData {
  workspaceId: string;
  workItemId: string;
  /** The revision row recording the create/update that added the mentions. */
  revisionId: string;
  /** The actor whose write produced the mentions. */
  authorId: string;
  mentionedUserIds: string[];
}

/**
 * The `work-item/transitioned` event payload (Story 5.4 · Subtask 5.4.5) —
 * emitted AFTER a status transition commits (never inside the transaction: a
 * rollback must not have notified anyone — the 5.1.2 rule), from BOTH paths
 * that route through `workItemsService.applyStatusTransition`: the direct
 * `updateStatus` entry point and the board move (`boardsService.moveCard`,
 * the most common way a status changes in practice). A no-op move (same
 * status) emits nothing. Channel-agnostic like its `work-item/*` siblings —
 * the 5.4.5 watcher-email job consumes it today, Story 5.7's in-app bell
 * fans in off the same event later.
 *
 * `revisionId` is the `work_item_revision` row written atomically with the
 * status change — the consumer's idempotency scope (revision × user), the
 * same role `commentId` / `revisionId` play on the mention events.
 */
export interface WorkItemTransitionedData {
  workspaceId: string;
  workItemId: string;
  /** The actor who moved the status — never self-notified. */
  actorId: string;
  fromStatusKey: string;
  toStatusKey: string;
  /** The revision row recording the transition. */
  revisionId: string;
}

/**
 * Map of event-name → payload. Each key is a job id and the event name that
 * triggers it; for an event's FIRST consumer the two are the same string (the
 * 1:1 convention). An event with MULTIPLE consumers (e.g.
 * `work-item/comment.created`, consumed by the 5.1.6 mention job AND the
 * 5.4.5 watcher job) registers each additional consumer under its own
 * distinct id with an explicit `trigger` (see `defineJob`). Grows one entry
 * per event. (An event MAY land before its consuming job does —
 * `work-item/comment.created` ships with 5.1.2 while the mention-notification
 * job consuming it is 5.1.6; publishing to an event no function subscribes to
 * is a no-op on Inngest's side.)
 */
export interface JobEventDataMap {
  'system.daily-health-check': SystemScheduledData;
  'system.attachment-gc': SystemScheduledData;
  'email.send': EmailSendData;
  'work-item/comment.created': WorkItemCommentCreatedData;
  'work-item/mentioned': WorkItemMentionedData;
  'work-item/transitioned': WorkItemTransitionedData;
}

/** Every registered event/job name. */
export type JobEventName = keyof JobEventDataMap;

/** The payload type for a given event name. */
export type JobEventData<N extends JobEventName> = JobEventDataMap[N];

/**
 * The names of events that are workspace-scoped (everything OUTSIDE the
 * `system.*` namespace). `sendEvent` is typed to accept only these — system
 * events never go through `sendEvent` (they are cron / harness triggered):
 * `email.send` + the `work-item/*` events.
 */
export type WorkspaceScopedEventName = Exclude<JobEventName, `system.${string}`>;
