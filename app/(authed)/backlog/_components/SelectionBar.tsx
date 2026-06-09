'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, ChevronRight, LayoutList, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { useBacklogDnd } from './BacklogDndProvider';
import { SprintMenuList } from './SprintMenuList';

// The multi-select bulk-action bar (Story 4.2 · Subtask 4.2.5), per
// design/backlog/backlog.mock.html panel 4. Appears above the stack the moment
// ≥1 row is selected: "N selected" + **Move to sprint ▸** (a Popover submenu of
// the project's sprints) + **Move to backlog** + **Clear**. The moves call the
// coordinator's shared bulk executors (4.2.2 `bulkAssignToSprint` /
// `bulkMoveToBacklog` — ONE atomic request), which clear the selection on
// dispatch. The bar sits on the `--el-accent` surface with light controls
// (AA-safe), and the count reads as text (not colour-alone, finding #35).

export function SelectionBar() {
  const t = useTranslations('backlog');
  const { selectedIds, sprints, moveItemsToSprint, moveItemsToBacklog, clearSelection } =
    useBacklogDnd();
  const [sprintMenuOpen, setSprintMenuOpen] = useState(false);

  const count = selectedIds.size;
  if (count === 0) return null;
  const ids = [...selectedIds];

  return (
    <div
      role="region"
      aria-label={t('selectionBarLabel', { count })}
      data-testid="backlog-selection-bar"
      className="mb-4 flex flex-wrap items-center gap-2 rounded-(--radius-card) bg-(--el-accent) px-(--spacing-card-padding) py-(--spacing-control-y) text-(--el-accent-text) shadow-(--shadow-card)"
    >
      <span className="text-sm font-semibold" data-testid="backlog-selection-count">
        {t('selectedCount', { count })}
      </span>

      <Popover open={sprintMenuOpen} onOpenChange={setSprintMenuOpen}>
        <Popover.Trigger
          disabled={sprints.length === 0}
          className="inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-btn) bg-(--el-surface) px-(--spacing-btn-x) text-sm font-medium text-(--el-text) hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--el-accent-text) focus-visible:outline-none disabled:opacity-60"
        >
          <ArrowRight className="h-4 w-4" aria-hidden />
          {t('moveToSprint')}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Popover.Trigger>
        <Popover.Content width={240} align="start" className="p-0">
          <SprintMenuList
            sprints={sprints}
            currentSprintId={null}
            onPick={(sprintId) => {
              moveItemsToSprint(ids, sprintId);
              setSprintMenuOpen(false);
            }}
          />
        </Popover.Content>
      </Popover>

      <button
        type="button"
        onClick={() => moveItemsToBacklog(ids)}
        className="inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-btn) bg-(--el-surface) px-(--spacing-btn-x) text-sm font-medium text-(--el-text) hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--el-accent-text) focus-visible:outline-none"
      >
        <LayoutList className="h-4 w-4" aria-hidden />
        {t('moveToBacklog')}
      </button>

      <span className="flex-1" />

      <button
        type="button"
        onClick={clearSelection}
        className="inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-btn) px-(--spacing-btn-x) text-sm font-medium text-(--el-accent-text) hover:bg-(--el-accent-pressed) focus-visible:ring-2 focus-visible:ring-(--el-accent-text) focus-visible:outline-none"
      >
        <X className="h-4 w-4" aria-hidden />
        {t('clearSelection')}
      </button>
    </div>
  );
}
