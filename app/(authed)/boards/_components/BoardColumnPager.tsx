'use client';

import { useEffect, useState, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { BoardColumnDto } from '@/lib/dto/boards';

// Mobile board responsiveness (Subtask 3.2.6 · design `board.mock.html` panel
// 7). On narrow viewports the board is a single-column horizontal scroll with a
// pager; these two exports drive that.

/**
 * Tracks which column is centred in the horizontal scroll region so the pager
 * can read "{name} · {i} of {n}". Recomputed on scroll (rAF-throttled) by
 * picking the `[data-board-column]` element whose horizontal midpoint is
 * nearest the viewport centre. Returns 0 before any scroll; the result is
 * clamped to the current column range so a board that shrinks (a re-fetch with
 * fewer columns) never points past the end.
 */
export function useActiveColumnIndex(
  scrollRef: RefObject<HTMLElement | null>,
  count: number,
): number {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const recompute = () => {
      raf = 0;
      const cols = el.querySelectorAll<HTMLElement>('[data-board-column]');
      if (cols.length === 0) return;
      const centre = el.scrollLeft + el.clientWidth / 2;
      let best = 0;
      let bestDist = Infinity;
      cols.forEach((col, i) => {
        const mid = col.offsetLeft + col.offsetWidth / 2;
        const dist = Math.abs(mid - centre);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      setActive(best);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(recompute);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    recompute();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, count]);
  return Math.min(active, Math.max(0, count - 1));
}

/**
 * The mobile column pager — a decorative position indicator shown only below
 * `sm` (where the board reads as a single-column scroll). Dots (one per column)
 * + "{name} · {i} of {n}". `aria-hidden` because the columns are landmarked
 * `<section>`s a screen reader navigates directly (the mock marks the pager
 * aria-hidden too) — it's a sighted affordance, not an assistive control. The
 * dots are genuinely circular, so `rounded-full` is correct (not a shaped
 * surface). Hidden when there is at most one column (nothing to page through).
 */
export function BoardColumnPager({
  columns,
  activeIndex,
}: {
  columns: BoardColumnDto[];
  activeIndex: number;
}) {
  const t = useTranslations('boards');
  if (columns.length <= 1) return null;
  const safeIndex = Math.min(Math.max(activeIndex, 0), columns.length - 1);
  const active = columns[safeIndex];
  if (!active) return null;
  return (
    <div
      aria-hidden
      className="flex items-center justify-center gap-1.5 text-xs text-(--el-text-muted) sm:hidden"
      data-testid="board-pager"
    >
      {columns.map((column, i) => (
        <span
          key={column.id}
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            i === safeIndex ? 'bg-(--el-accent)' : 'bg-(--el-border-strong)',
          )}
        />
      ))}
      <span className="ml-1.5">
        {t('pagerPosition', {
          name: active.name,
          index: safeIndex + 1,
          count: columns.length,
        })}
      </span>
    </div>
  );
}
