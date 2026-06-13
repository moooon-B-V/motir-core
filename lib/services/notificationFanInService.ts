import { Prisma, type WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { notificationRepository } from '@/lib/repositories/notificationRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { mentionExcerpt } from '@/lib/mentions/excerpt';
import type { WorkItemCommentCreatedData, WorkItemMentionedData } from '@/lib/jobs/types';

// In-app notification fan-in (Story 5.7 · Subtask 5.7.3). The business logic
// behind the notificationFanIn jobs (lib/jobs/definitions/notificationFanIn.ts),
// on the 5.1.6 mention-fan-out pattern — a SECOND consumer of the SAME
// channel-agnostic `work-item/*` events the 5.1.6 email job already consumes.
// It touches NO emit site and adds NO "also notify in-app" call anywhere: the
// emit already happened (5.1.2 / 5.1.6); this service just subscribes and
// writes `Notification` rows for the eligible recipients.
//
// ONE EMIT PATH, MANY CHANNELS (the locked Story-5.7 invariant): comment /
// description writes emit one channel-agnostic event after commit; the 5.1.6
// email job is one consumer, THIS in-app fan-in is a second. Neither reshapes
// the event; neither notifies the other's channel.
//
// EXTENSIBLE — the fan-in SEAM (no forward dep). The handler dispatches on a
// small `eventName → descriptor` registry (NOTIFICATION_FAN_IN_REGISTRY). Each
// descriptor knows ONE event's notification `type` + drawer `category` and how
// to turn its payload into a fan-in plan (the actor, the candidate recipients,
// the dedupe scope, the denormalized render payload). Story 5.4's
// `work-item/transitioned` (the `watching` category) and Story 6.6's
// `work-item/created` + `work-item/field.changed` fan in LATER by ADDING a
// registry entry — with NO change to this pipeline and NO dependency on
// 5.4/6.6 here (those stories document 5.7 as their seam). 5.7.3 registers
// ONLY the SHIPPED 5.1.6 events; an unregistered event name is a clean no-op,
// never an error. The `registry` parameter on `fanIn` is the injection point
// the extensibility test drives (a synthetic descriptor produces rows through
// the same core).
//
// The send-time rules (inherited from the 5.1.6 / 5.4 contract, in-app channel):
//   * the ACTOR is ALWAYS excluded (never notify yourself);
//   * candidate ids are DEDUPED (a user mentioned twice in one comment → one
//     row); the `(dedupeKey, recipientUserId)` unique (5.7.2) makes a replayed
//     or retried event idempotent on TOP of that;
//   * VIEW ACCESS is re-validated at fan-in time AS each recipient (the same
//     `canBrowse` policy the read paths enforce) — a recipient who can no
//     longer see the issue gets no row;
//   * the in-app PREFERENCE GATE is consulted per recipient (5.7.6 resolver,
//     permissive default until then) — channel off → no row;
//   * a work item / comment hard-deleted between write and fan-in means there
//     is nothing to notify about — the fan-out resolves to zero rows, it never
//     errors (deletion is a normal race, not a failure to retry).
//
// SCALE (finding #57): the candidate set is the event's bounded mention list,
// never an unbounded read. (A future `watching`-category descriptor that walks
// a large watcher roster pages it the way watcherNotificationsService does.)
//
// 4-layer note: this is a SERVICE (the job handlers are its only callers, via
// the injected jobServices bag). It composes repositories + the access policy +
// the preference gate, owns the ONE transaction the fan-out batch writes in
// (notificationRepository.createMany), and returns a plain JSON-serializable
// summary (step.run memoizes the return value).

/**
 * The denormalized render payload stored on each `Notification.data` (Json) so
 * the 5.7.4 feed read is a single-table scan (no join storm — the 5.7.2 schema
 * decision). `kind` discriminates the row renderer the 5.7.5 drawer picks.
 *
 * 5.7.3 emits only the `mentioned` shape; a later `transitioned` descriptor
 * (5.4) adds its own arm (from/to status) under the same union — the data
 * shape grows with the registry, no migration.
 */
export type NotificationData = {
  kind: 'mentioned';
  /** Which surface mentioned them — picks the row copy in the drawer. */
  source: 'comment' | 'description';
  /** The issue key for the deep-link + summary (e.g. `PROD-42`). */
  workItemKey: string;
  /** The issue title for the summary line. */
  workItemTitle: string;
  /** Plain-text excerpt (mention tokens as @Name), or null when empty. */
  excerpt: string | null;
};

/** The minimal event envelope the pipeline needs before dispatching to a
 * descriptor; the descriptor re-narrows to its specific payload. Every
 * `work-item/*` event carries these two fields. */
export interface NotificationSourceEvent {
  workspaceId: string;
  workItemId: string;
}

/** The per-event fan-in plan a descriptor produces from its payload + the
 * (already workspace-verified) work item. `null` = a clean no-op. */
export interface NotificationFanInPlan {
  /** The actor whose action produced the event — always excluded. */
  actorId: string;
  /** Candidate recipient ids BEFORE actor-exclude / dedupe / view / preference. */
  candidateUserIds: string[];
  /** The dedupe source id; the row's `dedupeKey` is `${type}:${dedupeSourceId}`,
   * uniquified per recipient by the 5.7.2 `(dedupeKey, recipientUserId)` unique. */
  dedupeSourceId: string;
  /** The denormalized payload written to every row's `data`. */
  data: NotificationData;
}

/** One registry entry: an event's notification `type` + drawer `category`, and
 * how to build its fan-in plan. ADDING one of these is the ONLY change 5.4/6.6
 * need to fan in (the no-forward-dep seam). */
export interface NotificationFanInDescriptor {
  /** The open `Notification.type` discriminator + the `dedupeKey` prefix. */
  notificationType: string;
  /** Which drawer tab the row lands in (`direct` = mentions/assignment/reporter). */
  category: 'direct' | 'watching';
  /** Resolve the event payload (+ the work item) into a fan-in plan, or null
   * for a no-op (no candidates, deleted source). */
  buildPlan(event: NotificationSourceEvent, item: WorkItem): Promise<NotificationFanInPlan | null>;
}

export type NotificationFanInRegistry = Record<string, NotificationFanInDescriptor>;

/** Build the `mentioned` render payload shared by both mention sources. */
function buildMentionData(
  source: 'comment' | 'description',
  item: WorkItem,
  excerpt: string | null,
): NotificationData {
  return {
    kind: 'mentioned',
    source,
    workItemKey: item.identifier,
    workItemTitle: item.title,
    excerpt,
  };
}

/**
 * The PRODUCTION registry — only the SHIPPED 5.1.6 events. Both mention sources
 * write a `mentioned` / `direct` notification; they differ in copy source
 * (comment body vs description) and dedupe scope (commentId vs revisionId).
 *
 * 5.4 adds `'work-item/transitioned'` → `{ notificationType: 'transitioned',
 * category: 'watching', buildPlan: … }`; 6.6 adds its events. Neither requires
 * a change here — that's the seam.
 */
export const NOTIFICATION_FAN_IN_REGISTRY: NotificationFanInRegistry = {
  'work-item/mentioned': {
    notificationType: 'mentioned',
    category: 'direct',
    async buildPlan(event, item) {
      const payload = event as WorkItemMentionedData;
      if (payload.mentionedUserIds.length === 0) return null;
      return {
        actorId: payload.authorId,
        candidateUserIds: payload.mentionedUserIds,
        dedupeSourceId: payload.revisionId,
        data: buildMentionData('description', item, mentionExcerpt(item.descriptionMd)),
      };
    },
  },
  'work-item/comment.created': {
    notificationType: 'mentioned',
    category: 'direct',
    async buildPlan(event, item) {
      const payload = event as WorkItemCommentCreatedData;
      if (payload.mentionedUserIds.length === 0) return null;
      // The comment must still exist (5.1's delete is HARD — an excerpt of a
      // deleted comment would resurrect content the author removed).
      const comment = await commentRepository.findById(payload.commentId);
      if (!comment || comment.workItemId !== item.id) return null;
      return {
        actorId: payload.authorId,
        candidateUserIds: payload.mentionedUserIds,
        dedupeSourceId: payload.commentId,
        data: buildMentionData('comment', item, mentionExcerpt(comment.bodyMd)),
      };
    },
  },
};

export interface NotificationFanInResult {
  /** The recipient ids a `Notification` row was written for (post validation +
   * preference gate). Empty on any no-op. */
  writtenUserIds: string[];
}

const NO_OP: NotificationFanInResult = { writtenUserIds: [] };

export const notificationFanInService = {
  /**
   * Fan one channel-agnostic `work-item/*` event into `Notification` rows for
   * every eligible recipient, in ONE transaction. Resolves (never throws) on a
   * vanished issue/comment, an unregistered event, or zero survivors.
   *
   * @param eventName the triggering event name — the registry key.
   * @param event the event payload (re-narrowed by the matched descriptor).
   * @param registry injection point for the extensibility test; defaults to the
   *   production registry. A synthetic entry proves 5.4/6.6 fan in with no core
   *   change.
   */
  async fanIn<E extends NotificationSourceEvent>(
    eventName: string,
    event: E,
    registry: NotificationFanInRegistry = NOTIFICATION_FAN_IN_REGISTRY,
  ): Promise<NotificationFanInResult> {
    const descriptor = registry[eventName];
    if (!descriptor) return NO_OP; // unregistered event → clean no-op, never an error.

    // The issue must still exist in this workspace (hard-deleted → nothing to
    // link to). Mirrors the 5.1.6 fan-out's scoping gate.
    const item = await workItemRepository.findById(event.workItemId);
    if (!item || item.workspaceId !== event.workspaceId) return NO_OP;

    const plan = await descriptor.buildPlan(event, item);
    if (!plan) return NO_OP;

    // Dedupe + exclude the actor (never self-notify).
    const candidateIds = [...new Set(plan.candidateUserIds)].filter((id) => id !== plan.actorId);
    if (candidateIds.length === 0) return NO_OP;

    // Re-validate view access AS each candidate (access may have changed since
    // the write). A project deleted out from under the issue → zero rows, no
    // error — the same vanish-tolerant behaviour the 5.1.6 fan-out has.
    let viewableIds: string[];
    try {
      const checks = await Promise.all(
        candidateIds.map(async (userId) => {
          const caps = await projectAccessService.getCapabilities(item.projectId, {
            workspaceId: event.workspaceId,
            userId,
          });
          return caps.canBrowse ? userId : null;
        }),
      );
      viewableIds = checks.filter((id): id is string => id !== null);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return NO_OP;
      throw err;
    }
    if (viewableIds.length === 0) return NO_OP;

    // The in-app preference gate, per recipient (5.7.6 resolver; permissive
    // default until then). Channel off → no row.
    const gateChecks = await Promise.all(
      viewableIds.map(async (userId) => {
        const enabled = await notificationPreferencesService.isChannelEnabled(
          userId,
          descriptor.notificationType,
          'in_app',
        );
        return enabled ? userId : null;
      }),
    );
    const recipientIds = gateChecks.filter((id): id is string => id !== null);
    if (recipientIds.length === 0) return NO_OP;

    // One row per recipient, written in ONE transaction. `createMany`'s
    // skipDuplicates + the `(dedupeKey, recipientUserId)` unique make a replay /
    // retry idempotent.
    const dedupeKey = `${descriptor.notificationType}:${plan.dedupeSourceId}`;
    const rows: Prisma.NotificationCreateManyInput[] = recipientIds.map((recipientUserId) => ({
      workspaceId: event.workspaceId,
      recipientUserId,
      type: descriptor.notificationType,
      category: descriptor.category,
      workItemId: item.id,
      actorId: plan.actorId,
      data: plan.data as unknown as Prisma.InputJsonValue,
      dedupeKey,
    }));
    await db.$transaction((tx) => notificationRepository.createMany(rows, tx));

    return { writtenUserIds: recipientIds };
  },
};
