import type { Comment, Prisma, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { commentMentionRepository } from '@/lib/repositories/commentMentionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { parseMentionIds } from '@/lib/mentions/parse';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { toCommentDto, toCommentThreadDto } from '@/lib/mappers/commentMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
  InvalidParentCommentError,
  ReplyDepthExceededError,
} from '@/lib/comments/errors';
import type { CommentDTO, CommentsPageDTO } from '@/lib/dto/comments';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Comments service (Story 5.1 · Subtask 5.1.2) — the business-logic core over
// the 5.1.1 repositories. Owns validation, the permission matrix, the
// single-level-threading rule, server-side mention parsing, transactions, DTO
// mapping, and the post-commit job event. Routes are HTTP-only (CLAUDE.md).
//
// Permission matrix (the Jira comment permissions mapped onto the shipped 6.4
// role model — see lib/projects/access.ts canComment/canModerateComments):
//   * add           — canComment (viewer is read-only → CommentForbiddenError)
//   * edit/delete   — the author themselves, OR canModerate (project admin /
//                     workspace owner-admin)
//   * everything    — view-gated: an issue the caller can't browse reads as
//                     WorkItemNotFoundError (→ 404, finding #44 — a hidden or
//                     cross-workspace id is indistinguishable from a
//                     never-existed one)
//
// Mentions: the service is the AUTHORITY. Every write parses
// `[@Name](mention:<userId>)` tokens (lib/mentions/parse.ts), validates each
// id against the members who can VIEW the issue — exactly the 6.4
// `assignableMembersService` scoping (private → project members; open/limited
// → workspace members), reused not duplicated — and silently DROPS the rest
// (the Jira rule: no view permission → no mention, never an error). The
// member-set read is reference data resolved BEFORE the transaction
// (assignableMembersService binds its own RLS context); the rows persist
// inside it.
//
// Events fire AFTER commit, never inside the tx — a rollback must not have
// notified anyone.

/** Jira-faithful page size — the newest window the Activity section renders. */
export const COMMENT_PAGE_SIZE = 20;

export interface ListCommentsOptions {
  /** Resume strictly after this root-comment id (the previous page's last). */
  cursor?: string;
  /** Page-walk direction. Default oldest-first (the Jira default sort). */
  order?: 'asc' | 'desc';
}

interface CommentGate {
  item: WorkItem;
  caps: {
    canBrowse: boolean;
    canComment: boolean;
    canModerate: boolean;
    accessLevel: 'open' | 'limited' | 'private';
  };
}

/**
 * Resolve a work item AND the caller's comment capabilities on its project,
 * enforcing the two hide-gates: a missing / cross-workspace item AND a
 * non-browsable project both read as WorkItemNotFoundError (404 — finding
 * #44; "you can't see it" must be indistinguishable from "it doesn't exist").
 */
async function resolveGatedWorkItem(
  workItemId: string,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<CommentGate> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
  const caps = await projectAccessService.getCommentCapabilities(item.projectId, ctx, tx);
  if (!caps.canBrowse) throw new WorkItemNotFoundError(workItemId);
  return { item, caps };
}

/**
 * Resolve a comment by id under the same hide-gates: missing or
 * cross-workspace → CommentNotFoundError (404, no existence leak).
 */
async function resolveComment(
  commentId: string,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
) {
  const row = await commentRepository.findById(commentId, tx);
  if (!row || row.workspaceId !== ctx.workspaceId) throw new CommentNotFoundError(commentId);
  return row;
}

/**
 * The user ids the body may validly mention — the members who can VIEW the
 * issue, via the 6.4 `assignableMembersService` scoping (reused, not
 * duplicated). Reference-data read; runs OUTSIDE the write transaction (the
 * member service binds its own workspace context).
 */
async function resolveMentionableIds(gate: CommentGate, ctx: ServiceContext): Promise<Set<string>> {
  const members = await assignableMembersService.list({
    projectId: gate.item.projectId,
    accessLevel: gate.caps.accessLevel,
    ctx,
  });
  return new Set(members.map((m) => m.userId));
}

/** Validate + normalize an incoming body, throwing on blank. */
function requireBody(bodyMd: string): string {
  if (bodyMd.trim().length === 0) throw new EmptyCommentBodyError();
  return bodyMd;
}

/** Map one freshly-written comment row to its DTO (single-row side reads). */
async function toSingleCommentDto(row: Comment, mentionedUserIds: string[]): Promise<CommentDTO> {
  const authors = await userRepository.findByIds([row.authorId]);
  return toCommentDto(
    row,
    new Map(authors.map((u) => [u.id, u])),
    new Map([[row.id, mentionedUserIds]]),
  );
}

