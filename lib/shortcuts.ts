/**
 * lib/shortcuts.ts — the single source of truth for the app-shell's global
 * keyboard shortcuts.
 *
 * Both the actual handlers (AppLayout's sidebar toggle, the
 * CommandPaletteProvider's palette + cheatsheet bindings) AND the
 * ShortcutsCheatsheet's displayed list read from this module, so the two can
 * never drift — a shortcut shown in the cheatsheet is, by construction, one a
 * handler actually registers, and vice-versa.
 *
 * `combo` is the string the `useShortcut` hook parses (see
 * `lib/hooks/useShortcut.ts` for the grammar — `Mod` resolves to ⌘ on Mac /
 * Ctrl elsewhere at bind time). `keys` is the display decomposition the
 * cheatsheet renders as <kbd> chips.
 */

export interface ShortcutDef {
  /** The combo string `useShortcut` binds against (`Mod+K`, `Mod+\\`, `?`). */
  combo: string;
  /** Per-key display tokens; `Mod` is rendered platform-aware by the cheatsheet. */
  keys: readonly string[];
  /** Human-readable action label shown beside the chips. */
  label: string;
}

export const SHORTCUTS = {
  commandPalette: { combo: 'Mod+K', keys: ['Mod', 'K'], label: 'Open the command palette' },
  createIssue: { combo: 'C', keys: ['C'], label: 'Create an issue' },
  toggleSidebar: { combo: 'Mod+\\', keys: ['Mod', '\\'], label: 'Collapse or expand the sidebar' },
  shortcuts: { combo: '?', keys: ['?'], label: 'Show this keyboard-shortcut cheatsheet' },
  closeOverlay: {
    combo: 'Escape',
    keys: ['Esc'],
    label: 'Close the palette, a dialog, or the drawer',
  },
} as const;

/** The full ordered list the cheatsheet enumerates. */
export const SHELL_SHORTCUTS: ShortcutDef[] = [
  SHORTCUTS.commandPalette,
  SHORTCUTS.createIssue,
  SHORTCUTS.toggleSidebar,
  SHORTCUTS.shortcuts,
  SHORTCUTS.closeOverlay,
];

/** True on Apple platforms — used to render `Mod` as ⌘ rather than `Ctrl`. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform);
}

/** Map a display key token to its platform-appropriate glyph. */
export function displayKey(token: string): string {
  if (token === 'Mod') return isMacPlatform() ? '⌘' : 'Ctrl';
  return token;
}
