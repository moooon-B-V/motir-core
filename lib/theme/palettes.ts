/**
 * The Motir PALETTE LIBRARY — the named-colour registry (Subtask 7.3.48).
 *
 * A "palette" is a named COLOUR scheme the whole UI can swap to at runtime —
 * the second half of the two-axis contract the style schema (7.3.32) wrote but
 * did not implement. It is the COLOUR/hue axis, and it is deliberately
 * INDEPENDENT of the SHAPE axis (`data-style` — see ./styles.ts): a palette
 * decides what colours the product WEARS (surfaces, ink, accent, tints,
 * semantic hues); a style decides how it FEELS (silhouette, elevation,
 * density, motion). Picking a palette never changes a radius, and picking a
 * style never changes a hue.
 *
 * ── The two-axis runtime contract ───────────────────────────────────────
 *   data-palette="<palette-id>" — THIS axis. Layers per-palette `--el-*`
 *                                 element-token overrides over the Tier-3
 *                                 base in app/globals.css.
 *   data-style="<style-id>"     — the INDEPENDENT shape/feel axis.
 *   data-theme="light|dark"     — the light/dark base WITHIN a palette
 *                                 (`--color-*`); orthogonal to the palette.
 *
 * A `[data-palette='…']` block in globals.css MUST override ONLY `--el-*`
 * element colour tokens — NEVER a shape/feel token (radius / spacing / shadow
 * / sizing / motion / type). That is the style axis's job, and keeping the two
 * disjoint is what makes "style × palette" a true product of two independent
 * choices rather than N×M hand-tuned combinations.
 *
 * ── v1 — Motir's own palette ─────────────────────────────────────────────
 * v1 ships exactly ONE registered palette: **Motir** — the warm, Notion-warm
 * scheme the product already wears (cream surfaces, charcoal ink, purple
 * primary, pastel feature tints). It is the Tier-0/Tier-3 BASE, so — exactly
 * like the `warm-editorial` base style — it needs NO `[data-palette]` override
 * block; the base `--el-*` tokens already are it. (Per Yue, 2026-06-17: "use
 * Motir's colour palette for the v1.") Each later "Palette: …" subtask ADDS its
 * entry here, ships a `[data-palette='<id>']` block in globals.css overriding
 * the `--el-*` layer, and authors its `docs/palettes/<id>.md` doc — exactly the
 * shape the per-style subtasks (7.3.33+) follow on the other axis.
 */

/** A registered, runtime-selectable colour palette. */
export interface PaletteDefinition {
  /** The `data-palette` attribute value. Stable; used as the localStorage value. */
  id: string;
  /** Display name shown in the gallery / `/tokens` toggle. */
  name: string;
  /** One-line characterization of the colour mood. */
  tagline: string;
  /** Where the colours are drawn from (credit / mood anchor). */
  inspiration: string;
  /**
   * Repo-relative path to this palette's doc — the colour-role reference a
   * later getdesign-style swap or the `/tokens` composer reads. Every
   * registered palette maps to exactly one.
   */
  designDoc: string;
}

/**
 * The registry. Insertion order is the gallery order. Each `id` matches a
 * `[data-palette='<id>']` block in app/globals.css (Motir is the base, so its
 * block is the Tier-3 defaults — no override block needed).
 */
export const PALETTE_REGISTRY = {
  motir: {
    id: 'motir',
    name: 'Motir',
    tagline: 'Warm and editorial — cream surfaces, charcoal ink, a purple primary, pastel tints.',
    inspiration: "Notion's warm marketing palette — the product's house colours.",
    designDoc: 'docs/palettes/motir.md',
  },
  cobalt: {
    id: 'cobalt',
    name: 'Cobalt',
    tagline:
      'Cool and institutional — slate-cool surfaces, a confident cobalt primary, cooled tints.',
    inspiration:
      "Coinbase's clean institutional blue + IBM's structured blue, on Radix Blue/Indigo/Slate scales.",
    designDoc: 'docs/palettes/cobalt.md',
  },
  graphite: {
    id: 'graphite',
    name: 'Graphite',
    tagline:
      'Stark and editorial — cool greyscale surfaces + ink, an ink CTA, a single restrained cool-blue accent.',
    inspiration:
      "Vercel's black-and-white precision + Linear's ultra-minimal, on Radix Slate/Blue scales.",
    designDoc: 'docs/palettes/graphite.md',
  },
  evergreen: {
    id: 'evergreen',
    name: 'Evergreen',
    tagline:
      'Fresh and technical — an emerald primary over cooled forest neutrals, a green-leaning UI.',
    inspiration:
      'getdesign.md — Supabase (dark emerald) / Spotify (vibrant green) / MongoDB (spring green), on Radix green/jade ramps.',
    designDoc: 'docs/palettes/evergreen.md',
  },
  spectrum: {
    id: 'spectrum',
    name: 'Spectrum',
    tagline:
      'Vibrant and playful — crisp cool surfaces, a bright violet primary, a candy-bright multi-hue accent & tint set.',
    inspiration:
      "Figma's vibrant multi-colour brand + Airtable's colourful, friendly palette, on Radix Violet/Iris/Pink/Blue scales.",
    designDoc: 'docs/palettes/spectrum.md',
  },
  amber: {
    id: 'amber',
    name: 'Amber',
    tagline:
      'Warm and energetic — a bright trading-floor gold primary over warm sand neutrals; dark labels on the gold.',
    inspiration:
      'getdesign.md — Binance (bold yellow on monochrome) / ClickHouse / Miro (bright yellow), on Radix Amber/Yellow + Sand scales.',
    designDoc: 'docs/palettes/amber.md',
  },
  sienna: {
    id: 'sienna',
    name: 'Sienna',
    tagline:
      'Warm and friendly — a burnt-orange primary over terracotta-warm neutrals; an inviting, workshop feel.',
    inspiration:
      'getdesign.md — Zapier (warm, friendly, illustration-driven orange), on Radix Orange/Tomato + Sand scales.',
    designDoc: 'docs/palettes/sienna.md',
  },
  garnet: {
    id: 'garnet',
    name: 'Garnet',
    tagline:
      'Rich and bold — a deep wine-red primary over warm rose-grey neutrals; white labels on the garnet.',
    inspiration:
      'getdesign.md — Ferrari (Ferrari red) / Pinterest / Sanity (red accent), on Radix Red/Ruby/Crimson + Sand scales.',
    designDoc: 'docs/palettes/garnet.md',
  },
} satisfies Record<string, PaletteDefinition>;

/** The id of every registered palette — `data-palette` value space. */
export type PaletteId = keyof typeof PALETTE_REGISTRY;

/** All registered palette ids, in gallery order. */
export const PALETTE_IDS = Object.keys(PALETTE_REGISTRY) as PaletteId[];

/**
 * The default palette a fresh install / unset preference resolves to. Motir is
 * the house palette and the Tier-3 base.
 */
export const DEFAULT_PALETTE_ID: PaletteId = 'motir';

/** Narrowing guard — is an arbitrary string a registered palette id? */
export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PALETTE_REGISTRY, value);
}

/** Resolve a (possibly stale / unknown) value to a valid palette definition. */
export function resolvePalette(value: unknown): PaletteDefinition {
  return PALETTE_REGISTRY[isPaletteId(value) ? value : DEFAULT_PALETTE_ID];
}
