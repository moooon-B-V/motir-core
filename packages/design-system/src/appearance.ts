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

import type { ThemePattern } from './theme/types';

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

/**
 * The APPLIED appearance — what actually drives the four `<html>` data-attributes
 * (Subtask 7.3.61). It differs from `AppearancePreferenceDto` in ONE place that
 * the per-axis DTO deliberately deferred to this subtask: the **type axis is
 * application-resolved**, not per-axis-resolved. A user who has not pinned a type
 * follows the active STYLE's `defaultTypeId` here — NOT the global default the
 * per-axis mapper falls back to. `typePinned` records whether the user actually
 * pinned a type, so the client can seed the theme context's `typeChoice`
 * (pinned id vs. `null` = follow-style) and the init script can reconcile the
 * localStorage `type` key without converting an unpinned user into a pinned one.
 *
 * `pattern` is the RAW choice (`system` | `light` | `dark`): `system` only
 * resolves to light/dark at runtime via `matchMedia`, so the server renders
 * `data-theme` only for an explicit `light`/`dark` and leaves `system` to the
 * init script. The other three axes have no runtime input and are fully
 * server-resolvable, so they render on the first byte.
 */
export interface AppliedAppearanceDto {
  /** Raw light/dark base — `system` resolves to light/dark via matchMedia. */
  pattern: ThemePattern;
  /** Axis 2 — the resolved `data-style` id. */
  styleId: string;
  /** Axis 1 — the resolved `data-palette` id. */
  paletteId: string;
  /** Axis 3 — the EFFECTIVE `data-type` id (pinned id, else the style default). */
  typeId: string;
  /** Whether the user explicitly pinned a type (vs. following the style default). */
  typePinned: boolean;
}
