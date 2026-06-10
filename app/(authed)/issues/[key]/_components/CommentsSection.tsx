'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDownNarrowWide, ArrowUpNarrowWide, Eye, MessageSquare } from 'lucide-react';
import { ErrorState } from '@/components/ui/ErrorState';
import { Segmented } from '@/components/ui/Segmented';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import type {
  CommentAuthorDTO,
  CommentDTO,
  CommentsPageDTO,
  CommentThreadDTO,
} from '@/lib/dto/comments';
import { useCommentsSort } from '@/lib/hooks/useCommentsSort';
import { ContentSectionCard } from './ContentSectionCard';
import { CommentComposer } from './CommentComposer';
import { CommentRow } from './CommentRow';
import { addCommentAction } from '../commentActions';

// The comments stream in the detail page's Activity slot (Subtask 5.1.5) —
// replaces the "Comments coming in Epic 5" placeholder with the
// `design/work-items/comments.mock.html` surface:
//
//   * header — total count gloss · the Comments/History filter seam (History
//     drawn disabled — Story 5.5's documented slot) · the per-user sort toggle
//     (oldest-first default, the Jira shape; persisted in localStorage);
//   * the thread list — the newest cursor page (20 roots) of single-level
//     threads; long threads collapse their older replies behind "Show N more
//     replies" (the Jira auto-collapse); "Show more comments (N older)" sits
//     at the OLDER edge, flipping top/bottom with the sort direction
//     (finding #57 — the read is cursor-paged, never load-all);
//   * the composer (new/reply) and per-row edit/delete via Server Actions —
//     this client component owns the loaded window, applies the returned DTOs
//     in place (so extending/paging state survives a mutation), and calls
//     `router.refresh()` to keep the server-rendered first page fresh;
//   * loading skeletons / inviting empty state / ErrorState + retry / the
//     viewer read-only line — the mockup's panels 7 and 9.
//
// The window is HELD newest-first (the fetch walk is always `order=desc` —
// page 1 is the newest 20 roots, the cursor extends backward); the sort
// toggle is a presentation flip of that same window, so toggling re-orders
// what's loaded without a refetch (the mockup's panel-6 contract).

/** Threads longer than this collapse their older replies (panel 1). */
const REPLY_COLLAPSE_THRESHOLD = 3;
/** How many (newest) replies stay visible while collapsed. */
const COLLAPSED_VISIBLE_REPLIES = 1;

interface ReplyTarget {
  rootId: string;
  author: CommentAuthorDTO;
}

