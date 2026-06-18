/**
 * The Motir STYLE LIBRARY — the named-aesthetic registry (Subtask 7.3.32).
 *
 * A "style" is a named, end-to-end AESTHETIC the whole UI can swap to at
 * runtime — the foundation the onboarding design wizard (7.3.27) and the
 * `/tokens` composer (7.3.30) build on. It is the SHAPE/feel axis, and it is
 * deliberately INDEPENDENT of the COLOR axis (`data-palette` — see below): a
 * style decides how the product FEELS (silhouette, stroke, elevation, surface
 * treatment, density, motion, typography, component silhouettes); a palette
 * decides what colours it WEARS. Picking a style never changes a hue, and
 * picking a palette never changes a radius.
 *
 * ── The two-axis runtime contract ───────────────────────────────────────
 *   data-style="<style-id>"      — THIS axis. Layers per-style shape/feel
 *                                  tokens (+ component-variant overrides) over
 *                                  the Tier-0 base scale in app/globals.css.
 *   data-palette="<palette-id>"  — the INDEPENDENT colour axis (re-skins the
 *                                  `--el-*` layer). Orthogonal to data-style.
 *   data-theme="light|dark"      — the light/dark base within a palette.
 *
 * A `[data-style='…']` block in globals.css MUST override ONLY shape/feel
 * tokens (radius / spacing / shadow / sizing / transition / type) — NEVER a
 * `--color-*` or `--el-*` colour token. That is the palette axis's job, and
 * keeping the two disjoint is what makes "style × palette" a true product of
 * two independent choices rather than 2×N hand-tuned combinations.
 *
 * ── Why a style is MORE than a token swap ───────────────────────────────
 * The feel-bearing DIMENSIONS below are the axes a pure token swap ignores:
 * two styles can share the Tier-0 scale yet feel utterly different because
 * their silhouette, elevation philosophy, surface treatment, and component
 * silhouettes diverge. The registry names those dimensions so each style (and
 * its DESIGN.md) is authored against the same rubric.
 *
 * This module is the schema + the registration of the first two styles
 * (Warm Editorial, the current default; Soft / Playful, the existing pill
 * alternate). Each later "Style: …" subtask (7.3.33–7.3.42) ADDS its entry
 * here, ships a `[data-style='<id>']` block in globals.css, and authors its
 * `docs/styles/<id>.md` DESIGN.md.
 */

/**
 * The feel-bearing axes a named style controls. A token-only swap reaches the
 * first few; the rest (surface treatment, motion, typography, component
 * silhouettes) are what give a style its identity and must be authored, not
 * derived. The order here is the canonical presentation order (the `/tokens`
 * page + each style's DESIGN.md walk them in this sequence).
 */
export const STYLE_DIMENSIONS = [
  {
    key: 'silhouette',
    label: 'Shape / silhouette',
    description:
      'Corner-radius personality — sober rectangles vs. soft pills vs. hard right angles.',
  },
  {
    key: 'stroke',
    label: 'Border / stroke',
    description: 'Hairline vs. heavy outline; whether structure is drawn with borders at all.',
  },
  {
    key: 'elevation',
    label: 'Elevation philosophy',
    description: 'How depth is expressed — soft diffuse shadows, hard offset shadows, or flat.',
  },
  {
    key: 'surface',
    label: 'Surface / background treatment',
    description:
      'Opaque cards vs. translucent glass vs. tinted washes — the material of a surface.',
  },
  {
    key: 'density',
    label: 'Density rhythm',
    description: 'Padding/sizing cadence — compact and efficient vs. roomy and relaxed.',
  },
  {
    key: 'motion',
    label: 'Motion',
    description: 'Transition speed and easing — snappy, gentle, or springy.',
  },
  {
    key: 'typography',
    label: 'Typography',
    description: 'Type pairing and treatment — editorial serif, geometric sans, mono accents.',
  },
  {
    key: 'components',
    label: 'Component silhouettes',
    description:
      'Per-component shape overrides beyond tokens (e.g. a pill button vs. a square one).',
  },
] as const;

export type StyleDimensionKey = (typeof STYLE_DIMENSIONS)[number]['key'];

/** A registered, runtime-selectable style. */
export interface StyleDefinition {
  /** The `data-style` attribute value. Stable; used as the localStorage value. */
  id: string;
  /** Display name shown in the gallery / `/tokens` toggle. */
  name: string;
  /** One-line characterization of the feel. */
  tagline: string;
  /** Where the look is drawn from (credit / mood anchor). */
  inspiration: string;
  /** One line per feel-bearing dimension — the authored rubric for this style. */
  dimensions: Record<StyleDimensionKey, string>;
  /**
   * Repo-relative path to this style's DESIGN.md — the doc the `/tokens` page
   * composes (and a later getdesign-style swap reads). Every registered style
   * maps to exactly one.
   */
  designDoc: string;
}

