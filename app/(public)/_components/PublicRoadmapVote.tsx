'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronUp, LogIn } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';

// The Canny-style upvote control on a public roadmap card (Story 6.12 · Subtask
// 6.12.7 · design Panel 3 `.vote`) — an up-chevron over the vote count. It is a
// SIBLING of the title link, never a button nested in an anchor (avoids the axe
// `nested-interactive` violation the design notes call out).
//
// Sign-in-to-act: a logged-OUT viewer's click opens a small "sign in to upvote"
// prompt (reading is open; voting needs an account) instead of voting. A
// logged-IN viewer toggles their one vote (6.12.6, server-enforced): optimistic
// flip → POST /api/public-requests/[id]/upvote → reconcile to the authoritative
// `{ voted, voteCount }`. Overlapping clicks are seq-guarded so an older
// response can't clobber the newest optimistic state (the CLAUDE.md optimistic-
// reconcile rule); a failed write reverts.

export function PublicRoadmapVote({
  requestId,
  initialVoted,
  initialCount,
  signedIn,
  size = 'sm',
}: {
  requestId: string;
  initialVoted: boolean;
  initialCount: number;
  signedIn: boolean;
  /** `sm` (the roadmap card default) · `lg` (the request-detail head, 6.12.12). */
  size?: 'sm' | 'lg';
}) {
  const t = useTranslations('publicProjects');
  const [voted, setVoted] = useState(initialVoted);
  const [count, setCount] = useState(initialCount);
  const [pending, setPending] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const seqRef = useRef(0);

  const toggle = useCallback(async () => {
    if (pending) return;
    const seq = ++seqRef.current;
    // Optimistic flip (the count never goes negative).
    const nextVoted = !voted;
    setVoted(nextVoted);
    setCount((c) => Math.max(0, c + (nextVoted ? 1 : -1)));
    setPending(true);
    try {
      const res = await fetch(`/api/public-requests/${encodeURIComponent(requestId)}/upvote`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`upvote ${res.status}`);
      const body: { voted: boolean; voteCount: number } = await res.json();
      // Apply the authoritative server state only if this is still the latest
      // action — a stale response must not clobber a newer optimistic toggle.
      if (seq === seqRef.current) {
        setVoted(body.voted);
        setCount(body.voteCount);
      }
    } catch {
      // Revert this action's optimistic change (only if still the latest).
      if (seq === seqRef.current) {
        setVoted(voted);
        setCount((c) => Math.max(0, c + (nextVoted ? -1 : 1)));
      }
    } finally {
      if (seq === seqRef.current) setPending(false);
    }
  }, [pending, voted, requestId]);

  const onClick = useCallback(() => {
    if (!signedIn) {
      setPromptOpen((v) => !v);
      return;
    }
    void toggle();
  }, [signedIn, toggle]);

  const ariaLabel = t(voted ? 'upvotedAria' : 'upvoteAria', { count });

  return (
    <div className="relative flex-none">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={signedIn ? voted : undefined}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={cn(
          'flex flex-col items-center justify-center gap-px rounded-(--radius-control) border transition-colors',
          size === 'lg' ? 'w-[54px] py-2.5' : 'w-[42px] py-1.5',
          voted
            ? 'border-(--el-vote-active-bg) bg-(--el-vote-active-bg) text-(--el-vote-active-text)'
            : 'border-(--el-border) bg-(--el-vote-bg) text-(--el-text-secondary) hover:border-(--el-accent)',
        )}
      >
        <ChevronUp
          className={cn(size === 'lg' ? 'h-[19px] w-[19px]' : 'h-[15px] w-[15px]')}
          aria-hidden
        />
        <span
          className={cn(
            'font-bold',
            size === 'lg' ? 'text-[16px]' : 'text-[13px]',
            voted ? 'text-(--el-vote-active-text)' : 'text-(--el-text-strong)',
          )}
        >
          {count}
        </span>
      </button>

      {promptOpen && !signedIn ? (
        <div
          role="dialog"
          aria-label={t('signInToVoteTitle')}
          className="absolute left-0 top-full z-10 mt-2 w-64 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) shadow-(--shadow-card)"
        >
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-(--el-text)">
            <LogIn className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
            {t('signInToVoteTitle')}
          </div>
          <p className="mb-3 text-[12.5px] leading-relaxed text-(--el-text-muted)">
            {t('signInToActBody')}
          </p>
          <Link href="/sign-in" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            {t('signIn')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
