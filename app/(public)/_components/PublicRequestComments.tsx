'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { LogIn } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { cn } from '@/lib/utils/cn';
import type { CommentDTO } from '@/lib/dto/comments';

// The PUBLIC request comment thread + composer (Story 6.12 · Subtask 6.12.12 ·
// design Panel 5 `.comment` / `.composer`). Client island: it owns the thread
// list seeded from the SSR'd public projection, renders each public comment
// (avatar · author · relative time · the Markdown body), and — for a signed-in
// viewer — a composer that POSTs to /api/public-requests/[id]/comments.
//
// Sign-in-to-act: reading the thread is open to everyone (it is in the crawlable
// SSR HTML); only commenting needs an account, so a logged-OUT viewer sees the
// sign-in-to-act prompt in place of the composer. On a successful post the new
// comment appears immediately (optimistic local insert) and is reconciled to the
// authoritative 201 `CommentDTO` — no whole-tree refresh (the page-state-after-
// mutation rule: this island owns the thread, so it updates itself). A failed
// post removes the optimistic row and surfaces the error inline, keeping the
// draft. Only `isPublic` comments are ever present — the projection strips the
// work item's internal Story-5.1 discussion server-side.

/** A small initial-letter avatar (the public surface stays decoupled from the
 *  authed `issueCellPrimitives` Avatar). Decorative — the name follows it. */
function CommentAvatar({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[11px] font-semibold text-(--el-text-inverted)"
      aria-hidden
    >
      {(name.trim().charAt(0) || '?').toUpperCase()}
    </span>
  );
}

function CommentItem({ comment }: { comment: CommentDTO }) {
  const format = useFormatter();
  const createdAt = new Date(comment.createdAt);
  return (
    <article className="flex gap-2.5">
      <CommentAvatar name={comment.author.name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-semibold text-(--el-text)">{comment.author.name}</span>
          <time
            dateTime={comment.createdAt}
            title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
            className="text-[11.5px] text-(--el-text-muted)"
          >
            {format.relativeTime(createdAt)}
          </time>
        </div>
        <MarkdownView value={comment.bodyMd} className="mt-1 text-[13.5px]" />
      </div>
    </article>
  );
}

export function PublicRequestComments({
  requestId,
  initialComments,
  signedIn,
  viewerName,
}: {
  requestId: string;
  initialComments: CommentDTO[];
  signedIn: boolean;
  /** The signed-in viewer's name — draws the composer's leading avatar. */
  viewerName?: string;
}) {
  const t = useTranslations('publicProjects');
  const [comments, setComments] = useState(initialComments);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic temp-id source for optimistic rows (no Date.now needed — a per
  // island counter is enough to key the in-flight row for reconcile/rollback).
  const tempSeq = useRef(0);

  const empty = draft.trim().length === 0;

  const submit = useCallback(async () => {
    if (empty || submitting) return;
    const body = draft.trim();
    const tempId = `temp-${(tempSeq.current += 1)}`;
    // Optimistic local insert — append at the bottom (chronological).
    const optimistic: CommentDTO = {
      id: tempId,
      workItemId: requestId,
      parentCommentId: null,
      author: { id: 'me', name: viewerName ?? '', image: null },
      bodyMd: body,
      editedAt: null,
      createdAt: new Date().toISOString(),
      mentionedUserIds: [],
    };
    setComments((prev) => [...prev, optimistic]);
    setDraft('');
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public-requests/${encodeURIComponent(requestId)}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bodyMd: body }),
      });
      if (!res.ok) throw new Error(`comment ${res.status}`);
      const saved: CommentDTO = await res.json();
      // Reconcile the optimistic row to the authoritative server comment.
      setComments((prev) => prev.map((c) => (c.id === tempId ? saved : c)));
    } catch {
      // Roll back the optimistic row and restore the draft so it isn't lost.
      setComments((prev) => prev.filter((c) => c.id !== tempId));
      setDraft(body);
      setError(t('commentError'));
    } finally {
      setSubmitting(false);
    }
  }, [draft, empty, submitting, requestId, viewerName, t]);

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-[15px] font-semibold text-(--el-text)">
        {t('commentsHeading', { count: comments.length })}
      </h2>

      {comments.length > 0 ? (
        <div className="flex flex-col gap-5">
          {comments.map((comment) => (
            <CommentItem key={comment.id} comment={comment} />
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-(--el-text-muted)">{t('commentsEmpty')}</p>
      )}

      <div className="mt-6 border-t border-(--el-border) pt-5">
        {signedIn ? (
          <div className="flex items-start gap-2.5">
            {viewerName ? <CommentAvatar name={viewerName} /> : null}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={t('commentPlaceholder')}
                placeholder={t('commentPlaceholder')}
                rows={3}
                disabled={submitting}
              />
              {error ? (
                <p
                  role="alert"
                  className="rounded-(--radius-control) bg-(--el-tint-rose) px-2.5 py-1.5 text-xs text-(--el-text-strong)"
                >
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={submit}
                  disabled={empty}
                  loading={submitting}
                >
                  {t('commentSubmit')}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              'flex flex-col items-start gap-2 rounded-(--radius-card) border border-(--el-border)',
              'bg-(--el-surface-soft) p-(--spacing-card-padding)',
            )}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-(--el-text)">
              <LogIn className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
              {t('signInToCommentTitle')}
            </div>
            <p className="text-[12.5px] leading-relaxed text-(--el-text-muted)">
              {t('signInToActBody')}
            </p>
            <Link
              href="/sign-in"
              className="mt-1 inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x-sm) text-[12.5px] font-semibold text-(--el-accent-text) hover:bg-(--el-accent-pressed)"
            >
              {t('signIn')}
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
