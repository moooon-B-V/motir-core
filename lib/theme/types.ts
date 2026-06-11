/**
 * Theme types for Motir's two-axis design system.
 *
 * Axis 1 — Color (light/dark base, accent override, full-palette override)
 * Axis 2 — Shape (display-style controls radius/shadow/spacing/density)
 *
 * Architecture mirrors dooooWeb. See docs/DESIGN.md for the rationale.
 */

/** Tier 1 — light/dark base. `system` follows OS preference at runtime. */
export type ThemePattern = 'system' | 'light' | 'dark';

/** Resolved pattern (what data-theme is set to after `system` resolves). */
export type ResolvedThemePattern = 'light' | 'dark';

/**
 * Axis 2 — shape personality. Overrides radius / shadow / spacing / density.
 * `default` and `soft` ship in 1.0.5.1; `flat` and `pill` arrive later.
 */
export type DisplayStyle = 'default' | 'soft';

/** Storage keys for persisting user preferences. */
export const THEME_STORAGE_KEYS = {
  pattern: 'motir.theme.pattern',
  displayStyle: 'motir.theme.displayStyle',
} as const;

/** Sensible defaults if localStorage is empty. */
export const THEME_DEFAULTS = {
  pattern: 'system' as ThemePattern,
  displayStyle: 'default' as DisplayStyle,
} as const;
