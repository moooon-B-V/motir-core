'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Filter } from 'lucide-react';
import { Button } from '@/components/ui/Button';

// The over-cap warning banner (Subtask 3.8.4 · design `board-scale.mock.html`
// panel 2). Mirrors Jira's "maximum number of viewable issues exceeded — refine
// your filter" warning: the board loads its issue set bounded by `BOARD_ISSUE_CAP`
// (Subtask 3.8.2), and when the board's total exceeds that cap the projection
// signals `truncated: true`, so this banner renders ABOVE the board (mounted in
// BoardContainer, so it shows for BOTH the flat and swimlane layouts) naming the
// cap. The caller renders it ONLY when `truncated` is true (an under-cap board
// shows no banner). The board is STILL bounded either way — the cap IS the bound
// (finding #57); this only distinguishes "everything fit" from "the cap was hit".
//
// Treatment: REUSES the 3.2.6 `UnmappedStatusesTray` yellow-tray treatment
// verbatim — `--el-tint-yellow` background carrying the hue, an `AlertTriangle`
// in `--el-warning`, `--el-text-strong` copy. Paired hue + icon + text so the
// signal is never colour-alone (finding #35 AA — the hue is in the BACKGROUND,
// never a tinted page surface). Announced to assistive tech via `role="status"`
// (it appears conditionally after a fetch, so it's a live region).
//
// Affordance (Story 6.15.3): the control that shrinks an over-cap board is the
// board filter. The "Refine filter" CTA now OPENS the board's quick `[Filter]`
// popover (`onRefine`, wired by BoardContainer through BoardFilterUiContext) —
// it used to point at the dead disabled `[Filter]` seam. When `onRefine` is
// absent (an isolated render with no board filter UI mounted) the CTA falls back
// to the documented disabled seam, so it never reads as a broken control. The
// cap / `truncated` are computed over the FILTERED set (6.15.2), so applying a
// filter that brings the board under the cap dismisses this banner entirely.

export function OverCapBanner({ cap, onRefine }: { cap: number; onRefine?: () => void }) {
  const t = useTranslations('boards');
  return (
    <aside
      role="status"
      aria-label={t('overCapLabel')}
      className="flex flex-wrap items-center gap-2.5 rounded-(--radius-card) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y)"
      data-testid="board-overcap-banner"
    >
      <AlertTriangle className="h-[18px] w-[18px] shrink-0 text-(--el-warning)" aria-hidden />
      <span className="min-w-[280px] flex-1 text-sm text-(--el-text-strong)">
        {t('overCapText', { cap })}
      </span>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<Filter className="h-4 w-4" />}
        disabled={!onRefine}
        onClick={onRefine}
        title={onRefine ? undefined : t('overCapSeamTitle')}
        data-testid="board-overcap-filter"
      >
        {t('overCapRefine')}
      </Button>
    </aside>
  );
}
