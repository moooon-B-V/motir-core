import type { Comment, User } from '@prisma/client';
import type { CommentWithReplies } from '@/lib/repositories/commentRepository';
import type { CommentAuthorDTO, CommentDTO, CommentThreadDTO } from '@/lib/dto/comments';

// Prisma → DTO converters for the comments domain (Story 5.1 · Subtask
// 5.1.2). The service batches the side reads — ONE author lookup and ONE
// mention read per page (no N+1) — and hands the buckets in; the mappers are
// pure shaping.

/**
 * Resolve a comment's author from the batched user read. The `author`
 * relation is `onDelete: Restrict`, so every persisted comment's author row
 * exists — a miss means the service forgot to include the id in its batch
 * read, which is a bug worth failing loudly on, not a renderable state.
 */
function authorFor(row: Comment, authorsById: Map<string, User>): CommentAuthorDTO {
  const user = authorsById.get(row.authorId);
  if (!user) {
    throw new Error(`Comment ${row.id}: author ${row.authorId} missing from the batched read.`);
  }
  return { id: user.id, name: user.name, image: user.image ?? null };
}

export function toCommentDto(
  row: Comment,
  authorsById: Map<string, User>,
  mentionsByCommentId: Map<string, string[]>,
): CommentDTO {
  return {
    id: row.id,
    workItemId: row.workItemId,
    parentCommentId: row.parentCommentId,
    author: authorFor(row, authorsById),
    bodyMd: row.bodyMd,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    mentionedUserIds: mentionsByCommentId.get(row.id) ?? [],
  };
}

export function toCommentThreadDto(
  row: CommentWithReplies,
  authorsById: Map<string, User>,
  mentionsByCommentId: Map<string, string[]>,
): CommentThreadDTO {
  return {
    ...toCommentDto(row, authorsById, mentionsByCommentId),
    replies: row.replies.map((reply) => toCommentDto(reply, authorsById, mentionsByCommentId)),
  };
}
