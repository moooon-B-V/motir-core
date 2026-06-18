/**
 * The Motir TYPOGRAPHY LIBRARY — the named-pairing registry (Subtask 7.3.53).
 *
 * A "type pairing" is a named TYPOGRAPHY scheme the whole UI can swap to at
 * runtime — the THIRD design axis, completing the token decomposition
 * (Colour `data-palette` · Type `data-type` · Shape/feel `data-style`). It is
 * deliberately INDEPENDENT of the other two: a pairing decides which TYPEFACES
 * the product wears (the headline / body / mono role mapping); it never touches
 * a hue (palette axis) or a radius (style axis).
 *
 * ── The three-axis runtime contract ─────────────────────────────────────
 *   data-type="<type-id>"       — THIS axis. A `[data-type='<id>']` block in
 *                                 app/globals.css re-points the `--font-*`
 *                                 role tokens (sans / serif / mono) — and ONLY
 *                                 font tokens, never colour or shape.
 *   data-palette="<palette-id>" — the INDEPENDENT colour axis (`--el-*`).
 *   data-style="<style-id>"     — the INDEPENDENT shape/feel axis.
 *
 * The shared `--font-size-*` SCALE stays common across pairings — sizes are
 * layout, not brand; a pairing remaps the FACES, not the type scale.
 *
 * ── A style declares a DEFAULT pairing (overridable) ────────────────────
 * Typography used to be BUNDLED into the style axis: `swiss-minimal-flat`,
 * `neo-brutalism` and `cybercore-y2k` each re-pointed `--font-serif` inside
 * their own `[data-style]` block. That is now a disjointness violation (two
 * axes setting `--font-*`). The fix: each style declares a `defaultTypeId`
 * (see ./styles.ts) — the pairing applied when the user has NOT pinned an
 * explicit type — and the per-style font overrides move here, as pairings.
 * So out-of-the-box looks are UNCHANGED; the new freedom is that type is now
 * independently overridable (e.g. Swiss shape + a serif pairing).
 *
 * ── v1 — the base faces only (no new payload) ───────────────────────────
 * v1 registered three pairings built from the THREE already-loaded next/font
 * faces (Inter · Source Serif 4 · JetBrains Mono) — so they add ZERO font
 * payload and carry NO new-typeface design decision:
 *   - `motir`      — the base: editorial serif headlines over a sans body.
 *   - `motir-sans` — all-sans (Inter headlines); reproduces the Swiss look.
 *   - `motir-mono` — mono headlines; reproduces the Neo-Brutalism / Cybercore look.
 * `motir` is the base — like the `motir` palette / `warm-editorial` style it
 * needs NO `[data-type]` override block; the base `--font-*` tokens already are
 * it.
 *
 * ── New-typeface pairings (Grotesk / Editorial / Mono-Technical, 7.3.54–56) ──
 * Each adds a real type-design decision and loads its own next/font face(s),
 * re-pointing a role in its own `[data-type]` block:
 *   - `grotesk` (7.3.54)        — Space Grotesk headlines over the Inter body.
 *   - `editorial` (7.3.55)      — Fraunces display-serif headlines over the Inter
 *     body; a magazine, considered pairing (one new face — Inter + JetBrains reused).
 *   - `mono-technical` (7.3.56) — IBM Plex Mono headlines + meta over an Inter
 *     body; a precise, developer-grade pairing (one new face — Inter reused).
 * Each later "Type: …" subtask ADDS its entry here + a `[data-type]` block (its
 * face loaded in `app/layout.tsx`) + its `docs/typography/<id>.md`.
 */

/** A registered, runtime-selectable type pairing. */
export interface TypographyDefinition {
  /** The `data-type` attribute value. Stable; used as the localStorage value. */
  id: string;
  /** Display name shown in the gallery / `/tokens` toggle. */
  name: string;
  /** One-line characterization of the typographic feel. */
  tagline: string;
  /** The headline / body / mono face mapping (credit / what it loads). */
  faces: string;
  /**
   * Repo-relative path to this pairing's doc — the type-role reference a later
   * getdesign-style swap or the `/tokens` composer reads. Every registered
   * pairing maps to exactly one.
   */
  designDoc: string;
}

/**
 * The registry. Insertion order is the gallery order. Each non-base `id`
 * matches a `[data-type='<id>']` block in app/globals.css (`motir` is the base,
 * so its block is the Tier-0 `--font-*` defaults — no override block needed).
 */
export const TYPE_REGISTRY = {
  motir: {
    id: 'motir',
    name: 'Motir',
    tagline: 'Editorial serif headlines over a clean sans body — the house pairing.',
    faces: 'Source Serif 4 headlines · Inter body · JetBrains Mono meta.',
    designDoc: 'docs/typography/motir.md',
  },
  'motir-sans': {
    id: 'motir-sans',
    name: 'Motir Sans',
    tagline: 'All-sans — Inter for headlines and body; structural, no serif.',
    faces: 'Inter headlines + body · JetBrains Mono meta.',
    designDoc: 'docs/typography/motir-sans.md',
  },
  'motir-mono': {
    id: 'motir-mono',
    name: 'Motir Mono',
    tagline: 'Monospace headlines over a sans body — technical, code-native.',
    faces: 'JetBrains Mono headlines · Inter body.',
    designDoc: 'docs/typography/motir-mono.md',
  },
  grotesk: {
    id: 'grotesk',
    name: 'Grotesk',
    tagline:
      'Geometric neo-grotesque headlines over a clean sans body — tight, confident, product-y.',
    faces: 'Space Grotesk headlines · Inter body · JetBrains Mono meta.',
    designDoc: 'docs/typography/grotesk.md',
  },
  editorial: {
    id: 'editorial',
    name: 'Editorial',
    tagline: 'A characterful display serif over a humanist sans — magazine, considered.',
    faces: 'Fraunces display headlines · Inter body · JetBrains Mono meta.',
    designDoc: 'docs/typography/editorial.md',
  },
  'mono-technical': {
    id: 'mono-technical',
    name: 'Mono-Technical',
    tagline:
      'IBM Plex Mono headlines and meta over a neutral sans body — precise, developer-grade.',
    faces: 'IBM Plex Mono headlines + meta/code · Inter body. (one new face — Inter is reused)',
    designDoc: 'docs/typography/mono-technical.md',
  },
} satisfies Record<string, TypographyDefinition>;

/** The id of every registered pairing — `data-type` value space. */
export type TypeId = keyof typeof TYPE_REGISTRY;

/** All registered pairing ids, in gallery order. */
export const TYPE_IDS = Object.keys(TYPE_REGISTRY) as TypeId[];

/**
 * The default pairing a fresh install / unset preference resolves to when the
 * active style declares none. Motir is the house pairing and the Tier-0 base.
 */
export const DEFAULT_TYPE_ID: TypeId = 'motir';

/** Narrowing guard — is an arbitrary string a registered pairing id? */
export function isTypeId(value: unknown): value is TypeId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TYPE_REGISTRY, value);
}

/** Resolve a (possibly stale / unknown) value to a valid pairing definition. */
export function resolveType(value: unknown): TypographyDefinition {
  return TYPE_REGISTRY[isTypeId(value) ? value : DEFAULT_TYPE_ID];
}
