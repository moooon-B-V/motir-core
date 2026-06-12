'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellRing, MoreHorizontal, Pencil, Trash2, UserCog } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';

// The per-row `⋯` actions menu for the Filters directory (Story 6.2 · Subtask
// 6.2.4 + 6.2.5), per design/work-items/saved-filters.mock.html panel 3 + 5.
// Reuses the shipped `Popover` (the menu primitive — no nested buttons,
// keyboard-operable `role="menu"`). Actions are gated by the 6.2.1 matrix:
// Subscribe… for ANYONE who can see the row (the read-layer action — a
// non-owner on a shared filter gets this one alone, 6.2.5); Edit details +
// Delete for owner/admin; Change owner for the admin tier on a project-shared
// filter. The trigger renders whenever at least one action is available.

export function FilterRowActionsMenu({
  filterName,
  canSubscribe,
  canManage,
  canChangeOwner,
  onSubscribe,
  onEdit,
  onChangeOwner,
  onDelete,
}: {
  filterName: string;
  canSubscribe: boolean;
  canManage: boolean;
  canChangeOwner: boolean;
  onSubscribe: () => void;
  onEdit: () => void;
  onChangeOwner: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('savedFilters');
  const [open, setOpen] = useState(false);

  if (!canSubscribe && !canManage && !canChangeOwner) return null;

  const itemClass =
    'flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none';

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={t('rowActions', { name: filterName })}
        className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={208} align="end" className="p-0">
        <div className="p-1" role="menu" aria-label={t('rowActions', { name: filterName })}>
          {canSubscribe ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => run(onSubscribe)}
            >
              <BellRing className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
              <span className="flex-1 truncate">{t('subscribeAction')}</span>
            </button>
          ) : null}
          {canSubscribe && (canManage || canChangeOwner) ? (
            <div className="mx-1 my-1 h-px bg-(--el-border)" />
          ) : null}
          {canManage ? (
            <button type="button" role="menuitem" className={itemClass} onClick={() => run(onEdit)}>
              <Pencil className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
              <span className="flex-1 truncate">{t('editDetails')}</span>
            </button>
          ) : null}
          {canChangeOwner ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => run(onChangeOwner)}
            >
              <UserCog className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
              <span className="flex-1 truncate">{t('changeOwner')}</span>
            </button>
          ) : null}
          {canManage ? (
            <>
              <div className="mx-1 my-1 h-px bg-(--el-border)" />
              <button
                type="button"
                role="menuitem"
                className="flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-danger-text) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none"
                onClick={() => run(onDelete)}
              >
                <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
                <span className="flex-1 truncate">{t('delete')}</span>
              </button>
            </>
          ) : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}
