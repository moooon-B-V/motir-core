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
 *
 * SLOT 1 of the bar's four-slot below-`md` budget (MOTIR-2373 · design/shell
 * design-notes.md § *The top bar's control budget*): a `--height-control` SQUARE
 * until `lg`, where the label + chip arrive and it grows to `lg:w-auto`. The box
 * is a shape token, not `h-9`, so all four slots stay one square under a
 * `data-style` swap. Label AND chip are gated TOGETHER at `lg` — gating one
 * without the other leaves an icon beside a bare ⌘K chip that overflows the
 * square.
 */
export function CommandPaletteTrigger() {
  const t = useTranslations('shell');
  const { openCommandPalette } = useCommandPalette();

  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-keyshortcuts="Meta+K Control+K"
      // The label is `lg`-gated, so below 1024px this button is icon-only and
      // the SVG is aria-hidden — without a name it would announce as "button".
      // Same string as the visible label (mirrors CreateIssueButton), so the
      // accessible name is stable across the breakpoint instead of appearing
      // only where the text does.
      aria-label={t('commandPalette.search')}
      className="text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) inline-flex h-(--height-control) w-(--height-control) items-center justify-center gap-2 rounded-(--radius-btn) border border-(--el-border) font-sans text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 lg:w-auto lg:px-2.5"
    >
      <Search className="h-4 w-4" aria-hidden />
      <span className="hidden lg:inline">{t('commandPalette.search')}</span>
      <kbd className="hidden rounded-(--radius-kbd) border border-(--el-border) px-1 py-0.5 font-mono text-[10px] lg:inline">
        {displayKey('Mod')}K
      </kbd>
    </button>
  );
}
