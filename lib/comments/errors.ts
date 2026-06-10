// Typed errors for the comments domain (Story 5.1 · Subtask 5.1.2). Kept in
// their own file so callers — route handlers, server actions, server
// components — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, the service throws these and the route layer translates the
// stable `code` to an HTTP status:
//   CommentNotFoundError      → 404 (a cross-workspace or invisible comment id
//                                    is indistinguishable from a never-existed
//                                    one — finding #44, no existence leak)
//   CommentForbiddenError     → 403 (the caller can SEE the issue but lacks the
//                                    comment permission — the Jira permission
//                                    split mapped onto the 6.4 role model)
//   EmptyCommentBodyError     → 422
//   InvalidParentCommentError → 422
//   ReplyDepthExceededError   → 422 (single-level threading: replies attach to
//                                    roots only; the UI attaches a
//                                    reply-to-a-reply to the root, 5.1.5)

export class CommentNotFoundError extends Error {
  readonly code = 'COMMENT_NOT_FOUND' as const;
  constructor(commentId: string) {
    super(`Comment ${commentId} not found.`);
    this.name = 'CommentNotFoundError';
  }
}

/** The comment action the caller was denied — drives the message only. */
export type CommentAction = 'add' | 'edit' | 'delete';

export class CommentForbiddenError extends Error {
  readonly code = 'COMMENT_FORBIDDEN' as const;
  readonly action: CommentAction;
  constructor(action: CommentAction) {
    super(`You do not have permission to ${action} this comment.`);
    this.name = 'CommentForbiddenError';
    this.action = action;
  }
}

export class EmptyCommentBodyError extends Error {
  readonly code = 'EMPTY_COMMENT_BODY' as const;
  constructor() {
    super('A comment body must not be empty.');
    this.name = 'EmptyCommentBodyError';
  }
}

export class InvalidParentCommentError extends Error {
  readonly code = 'INVALID_PARENT_COMMENT' as const;
  constructor(parentCommentId: string) {
    super(`Comment ${parentCommentId} belongs to a different work item.`);
    this.name = 'InvalidParentCommentError';
  }
}

export class ReplyDepthExceededError extends Error {
  readonly code = 'REPLY_DEPTH_EXCEEDED' as const;
  constructor(parentCommentId: string) {
    super(
      `Comment ${parentCommentId} is itself a reply — replies attach to root comments only (single-level threading).`,
    );
    this.name = 'ReplyDepthExceededError';
  }
}