/**
 * The registry. Insertion order is the gallery order. Each `id` matches a
 * `[data-style='<id>']` block in app/globals.css (Warm Editorial is the base,
 * so its block is the Tier-0 defaults — no override block needed).
 */
export const STYLE_REGISTRY = {
  'warm-editorial': {
    id: 'warm-editorial',
    name: 'Warm Editorial',
    tagline: 'Thoughtful, warm, technical-but-not-cold, slightly editorial.',
    inspiration: "Notion's warm palette + Source Serif headlines over Inter body.",
    designDoc: 'docs/styles/warm-editorial.md',
    dimensions: {
      silhouette: 'Sober rectangles — 8px buttons, 12px cards. Restrained, document-like.',
      stroke: 'Hairline borders (1px warm-grey); structure drawn quietly, never heavy.',
      elevation: 'Modest, low-spread shadows; surfaces sit close to the page.',
      surface: 'Opaque cream surfaces over a white canvas; pastel tints for feature cards only.',
      density: 'Comfortable default rhythm — 18×10 button padding, 24px card padding.',
      motion: 'Brisk 150ms ease; understated, gets out of the way.',
      typography: 'Source Serif 4 editorial headlines + Inter body + JetBrains Mono meta.',
      components:
        'Rectangular buttons/inputs, hairline-bordered cards, badge pills for status only.',
    },
  },
  'soft-playful': {
    id: 'soft-playful',
    name: 'Soft / Playful',
    tagline: 'More energy — rounded, generous, gently animated.',
    inspiration: "Figma's pill-shape language (50px pills, roomy spacing).",
    designDoc: 'docs/styles/soft-playful.md',
    dimensions: {
      silhouette: 'Pill buttons (fully rounded) and large 24px card/input radii. Friendly, bubbly.',
      stroke: 'Same hairline borders as the base; identity comes from radius, not stroke weight.',
      elevation: 'Softer, more diffused shadows — surfaces float a touch more.',
      surface: 'Opaque, like the base — colour stays the palette axis; only the shape softens.',
      density: 'Roomier — 20×12 button padding, 28px card padding, taller controls.',
      motion: 'Gentler 200ms ease and a slightly deeper press scale for a springy feel.',
      typography: 'Inherits the base type pairing; the personality is in shape, not type.',
      components: 'Pill buttons, heavily-rounded inputs/cards/modals, rounder small affordances.',
    },
  },
  'swiss-minimal-flat': {
    id: 'swiss-minimal-flat',
    name: 'Swiss / Minimal-Flat',
    tagline: 'International-typographic, structural, calm — flat, sharp, gridded.',
    inspiration: 'Swiss International Typographic Style — Müller-Brockmann grids, flat surfaces.',
    designDoc: 'docs/styles/swiss-minimal-flat.md',
    dimensions: {
      silhouette:
        'Sharp near-square corners (2px) on every surface — hard right angles, structural.',
      stroke:
        'Hairline borders do ALL the structural work; with elevation removed, the 1px rule is the only divider.',
      elevation:
        'Flat — every shadow is removed (none). Depth comes from borders + whitespace, not lift.',
      surface:
        'Opaque, untinted panels delineated by hairline rules; no floating, no glass, no wash.',
      density:
        'Tight, gridded controls (crisp 16×9 buttons, 34px control height) with generous 28px card whitespace.',
      motion:
        'Minimal — fast 100ms transitions and NO press-scale (calm, mechanical, never springy).',
      typography:
        'Restrained neo-grotesque sans throughout — headlines drop the editorial serif for Inter, tight and strong.',
      components:
        'Square buttons/inputs/cards/modals, rectangular (non-pill) status chips, flat hairline-ruled surfaces.',
    },
  },
} satisfies Record<string, StyleDefinition>;

/** The id of every registered style — `data-style` value space. */
export type StyleId = keyof typeof STYLE_REGISTRY;

/** All registered style ids, in gallery order. */
export const STYLE_IDS = Object.keys(STYLE_REGISTRY) as StyleId[];

/**
 * The default style a fresh install / unset preference resolves to. Warm
 * Editorial is Motir's house style and the Tier-0 base.
 */
export const DEFAULT_STYLE_ID: StyleId = 'warm-editorial';

/** Narrowing guard — is an arbitrary string a registered style id? */
export function isStyleId(value: unknown): value is StyleId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STYLE_REGISTRY, value);
}

/** Resolve a (possibly stale / unknown) value to a valid style definition. */
export function resolveStyle(value: unknown): StyleDefinition {
  return STYLE_REGISTRY[isStyleId(value) ? value : DEFAULT_STYLE_ID];
}
