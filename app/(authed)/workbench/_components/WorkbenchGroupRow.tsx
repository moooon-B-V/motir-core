'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

// The pieces a GROUPED work tab adds to the shipped Workbench row (Story MOTIR-8012 ·
// MOTIR-8016; `design/workbench/design-notes.md` § 36). To do, In progress and Recently
// finished draw their items under the runnable container they belong to; the row itself
// stays `WorkbenchList`'s, and these are the three things it gains:
//
// - the LEAD SLOT — `/ready`'s 16px chevron button on a group row, an empty 16px slot on
//   every other row of the tab, so all kind icons sit on one edge (§ 36.3);
// - the COUNT — the strip's count chip, the number of the group's members ON THIS TAB;
// - the CONTEXT MARKER — the Your-role cell of a head that is not on the tab (§ 36.2).
//
// Composed, not re-invented: the chevron's classes are `ReadyContainerRow`'s and the
// chip's are `GroupBand`'s. No run control — the Workbench offers none (§ 36, *What this
// asset does NOT decide*).

/** The width every row on a grouped tab reserves before its kind icon (§ 36.3). */
const SLOT = 'flex h-4 w-4 shrink-0 items-center justify-center';

/** The chevron that opens and closes a group — `/ready`'s, named for its container. */
export function GroupChevron({
  itemKey,
  open,
  controls,
  onToggle,
}: {
  itemKey: string;
  open: boolean;
  /** The id of the rowgroup the members render into. */
  controls: string;
  onToggle: () => void;
}) {
  const t = useTranslations('workbench.group');
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? t('collapse', { key: itemKey }) : t('expand', { key: itemKey })}
      data-testid={`workbench-group-toggle-${itemKey}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        SLOT,
        'relative z-10 rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
      )}
    >
      <ChevronRight
        className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
        aria-hidden
      />
    </button>
  );
}

/** The reserved slot on a row that heads nothing, so its kind icon aligns with a group's. */
export function GroupSlot() {
  return <span aria-hidden data-group-slot className={SLOT} />;
}

/**
 * The members on this tab — a bare number, named in full for assistive tech. A count of
 * 0 is not drawn (the strip's own zero rule), and neither is the count of a group held
 * after its last member left (§ 36.7): the caller passes `null` for both.
 */
export function GroupCount({ count }: { count: number | null }) {
  const t = useTranslations('workbench.group');
  if (!count) return null;
  const label = t('count', { count });
  return (
    <span
      title={label}
      aria-label={label}
      data-testid="workbench-group-count"
      className="inline-flex h-[18px] min-w-[20px] shrink-0 items-center justify-center rounded-(--radius-badge) bg-(--el-count-bg) px-(--spacing-chip-x) text-[11px] font-semibold text-(--el-count-text)"
    >
      {count}
    </span>
  );
}

/** A context head's Your-role cell: it is here to name its members, not as the reader's. */
export function ContextMarker() {
  const t = useTranslations('workbench.group');
  return <span className="truncate text-xs text-(--el-text-secondary) italic">{t('context')}</span>;
}
