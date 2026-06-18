/**
 * Theme types for Motir's THREE-axis design system.
 *
 * Axis 1 — COLOR  (`data-theme` light/dark base · `data-palette` full
 *                  `--el-*` palette swap — the colour axis)
 * Axis 2 — STYLE  (`data-style` — a named aesthetic controlling shape /
 *                  silhouette / elevation / surface / density / motion /
 *                  component silhouettes)
 * Axis 3 — TYPE   (`data-type` — a named pairing controlling the `--font-*`
 *                  role mapping; a style declares a default pairing, overridable)
 *
 * The three axes are INDEPENDENT: a style never touches a hue or a face, a
 * palette never touches a radius, a type pairing never touches colour or shape.
 * The registries live in `./styles.ts`, `./palettes.ts`, `./typography.ts`.
 *
 * Architecture mirrors dooooWeb. See docs/DESIGN.md for the rationale.
 */

import { DEFAULT_STYLE_ID, type StyleId } from './styles';
import { DEFAULT_PALETTE_ID, type PaletteId } from './palettes';
import { DEFAULT_TYPE_ID, type TypeId } from './typography';

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

/**
 * Axis 1 (colour) — the active named palette (`data-palette`). The value space
 * + the registry of every palette live in `./palettes.ts`; re-exported here so
 * `lib/theme/*` stays the single import surface for theme consumers.
 */
export type { PaletteId } from './palettes';

/**
 * Axis 3 — the active named type pairing (`data-type`). The value space + the
 * registry live in `./typography.ts`; re-exported here so `lib/theme/*` stays
 * the single import surface for theme consumers.
 */
export type { TypeId } from './typography';

/** Storage keys for persisting user preferences. */
export const THEME_STORAGE_KEYS = {
  pattern: 'motir.theme.pattern',
  style: 'motir.theme.style',
  palette: 'motir.theme.palette',
  type: 'motir.theme.type',
} as const;

/**
 * Sensible defaults if localStorage is empty. Note `type` is the GLOBAL fallback
 * only — when no explicit type is pinned, the active STYLE's `defaultTypeId`
 * wins (see `STYLE_DEFAULT_TYPE` / the theme context); this is the floor under
 * an unknown style.
 */
export const THEME_DEFAULTS = {
  pattern: 'system' as ThemePattern,
  style: DEFAULT_STYLE_ID as StyleId,
  palette: DEFAULT_PALETTE_ID as PaletteId,
  type: DEFAULT_TYPE_ID as TypeId,
} as const;

/**
 * Narrowing guard — is an arbitrary value a valid `pattern` axis id? The
 * colour / style / type axes each ship `isXId` in their registry file; the
 * pattern axis is a fixed three-value union, so its guard lives here next to
 * the type. Mirrors `isStyleId` / `isPaletteId` / `isTypeId`.
 */
export function isThemePattern(value: unknown): value is ThemePattern {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Resolve a (possibly stale / unknown / null) value to a valid `pattern`,
 * falling back to `THEME_DEFAULTS.pattern`. The pattern-axis analogue of
 * `resolveStyle` / `resolvePalette` / `resolveType`.
 */
export function resolvePattern(value: unknown): ThemePattern {
  return isThemePattern(value) ? value : THEME_DEFAULTS.pattern;
}
