'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { DeleteWorkItemDialog } from '@/components/issues/actions/DeleteWorkItemDialog';
import {
  MENU_DANGER_ITEM_CLASS,
  MENU_TRIGGER_CLASS,
} from '@/components/issues/actions/WorkItemActionsMenu';

// The archived-row `⋯` overflow menu (Story 2.9 · Subtask 2.9.5), per
// design/work-items/delete-confirm.mock.html + design-notes §2.9.7. Unlike the
// live list/board's full WorkItemActionsMenu, this `⋯` is PURELY the Delete
// affordance: a single danger `Delete…` row, so the menu maps 1:1 to the
// `canManage` capability (Restore stays the prominent inline button on the row).
// It reuses the shipped Popover + the SAME danger-row/trigger vocabulary (the
// exported MENU_* classes) — no new primitive.
//
// `Delete…` opens the ARCHIVED variant of the shipped DeleteWorkItemDialog
// (2.9.10): no "Archive instead" escape-hatch + the live-descendant warning.
// The dialog owns the delete-preview read, the DELETE call, and the
// `{key} deleted` toast; on success it calls `onDeleted`, which the list uses to
// remove the row optimistically (the page-state-after-mutation contract — the
// archived list is a client island).
export function ArchivedRowDeleteMenu({
  itemId,
  identifier,
  title,
  onDeleted,
}: {
  /** The work-item id — the target of the delete-preview + DELETE calls. */
  itemId: string;
  /** The `PROD-N` key — the menu label + the dialog body. */
  identifier: string;
  title: string;
  /** Run after a successful delete — the list drops the row optimistically. */
  onDeleted: () => void;
}) {
  const t = useTranslations('workItemActions');
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const menuLabel = t('menuLabel', { key: identifier });

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger aria-label={menuLabel} className={MENU_TRIGGER_CLASS}>
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Popover.Trigger>
        <Popover.Content width={232} align="end" className="p-0">
          <div className="p-1" role="menu" aria-label={menuLabel}>
            <button
              type="button"
              role="menuitem"
              className={MENU_DANGER_ITEM_CLASS}
              onClick={() => {
                setOpen(false);
                setDialogOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
              {t('delete')}
            </button>
          </div>
        </Popover.Content>
      </Popover>

      {dialogOpen ? (
        <DeleteWorkItemDialog
          itemId={itemId}
          identifier={identifier}
          title={title}
          archived
          onClose={() => setDialogOpen(false)}
          onDeleted={() => {
            setDialogOpen(false);
            onDeleted();
          }}
        />
      ) : null}
    </>
  );
}
