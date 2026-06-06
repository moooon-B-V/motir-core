'use client';

import { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { SHELL_SHORTCUTS, displayKey } from '@/lib/shortcuts';

/**
 * ShortcutsCheatsheet — the dialog opened by `?` that enumerates every global
 * shortcut the shell registers.
 *
 * The list is sourced entirely from `lib/shortcuts.ts` (the same module the
 * handlers bind against), so it can't drift from what's actually wired. Each
 * row shows the key combo as <kbd> chips on the left and the action label on
 * the right; `Mod` renders platform-aware (⌘ on Mac, Ctrl elsewhere).
 */
export function ShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('shell');
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('shortcuts.title')}
      description={t('shortcuts.description')}
      size="md"
    >
      <ul className="flex flex-col gap-1">
        {SHELL_SHORTCUTS.map((shortcut) => (
          <li
            key={shortcut.combo}
            className="flex items-center justify-between gap-4 rounded-(--radius-sm) px-1 py-1.5"
          >
            <span className="font-sans text-sm text-(--el-text)">{shortcut.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {shortcut.keys.map((key, i) => (
                <Fragment key={key}>
                  {i > 0 ? (
                    <span className="text-(--el-text-muted) font-mono text-xs">+</span>
                  ) : null}
                  <kbd className="text-(--el-text-muted) rounded-(--radius-xs) border border-(--el-border) bg-(--el-surface) px-1.5 py-0.5 font-mono text-xs">
                    {displayKey(key)}
                  </kbd>
                </Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
