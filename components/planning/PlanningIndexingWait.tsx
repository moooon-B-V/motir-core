'use client';

import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/Button';

// THE WINDOW SHOWS THE WAIT (Story MOTIR-4753 · MOTIR-4829) — a repository is
// connected, its code graph does not exist yet, and Motir is building one.
//
// ⚠️ TWO INSTRUMENTS, AND NEITHER IS THE OTHER'S CAPTION (Yue, 2026-09-07:
// *"with the banner and say it"*). This is the load-bearing decision of the
// surface and the one a build is most likely to collapse:
//
//   THE BANNER  — the STATE. Durable, at the top of the window, present whether
//                 or not anybody reads a word, and still there when somebody
//                 comes back. It says WHAT is happening.
//   THE TURN    — the REASON. The verdict's own `message`, in the planner's
//                 voice, naming their repository — rendered the way every other
//                 outcome's message is rendered. It says WHY they are waiting.
//
// A banner alone leaves a person guessing why they are waiting; a turn alone
// puts a durable state into a transcript that scrolls away. They answer
// different questions, and the failure mode of merging them is silent: the build
// that keeps only the banner looks finished. `design/ai-chat/design-notes.md`
// § *AMENDMENT (2026-09-07 · MOTIR-4825)* carries the table.
//
// ⚠️ NOT A PROGRESS BAR — panel 1's rule, and the same reason rather than a new
// one: `motir-core` is told an index has SUCCEEDED and is never told how far
// along it is, so a track and a fill would be a claim nothing can support.
// Indexing is the wait that most FEELS like it has a percentage, which is
// exactly why the constraint is restated here. There is no `role="progressbar"`
// in this file and there must not be one.
//
// ⚠️ THE SURFACE RENDERS THE VERDICT; IT DOES NOT SECOND-GUESS IT. Nothing here
// compares an index state to decide what to draw — the phase it is given comes
// from the poll's own fact and the verdict's own outcome (MOTIR-4828).

/** Which of the wait's three live shapes is on screen. */
export type IndexingWaitPhase =
  /** Enqueued and not yet observed running — *just started*. */
  | 'queued'
  /** Under way. */
  | 'running'
  /**
   * The index did not finish. One of the three ways this state is reached at
   * all, so it is drawn rather than left to whoever passes through.
   */
  | 'failed';

export interface PlanningIndexingWaitProps {
  /** The repositories being waited on, named — never a bare "your repository". */
  repositories: string[];
  /** The planner's own turn. Rendered verbatim; this component writes no copy for it. */
  message: string;
  phase: IndexingWaitPhase;
  /** Re-enqueue. Present only on `failed`. */
  onRetry?: () => void;
  /**
   * Ask the routing run again WITHOUT a readable repository — a case the verdict
   * already knows, so it becomes an ordinary onboarding route rather than a
   * bespoke failure path. Present only on `failed`.
   */
  onPlanAnyway?: () => void;
}

export function PlanningIndexingWait({
  repositories,
  message,
  phase,
  onRetry,
  onPlanAnyway,
}: PlanningIndexingWaitProps) {
  const t = useTranslations('planningWorkspace.indexing');
  const failed = phase === 'failed';
  // ⚠️ THE TITLE DOES NOT CHANGE BETWEEN `queued` AND `running`, and the asset
  // says why: the person is waiting for the same thing either way, and a title
  // that changes under them reads as a second event. The SUB-LINE and the CHIP
  // are where the distinction earns its keep — they are what tells somebody who
  // came back whether anything has moved.
  const named = repositories.join(', ');

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-4 p-(--spacing-card-padding)"
      aria-live="polite"
    >
      {/* ── THE BANNER — the STATE ─────────────────────────────────────────── */}
      <div
        role="status"
        data-testid="planning-indexing-banner"
        data-phase={phase}
        className={cn(
          'flex w-full max-w-[32.5rem] items-center gap-3 rounded-(--radius-card)',
          'px-(--spacing-control-x) py-(--spacing-control-y)',
          failed
            ? 'border border-(--el-danger-on-surface) bg-(--el-danger-surface)'
            : 'border border-(--el-border-soft) bg-(--el-tint-sky)',
        )}
      >
        <span className="flex-none" aria-hidden>
          {failed ? (
            // ⚠️ THE HUE IS IN THE GLYPH AND THE BORDER, AND THE LABEL STAYS ON
            // `--el-text` — the composition `CLAUDE.md` prefers for a big danger
            // label, since graphics need only 3:1. `--el-danger-text` is NOT
            // legal here: it is the ink FOR a `--el-danger` FILL and measures
            // 1.00–1.04:1 on a light page in all ten palettes.
            <TriangleAlert className="size-4.5 text-(--el-danger-on-surface)" />
          ) : (
            <span className="inline-flex gap-1">
              <i className="size-1.5 rounded-(--radius-badge) bg-(--el-text-secondary)" />
              <i className="size-1.5 rounded-(--radius-badge) bg-(--el-text-secondary) opacity-60" />
              <i className="size-1.5 rounded-(--radius-badge) bg-(--el-text-secondary) opacity-30" />
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'truncate text-sm font-semibold',
              failed ? 'text-(--el-text)' : 'text-(--el-text-strong)',
            )}
          >
            {failed ? t('failedTitle', { repos: named }) : t('title', { repos: named })}
          </span>
          {/* `--el-text-secondary`, which clears AA on every surface in both
              themes — `--el-text-muted`'s 4.54:1 was measured on the white page
              and this is a tint. */}
          <span className="text-xs leading-snug text-(--el-text-secondary)">
            {failed ? t('failedSub') : phase === 'queued' ? t('subQueued') : t('subRunning')}
          </span>
        </span>
        {failed ? (
          // ⚠️ TWO WAYS ONWARD, because a card whose only control is Close is the
          // one thing the asset's *must not look like* panel forbids.
          <span className="flex flex-none gap-2">
            <Button size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onPlanAnyway}>
              {t('planAnyway')}
            </Button>
          </span>
        ) : (
          <span className="flex-none rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
            {phase === 'queued' ? t('chipQueued') : t('chipRunning')}
          </span>
        )}
      </div>

      {/* ── THE TURN — the REASON, in the planner's own words ───────────────── */}
      <div
        data-testid="planning-indexing-turn"
        className={cn(
          'w-full max-w-[32.5rem] rounded-(--radius-card) border border-(--el-border)',
          'bg-(--el-card) p-(--spacing-card-padding) shadow-(--shadow-subtle)',
        )}
      >
        <p className="text-xs font-semibold tracking-wide text-(--el-text-eyebrow) uppercase">
          {t('eyebrow')}
        </p>
        {/* ⚠️ VERBATIM. This is the verdict's `message` — the planner speaking
            about a project it has just looked at — and nothing here rewrites,
            truncates or wraps it in copy of Motir's own. */}
        <p className="mt-2 text-sm leading-relaxed text-(--el-text)">{message}</p>
        {/* ⚠️ THE EXIT, drawn because the person opened this window to plan. The
            work continues without them, and they are told so rather than left to
            guess whether closing cancels it. */}
        {!failed ? (
          <p
            className="mt-3 text-xs text-(--el-text-secondary)"
            data-testid="planning-indexing-exit"
          >
            {t('exit')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
