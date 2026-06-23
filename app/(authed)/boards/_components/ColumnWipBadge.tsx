'use client';

import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';

// ColumnWipBadge (Subtask 3.3.6) — the per-column WIP count chip, per
// `design/boards/swimlanes-wip.mock.html` (panel 6) + the "Swimlanes + WIP"
// design notes. Renders `n/limit` when the column carries a WIP limit:
//   - under  (n < limit) and AT (n == limit) → QUIET (the neutral count chip,
//     no warning — at-limit is intentionally not warned).
//   - over   (n > limit, STRICTLY greater)   → the SOFT over-limit treatment:
//     a peach tint + a warning alert icon + the `n/limit` label (the hue is
//     PAIRED with the icon + text so it is never colour-alone, finding #35),
//     announced via `role="status"`.
// No limit set → renders nothing (the caller's plain count badge stands alone).
//
// SOFT is the load-bearing semantic: this is a presentational warning ONLY —
// it does NOT gate drops. The 3.2.4 move contract is untouched (a drop into an
// at/over-limit column still succeeds; the warning just persists). Colour via
// `--el-*`, shape via element tokens.

export function ColumnWipBadge({
  columnId,
  totalCount,
  wipLimit,
}: {
  columnId: string;
  totalCount: number;
  wipLimit: number | null;
}) {
  const t = useTranslations('boards');
  if (wipLimit == null) return null;

  // Strictly greater — `n == limit` is at-limit and is NOT warned.
  const isOver = totalCount > wipLimit;
  const label = `${totalCount}/${wipLimit}`;

  if (isOver) {
    return (
      <span
        role="status"
        aria-label={t('wipOverLimitAria', { count: totalCount, limit: wipLimit })}
        data-testid={`board-wip-${columnId}`}
        data-over="true"
        className="inline-flex h-5 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-peach) px-(--spacing-chip-x) font-mono text-[11px] font-semibold text-(--el-text-strong)"
      >
        <TriangleAlert className="h-3 w-3 shrink-0 text-(--el-warning)" aria-hidden />
        {label}
      </span>
    );
  }

  return (
    <span
      title={t('wipCountTitle', { count: totalCount, limit: wipLimit })}
      data-testid={`board-wip-${columnId}`}
      className="inline-flex h-5 items-center rounded-(--radius-badge) bg-(--el-count-bg) px-(--spacing-chip-x) font-mono text-[11px] font-semibold text-(--el-count-text)"
    >
      {label}
    </span>
  );
}
