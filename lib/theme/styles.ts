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
 * A `[data-style='…']` TOKEN block in globals.css MUST override ONLY shape/feel
 * tokens (radius / spacing / shadow / sizing / transition / type) — NEVER a
 * `--color-*` or `--el-*` colour token. That is the palette axis's job, and
 * keeping the two disjoint is what makes "style × palette" a true product of
 * two independent choices rather than 2×N hand-tuned combinations.
 *
 * A SURFACE-MATERIAL style (glassmorphism, 7.3.35; later cybercore, aurora,
 * neumorphism …) owns a richer surface — translucency, a gradient canvas,
 * frosted backdrop-blur — that the token block cannot express. It adds a
 * palette-DERIVED MATERIAL LAYER: style-scoped component rules
 * (`[data-style='id'] [data-surface='…'] { … }`) whose colour comes ONLY from
 * `color-mix()`/`var(--color-*|--el-*)` over the ACTIVE palette, never a raw
 * hue — so the two axes stay disjoint (a palette swap re-tints the material; a
 * style swap leaves hues untouched). Surfaces opt in via the `data-surface`
 * hook the shared primitives emit. Both rules are enforced by
 * tests/theme/styleRegistry.test.ts.
 *
 * ── Why a style is MORE than a token swap ───────────────────────────────
 * The feel-bearing DIMENSIONS below are the axes a pure token swap ignores:
 * two styles can share the Tier-0 scale yet feel utterly different because
 * their silhouette, elevation philosophy, surface treatment, and component
 * silhouettes diverge. The registry names those dimensions so each style (and
 * its DESIGN.md) is authored against the same rubric.
 *
 * This module is the schema + the registration of the styles. Each "Style: …"
 * subtask (7.3.33–7.3.42) ADDS its entry here, ships a `[data-style='<id>']`
 * token block in globals.css (plus, for a surface-material style, the
 * palette-derived material layer above), and authors its `docs/styles/<id>.md`
 * DESIGN.md.
 */

