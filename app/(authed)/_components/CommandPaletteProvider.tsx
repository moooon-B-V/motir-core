'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useShortcut } from '@/lib/hooks/useShortcut';
import { SHORTCUTS } from '@/lib/shortcuts';
import { ShortcutsCheatsheet } from './ShortcutsCheatsheet';

/**
 * CommandPaletteProvider — owns the open state of the ⌘K command palette and
 * the `?` shortcut cheatsheet, and registers their global shortcuts once for
 * the whole authenticated shell.
 *
 * It exposes `openCommandPalette()` via context so the top-nav "Search" button
 * (and anything else) can open the palette without prop-drilling. The palette
 * UI itself is rendered by a sibling `<AppCommandPalette />`, which reads
 * `open` / `setOpen` from this same context — the provider stays data-agnostic
 * (it knows nothing about workspaces or projects), so the application data only
 * has to flow into `AppCommandPalette`.
 *
 * Shortcut bindings come from `lib/shortcuts.ts` (the single source of truth the
 * cheatsheet also reads), so the keys advertised in the cheatsheet are exactly
 * the keys wired here.
 */
interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openCommandPalette: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  // ⌘K / Ctrl+K opens the palette from anywhere — including while a text input
  // is focused (the chord can't type a character), so `whenInputFocused: true`.
  useShortcut(SHORTCUTS.commandPalette.combo, () => setOpen(true), { whenInputFocused: true });

  // `?` opens the cheatsheet, but only when NOT typing — so a literal `?` in a
  // search box stays a question mark (the hook's default input guard).
  useShortcut(SHORTCUTS.shortcuts.combo, () => setCheatsheetOpen(true));

  const value = useMemo<CommandPaletteContextValue>(
    () => ({ open, setOpen, openCommandPalette: () => setOpen(true) }),
    [open],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <ShortcutsCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
  }
  return ctx;
}
