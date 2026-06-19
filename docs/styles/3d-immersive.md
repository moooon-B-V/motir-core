# Style — 3D / Immersive (`data-style="3d-immersive"`)

> **DEFERRED follow-up (post-v1), EXPERIMENTAL.** The depth + perspective
> alternate. Shipped as the `[data-style='3d-immersive']` block in
> [`app/globals.css`](../../app/globals.css) (Tier 2), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Depth and perspective — dimensional cards floating over the page.
**Inspiration:** Spatial / depth UI — visionOS spatial layers, Stripe-era
layered cards, soft real-world light.
**Wrong moods:** flat, austere, gridded, hard-edged, paper-like.

This is the STYLE (shape/feel) axis only. **Colour is the independent
`data-palette` axis** — 3D / Immersive inherits whatever palette is active and
changes no hue. The `[data-style]` block overrides ONLY shape/feel tokens; see
[`DESIGN.md`](../DESIGN.md) for the colour system and the two-axis contract.

**Where the "depth" comes from.** A style cannot set a colour, so the depth is
built entirely from **shape/feel tokens**: every shadow token becomes a deep,
**layered two-stop** drop (a tight ambient wash close to the surface PLUS a
wide, soft directional key light), so each surface lifts dramatically off the
canvas and reads as a physical object floating in space. The shadow ink is the
same literal near-ink the base shadows already hard-code (`rgba(15, 15, 15, …)`)
— never a palette token — so the colour axis is untouched and the active
palette's AA contrast is preserved by construction. The second half of the
identity — a **parallax lift toward you on hover** — is a small component-variant
rule (below), and it is **reduced-motion-gated**.

**How it differs from Glassmorphism:** both are soft, rounded, and floating, but
Glassmorphism is a translucent **material** (frosted backdrop-blur over a
palette-derived gradient canvas), whereas 3D / Immersive is **opaque depth** —
real layered light and lift, no blur, no tint, no gradient canvas. Glass re-tints
with the palette; 3D's depth is colour-free and stays constant across palettes.

## Feel-bearing dimensions

| Dimension             | 3D / Immersive                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Shape / silhouette    | Generously rounded dimensional tiles — 14px buttons/inputs, 20px cards, 28px modals. Soft, tactile.         |
| Border / stroke       | Borders nearly vanish (a faint hairline) — structure is read from depth + shadow, not an outline.           |
| Elevation philosophy  | The identity: deep, layered two-stop shadows (ambient wash + directional key light) float every surface.    |
| Surface / background  | Opaque dimensional cards floating over the canvas; depth (not tint or glass) is the material.               |
| Density rhythm        | Roomy and immersive — 22×12 buttons, 28px card padding, 40px controls; depth wants air.                     |
| Motion                | Smooth, floaty 260ms ease; interactive surfaces LIFT on hover (reduced-motion-gated), then settle.          |
| Typography            | Inherits the base editorial pairing (`motir`); the personality is in depth + light, not the type.           |
| Component silhouettes | Deeply-shadowed rounded cards / popovers / modals that lift on hover; pill status chips. Every tile floats. |

## Token overrides (`[data-style='3d-immersive']`)

Only shape/feel tokens — no colour token appears in the block (the disjoint-axis
acceptance criterion; enforced by `tests/theme/styleRegistry.test.ts`). The
shadow ink is `rgba(15, 15, 15, …)`, the same near-ink the base + neo-brutalism
shadow tokens use — never a `--color-*` / `--el-*`:

- **Radius (silhouette):** generous dimensional rounding — the generic scale
  opens up (`--radius-xs: 6px` … `--radius-xl: 24px`) and the semantic surfaces
  follow (`--radius-btn / -input: 14px`, `--radius-card: 20px`,
  `--radius-modal: 28px`, `--radius-control: 12px`, `--radius-kbd: 8px`), with
  **`--radius-badge: 9999px`** keeping soft dimensional status pills.
  `--radius-pill` is left **untouched** so genuinely-circular affordances
  (avatars, status dots, the spinner) stay round.