export function CommentsSection({
  workItemId,
  canComment,
  canModerate,
  currentUserId,
  currentUserName,
  mentionCandidates,
  initialPage,
}: {
  workItemId: string;
  canComment: boolean;
  canModerate: boolean;
  currentUserId: string;
  currentUserName: string;
  mentionCandidates: MentionCandidate[];
  /** The server-rendered first page (newest 20 threads), or null when the
   * server read failed — the section then renders ErrorState + retry. */
  initialPage: CommentsPageDTO | null;
}) {
  const t = useTranslations('comments');
  const router = useRouter();

  const [threads, setThreads] = useState<CommentThreadDTO[]>(initialPage?.threads ?? []);
  const [totalCount, setTotalCount] = useState(initialPage?.totalCount ?? 0);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
  // Per-user sort (Jira's "Reverse sort direction"), localStorage-persisted
  // through the shared store hook — SSR paints the oldest-first default.
  const [order, setOrder] = useCommentsSort();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(initialPage === null);
  const [expandedThreads, setExpandedThreads] = useState<ReadonlySet<string>>(new Set());
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);

  function toggleOrder() {
    setOrder(order === 'asc' ? 'desc' : 'asc');
  }

  async function fetchPage(cursor?: string): Promise<CommentsPageDTO> {
    const params = new URLSearchParams({ order: 'desc' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/work-items/${workItemId}/comments?${params}`);
    if (!res.ok) throw new Error(`Comments read failed (${res.status})`);
    return (await res.json()) as CommentsPageDTO;
  }

  function retryInitial() {
    setFailed(false);
    setLoading(true);
    void fetchPage()
      .then((page) => {
        setThreads(page.threads);
        setTotalCount(page.totalCount);
        setNextCursor(page.nextCursor);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }

  // "Show more comments (N older)" — extend the window backward. In
  // oldest-first display the older page renders ABOVE the current content, so
  // compensate the scroll position by the height the extension added (the
  // mockup's "keeps scroll position").
  function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const scroller = document.scrollingElement;
    const prevHeight = scroller?.scrollHeight ?? 0;
    void fetchPage(nextCursor)
      .then((page) => {
        setThreads((current) => [...current, ...page.threads]);
        setTotalCount(page.totalCount);
        setNextCursor(page.nextCursor);
        if (order === 'asc' && scroller) {
          requestAnimationFrame(() => {
            scroller.scrollTop += scroller.scrollHeight - prevHeight;
          });
        }
      })
      .catch(() => setFailed(true))
      .finally(() => setLoadingMore(false));
  }

  async function submitNewComment(bodyMd: string): Promise<string | null> {
    const res = await addCommentAction({ workItemId, bodyMd });
    if (!res.ok) return res.error;
    // The new root joins the window's newest edge (held newest-first).
    setThreads((current) => [{ ...res.comment, replies: [] }, ...current]);
    setTotalCount((current) => current + 1);
    router.refresh();
    return null;
  }

  async function submitReply(rootId: string, bodyMd: string): Promise<string | null> {
    const res = await addCommentAction({ workItemId, bodyMd, parentCommentId: rootId });
    if (!res.ok) return res.error;
    setThreads((current) =>
      current.map((thread) =>
        thread.id === rootId ? { ...thread, replies: [...thread.replies, res.comment] } : thread,
      ),
    );
    setTotalCount((current) => current + 1);
    setReplyTarget(null);
    router.refresh();
    return null;
  }

  function handleEdited(updated: CommentDTO) {
    setThreads((current) =>
      current.map((thread) => {
        if (thread.id === updated.id) return { ...thread, ...updated };
        if (thread.id !== updated.parentCommentId) return thread;
        return {
          ...thread,
          replies: thread.replies.map((reply) => (reply.id === updated.id ? updated : reply)),
        };
      }),
    );
    router.refresh();
  }

  function handleRootDeleted(thread: CommentThreadDTO) {
    setThreads((current) => current.filter((item) => item.id !== thread.id));
    setTotalCount((current) => Math.max(0, current - 1 - thread.replies.length));
    if (replyTarget?.rootId === thread.id) setReplyTarget(null);
    router.refresh();
  }

  function handleReplyDeleted(rootId: string, replyId: string) {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === rootId
          ? { ...thread, replies: thread.replies.filter((reply) => reply.id !== replyId) }
          : thread,
      ),
    );
    setTotalCount((current) => Math.max(0, current - 1));
    router.refresh();
  }

  const loadedCount = threads.reduce((sum, thread) => sum + 1 + thread.replies.length, 0);
  const olderCount = Math.max(0, totalCount - loadedCount);
  const displayThreads = order === 'asc' ? [...threads].reverse() : threads;
  const empty = !failed && !loading && totalCount === 0 && threads.length === 0;

  const showMore =
    nextCursor && !failed ? (
      <button
        type="button"
        onClick={loadMore}
        disabled={loadingMore}
        className="border-(--el-border-strong) bg-(--el-surface-soft) text-(--el-text-secondary) hover:text-(--el-text) h-(--height-control) w-full rounded-(--radius-control) border border-dashed px-(--spacing-control-x) font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t('showMore', { count: olderCount })}
      </button>
    ) : null;

  const olderEdgeSkeleton = loadingMore ? <CommentSkeleton rows={2} /> : null;

  return (
    <ContentSectionCard
      title={t('title')}
      subtitle={failed ? undefined : t('countGloss', { count: totalCount })}
      headerRight={
        <div className="flex items-center gap-2">
          <Segmented
            label={t('filterAria')}
            value="comments"
            onChange={() => {}}
            options={[
              { value: 'comments', label: t('filterComments') },
              {
                value: 'history',
                label: t('filterHistory'),
                disabled: true,
                title: t('historySeamTitle'),
              },
            ]}
          />
          <button
            type="button"
            onClick={toggleOrder}
            aria-label={order === 'asc' ? t('sortAriaOldest') : t('sortAriaNewest')}
            className="border-(--el-border) text-(--el-text-secondary) hover:text-(--el-text) inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-btn) border px-(--spacing-control-x) font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {order === 'asc' ? (
              <ArrowDownNarrowWide className="text-(--el-text-muted) h-3.5 w-3.5" aria-hidden />
            ) : (
              <ArrowUpNarrowWide className="text-(--el-text-muted) h-3.5 w-3.5" aria-hidden />
            )}
            {order === 'asc' ? t('sortOldest') : t('sortNewest')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {failed ? (
          <ErrorState
            title={t('errorTitle')}
            description={t('errorDescription')}
            retry={retryInitial}
          />
        ) : loading ? (
          <CommentSkeleton rows={3} />
        ) : empty ? (
          <div className="flex flex-col items-center gap-1.5 py-6">
            <MessageSquare className="text-(--el-text-faint) h-[22px] w-[22px]" aria-hidden />
            <p className="text-(--el-text-secondary) font-sans text-sm">{t('empty')}</p>
          </div>
        ) : (
          <ul aria-label={t('threadAria')} className="flex list-none flex-col gap-5">
            {/* The OLDER edge — top in oldest-first display (panel 6). */}
            {order === 'asc' ? (
              <>
                {showMore ? <li>{showMore}</li> : null}
                {olderEdgeSkeleton ? <li>{olderEdgeSkeleton}</li> : null}
              </>
            ) : null}
            {displayThreads.map((thread) => {
              const collapsed =
                thread.replies.length > REPLY_COLLAPSE_THRESHOLD && !expandedThreads.has(thread.id);
              const visibleReplies = collapsed
                ? thread.replies.slice(thread.replies.length - COLLAPSED_VISIBLE_REPLIES)
                : thread.replies;
              return (
                <li key={thread.id}>
                  <CommentRow
                    comment={thread}
                    replyCount={thread.replies.length}
                    canComment={canComment}
                    canModerate={canModerate}
                    currentUserId={currentUserId}
                    mentionCandidates={mentionCandidates}
                    onStartReply={(author) => setReplyTarget({ rootId: thread.id, author })}
                    onEdited={handleEdited}
                    onDeleted={() => handleRootDeleted(thread)}
                  />
                  {thread.replies.length > 0 || replyTarget?.rootId === thread.id ? (
                    <div className="border-(--el-border-soft) mt-3 ml-[11px] flex flex-col gap-4 border-l-2 pl-3.5">
                      {collapsed ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedThreads((current) => new Set(current).add(thread.id))
                          }
                          className="text-(--el-text-muted) hover:text-(--el-text) self-start rounded-(--radius-control) px-1 py-0.5 font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                        >
                          {t('showMoreReplies', {
                            count: thread.replies.length - COLLAPSED_VISIBLE_REPLIES,
                          })}
                        </button>
                      ) : null}
                      {visibleReplies.length > 0 ? (
                        <ul aria-label={t('repliesAria')} className="flex list-none flex-col gap-4">
                          {visibleReplies.map((reply) => (
                            <li key={reply.id}>
                              <CommentRow
                                comment={reply}
                                canComment={canComment}
                                canModerate={canModerate}
                                currentUserId={currentUserId}
                                mentionCandidates={mentionCandidates}
                                onStartReply={(author) =>
                                  setReplyTarget({ rootId: thread.id, author })
                                }
                                onEdited={handleEdited}
                                onDeleted={() => handleReplyDeleted(thread.id, reply.id)}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {replyTarget?.rootId === thread.id ? (
                        <CommentComposer
                          key={`${thread.id}:${replyTarget.author.id}`}
                          mode="reply"
                          label={t('replyLabel')}
                          submitLabel={t('reply')}
                          initialValue={`[@${replyTarget.author.name}](mention:${replyTarget.author.id}) `}
                          mentionCandidates={mentionCandidates}
                          onSubmit={(bodyMd) => submitReply(thread.id, bodyMd)}
                          onCancel={() => setReplyTarget(null)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
            {/* The OLDER edge — bottom in newest-first display (panel 6). */}
            {order === 'desc' ? (
              <>
                {olderEdgeSkeleton ? <li>{olderEdgeSkeleton}</li> : null}
                {showMore ? <li>{showMore}</li> : null}
              </>
            ) : null}
          </ul>
        )}

        {/* No composer under a failed/loading thread (the mockup's panel-7
            error/loading states draw the section without it). */}
        {failed || loading ? null : canComment ? (
          <CommentComposer
            mode="new"
            label={t('composerLabel')}
            submitLabel={t('comment')}
            authorName={currentUserName}
            mentionCandidates={mentionCandidates}
            onSubmit={submitNewComment}
          />
        ) : (
          <p className="bg-(--el-surface-soft) text-(--el-text-secondary) flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-2 font-sans text-xs">
            <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('readOnly')}
          </p>
        )}
      </div>
    </ContentSectionCard>
  );
}

/** Comment-row-shaped pulse skeleton (panel 7 — the BacklogSkeleton grammar). */
function CommentSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-busy className="flex animate-pulse flex-col gap-5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-2.5">
          <span className="bg-(--el-muted) h-[22px] w-[22px] shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="bg-(--el-muted) h-3 w-2/5 rounded-(--radius-control)" />
            <span className="bg-(--el-muted) h-3 w-4/5 rounded-(--radius-control)" />
            {index % 2 === 0 ? (
              <span className="bg-(--el-muted) h-3 w-3/5 rounded-(--radius-control)" />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
