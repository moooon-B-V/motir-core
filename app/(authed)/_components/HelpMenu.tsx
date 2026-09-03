'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, CircleQuestionMark, Keyboard, Scale } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';
import { useCommandPalette } from './CommandPaletteProvider';

// The same icon-box grammar `ReportButton`'s local `ICON_BTN` defines for the
// drawer's utility strip — not exported there, so mirrored here rather than
// reached across a component boundary for one string (MOTIR-4239).
const DRAWER_ICON_BTN =
  'items-center justify-center rounded-(--radius-control) h-(--height-control) w-(--height-control) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)';

const ROW_CLASS =
  'hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none';

export interface HelpMenuProps {
  /**
   * Where the operator's documentation index lives, or `null` when this
   * deployment has configured none (`lib/docs/links.ts`). Defaults `null` —
   * an omitted prop hides the row rather than rendering a dead link, the same
   * fail-closed shape `UserMenu`'s `platformStaff` / `workspaceTierRevealed` use.
   */
  docsIndexUrl?: string | null;
  /**
   * Where the operator's legal-documents index lives, or `null` when this
   * deployment has published none (`lib/legal/links.ts`). Same shape as
   * `docsIndexUrl`, for the same reason.
   */
  legalIndexUrl?: string | null;
  /**
   * Which home renders the trigger: `'footer'` (default) is the rail's footer
   * slot at `≥ md`, taking `SidebarToggle`'s own ghost-button grammar so the
   * two controls read as one pair; `'drawer'` is the drawer's utility strip
   * below `md`, taking the square icon-box grammar `ReportButton` /
   * `ThemeToggle` use there.
   */
  placement?: 'footer' | 'drawer';
}

export function HelpMenu({
  docsIndexUrl = null,
  legalIndexUrl = null,
  placement = 'footer',
}: HelpMenuProps) {
  const t = useTranslations('shell');
  const [collapsed] = useSidebarCollapsed();
  const [open, setOpen] = useState(false);
  const { openShortcuts } = useCommandPalette();
  const label = t('help.label');

  function openShortcutsAndClose() {
    setOpen(false);
    openShortcuts();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {placement === 'drawer' ? (
          <button
            type="button"
            aria-label={label}
            className={cn(
              DRAWER_ICON_BTN,
              'inline-flex text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text)',
            )}
          >
            <CircleQuestionMark className="h-5 w-5" aria-hidden />
          </button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            className={cn(collapsed ? 'mx-auto w-9 px-0' : 'w-9 px-0')}
          >
            <CircleQuestionMark className="h-4 w-4" />
          </Button>
        )}
      </Popover.Trigger>
      <Popover.Content align="start" width={240} aria-label={label} className="py-1">
        <div className="px-1">
          {docsIndexUrl ? (
            <a href={docsIndexUrl} onClick={() => setOpen(false)} className={ROW_CLASS}>
              <BookOpen className="text-(--el-text-muted) h-4 w-4" aria-hidden />
              {t('help.docs')}
            </a>
          ) : null}
          <button type="button" onClick={openShortcutsAndClose} className={ROW_CLASS}>
            <Keyboard className="text-(--el-text-muted) h-4 w-4" aria-hidden />
            {t('help.shortcuts')}
          </button>
          {legalIndexUrl ? (
            <a href={legalIndexUrl} onClick={() => setOpen(false)} className={ROW_CLASS}>
              <Scale className="text-(--el-text-muted) h-4 w-4" aria-hidden />
              {t('help.legal')}
            </a>
          ) : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}