- **Elevation (the signature):** every shadow token becomes a **deep, layered
  two-stop** drop — a tight ambient wash + a wide soft key light — scaling up
  from `--shadow-subtle` through `--shadow-card`, `--shadow-elevated`,
  `--shadow-modal`, to `--shadow-hero-mockup` (the deepest float). Surfaces read
  as physical objects lifted off the page.
- **Typography:** unchanged — `defaultTypeId: 'motir'` (the base editorial
  pairing). A `[data-style]` block sets no `--font-*` token (the type axis is
  independent, `data-type`).
- **Density:** roomy — `--spacing-btn-x/y: 22/12`, `--spacing-input-x/y: 18/13`,
  `--spacing-control-x/y: 14/8`, `--height-control: 40px`, `--height-input: 46px`
  over a generous `--spacing-card-padding: 28px`; depth wants air around each tile.
- **Motion:** `--transition-duration: 260ms` (`--transition-fast: 180ms`,
  `--transition-slow: 360ms`) with `--active-scale: 0.98` — a slower, weighty
  ease so the depth feels heavy, with a gentle press that settles a lifted
  surface back down.

### The parallax lift (the perspective half)

The "motion + perspective" axis is carried by a small **component-variant
override** — `[data-style='3d-immersive'] [data-surface='card' | 'popover']` —
rather than a token (a token can't apply a `transform`). On hover, a floating
surface lifts (`translateY(-4px)`) and its shadow deepens to `--shadow-elevated`,
for a parallax/dimensional read. It pins **no hue** (transform + box-shadow only,
the box-shadow drawing the existing near-ink token), so the style/palette axes
stay disjoint, and `styleRegistry.test.ts`'s material-rule check (which inspects
only colour-painting rules) skips it. Surfaces opt in via the `data-surface` hook
the shared primitives already emit (the same hook glassmorphism frosts).

## Why this is more than a token swap

The feel-bearing axes a pure radius swap would miss are all moved here:

- **Elevation** flips from "modest drop shadows" to **deep, layered two-stop
  depth** — the single biggest visible change and the source of the floating read.
- **Motion** adds a reduced-motion-gated hover **lift**, so surfaces respond
  spatially to the cursor rather than only re-colouring.
- **Density** opens up (roomy padding + taller controls), giving each lifted
  tile the air depth needs to read.

Because every `motir-core` primitive consumes the semantic shape tokens
(`Card` → `--radius-card` + `--shadow-card`, `Modal` → `--radius-modal` +
`--shadow-modal`, `Button` → `--radius-btn` + `--active-scale`, `Input` →
`--radius-input` + `--height-input`, `Popover` → `--shadow-elevated`), the token
block alone re-shapes the entire UI into floating tiles; the only extra rule is
the hover lift (the same component-variant approach the schema sanctions for
richer styles).

## Accessibility & performance

This style is flagged **EXPERIMENTAL — performance + accessibility heavy; gate
carefully**, and it is gated on both fronts:

- **Reduced motion.** The hover lift + its transition live entirely inside an
  `@media (prefers-reduced-motion: no-preference)` block. A user who asks for
  reduced motion gets **no transform and no transition** — they keep the static
  deep-shadow depth, which carries the whole identity without any movement.
- **Performance.** The depth is expressed as **box-shadow** (compositor-friendly)
  and the hover animation moves only **`transform`** (GPU-accelerated, no layout
  or paint). Shadows are capped at two layers per token; the lift is confined to
  the floating `data-surface` primitives, not every element.
- **Contrast.** The style changes no colour token, so the active palette's AA
  contrast is preserved by construction (text/background pairs are untouched).
  The shadows sit on surface edges, never under text, so no foreground/background
  contrast is reduced. Verify on the `/tokens` specimen + the design-mockup
  render checklist.
