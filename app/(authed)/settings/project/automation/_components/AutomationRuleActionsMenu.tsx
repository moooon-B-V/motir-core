'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { List, MoreHorizontal, Pencil, Power, Trash2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';

// The per-rule `⋯` actions menu (Story 6.6 · Subtask 6.6.5), per
// design/projects/automation.mock.html panel 0 (Edit · Disable/Enable · Delete).
// Reuses the shipped `Popover` as the menu primitive (the FilterRowActionsMenu
// grammar — no nested buttons, keyboard-operable `role="menu"`). "View log" is
// the 6.6.6 audit surface (added when that subtask lands); the whole surface is
// admin-only, so the menu always renders for the actor who can see the page.

export function AutomationRuleActionsMenu({
  ruleName,
  enabled,
  onEdit,
  onViewLog,
  onToggleEnabled,
  onDelete,
}: {
  ruleName: string;
  enabled: boolean;
  onEdit: () => void;
  onViewLog: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('settings.automation.menu');
  const ta = useTranslations('settings.automation.row');
  const [open, setOpen] = useState(false);

  const itemClass =
    'flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none';

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={ta('actionsAria', { name: ruleName })}
        className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={200} align="end" className="p-0">
        <div className="p-1" role="menu" aria-label={ta('actionsAria', { name: ruleName })}>
          <button type="button" role="menuitem" className={itemClass} onClick={() => run(onEdit)}>
            <Pencil className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <span className="flex-1 truncate">{t('edit')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => run(onViewLog)}
          >
            <List className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <span className="flex-1 truncate">{t('viewLog')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => run(onToggleEnabled)}
          >
            <Power className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <span className="flex-1 truncate">{enabled ? t('disable') : t('enable')}</span>
          </button>
          <div className="mx-1 my-1 h-px bg-(--el-border)" />
          <button
            type="button"
            role="menuitem"
            className="flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-danger) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none"
            onClick={() => run(onDelete)}
          >
            <Trash2 className="h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
            <span className="flex-1 truncate">{t('delete')}</span>
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}
