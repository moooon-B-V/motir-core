'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpToLine,
  ChevronRight,
  LayoutList,
  MoreHorizontal,
} from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { useBacklogDnd } from './BacklogDndProvider';
import { SprintMenuList } from './SprintMenuList';
import type { RegionKind } from './backlogDnd';

// The per-row `⋯` context menu (Story 4.2 · Subtask 4.2.5), per
// design/backlog/backlog.mock.html panel 5. Reuses the shipped `Popover` (the
// menu primitive — no nested buttons, no hand-rolled popover), keyboard-operable.
// Actions, context-dependent on where the row lives:
//   * **Move to sprint ▸** — a sub-view of the project's sprints (the current one
//     check-marked); picking one calls 4.2.2 `bulkAssignToSprint` (one id).
//   * **Move to backlog** — only for a row currently in a sprint (4.2.2 bulk move).
//   * **Move to top / bottom of backlog** — only for a backlog row; ranks to the
//     boundary via 4.1.4 `rankIssue` (append/prepend).
// The "Move to sprint" submenu is rendered as a second VIEW inside the one
// Popover (a flyout needs a nested-portal focus dance the design only illustrates
// side-by-side) — keyboard-operable with a Back affordance.

export function RowActionsMenu({
  itemId,
  identifier,
  regionKind,
  currentSprintId,
}: {
  itemId: string;
  identifier: string;
  regionKind: RegionKind;
  /** The sprint this row currently lives in (check-marked in the submenu), or null in the backlog. */
  currentSprintId: string | null;
}) {
  const t = useTranslations('backlog');
  const { sprints, moveItemsToSprint, moveItemsToBacklog, rankItemToBoundary } = useBacklogDnd();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'root' | 'sprints'>('root');

  const inSprint = regionKind === 'sprint';

  function close() {
    setOpen(false);
    setView('root');
  }

  const itemClass =
    'flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none';

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setView('root');
      }}
    >
      <Popover.Trigger
        aria-label={t('rowActions')}
        data-testid={`backlog-row-actions-${identifier}`}
        // Stop the pointer-down from reaching the row's drag listeners / click
        // selection — the menu button is a sibling control, not a drag/select cue.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={232} align="end" className="p-0">
        {view === 'root' ? (
          <div className="p-1" role="menu" aria-label={t('rowActions')}>
            <div className="px-(--spacing-control-x) py-1 text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
              {identifier}
            </div>
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => setView('sprints')}
            >
              <ArrowRight className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
              <span className="flex-1 truncate">{t('moveToSprint')}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
            </button>

            {inSprint ? (
              <button
                type="button"
                role="menuitem"
                className={itemClass}
                data-testid={`row-move-to-backlog-${identifier}`}
                onClick={() => {
                  moveItemsToBacklog([itemId]);
                  close();
                }}
              >
                <LayoutList className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
                <span className="flex-1 truncate">{t('moveToBacklog')}</span>
              </button>
            ) : (
              <>
                <div className="mx-1 my-1 h-px bg-(--el-border)" />
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  data-testid={`row-move-top-${identifier}`}
                  onClick={() => {
                    rankItemToBoundary(itemId, 'top');
                    close();
                  }}
                >
                  <ArrowUpToLine className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
                  <span className="flex-1 truncate">{t('moveToTop')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  data-testid={`row-move-bottom-${identifier}`}
                  onClick={() => {
                    rankItemToBoundary(itemId, 'bottom');
                    close();
                  }}
                >
                  <ArrowDownToLine
                    className="h-4 w-4 shrink-0 text-(--el-text-muted)"
                    aria-hidden
                  />
                  <span className="flex-1 truncate">{t('moveToBottom')}</span>
                </button>
              </>
            )}
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setView('root')}
              className="flex h-(--height-control) w-full items-center gap-2 border-b border-(--el-border) px-(--spacing-control-x) text-left text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
              {t('back')}
            </button>
            <SprintMenuList
              sprints={sprints}
              currentSprintId={currentSprintId}
              onPick={(sprintId) => {
                moveItemsToSprint([itemId], sprintId);
                close();
              }}
            />
          </div>
        )}
      </Popover.Content>
    </Popover>
  );
}
