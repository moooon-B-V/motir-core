'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Hash, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { deckForConfig, formatStoryPoints } from '@/lib/estimation/scales';
import type { PointScaleDto } from '@/lib/dto/estimation';
import { useEstimationConfig, type EstimationConfigContextValue } from './EstimationConfigProvider';

// EstimateBadge (Story 4.3 · Subtask 4.3.4) — the ONE inline estimate chip +
// click-to-edit picker, reused on every surface that renders an issue (backlog
// row · board/scrum card · issue-detail rail · list Points column). Drawn per
// `design/estimation/estimation.mock.html` panels 0–2 + 5 (the `.est` / `.est--btn`
// chip + the Popover picker). It renders the project's configured estimation
// STATISTIC (story points by default; the formatted time estimate when Time;
// nothing per-issue when Issue count — that's a derived aggregate) read from
// `useEstimationConfig`, so it's one component parameterised by the statistic,
// not three.
//
// EDITING is story-points-only (the scale deck is a story-point concept — design
// notes): the badge is a click-to-edit `<button>` opening the picker ONLY when
// the statistic is Story Points AND the actor `canEdit`. For Time / Issue count,
// or a viewer, it degrades to the static read-only chip with NO layout shift
// (design panel 5). The write goes through `PATCH /api/work-items/[id]/estimate`
// (4.3.3) — OPTIMISTICALLY with snap-back on error — never the 2.3.6 time path.
//
// The component is split so the read-only path depends ONLY on intl + the config
// context (it renders anywhere — board DragOverlay clone, a viewer, a card-only
// test), while the editable path adds the router/toast/transition the write
// needs. It is NEVER nested inside another button: on the backlog/board row it
// sits in the flex container alongside the avatar / ⋯ menu, a sibling.

const DECK_LABEL_KEY: Record<PointScaleDto, 'deckFibonacci' | 'deckLinear' | 'deckCustom'> = {
  fibonacci: 'deckFibonacci',
  linear: 'deckLinear',
  custom: 'deckCustom',
};

const BASE_CLASS =
  'inline-flex items-center gap-1 font-mono text-xs font-semibold whitespace-nowrap';

function valueClassFor(valueText: string | null): string {
  return valueText == null ? 'text-(--el-text-faint)' : 'text-(--el-text-secondary)';
}

function Glyph() {
  return <Hash className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />;
}

export interface EstimateBadgeProps {
  /** The work-item id — the `PATCH /api/work-items/[id]/estimate` target. */
  itemId: string;
  /** The issue's current story-point estimate (null = unestimated). */
  storyPoints: number | null;
  /** The issue's TIME estimate in minutes — shown when the statistic is Time. */
  estimateMinutes?: number | null;
  /**
   * Force the static read-only chip even when the actor `canEdit`. Used by the
   * board card, whose whole surface is a drag/click `<button>` — an interactive
   * picker button can't nest inside it (invalid HTML; the design wants the badge
   * as a flex-sibling). The board still SHOWS the configured statistic; inline
   * board editing awaits the card → stretched-overlay refactor (PRODECT_FINDINGS).
   */
  readOnly?: boolean;
  /**
   * Always render the STORY-POINT value (+ picker), ignoring the project's
   * display statistic. The issue-detail rail uses this for its dedicated "Story
   * points" field — distinct from the TIME "Estimate" field, the two coexist
   * permanently (the statistic only decides which the backlog/board/roll-ups
   * SUM). The deck still comes from the project config.
   */
  forceStoryPoints?: boolean;
  /** Extra classes for the surface's slot fit (alignment / width). */
  className?: string;
}

export function EstimateBadge({
  itemId,
  storyPoints,
  estimateMinutes = null,
  readOnly = false,
  forceStoryPoints = false,
  className,
}: EstimateBadgeProps) {
  const t = useTranslations('estimation');
  const config = useEstimationConfig();
  const statistic = config.estimationStatistic;

  // Issue count is a derived aggregate, not a per-issue value — nothing renders
  // on the issue chip (the count lives on the column/roll-up, not here). The
  // detail rail's dedicated story-points field (`forceStoryPoints`) is exempt.
  if (!forceStoryPoints && statistic === 'issue_count') return null;

  const isStoryPoints = forceStoryPoints || statistic === 'story_points';

  // Editing is story-points-only and gated on canEdit (design notes; 6.4.6).
  if (isStoryPoints && config.canEdit && !readOnly) {
    return (
      <EstimateBadgeEditor
        itemId={itemId}
        storyPoints={storyPoints}
        config={config}
        className={className}
      />
    );
  }

  // Read-only chip — story points, the formatted time estimate, or the muted
  // em-dash. Depends on nothing beyond intl + config, so it renders anywhere.
  const valueText = isStoryPoints
    ? storyPoints != null
      ? formatStoryPoints(storyPoints)
      : null
    : estimateMinutes != null
      ? formatDurationMinutes(estimateMinutes)
      : null;
  const aria = valueText != null ? t('valueAria', { value: valueText }) : t('emptyAria');
  return (
    <span className={cn(BASE_CLASS, valueClassFor(valueText), className)} aria-label={aria}>
      <Glyph />
      {valueText ?? '—'}
    </span>
  );
}

