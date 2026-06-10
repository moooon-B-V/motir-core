'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { commentsService } from '@/lib/services/commentsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
  InvalidParentCommentError,
  ReplyDepthExceededError,
} from '@/lib/comments/errors';
import type { CommentDTO } from '@/lib/dto/comments';

// Server Actions for the issue detail page's comments section (Subtask 5.1.5).
// Thin transports over `commentsService` (the 5.1.2 business-logic core): one
// service call each, typed comment errors translated to user-facing copy from
// the `comments` catalog namespace. The section is a client component that owns
// the loaded window, so each action returns the written DTO for an in-place
// state update; `revalidatePath` keeps the server-rendered first page fresh for
// the next navigation (the shipped detail-page pattern).

const ISSUES_PATH = '/issues';

export type CommentActionResult = { ok: true; comment: CommentDTO } | { ok: false; error: string };

export type DeleteCommentActionResult = { ok: true } | { ok: false; error: string };

async function commentErrorMessage(err: unknown): Promise<string | null> {
  const t = await getTranslations('comments');
  if (
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError ||
    err instanceof CommentNotFoundError
  ) {
    return t('errors.notFound');
  }
  if (err instanceof CommentForbiddenError) return t('errors.forbidden');
  if (err instanceof EmptyCommentBodyError) return t('errors.empty');
  // Both are UI-invariant violations (the section only offers legal reply
  // targets); still translate rather than leak an internal message.
  if (err instanceof InvalidParentCommentError || err instanceof ReplyDepthExceededError) {
    return t('errors.generic');
  }
  return null;
}

export async function addCommentAction(input: {
  workItemId: string;
  bodyMd: string;
  parentCommentId?: string | null;
}): Promise<CommentActionResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: (await getTranslations('comments'))('errors.generic') };
  try {
    const comment = await commentsService.addComment(
      input.workItemId,
      { bodyMd: input.bodyMd, parentCommentId: input.parentCommentId ?? null },
      ctx,
    );
    revalidatePath(ISSUES_PATH);
    return { ok: true, comment };
  } catch (err) {
    const message = await commentErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export async function editCommentAction(input: {
  commentId: string;
  bodyMd: string;
}): Promise<CommentActionResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: (await getTranslations('comments'))('errors.generic') };
  try {
    const comment = await commentsService.editComment(
      input.commentId,
      { bodyMd: input.bodyMd },
      ctx,
    );
    revalidatePath(ISSUES_PATH);
    return { ok: true, comment };
  } catch (err) {
    const message = await commentErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}

export async function deleteCommentAction(input: {
  commentId: string;
}): Promise<DeleteCommentActionResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: (await getTranslations('comments'))('errors.generic') };
  try {
    await commentsService.deleteComment(input.commentId, ctx);
    revalidatePath(ISSUES_PATH);
    return { ok: true };
  } catch (err) {
    const message = await commentErrorMessage(err);
    if (message) return { ok: false, error: message };
    throw err;
  }
}
