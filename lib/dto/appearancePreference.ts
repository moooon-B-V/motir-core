// DTO for the cross-device appearance-preference surface (Story 7.3 · Subtask
// 7.3.60) — the shape that crosses the API boundary to the account-settings
// Appearance pane (7.3.62) and the SSR application layer (7.3.61).
//
// Every axis is RESOLVED: a null stored column (or no row at all) is replaced
// by the documented default via the theme resolvers, so the consumer never
// has to know about absence — it always receives four concrete, valid ids.
// (The precedence between an explicit `typeId` and the active style's
// `defaultTypeId` is an application-time concern owned by 7.3.61, not this
// per-axis resolution.)

import type { ThemePattern } from '@/lib/theme/types';

/** The current user's resolved appearance preference — one valid id per axis. */
export interface AppearancePreferenceDto {
  /** Light/dark base (`system` follows the OS at runtime). */
  pattern: ThemePattern;
  /** Axis 2 — the active `data-style` id (e.g. `warm-editorial`). */
  styleId: string;
  /** Axis 1 — the active `data-palette` id (e.g. `motir`). */
  paletteId: string;
  /** Axis 3 — the active `data-type` id (e.g. `motir`). */
  typeId: string;
}
