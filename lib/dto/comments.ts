// Wire DTOs for the comments domain (Story 5.1 · Subtask 5.1.2). The service
// maps Prisma rows to these via lib/mappers/commentMappers.ts just before
// returning (CLAUDE.md — services never return raw Prisma models). Dates are
// ISO strings, matching the work-items DTO convention.

import type { WorkItemRefMap } from '@/lib/dto/workItems';

/** The comment author as the thread renders it (Avatar · name). */
export interface CommentAuthorDTO {
  id: string;
  name: string;
  image: string | null;
}

export interface CommentDTO {
  id: string;
  workItemId: string;
  /** Null for a root comment; the root's id for a (single-level) reply. */
  parentCommentId: string | null;
  author: CommentAuthorDTO;
  /** Markdown, mention tokens included — MarkdownView renders the chips. */
  bodyMd: string;
  /** Set on body edit — drives the "Edited" tag. Null when never edited. */
  editedAt: string | null;
  createdAt: string;
  /** The validated, persisted mention set (comment_mention rows). */
  mentionedUserIds: string[];
}

/** A root comment with its whole single-level thread riding along. */
export interface CommentThreadDTO extends CommentDTO {
  replies: CommentDTO[];
}

/**
 * One cursor-paged window of an issue's comment threads (finding #57 — never
 * a load-all). `totalCount` counts EVERY comment (replies included — the
 * Activity header's "N comments"); `nextCursor` is the cursor for the next
 * (older, in the active walk direction) page, or null on the last page.
 */
export interface CommentsPageDTO {
  threads: CommentThreadDTO[];
  totalCount: number;
  nextCursor: string | null;
  /** The page-walk direction this window was read in. */
  order: 'asc' | 'desc';
  /**
   * Resolved work-item references (Subtask 5.8.6) found in THIS page's comment
   * bodies — `[KEY](motir:<id>)` tokens, keyed by id, so the bodies render the
   * live internal-link chip (current key · title · status). The client merges
   * each page's map as it extends the window. Optional for fixture back-compat;
   * the live read always sets it.
   */
  workItemRefs?: WorkItemRefMap;
}
