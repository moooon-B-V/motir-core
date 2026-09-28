'use client';

import { useTranslations } from 'next-intl';
import { Wrench } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

// THE TO FIX TAG (Story MOTIR-6589 · MOTIR-6610) — one component, TWO forms,
// mirroring `CiStateBadge` and `DecisionWaitingMarker`.
//
// Design: `design/work-items/to-fix--tag-and-banner.mock.html` (panels 1–4 and
// 8–10), specified in `design/work-items/design-notes.md` § *The TO FIX tag and
// banner (MOTIR-6608)*.
//
// ⚠️ THE TAG IS THE ONE SOLID FILL ON THESE SURFACES, and that is the design's
// whole answer to "must not be confused with the CI badge": the CI badge, Blocked,
// the decision marker and every status pill are pastel tints or bare glyphs. The
// fill is `--el-danger` and the ink `--el-danger-text` — the ONE legal use of that
// ink is on an element that also carries `bg-(--el-danger)` (CLAUDE.md,
// MOTIR-3663), which both forms below do.
//
// ⚠️ ALL FOUR REASONS DRAW THE SAME TAG. The reason is in the accessible name and
// the `title`, never in colour or shape; the detail (the check, the base, the
// reviewer) is the item-page banner's job (MOTIR-6611).

/**
 * WHAT TO DRAW for a work item's stored `fixReason`, given its status CATEGORY —
 * the CI badge's own done-category rule (`ciBadgeState`), restated for the tag.
 *
 * - no reason ⇒ nothing;
 * - a `done`-category status ⇒ nothing, whatever the column says. The recompute
 *   clears the reason when a card reaches done, so this only matters for a stale
 *   value — and a done card telling a reader to repair it is wrong either way.
 *
 * Pure, and shared by the board card, the List / Tree row and the quick view, so
 * the three cannot drift into three readings of one column.
 */
export function toFixTagState(
  fixReason: WorkItemFixReasonDto | null | undefined,
  statusCategory: StatusCategoryDto | null | undefined,
): WorkItemFixReasonDto | null {
  if (statusCategory === 'done') return null;
  return fixReason ?? null;
}

/** The DOM id a board card's `aria-describedby` points at (the card is one `<button>`). */
export function toFixTagId(cardId: string): string {
  return `to-fix-${cardId}`;
}

interface ToFixTagProps {
  /** The work item's stored `WorkItem.fixReason`. */
  fixReason: WorkItemFixReasonDto | null | undefined;
  /** Its status CATEGORY — a `done` item draws nothing (see `toFixTagState`). */
  statusCategory: StatusCategoryDto | null | undefined;
  /**
   * `label` on a board card and the quick-view header; `glyph` in a List / Tree
   * STATUS cell, where the track holds a pill and at most two 18px glyphs.
   */
  form?: 'label' | 'glyph';
  /** Label form: the id a board card's `aria-describedby` references. */
  id?: string;
}

export function ToFixTag({ fixReason, statusCategory, form = 'label', id }: ToFixTagProps) {
  const t = useTranslations();
  const reason = toFixTagState(fixReason, statusCategory);
  if (!reason) return null;

  const name = t(`toFix.tagName.${reason}`);

  if (form === 'glyph') {
    // ⚠️ `shrink-0` is load-bearing, as on the CI and decision glyphs: the status
    // cell is a flex row, and a squeezed tag overlaps the status pill instead.
    return (
      <span
        className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-danger) text-(--el-danger-text)"
        role="img"
        aria-label={name}
        title={name}
        data-to-fix={reason}
      >
        <Wrench className="h-3 w-3 shrink-0" aria-hidden />
      </span>
    );
  }

  // The visible words are *To fix*; an `sr-only` tail finishes the sentence, so the
  // label read through a board card's `aria-describedby` names the reason too.
  // `whitespace-nowrap` + `shrink-0`: two words never break, the pill row wraps.
  const words = t('workbench.tabs.toFix');
  const tail = name.startsWith(words) ? name.slice(words.length) : ` · ${name}`;
  return (
    <Pill
      id={id}
      className="shrink-0 whitespace-nowrap border-transparent bg-(--el-danger) text-(--el-danger-text)"
      title={name}
      data-to-fix={reason}
    >
      <Wrench className="h-3 w-3 shrink-0" aria-hidden />
      {words}
      <span className="sr-only">{tail}</span>
    </Pill>
  );
}
