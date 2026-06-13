import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { mentionExcerpt } from '@/lib/mentions/excerpt';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { NOTIFICATION_EVENT_TYPE } from '@/lib/notifications/preferences';

// Mention → email fan-out (Story 5.1 · Subtask 5.1.6). The business logic
// behind the mentionNotify job (lib/jobs/definitions/mentionNotify.ts): given
// a `work-item/comment.created` or `work-item/mentioned` payload, decide who
// actually gets a mention email NOW — re-validated at send time, not at write
// time — and enqueue one `email.send` event per recipient.
//
// The send-time rules (the Jira behaviour, recorded in the 5.1 story plan):
//   * the author never gets notified about their own mention;
//   * a mentioned user is emailed ONLY if they can still VIEW the issue at
//     send time (access may have changed since the write — the same
//     `canBrowse` policy the comment read path enforces, evaluated AS the
//     mentioned user);
//   * a work item / comment hard-deleted between write and send means there
//     is nothing to notify about — the fan-out resolves to zero sends, it
//     never errors (deletion is a normal race, not a failure to retry).
//
// IDEMPOTENCY: delivery dedup lives on the `email.send` job (Inngest event
// dedup over `event.data.idempotencyKey` — the 1.6.3 harness mechanism). Each
// enqueued send carries `mention:<sourceId>:<userId>` where sourceId is the
// commentId (comment mentions) or the work_item_revision id (description
// mentions), so a replayed event or a retried fan-out step collapses to one
// delivery per source × user. The fan-out job itself deliberately has NO
// job-level idempotency on commentId: a comment EDIT re-fires the same event
// name with the same commentId carrying ONLY newly-added mention ids, and a
// commentId-scoped dedup window would silently drop that follow-up.
//
// LOCALE: rendered with the default locale — there is no persisted per-user
// locale to honour yet (the same signal gap the invite email documents; the
// invite at least has the inviter's request-scoped locale, but this fan-out
// runs off-request in a job).
//
// 4-layer note: this is a SERVICE (the job handler is its only caller, via
// the injected jobServices bag). It composes repositories + the access policy
// + the email pipeline; it opens no transaction (it only reads — the writes
// happened in commentsService / workItemsService) and returns a plain
// JSON-serializable summary (step.run memoizes the return value).

export interface MentionFanOutInput {
  workspaceId: string;
  workItemId: string;
  /** The actor whose write produced the mentions — never self-notified. */
  authorId: string;
  mentionedUserIds: string[];
  /** Which surface mentioned them — picks the email copy + idempotency scope. */
  source: { kind: 'comment'; commentId: string } | { kind: 'description'; revisionId: string };
}

export interface MentionFanOutResult {
  /** The user ids an email was enqueued for (post send-time validation). */
  notifiedUserIds: string[];
}

export const mentionNotificationsService = {
  /**
   * Re-validate and enqueue the mention emails for one mention-bearing write.
   * Returns the recipients actually enqueued; resolves (never throws) when the
   * issue / comment vanished or every candidate fails send-time validation.
   */
  async fanOut(input: MentionFanOutInput): Promise<MentionFanOutResult> {
    const candidateIds = [...new Set(input.mentionedUserIds)].filter((id) => id !== input.authorId);
    if (candidateIds.length === 0) return { notifiedUserIds: [] };

    // The issue must still exist in this workspace (hard-deleted → nothing to
    // link to, nothing to notify). The workspace check mirrors the service
    // read paths' scoping gate.
    const item = await workItemRepository.findById(input.workItemId);
    if (!item || item.workspaceId !== input.workspaceId) return { notifiedUserIds: [] };

    // For a comment mention, the comment must still exist too (5.1's delete is
    // a HARD delete — emailing an excerpt of a deleted comment would resurrect
    // content the author removed).
    let bodyMd: string | null;
    let sourceId: string;
    if (input.source.kind === 'comment') {
      const comment = await commentRepository.findById(input.source.commentId);
      if (!comment || comment.workItemId !== item.id) return { notifiedUserIds: [] };
      bodyMd = comment.bodyMd;
      sourceId = comment.id;
    } else {
      bodyMd = item.descriptionMd;
      sourceId = input.source.revisionId;
    }

    // Send-time access re-validation, evaluated AS each mentioned user (the
    // same canBrowse policy the read paths enforce). A project deleted out
    // from under the issue reads as "no one can view" — zero sends, no error.
    let viewableIds: string[];
    try {
      const checks = await Promise.all(
        candidateIds.map(async (userId) => {
          const caps = await projectAccessService.getCommentCapabilities(item.projectId, {
            workspaceId: input.workspaceId,
            userId,
          });
          return caps.canBrowse ? userId : null;
        }),
      );
      viewableIds = checks.filter((id): id is string => id !== null);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return { notifiedUserIds: [] };
      throw err;
    }
    if (viewableIds.length === 0) return { notifiedUserIds: [] };

    // Per-user CHANNEL GATE (Story 5.7 · Subtask 5.7.6). The mention email is
    // the `email` channel of the `mentioned` event type; a recipient who turned
    // email off for mentions is dropped HERE — at the SEND decision, not at any
    // emit site (the event still fired once; the one-emit-path invariant holds).
    // An unset preference resolves to the documented default (mentions ON), so
    // this is behaviour-preserving for every user who hasn't opted out.
    const emailEnabledIds = await notificationPreferencesService.filterChannelEnabled(
      viewableIds,
      NOTIFICATION_EVENT_TYPE.mentioned,
      'email',
    );
    if (emailEnabledIds.length === 0) return { notifiedUserIds: [] };

    const [author] = await userRepository.findByIds([input.authorId]);
    const recipients = await userRepository.findByIds(emailEnabledIds);
    const excerpt = mentionExcerpt(bodyMd);
    const issueUrl = `${resolveBaseUrlTrimmed()}/issues/${encodeURIComponent(item.identifier)}`;

    const notifiedUserIds: string[] = [];
    for (const recipient of recipients) {
      await sendEvent('email.send', {
        workspaceId: input.workspaceId,
        // One delivery per source × user — Inngest dedups same-key
        // `email.send` events (the harness idempotency mechanism, 1.6.3).
        idempotencyKey: `mention:${sourceId}:${recipient.id}`,
        to: recipient.email,
        template: 'mention-notification',
        data: {
          recipientName: recipient.name,
          authorName: author?.name ?? 'Someone',
          workItemIdentifier: item.identifier,
          workItemTitle: item.title,
          source: input.source.kind,
          excerpt,
          issueUrl,
        },
      });
      notifiedUserIds.push(recipient.id);
    }
    return { notifiedUserIds };
  },
};
