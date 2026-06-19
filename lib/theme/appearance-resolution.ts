/**
 * Appearance APPLICATION resolution (Story 7.3 · Subtask 7.3.61).
 *
 * The single, registry-pure source of truth for turning a set of stored axis
 * values — whether they came from the server (a logged-in user's DB row) or
 * from localStorage (an anonymous visitor) — into the four concrete attribute
 * values applied to `<html>`. It is deliberately free of any Prisma / DOM /
 * Next import so BOTH the server (the appearance service + mapper) and the
 * client (the theme context's seeding) can call it.
 *
 * The one piece of logic that lives ONLY here (and is mirrored, by necessity,
 * as inlined JS in `init-script.ts`) is the **type-axis precedence** the
 * per-axis DTO mapper deferred to this subtask: an unpinned type follows the
 * active STYLE's `defaultTypeId`, NOT the global default. See
 * `AppliedAppearanceDto`.
 */

import type { AppliedAppearanceDto } from '@/lib/dto/appearancePreference';
import { resolvePattern } from './types';
import { resolveStyle, defaultTypeForStyle } from './styles';
import { resolvePalette } from './palettes';
import { isTypeId, type TypeId } from './typography';

/** The four raw axis values as stored — a DB row's columns or localStorage. */
export interface AppearanceAxesInput {
  pattern?: string | null;
  styleId?: string | null;
  paletteId?: string | null;
  typeId?: string | null;
}

/** The raw localStorage snapshot the client reads (keys per `THEME_STORAGE_KEYS`). */
export interface LocalAppearanceSnapshot {
  pattern: string | null;
  style: string | null;
  palette: string | null;
  type: string | null;
}

/**
 * Resolve raw axis values to the applied appearance. Each axis is resolved
 * through its registry (a stale / unknown / absent value collapses to the
 * documented default); the type axis additionally applies the style-default
 * precedence: a pinned, still-registered `typeId` wins, otherwise the resolved
 * style's `defaultTypeId`. `typePinned` reflects whether a real type was pinned.
 */
export function resolveAxesToApplied(axes: AppearanceAxesInput): AppliedAppearanceDto {
  const pattern = resolvePattern(axes.pattern);
  const styleId = resolveStyle(axes.styleId).id;
  const paletteId = resolvePalette(axes.paletteId).id;
  const typePinned = isTypeId(axes.typeId);
  const typeId: TypeId = typePinned ? (axes.typeId as TypeId) : defaultTypeForStyle(styleId);
  return { pattern, styleId, paletteId, typeId, typePinned };
}

/**
 * The reconciliation: given the authoritative SERVER preference (or `null` for
 * an anonymous visitor) and the localStorage snapshot, decide what to apply.
 *
 * - **Server present** → the server preference wins (it followed the user to
 *   this device); localStorage is ignored for the applied value.
 * - **Server absent (anonymous / not signed in)** → resolve from localStorage.
 *
 * localStorage is therefore the anonymous store + the instant-apply cache, never
 * an override of a present server value (the precedence rule of 7.3.61).
 */
export function resolveAppliedAppearance(
  server: AppliedAppearanceDto | null,
  local: LocalAppearanceSnapshot,
): AppliedAppearanceDto {
  if (server) return server;
  return resolveAxesToApplied({
    pattern: local.pattern,
    styleId: local.style,
    paletteId: local.palette,
    typeId: local.type,
  });
}