export const commentsService = {
  /**
   * Add a comment (or a single-level reply) to a work item. View-gated +
   * permission-gated; `parentCommentId` must point at a ROOT comment on the
   * SAME issue (depth > 1 → ReplyDepthExceededError — the UI attaches a
   * reply-to-a-reply to the root, 5.1.5). In ONE transaction: the comment row
   * + its validated mention rows. After commit: the
   * `work-item/comment.created` event.
   */
  async addComment(
    workItemId: string,
    input: { bodyMd: string; parentCommentId?: string | null },
    ctx: ServiceContext,
  ): Promise<CommentDTO> {
    const bodyMd = requireBody(input.bodyMd);
    const tokenIds = parseMentionIds(bodyMd);

    // Reference-data read (mention candidates) ahead of the tx — only when
    // the body actually mentions someone. The pre-gate also fails fast on a
    // hidden issue before any member read happens.
    let mentionable = new Set<string>();
    if (tokenIds.length > 0) {
      mentionable = await resolveMentionableIds(await resolveGatedWorkItem(workItemId, ctx), ctx);
    }

    const { row, storedMentionIds } = await db.$transaction(async (tx) => {
      const gate = await resolveGatedWorkItem(workItemId, ctx, tx);
      if (!gate.caps.canComment) throw new CommentForbiddenError('add');

      if (input.parentCommentId) {
        const parent = await resolveComment(input.parentCommentId, ctx, tx);
        if (parent.workItemId !== gate.item.id) {
          throw new InvalidParentCommentError(input.parentCommentId);
        }
        if (parent.parentCommentId !== null) {
          throw new ReplyDepthExceededError(input.parentCommentId);
        }
      }

      const created = await commentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          workItemId: gate.item.id,
          authorId: ctx.userId,
          parentCommentId: input.parentCommentId ?? null,
          bodyMd,
        },
        tx,
      );
      const stored = tokenIds.filter((id) => mentionable.has(id));
      await commentMentionRepository.createMany(
        stored.map((mentionedUserId) => ({ commentId: created.id, mentionedUserId })),
        tx,
      );
      return { row: created, storedMentionIds: stored };
    });

    // Post-commit, never inside the tx — a rollback must not have notified.
    await sendEvent('work-item/comment.created', {
      workspaceId: ctx.workspaceId,
      workItemId,
      commentId: row.id,
      authorId: ctx.userId,
      mentionedUserIds: storedMentionIds,
    });

    return toSingleCommentDto(row, storedMentionIds);
  },

  /**
   * Edit a comment's body. Author edits their own; project admin / workspace
   * owner-admin edit all (the Jira "Edit own / Edit all" split). Sets
   * `editedAt` (the "Edited" tag) — except on a no-op edit (identical body),
   * which returns unchanged without writing or notifying. Mentions re-parse
   * and diff in the same tx; newly-added mentions re-fire the
   * `work-item/comment.created` event carrying ONLY the new ids.
   */
  async editComment(
    commentId: string,
    input: { bodyMd: string },
    ctx: ServiceContext,
  ): Promise<CommentDTO> {
    const bodyMd = requireBody(input.bodyMd);
    const tokenIds = parseMentionIds(bodyMd);

    // Pre-tx: resolve the comment → its issue (both hide-gated) for the
    // reference-data mention read.
    const preGate = await resolveGatedWorkItem(
      (await resolveComment(commentId, ctx)).workItemId,
      ctx,
    );
    const mentionable =
      tokenIds.length > 0 ? await resolveMentionableIds(preGate, ctx) : new Set<string>();

    const { row, storedMentionIds, addedMentionIds, changed } = await db.$transaction(
      async (tx) => {
        const current = await resolveComment(commentId, ctx, tx);
        const gate = await resolveGatedWorkItem(current.workItemId, ctx, tx);
        if (current.authorId !== ctx.userId && !gate.caps.canModerate) {
          throw new CommentForbiddenError('edit');
        }

        const prevRows = await commentMentionRepository.findByCommentIds([commentId], tx);
        const prevIds = prevRows.map((m) => m.mentionedUserId);

        if (current.bodyMd === bodyMd) {
          // No-op edit: no write, no "Edited" tag, no event.
          return { row: current, storedMentionIds: prevIds, addedMentionIds: [], changed: false };
        }

        const stored = tokenIds.filter((id) => mentionable.has(id));
        const prevSet = new Set(prevIds);
        const added = stored.filter((id) => !prevSet.has(id));

        const updated = await commentRepository.update(
          commentId,
          { bodyMd, editedAt: new Date() },
          tx,
        );
        // Clear-and-rewrite keeps the row set exactly the re-parse result
        // (drops removed mentions, keeps kept ones, adds new ones).
        await commentMentionRepository.deleteByCommentId(commentId, tx);
        await commentMentionRepository.createMany(
          stored.map((mentionedUserId) => ({ commentId, mentionedUserId })),
          tx,
        );
        return { row: updated, storedMentionIds: stored, addedMentionIds: added, changed: true };
      },
    );

    if (changed && addedMentionIds.length > 0) {
      await sendEvent('work-item/comment.created', {
        workspaceId: ctx.workspaceId,
        workItemId: row.workItemId,
        commentId: row.id,
        authorId: ctx.userId,
        mentionedUserIds: addedMentionIds,
      });
    }

    return toSingleCommentDto(row, storedMentionIds);
  },

  /**
   * HARD-delete a comment (the Jira-faithful semantics — no tombstone).
   * Author deletes their own; project admin / workspace owner-admin delete
   * all. For a ROOT, the DB cascade takes its replies + mention rows; in the
   * SAME transaction a `work_item_revision` row (changeKind
   * `comment_deleted`) records that a comment by X was deleted by Y, reply
   * count included — the surviving History trace Story 5.5 renders.
   */
  async deleteComment(commentId: string, ctx: ServiceContext): Promise<void> {
    await db.$transaction(async (tx) => {
      const current = await resolveComment(commentId, ctx, tx);
      const gate = await resolveGatedWorkItem(current.workItemId, ctx, tx);
      if (current.authorId !== ctx.userId && !gate.caps.canModerate) {
        throw new CommentForbiddenError('delete');
      }

      const replyCount =
        current.parentCommentId === null
          ? await commentRepository.countByParent(current.id, tx)
          : 0;

      await workItemRevisionsService.recordRevision(
        {
          workItemId: current.workItemId,
          changedById: ctx.userId,
          changeKind: 'comment_deleted',
          diff: {
            comment: {
              from: { commentId: current.id, authorId: current.authorId, replyCount },
              to: null,
            },
          },
        },
        tx,
      );
      await commentRepository.delete(current.id, tx);
    });
  },

  /**
   * One cursor-paged window of a work item's comment THREADS (finding #57 —
   * never a load-all): up to {@link COMMENT_PAGE_SIZE} roots, each carrying
   * its whole single-level thread (replies are bounded by the threading
   * decision). `totalCount` counts every comment, replies included (the
   * Activity header + "Show more comments (N older)" denominator). View-gated
   * like every read. Default order oldest-first (the Jira default); `desc`
   * walks newest-first.
   */
  async listComments(
    workItemId: string,
    options: ListCommentsOptions,
    ctx: ServiceContext,
  ): Promise<CommentsPageDTO> {
    await resolveGatedWorkItem(workItemId, ctx);
    const order = options.order ?? 'asc';

    // take+1 probes for a next page without a second count read.
    const window = await commentRepository.listThreadsByWorkItem(workItemId, {
      take: COMMENT_PAGE_SIZE + 1,
      cursor: options.cursor,
      order,
    });
    const roots = window.slice(0, COMMENT_PAGE_SIZE);
    const hasMore = window.length > COMMENT_PAGE_SIZE;

    const pageComments = roots.flatMap((root) => [root, ...root.replies]);
    const [mentionRows, authors, totalCount] = await Promise.all([
      commentMentionRepository.findByCommentIds(pageComments.map((c) => c.id)),
      userRepository.findByIds([...new Set(pageComments.map((c) => c.authorId))]),
      commentRepository.countByWorkItem(workItemId),
    ]);

    const mentionsByCommentId = new Map<string, string[]>();
    for (const m of mentionRows) {
      const bucket = mentionsByCommentId.get(m.commentId);
      if (bucket) bucket.push(m.mentionedUserId);
      else mentionsByCommentId.set(m.commentId, [m.mentionedUserId]);
    }
    const authorsById = new Map(authors.map((u) => [u.id, u]));

    return {
      threads: roots.map((root) => toCommentThreadDto(root, authorsById, mentionsByCommentId)),
      totalCount,
      nextCursor: hasMore ? (roots[roots.length - 1]?.id ?? null) : null,
      order,
    };
  },
};
