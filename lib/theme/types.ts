/**
 * Theme types for Motir's two-axis design system.
 *
 * Axis 1 — COLOR  (`data-theme` light/dark base · `data-palette` full
 *                  `--el-*` palette swap — the colour axis)
 * Axis 2 — STYLE  (`data-style` — a named aesthetic controlling shape /
 *                  silhouette / elevation / surface / density / motion /
 *                  typography / component silhouettes)
 *
 * The two axes are INDEPENDENT: a style never touches a hue, a palette never
 * touches a radius. The named-style registry lives in `./styles.ts`.
 *
 * Architecture mirrors dooooWeb. See docs/DESIGN.md for the rationale.
 */

import { DEFAULT_STYLE_ID, type StyleId } from './styles';

/** Tier 1 — light/dark base. `system` follows OS preference at runtime. */
export type ThemePattern = 'system' | 'light' | 'dark';

/** Resolved pattern (what data-theme is set to after `system` resolves). */
export type ResolvedThemePattern = 'light' | 'dark';

/**
 * Axis 2 — the active named style (`data-style`). The value space + the
 * registry of every style live in `./styles.ts`; this re-export keeps
 * `lib/theme/*` the single import surface for theme consumers.
 */
export type { StyleId } from './styles';

/** Storage keys for persisting user preferences. */
export const THEME_STORAGE_KEYS = {
  pattern: 'motir.theme.pattern',
  style: 'motir.theme.style',
} as const;

/** Sensible defaults if localStorage is empty. */
export const THEME_DEFAULTS = {
  pattern: 'system' as ThemePattern,
  style: DEFAULT_STYLE_ID as StyleId,
} as const;
