'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, Ban, History } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';

// THE OBSOLESCENCE BADGE (Story MOTIR-6575 · MOTIR-6674) — one component, built to
// `design/work-items/core-fields--obsolescence.mock.html` panel 2 and reused by the
// list row and the board card (MOTIR-6677), so the mark reads the same everywhere.
//
// ⚠️ TWO FILLS, NEITHER SPENT ELSEWHERE IN THE EYEBROW. Outdated is the Pill's
// `severity="warning"` (peach) and Deprecated its `severity="danger"` (rose), both
// with `--el-text-strong` ink — the two tints the decision-waiting marker (yellow,
// `tone="awaiting"`) and the Archived chip (neutral) do not use, so the four tags
// that can share the header never share a fill. The glyph carries the difference
// too (`History` vs `Ban`), and is decorative: the word carries the meaning.

const GLYPH: Record<WorkItemObsolescenceDto, typeof History> = {
  outdated: History,
  deprecated: Ban,
};

const SEVERITY: Record<WorkItemObsolescenceDto, 'warning' | 'danger'> = {
  outdated: 'warning',
  deprecated: 'danger',
};

/** The GLYPH form's ink — the CI badge's glyph rule: `--el-danger-on-surface` for
 *  the retired state (never `--el-danger-text`), `--el-text-secondary` otherwise;
 *  both clear AA on every surface a row paints in. */
const GLYPH_INK: Record<WorkItemObsolescenceDto, string> = {
  outdated: 'text-(--el-text-secondary)',
  deprecated: 'text-(--el-danger-on-surface)',
};

export function ObsolescenceBadge({
  mark,
  className,
  trailing,
  form = 'pill',
}: {
  mark: WorkItemObsolescenceDto;
  className?: string;
  /** A trailing glyph after the word — the header link's `ArrowDown`. The badge
   *  itself stays static, the decision marker's rule. */
  trailing?: ReactNode;
  /** `glyph` — the `/items` List and Tree status cell's form (MOTIR-6677): the
   *  glyph alone, the word as its accessible name and title. */
  form?: 'pill' | 'glyph';
}) {
  const t = useTranslations('workItems.obsolescence');
  const Glyph = GLYPH[mark];
  if (form === 'glyph') {
    const label = t(`value.${mark}`);
    // ⚠️ `shrink-0` is load-bearing: the status cell is `flex min-w-0`, and a
    // squeezed glyph would overlap the status pill instead of sitting beside it.
    return (
      <span
        className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center ${GLYPH_INK[mark]}`}
        role="img"
        aria-label={label}
        title={label}
        data-obsolescence={mark}
      >
        <Glyph className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  return (
    <Pill
      severity={SEVERITY[mark]}
      className={
        className ? `min-w-0 max-w-full shrink-0 ${className}` : 'min-w-0 max-w-full shrink-0'
      }
      data-obsolescence={mark}
    >
      <Glyph className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{t(`value.${mark}`)}</span>
      {trailing}
    </Pill>
  );
}

/** The DOM id of the Obsolescence field — the header badge's destination. */
export const OBSOLESCENCE_FIELD_ANCHOR = 'obsolescence-field';

/**
 * Scroll to the Obsolescence field `targetId` and focus it — the one gesture both
 * doors to the field make (the header badge, and the held status box's *Clear the
 * mark*). Returns `false` when this page draws no such field, so a caller can fall
 * back to the item page. Moves focus; changes nothing.
 */
export function goToObsolescenceField(targetId: string = OBSOLESCENCE_FIELD_ANCHOR): boolean {
  const field = document.getElementById(targetId);
  if (!field) return false;
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  field.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  field.focus({ preventScroll: true });
  return true;
}

/**
 * The badge as a POINTER (panel 2): pressing it scrolls to the Obsolescence field
 * and focuses it — the decision-waiting header link's rule, with its `ArrowDown`.
 * It never edits and never opens a menu.
 */
export function ObsolescenceHeaderLink({
  mark,
  targetId = OBSOLESCENCE_FIELD_ANCHOR,
}: {
  mark: WorkItemObsolescenceDto;
  /** The field to land on — the item page's by default; the peek passes its own. */
  targetId?: string;
}) {
  const t = useTranslations('workItems.obsolescence');
  const onPress = () => {
    goToObsolescenceField(targetId);
  };
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={`${t(`value.${mark}`)} — ${t('badge.jump')}`}
      className="inline-flex max-w-full min-w-0 shrink-0 rounded-(--radius-badge) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      data-obsolescence-link={mark}
    >
      <ObsolescenceBadge
        mark={mark}
        className="border border-transparent hover:border-(--el-border-strong)"
        trailing={<ArrowDown className="h-3 w-3 shrink-0" aria-hidden />}
      />
    </button>
  );
}
