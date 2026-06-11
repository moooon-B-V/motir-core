import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { mentionExcerpt } from '@/lib/mentions/excerpt';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { sendEvent } from '@/lib/jobs/sendEvent';

// Watcher → email fan-out (Story 5.4 · Subtask 5.4.5). The business logic
// behind the watcherNotify jobs (lib/jobs/definitions/watcherNotify.ts), on
// the 5.1.6 mention-fan-out pattern: given a `work-item/comment.created` or
// `work-item/transitioned` payload, decide which WATCHERS get an email NOW —
// re-validated at send time — and enqueue one `email.send` per recipient.
//
// The send-time rules (mirror-verified in the Story 5.4 description):
//   * the ACTOR is never notified of their own change (the Jira default) —
//     they usually auto-watch what they touch, so this exclusion is load-
//     bearing, not theoretical;
//   * on a comment event, the comment's MENTIONED users are excluded — they
//     get the 5.1.6 mention email instead. One email per person per event;
//     the mention wins (the cross-job dedupe rule);
//   * a watcher is emailed ONLY if they can still VIEW the issue at send time
//     (the same canBrowse policy the read paths enforce, evaluated AS the
//     watcher — access may have changed since they started watching);
//   * a work item / comment hard-deleted between write and send means there
//     is nothing to notify about — the fan-out resolves to zero sends, it
//     never errors (deletion is a normal race, not a failure to retry).
//
// PAGED fan-out (finding #57): watchers are walked in pages of
// {@link WATCHER_FAN_OUT_PAGE_SIZE} via the cursor-paged repository read — a
// 200-watcher issue never builds an unbounded in-memory batch.
//
// IDEMPOTENCY: delivery dedup lives on the `email.send` job (Inngest event
// dedup over `event.data.idempotencyKey`, the 1.6.3 harness mechanism). Each
// enqueued send carries `watcher-comment:<commentId>:<userId>` or
// `watcher-transition:<revisionId>:<userId>`, so a replayed event or a
// retried fan-out step collapses to one delivery per source × user. A comment
// EDIT re-fires `work-item/comment.created` with the same commentId — the
// same-key dedup is what keeps watchers from being re-mailed per edit.
//
// LOCALE: rendered with the default locale — no persisted per-user locale yet
// (the 5.1.6 signal gap).
//
// 4-layer note: this is a SERVICE (the job handlers are its only callers, via
// the injected jobServices bag). It composes repositories + the access policy
// + the email pipeline; it opens no transaction (it only reads — the writes
// happened in commentsService / workItemsService / boardsService) and returns
// a plain JSON-serializable summary (step.run memoizes the return value).

/** Watcher-page size per fan-out read — bounded, never a load-all (finding #57). */
export const WATCHER_FAN_OUT_PAGE_SIZE = 100;

export type WatcherFanOutInput =
  | {
      kind: 'comment';
      workspaceId: string;
      workItemId: string;
      /** The comment author — never notified of their own comment. */
      actorId: string;
      commentId: string;
      /** The comment's mention recipients — they get the mention email instead. */
      mentionedUserIds: string[];
    }
  | {
      kind: 'transition';
      workspaceId: string;
      workItemId: string;
      /** The user who moved the status — never notified of their own move. */
      actorId: string;
      /** The revision row recording the transition — the idempotency scope. */
      revisionId: string;
      fromStatusKey: string;
      toStatusKey: string;
    };

export interface WatcherFanOutResult {
  /** The user ids an email was enqueued for (post send-time validation). */
  notifiedUserIds: string[];
}