import { DEFAULT_TYPE_ID, type TypeId } from './typography';

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
    description:
      "The style's DEFAULT type pairing — type is the independent `data-type` axis now (see ./typography.ts + `defaultTypeId`); this describes the pairing the style ships with: editorial serif, all-sans, or mono headlines.",
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
  /**
   * The type pairing (`data-type`, see ./typography.ts) this style applies when
   * the user has NOT pinned an explicit type — the style's curated default,
   * overridable. Type is its own axis now; this is how a style keeps its
   * out-of-the-box typographic feel (e.g. swiss → `motir-sans`, neo-brutalism /
   * cybercore-y2k → `motir-mono`) without owning `--font-*` in its own block.
   */
  defaultTypeId: TypeId;
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
    defaultTypeId: 'motir',
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
    defaultTypeId: 'motir',
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
    defaultTypeId: 'motir-sans',
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
  'neo-brutalism': {
    id: 'neo-brutalism',
    name: 'Neo-Brutalism',
    tagline: 'Raw, punchy, utilitarian — 0px corners, thick borders, hard-offset shadows.',
    inspiration:
      'Neo-brutalist web design — Gumroad / Figma-community brutalism: blocky, unpolished, loud.',
    designDoc: 'docs/styles/neo-brutalism.md',
    defaultTypeId: 'motir-mono',
    dimensions: {
      silhouette:
        'Zero radius — hard 0px corners on EVERY surface (buttons, cards, inputs, modals, status chips). Blocky and uncompromising.',
      stroke:
        'Heavy solid 2px outlines do the structural work — borders are LOUD, not hairline (the defining neo-brutalist move, applied via a style-scoped component-variant block).',
      elevation:
        'Hard-offset drop shadows with ZERO blur (e.g. 4px 4px 0 0) — a solid block of shadow, never a soft lift; the chunky frame, not diffusion.',
      surface:
        'Opaque, flat, untinted panels framed by the thick border + the hard shadow; no glass, no wash, no gradient.',
      density:
        'Tight, utilitarian controls (16×10 buttons, 36px control height) with compact 20px card padding — no wasted space.',
      motion:
        'Snappy and mechanical — near-instant 60ms transitions and NO press-scale; the UI reacts, it does not animate.',
      typography:
        'Raw monospace headlines — the editorial serif is re-pointed at the JetBrains Mono stack, against the Inter grotesk body.',
      components:
        'Square buttons/inputs/cards/modals, rectangular (non-pill) status chips, thick-bordered surfaces with hard-offset shadows.',
    },
  },
  glassmorphism: {
    id: 'glassmorphism',
    name: 'Glassmorphism',
    tagline: 'Translucent frosted glass floating over a soft, vibrant gradient.',
    inspiration:
      "Apple's visionOS / macOS Big Sur 'frosted glass' material — backdrop-blur over depth.",
    designDoc: 'docs/styles/glassmorphism.md',
    defaultTypeId: 'motir',
    dimensions: {
      silhouette:
        'Soft, rounded glass tiles — 12px buttons/inputs, 18px cards, 22px modals. Friendly, never sharp.',
      stroke:
        'Light 1px hairlines at reduced opacity — a glass edge catching light, not a structural rule.',
      elevation:
        'Layered, diffuse, low-opacity shadows — panels float as hovering frosted sheets above the canvas.',
      surface:
        'The identity axis: translucent frosted panels (backdrop-blur) over a soft palette-derived gradient canvas — material, not opaque.',
      density:
        'Comfortable, a touch roomy — 20×11 buttons, 26px card padding, 38px controls; glass tiles want air.',
      motion:
        'Gentle, smooth — 220ms ease and a light press-scale; glass slides into place, it never snaps.',
      typography:
        'Inherits the base editorial type pairing; the personality is in the material, not the type.',
      components:
        'Rounded frosted cards / popovers / modals / sidebar / inputs (the data-surface material layer), pill status chips.',
    },
  },
  'cybercore-y2k': {
    id: 'cybercore-y2k',
    name: 'Cybercore / Y2K',
    tagline: 'Neon-on-dark retro-tech — glowing HUD panels, a tech grid, mono headlines.',
    inspiration:
      'Y2K / cyberpunk HUDs — neon-on-dark terminals, Tron grids, glowing edges, monospace displays.',
    designDoc: 'docs/styles/cybercore-y2k.md',
    defaultTypeId: 'motir-mono',
    dimensions: {
      silhouette:
        'Hard terminal-frame corners (sharp 2–4px) — chiseled HUD panels, not soft cards.',
      stroke:
        'Structure drawn by a lit edge — a 1px glow-ring (currentColor halo) on every surface, not a heavier border.',
      elevation:
        'Neon GLOW instead of drop-shadow — surfaces emit an outward currentColor halo, lit rather than lifted.',
      surface:
        'A faint tech grid (scanline/grid texture) washes the canvas behind opaque HUD panels.',
      density:
        'Tight, technical HUD rhythm — compact controls (18×9 buttons, 34px control height) over snug 20px card padding.',
      motion: 'Snappy and electric — very fast 90ms transitions with a crisp press-scale.',
      typography:
        'Mono/display headlines — the serif headline face is swapped to JetBrains Mono for a terminal read; body stays sans.',
      components:
        'Sharp glow-ringed panels, mono headings, rectangular chips; the lit edge replaces the drop shadow everywhere.',
    },
  },
  aurora: {
    id: 'aurora',
    name: 'Aurora',
    tagline: 'Soft, drifting aurora light behind fluid, gently-glowing surfaces.',
    inspiration:
      'The northern lights — slow ribbons of colour over a night sky — and the soft animated-gradient "aurora" hero look (Stripe / Vercel ambient gradients).',
    designDoc: 'docs/styles/aurora.md',
    defaultTypeId: 'motir',
    dimensions: {
      silhouette:
        'Fluid, soft corners — 14px buttons/inputs, 20px cards, 26px modals. Organic and rounded, a touch softer than glass.',
      stroke:
        'Quiet 1px hairlines; structure is implied by the gentle glow and elevation, never drawn by a heavy rule.',
      elevation:
        'A soft neutral lift PLUS a gentle palette-derived COLOUR glow halo — surfaces feel lit from within, never hard-edged.',
      surface:
        'The identity axis: opaque fluid surfaces floating over a slowly-DRIFTING, animated aurora gradient canvas (palette-derived ribbons).',
      density:
        'Comfortable and roomy — 20×11 buttons, 26px card padding, 38px controls; the light wants space to breathe.',
      motion:
        'Smooth and slow — 260ms eased transitions, a faint press-scale, and a 28s ambient drift of the aurora canvas (stilled under prefers-reduced-motion).',
      typography:
        'Inherits the base editorial pairing (Source Serif headlines + Inter body); the personality is in the moving light, not the type.',
      components:
        'Fluid, gently-glowing cards / popovers / modals / sidebar (the data-surface material layer); pill status chips.',
    },
  },
  '3d-immersive': {
    id: '3d-immersive',
    name: '3D / Immersive',
    tagline: 'Depth and perspective — dimensional cards floating over the page.',
    inspiration:
      'Spatial / depth UI — visionOS spatial layers, Stripe-era layered cards, soft real-world light.',
    designDoc: 'docs/styles/3d-immersive.md',
    defaultTypeId: 'motir',
    dimensions: {
      silhouette:
        'Generously rounded dimensional tiles — 14px buttons/inputs, 20px cards, 28px modals. Soft, tactile, never sharp.',
      stroke:
        'Borders nearly vanish (a faint hairline) — structure is read from depth + shadow, not an outline.',
      elevation:
        'The identity axis: deep multi-layer shadows float every surface off the canvas, and on tilt a card becomes a TRUE 3D object — perspective + preserve-3d + per-slot translateZ planes (header pops forward, footer behind) parallax under a cursor-tracked glare. Not a flat-plane tilt.',
      surface:
        'A palette-derived immersive background atmosphere on every page, with opaque dimensional panels (cards, tables, board columns, widgets) floating above it on deep resting shadows — depth (not tint or glass) is the material; nothing sits flat.',
      density:
        'Roomy and immersive — 22×12 buttons, 28px card padding, 40px controls; depth wants air around each tile.',
      motion:
        'The standard "3D card" pointer-parallax — tiles tip toward the cursor (rotateX/rotateY over a perspective) via the ImmersiveTilt engine, lifting as they turn; reduced-motion-gated, settling flat on leave.',
      typography:
        'Inherits the base editorial type pairing; the personality is in depth + light, not the type.',
      components:
        'Rounded cards / board cards / modals that tilt toward the pointer with layered parallax; PHYSICAL buttons with real thickness (a solid base edge) that press DOWN on click; each board column floats as its own card. Nothing is flat.',
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

/**
 * styleId → its `defaultTypeId` — the type pairing applied when the user has
 * not pinned an explicit `data-type`. Baked into the FOUC init script (so the
 * pre-hydration pass can resolve the right type for the active style) and used
 * by the theme context's effective-type derivation. `resolveType` (the
 * registry) supplies the ultimate fallback, so every value here is a real id.
 */
export const STYLE_DEFAULT_TYPE: Record<StyleId, TypeId> = Object.fromEntries(
  STYLE_IDS.map((id) => [id, STYLE_REGISTRY[id].defaultTypeId]),
) as Record<StyleId, TypeId>;

/** The default type for a (possibly unknown) style value — the fallback chain. */
export function defaultTypeForStyle(styleValue: unknown): TypeId {
  return isStyleId(styleValue) ? STYLE_REGISTRY[styleValue].defaultTypeId : DEFAULT_TYPE_ID;
}
