'use client';

import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { CI_STATE_META, ciBadgeState } from './ciStateMeta';

// THE CI BADGE (Story MOTIR-5469 · MOTIR-5474) — one component, TWO forms.
//
// Design: `design/boards/board-card--ci-badge.mock.html` (panels 1–5) and
// `design/work-items/list--ci-badge.mock.html` (panels 6–9), specified in
// `design/work-items/design-notes.md` § *The CI badge (MOTIR-5471)*.
//
// ⚠️ THE TWO FORMS ARE A MEASUREMENT, NOT A PREFERENCE, and the notes carry the
// arithmetic. A `/items` row is a CSS grid whose title track floors at `10rem` =
// 160px, and at the row's own 1204px minimum that is all it gets. A LABELLED pill
// there does not fit: drawn that way it overlapped the item key, because the title
// cell is `min-w-0` with no `overflow-hidden`. A new *Checks* column is worse —
// 1340px, clipping at 1280 AND 1200 on a surface that already clips (MOTIR-1307).
//
// So a ROW carries the GLYPH and a BOARD CARD carries the LABEL. State is still
// never colour alone: the two glyphs differ in SHAPE (`circle-x` vs
// `circle-ellipsis`) and the glyph form carries the same shipped string as its
// accessible name — the bargain every other icon-only affordance in that row
// already makes.

interface CiStateBadgeProps {
  /** The work item's stored `WorkItem.ciState`. */
  ciState: string | null | undefined;
  /** Its status CATEGORY — a `done` item draws nothing (see `ciBadgeState`). */
  statusCategory: StatusCategoryDto | null | undefined;
  /**
   * `label` on a board card, which has a wrapping row and room; `glyph` on a
   * list / tree / Workbench row, where the title track cannot hold a pill.
   */
  form?: 'label' | 'glyph';
}

export function CiStateBadge({ ciState, statusCategory, form = 'label' }: CiStateBadgeProps) {
  const t = useTranslations('github');
  const state = ciBadgeState(ciState, statusCategory);
  if (!state) return null;

  const meta = CI_STATE_META[state];
  const label = t(`development.ciState.${state}`);

  if (form === 'glyph') {
    // ⚠️ `shrink-0` is load-bearing: the title cell is `flex min-w-0`, so without
    // it the badge is squeezed and OVERLAPS the item key instead of the title
    // truncating. Ink is `--el-danger-on-surface` for failing — NEVER
    // `--el-danger-text`, which is the ink for a danger FILL and renders
    // white-on-white on a page (MOTIR-3663) — and `--el-text-secondary` for
    // running; both clear AA on every surface a row paints in.
    return (
      <span
        className={`inline-flex shrink-0 items-center ${
          state === 'failing' ? 'text-(--el-danger-on-surface)' : 'text-(--el-text-secondary)'
        }`}
        title={label}
        role="img"
        aria-label={label}
        data-ci-state={state}
      >
        <meta.icon className="h-3.5 w-3.5" />
      </span>
    );
  }

  // ⚠️ `whitespace-nowrap` is REQUIRED and `Pill` does not set it: at the board's
  // 288px column the two-word label breaks INSIDE the chip, with the glyph
  // orphaned beside the first line. The card's pill row wraps instead (see
  // `BoardCard.tsx`), which is what keeps the pairing legible.
  return (
    <Pill {...meta.pill} className="shrink-0 whitespace-nowrap" data-ci-state={state}>
      <meta.icon className="h-3 w-3" aria-hidden />
      {label}
    </Pill>
  );
}
