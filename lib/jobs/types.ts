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
  /**
   * Automation provenance (Story 6.6 · Subtask 6.6.3). Set to the rule id when
   * this comment was written by an automation rule's `add_comment` action;
   * absent on an ordinary user comment. The automation engine's `commented`-
   * trigger consumer SKIPS any event carrying this — the verified Jira loop-
   * prevention default (rules don't trigger rules), so an add-comment action
   * cannot re-fire a comment-trigger rule. The mention / watcher consumers
   * ignore it (mention + watcher emails still send for an automation comment).
   */
  viaAutomationRuleId?: string;
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
  /**
   * Automation provenance (Story 6.6 · Subtask 6.6.2). Set to the rule id when
   * this transition was performed by an automation rule's `transition` action;
   * absent on a user-driven move. The automation engine SKIPS any event
   * carrying this — the verified Jira loop-prevention default (rules don't
   * trigger rules). The 6.6.3 `transitioned`-trigger consumer reads it; the
   * existing watcher/bell consumers ignore it.
   */
  viaAutomationRuleId?: string;
}

/**
 * The `work-item/created` event payload (Story 6.6 · Subtask 6.6.2) — emitted
 * AFTER a work-item create commits (never inside the tx: a rollback must not
 * have fired a rule — the 5.1.2 rule), from the SHIPPED `workItemsService`
 * create path. The automation engine's `created`-trigger consumer reads it; it
 * is the same event the 5.7 stub anticipates for assignment notifications.
 * Workspace-scoped; `projectId` lets the engine load the project's rules in one
 * indexed read without re-fetching the item first.
 */
export interface WorkItemCreatedData {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  /** The actor who created the item (a rule run is attributed to the rule
   * owner, not this actor — the recorded 6.6 deviation). */
  actorId: string;
  /** Automation provenance — set when the create itself was performed by a
   * rule action (none ship in 6.6.2, but the field exists so a future
   * create-item action can't loop). The engine skips provenance-carrying
   * events. */
  viaAutomationRuleId?: string;
}

/**
 * The `work-item/field.changed` event payload (Story 6.6 · Subtask 6.6.2) —
 * emitted AFTER a free-form work-item UPDATE commits, carrying the built-in
 * field ids that actually changed (computed from the 1.4.6 revision diff). The
 * automation engine's `field_changed`-trigger consumer narrows by its
 * configured field id against `changedFields`; `assignee` is the verified
 * "assigned" preset. Status transitions DON'T ride this event — they ride
 * `work-item/transitioned` from the typed-workflow path. Emitted only when at
 * least one automatable built-in field (assignee / priority / dueDate /
 * estimate) changed, so the event is never a no-op for the engine.
 */
export interface WorkItemFieldChangedData {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  /** The actor who edited the item. */
  actorId: string;
  /** The changed built-in field ids — a subset of
   * `AUTOMATION_FIELD_CHANGED_FIELDS` (assignee / priority / dueDate /
   * estimate). Always non-empty (the emit gate). */
  changedFields: string[];
  /** The `work_item_revision` row recording the edit. */
  revisionId: string;
  /** Automation provenance — set when the edit was performed by a rule's
   * `set_field` action; the engine skips provenance-carrying events (loop
   * prevention). */
  viaAutomationRuleId?: string;
}

/**
 * The `filter-subscription/deliver` event payload (Story 6.2 · Subtask 6.2.5)
 * — one per DUE subscription, enqueued by the hourly `system.filter-
 * subscription-tick` cron so each delivery retries/dead-letters independently
 * (the watcher fan-out shape). The consumer (savedFilterSubscriptionsService.
 * deliver) resolves the filter AS the subscriber and enqueues the durable
 * `email.send`. Workspace-scoped — the tick reads the denormalized
 * `workspaceId` so it never touches the RLS-protected saved_filter.
 */
export interface FilterSubscriptionDeliverData {
  workspaceId: string;
  subscriptionId: string;
  /** The per-occurrence email idempotency key — one mail per scheduled tick. */
  occurrenceKey: string;
}

/**
 * The `system.billing-seat-sync` event payload (Story 8.1 · Subtask 8.1.12) —
 * one per org-membership add/remove, enqueued best-effort AFTER the membership tx
 * commits (`enqueueScaledTrackerSeatSync`). The consumer
 * (billingService.syncScaledTrackerSeatQuantity) re-derives the org's active-
 * member count and sets the scaled-tracker Stripe seat `quantity` over the
 * boundary. SYSTEM-scoped (no `workspaceId`): an org spans workspaces, so the job
 * runs under `withSystemContext`, like every `system.*` job — and the `system.*`
 * namespace keeps it out of `WorkspaceScopedEventName` / `sendEvent` (it carries
 * no workspace id, so it is enqueued via `inngest.send` directly).
 */
export interface BillingSeatSyncData {
  organizationId: string;
}

/**
 * The `system.code-graph-index` event payload (Story 7.5 · MOTIR-1500) — one per
 * NEWLY-ADDED GitHub repo, enqueued best-effort AFTER the installation's repos
 * persist (`enqueueCodeGraphIndex`, from the webhook reconcile + the fresh-install
 * bind paths). The consumer (codeGraphIndexService) fetches the repo's tarball
 * with the installation token and hands the BYTES to motir-ai per project (the
 * open-core producer half). `installationId` is GitHub's numeric installation id
 * (the token-minting key); `workspaceId` is the installation's bound workspace —
 * carried so the run is scoped on the job_run ledger (a real, valid FK), even
 * though the job is `system.*`-namespaced and enqueued via `inngest.send`
 * (NOT `sendEvent`), like every system job. The repo identity rides in the
 * payload so the handler indexes exactly the added repo without re-diffing.
 */
export interface CodeGraphIndexData {
  installationId: string;
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
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
  'system.filter-subscription-tick': SystemScheduledData;
  'system.automation-retention-sweep': SystemScheduledData;
  'system.billing-seat-sync': BillingSeatSyncData;
  'system.code-graph-index': CodeGraphIndexData;
  'filter-subscription/deliver': FilterSubscriptionDeliverData;
  'email.send': EmailSendData;
  'work-item/comment.created': WorkItemCommentCreatedData;
  'work-item/mentioned': WorkItemMentionedData;
  'work-item/transitioned': WorkItemTransitionedData;
  'work-item/created': WorkItemCreatedData;
  'work-item/field.changed': WorkItemFieldChangedData;
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