export const watcherNotificationsService = {
  /**
   * Re-validate and enqueue the watcher emails for one comment / transition
   * event. Returns the recipients actually enqueued; resolves (never throws)
   * when the issue / comment vanished or every candidate fails send-time
   * validation. `pageSize` is injectable for tests; production callers omit it.
   */
  async fanOut(
    input: WatcherFanOutInput,
    opts: { pageSize?: number } = {},
  ): Promise<WatcherFanOutResult> {
    const pageSize = opts.pageSize ?? WATCHER_FAN_OUT_PAGE_SIZE;

    // The issue must still exist in this workspace (hard-deleted → nothing to
    // link to, nothing to notify). The workspace check mirrors the service
    // read paths' scoping gate.
    const item = await workItemRepository.findById(input.workItemId);
    if (!item || item.workspaceId !== input.workspaceId) return { notifiedUserIds: [] };

    // Resolve the event-specific email inputs up front (one read each, before
    // the paged watcher walk).
    let excerpt: string | null = null;
    let statusName: string | null = null;
    if (input.kind === 'comment') {
      // The comment must still exist (5.1's delete is a HARD delete — mailing
      // an excerpt of a deleted comment would resurrect removed content).
      const comment = await commentRepository.findById(input.commentId);
      if (!comment || comment.workItemId !== item.id) return { notifiedUserIds: [] };
      excerpt = mentionExcerpt(comment.bodyMd);
    } else {
      // The target status's display name; a status deleted/renamed between
      // write and send falls back to the event's key (the move still
      // happened — the email still goes out).
      const status = await workflowsService.getStatusByKey(
        item.projectId,
        input.toStatusKey,
        input.workspaceId,
      );
      statusName = status?.label ?? input.toStatusKey;
    }

    // Excluded from the watcher fan-out: the actor (never self-notified) and,
    // on a comment, the mentioned users (the mention email wins — one email
    // per person per event).
    const excluded = new Set<string>([input.actorId]);
    if (input.kind === 'comment') for (const id of input.mentionedUserIds) excluded.add(id);

    const [actor] = await userRepository.findByIds([input.actorId]);
    const actorName = actor?.name ?? 'Someone';
    const issueUrl = `${resolveBaseUrlTrimmed()}/issues/${encodeURIComponent(item.identifier)}`;

    // Walk the watcher roster page by page (finding #57 — bounded reads), and
    // enqueue per surviving recipient as each page resolves.
    const notifiedUserIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await watcherRepository.listByWorkItem(item.id, { take: pageSize, cursor });
      cursor = page.length === pageSize ? page[page.length - 1]!.id : undefined;

      const candidates = page.filter((w) => !excluded.has(w.userId));
      if (candidates.length === 0) continue;

      // Send-time access re-validation, evaluated AS each watcher (the same
      // canBrowse policy the read paths enforce). A project deleted out from
      // under the issue reads as "no one can view" — zero sends, no error.
      let viewable: typeof candidates;
      try {
        const checks = await Promise.all(
          candidates.map(async (watcher) => {
            const caps = await projectAccessService.getCapabilities(item.projectId, {
              workspaceId: input.workspaceId,
              userId: watcher.userId,
            });
            return caps.canBrowse ? watcher : null;
          }),
        );
        viewable = checks.filter((w): w is (typeof candidates)[number] => w !== null);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return { notifiedUserIds: [] };
        throw err;
      }

      for (const watcher of viewable) {
        if (input.kind === 'comment') {
          await sendEvent('email.send', {
            workspaceId: input.workspaceId,
            // One delivery per source × user — Inngest dedups same-key
            // `email.send` events (the harness idempotency mechanism, 1.6.3).
            idempotencyKey: `watcher-comment:${input.commentId}:${watcher.userId}`,
            to: watcher.user.email,
            template: 'watcher-comment-notification',
            data: {
              recipientName: watcher.user.name,
              authorName: actorName,
              workItemIdentifier: item.identifier,
              workItemTitle: item.title,
              excerpt,
              issueUrl,
            },
          });
        } else {
          await sendEvent('email.send', {
            workspaceId: input.workspaceId,
            idempotencyKey: `watcher-transition:${input.revisionId}:${watcher.userId}`,
            to: watcher.user.email,
            template: 'watcher-transition-notification',
            data: {
              recipientName: watcher.user.name,
              actorName,
              workItemIdentifier: item.identifier,
              workItemTitle: item.title,
              statusName: statusName!,
              issueUrl,
            },
          });
        }
        notifiedUserIds.push(watcher.userId);
      }
    } while (cursor);

    return { notifiedUserIds };
  },
};