// The editable story-points badge — owns the optimistic write + the picker.
function EstimateBadgeEditor({
  itemId,
  storyPoints,
  config,
  className,
}: {
  itemId: string;
  storyPoints: number | null;
  config: EstimationConfigContextValue;
  className?: string;
}) {
  const t = useTranslations('estimation');
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  // Optimistic override: `undefined` = show the server value; `number | null` =
  // the value we committed (kept after a successful write — the response is the
  // confirmation), snapped back to `undefined` ONLY on error so the server
  // value re-shows.
  const [override, setOverride] = useState<number | null | undefined>(undefined);
  const [draft, setDraft] = useState('');

  const points = override !== undefined ? override : storyPoints;
  const valueText = points != null ? formatStoryPoints(points) : null;

  function openPicker() {
    setDraft(points != null ? formatStoryPoints(points) : '');
    setOpen(true);
  }

  function commit(next: number | null) {
    setOpen(false);
    if (next === (points ?? null)) return;
    setOverride(next);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/work-items/${itemId}/estimate`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ points: next }),
        });
        if (!res.ok) {
          setOverride(undefined);
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          toast({ variant: 'error', title: body?.error ?? t('saveError') });
          return;
        }
        // Success: the 200 IS the confirmation, so KEEP the optimistic value
        // (the override stays = `next`). Do NOT clear it back to the server
        // prop + router.refresh() — the refresh re-reads the RSC payload before
        // the write has propagated and momentarily reverts the badge to its
        // pre-edit value (the inline-edit revert bug: a field-update success
        // path must never whole-tree-refresh). Sibling surfaces pick up the new
        // estimate on their next load / on reload.
      } catch {
        setOverride(undefined);
        toast({ variant: 'error', title: t('saveError') });
      }
    });
  }

  function commitDraft() {
    const trimmed = draft.trim();
    if (trimmed === '') {
      commit(null);
      return;
    }
    const value = Number(trimmed);
    // Reject silently (keep the picker open so the user can correct it).
    if (!Number.isFinite(value) || value < 0) return;
    commit(value);
  }

  const deck = deckForConfig(config);
  const aria = valueText != null ? t('editAria', { value: valueText }) : t('addAria');

  return (
    <Popover open={open} onOpenChange={(o) => (o ? openPicker() : setOpen(false))}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={aria}
          disabled={isPending}
          className={cn(
            BASE_CLASS,
            valueClassFor(valueText),
            'cursor-pointer rounded-(--radius-badge) border border-transparent px-(--spacing-chip-x) py-(--spacing-chip-y)',
            'hover:border-(--el-border) hover:bg-(--el-surface) hover:text-(--el-text-strong)',
            'focus-visible:border-(--el-border) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
            'data-[state=open]:border-(--el-border) data-[state=open]:bg-(--el-surface) data-[state=open]:text-(--el-text-strong)',
            className,
          )}
        >
          <Glyph />
          {valueText ?? '—'}
        </button>
      </Popover.Trigger>
      <Popover.Content
        width={244}
        align="start"
        role="dialog"
        aria-label={t('pickerLabel')}
        className="p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-bold tracking-wider text-(--el-text-faint) uppercase">
            {t('header')}
          </span>
          <span className="text-xs font-semibold text-(--el-text-muted)">
            {t(DECK_LABEL_KEY[config.pointScale])}
          </span>
        </div>

        {deck.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {deck.map((value) => {
              const pressed = points != null && Number(points) === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={pressed}
                  aria-label={t('chipAria', { value: formatStoryPoints(value) })}
                  onClick={() => commit(value)}
                  className={cn(
                    'inline-flex h-[30px] min-w-[32px] items-center justify-center px-2 font-mono text-[13px] font-semibold',
                    'rounded-(--radius-control) border',
                    pressed
                      ? 'border-(--el-accent) bg-(--el-accent) text-(--el-accent-text)'
                      : 'border-(--el-border) bg-(--el-surface) text-(--el-text) hover:border-(--el-border-strong) hover:bg-(--el-page-bg)',
                  )}
                >
                  {formatStoryPoints(value)}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="mt-3 flex items-center gap-2">
          <input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            autoFocus
            aria-label={t('numericLabel')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
              }
            }}
            className="h-(--height-control) flex-1 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) font-mono text-[13px] text-(--el-text) outline-none focus-visible:border-(--el-accent) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <kbd className="rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-1.5 py-0.5 font-mono text-[10.5px] text-(--el-text-faint)">
            ↵
          </kbd>
        </div>

        <div className="mt-2.5 flex items-center justify-between border-t border-(--el-border) pt-2.5">
          <button
            type="button"
            onClick={() => commit(null)}
            className="inline-flex h-7 items-center gap-1.5 rounded-(--radius-btn) px-2.5 font-sans text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text-strong)"
          >
            <X className="h-3 w-3" aria-hidden />
            {t('clear')}
          </button>
          <span className="font-mono text-[10.5px] text-(--el-text-faint)">{t('cancelHint')}</span>
        </div>
      </Popover.Content>
    </Popover>
  );
}
