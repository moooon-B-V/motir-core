'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  MENU_DANGER_ITEM_CLASS,
  MENU_ITEM_CLASS,
  MENU_TRIGGER_CLASS,
} from '@/components/issues/actions/WorkItemActionsMenu';
import type { SprintDto } from '@/lib/dto/sprints';
import { DeleteSprintDialog } from './DeleteSprintDialog';
import { RenameSprintDialog } from './RenameSprintDialog';

// The sprint-header `⋯` actions menu (Story 4.2 · Subtask 4.2.5 — the menu was
// placed-but-disabled; ENABLED here + wired to Delete in bug MOTIR-1492), per
// design/backlog/design-notes.md ("`⋯` menu — sprint actions (rename · edit
// dates · delete · start), the shipped dropdown Menu"). Reuses the shipped
// `Popover` menu primitive and the SAME danger-row + trigger vocabulary as the
// work-item `WorkItemActionsMenu` (one source of truth, no token drift) —
// role="menu"/menuitem, keyboard-operable, no nested buttons.
//
// MOTIR-1492 owned ENABLING the menu + the **Delete** action → the shipped
// `DELETE /api/sprints/[id]`. Delete is offered for a planned/complete sprint; an
// ACTIVE sprint can't be deleted (the backend throws CannotDeleteActiveSprint →
// 409 — an active sprint is ended via Story 4.4's complete flow, not deleted), so
// the row is DISABLED with a reason there (a Tooltip state-gate, mirroring
// WorkItemActionsMenu's "add to active sprint" disabled row).
//
// **Rename (MOTIR-1493)** lands here as the first sibling item → the shipped
// `PATCH /api/sprints/[id]` `{ name }` (`RenameSprintDialog`). It is offered for a
// planned/active sprint and DISABLED-with-reason for a complete one (frozen:
// `updateSprint` throws CannotModifyCompletedSprint), the same Tooltip state-gate
// shape as Delete. Edit-dates (MOTIR-1494) is the next sibling; Start stays its
// own header button (already wired, Story 4.4).

export function SprintActionsMenu({
  sprint,
  onRenamed,
  onDeleted,
}: {
  sprint: SprintDto;
  /** Refetch the backlog after a rename (the sprint list is a client island seeded
   *  once, so the new name only re-renders across the header + region aria-label
   *  on a re-read — the page-state-after-mutation contract). */
  onRenamed: () => void | Promise<void>;
  /** Refetch the backlog after a delete (the sprint drops out + its issues return
   *  to the backlog list). */
  onDeleted: () => void | Promise<void>;
}) {
  const t = useTranslations('backlog');
  const [open, setOpen] = useState(false);
  const [confirmRename, setConfirmRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A COMPLETE sprint is frozen — `sprintsService.updateSprint` throws
  // CannotModifyCompletedSprint (409) — so Rename is offered for a planned/active
  // sprint and disabled-with-reason for a complete one (the AC's "complete
  // sprint's name is not editable"). The planning view surfaces only planned +
  // active sprints, so this gate is the safety backstop, mirroring the Delete
  // active-disabled state-gate below.
  const canRename = sprint.state !== 'complete';

  // Only an ACTIVE sprint is undeletable (complete it first); planned + complete
  // are deletable. The backlog planning view surfaces only planned + active
  // sprints (completed ones live in reports), so here Delete is enabled for a
  // planned sprint and disabled for the active one.
  const canDelete = sprint.state !== 'active';

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label={t('sprintActions')}
          data-testid={`sprint-actions-${sprint.id}`}
          className={MENU_TRIGGER_CLASS}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Popover.Trigger>
        <Popover.Content width={232} align="end" className="p-0">
          <div className="p-1" role="menu" aria-label={t('sprintActions')}>
            {canRename ? (
              <button
                type="button"
                role="menuitem"
                data-testid={`sprint-rename-${sprint.id}`}
                className={MENU_ITEM_CLASS}
                onClick={() => {
                  setOpen(false);
                  setConfirmRename(true);
                }}
              >
                <Pencil className="h-4 w-4 shrink-0" aria-hidden />
                {t('renameSprintFlow.menuItem')}
              </button>
            ) : (
              <Tooltip content={t('renameSprintFlow.completeDisabled')}>
                <div
                  role="menuitem"
                  aria-disabled="true"
                  tabIndex={0}
                  data-testid={`sprint-rename-${sprint.id}`}
                  className="flex h-(--height-control) w-full cursor-default items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) opacity-50 focus-visible:outline-none"
                >
                  <Pencil className="h-4 w-4 shrink-0" aria-hidden />
                  {t('renameSprintFlow.menuItem')}
                </div>
              </Tooltip>
            )}
            {canDelete ? (
              <button
                type="button"
                role="menuitem"
                data-testid={`sprint-delete-${sprint.id}`}
                className={MENU_DANGER_ITEM_CLASS}
                onClick={() => {
                  setOpen(false);
                  setConfirmDelete(true);
                }}
              >
                <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
                {t('deleteSprintFlow.menuItem')}
              </button>
            ) : (
              <Tooltip content={t('deleteSprintFlow.activeDisabled')}>
                <div
                  role="menuitem"
                  aria-disabled="true"
                  tabIndex={0}
                  data-testid={`sprint-delete-${sprint.id}`}
                  className="flex h-(--height-control) w-full cursor-default items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-danger) opacity-50 focus-visible:outline-none"
                >
                  <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
                  {t('deleteSprintFlow.menuItem')}
                </div>
              </Tooltip>
            )}
          </div>
        </Popover.Content>
      </Popover>

      {confirmRename ? (
        <RenameSprintDialog
          sprint={sprint}
          onClose={() => setConfirmRename(false)}
          onRenamed={async () => {
            await onRenamed();
          }}
        />
      ) : null}

      {confirmDelete ? (
        <DeleteSprintDialog
          sprint={sprint}
          onClose={() => setConfirmDelete(false)}
          onDeleted={async () => {
            setConfirmDelete(false);
            await onDeleted();
          }}
        />
      ) : null}
    </>
  );
}
