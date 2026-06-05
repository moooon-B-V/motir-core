'use client';

import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { displayKey } from '@/lib/shortcuts';
import { useCommandPalette } from './CommandPaletteProvider';

/**
 * CommandPaletteTrigger — the top-nav "Search" button that opens the ⌘K
 * command palette. Fills the cmd-k slot 1.5.3 left empty in TopNav.
 *
 * It only owns the affordance; the open state + the ⌘K key binding live in
 * CommandPaletteProvider (consumed via `useCommandPalette`). The trailing chip
 * mirrors the global shortcut so the keyboard path is discoverable.
 */
export function CommandPaletteTrigger() {
  const t = useTranslations('shell');
  const { openCommandPalette } = useCommandPalette();

  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-keyshortcuts="Meta+K Control+K"
      className="text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) inline-flex h-9 items-center gap-2 rounded-(--radius-sm) border border-(--el-border) px-2.5 font-sans text-sm transition-colors focus-visible:outline-none focus-visible:ring-2"
    >
      <Search className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">{t('commandPalette.search')}</span>
      <kbd className="hidden rounded-(--radius-xs) border border-(--el-border) px-1 py-0.5 font-mono text-[10px] sm:inline">
        {displayKey('Mod')}K
      </kbd>
    </button>
  );
}
