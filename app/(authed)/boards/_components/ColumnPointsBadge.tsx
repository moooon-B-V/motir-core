'use client';

import { useTranslations } from 'next-intl';

// ColumnPointsBadge (Subtask 4.5.3) — the per-column "sprint health" point total
// (`design/boards/scrum.mock.html` panel 4, the `.col-pts` pill). Rendered in the
// REUSED 3.2/3.3 column header right AFTER the card-count badge (both describe the
// column's contents, so they sit together on the left; the 3.3 WIP slot stays
// right-aligned by the `[⋯]` actions). Muted, mono, "N pts".
//
// The value is `SprintSummaryDto.columnPoints[columnId]` (Story 4.5.2) — a bounded
// SUM aggregate, NEVER a client sum of loaded cards (finding #57). The pill is
// CONDITIONAL: it renders only when the board is a scrum board with an active,
// ESTIMATED sprint (the container passes `points = null` for a kanban board / an
// unestimated sprint, so the same column header serves both board kinds without a
// scrum-specific column component). Colour via `--el-*`, shape via element tokens.
export function ColumnPointsBadge({
  columnId,
  points,
}: {
  columnId: string;
  /** The column's sprint point total; `null`/`undefined` → no pill (kanban board,
   *  unestimated sprint, or a column absent from the aggregate). */
  points: number | null | undefined;
}) {
  const t = useTranslations('boards');
  if (points == null) return null;
  return (
    <span
      className="inline-flex h-5 items-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) font-mono text-[11.5px] font-semibold text-(--el-text-secondary)"
      title={t('sprintColumnPointsTitle', { points })}
      aria-label={t('sprintColumnPointsTitle', { points })}
      data-testid={`board-points-${columnId}`}
    >
      {t('sprintColumnPoints', { points })}
    </span>
  );
}
