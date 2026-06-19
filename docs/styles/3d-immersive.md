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

**Where the "depth" comes from.** Two halves:

1. **Static depth (CSS tokens).** Every shadow token becomes a **deep, multi-layer**
   drop — a top specular highlight (a lit edge where light catches the raised
   tile) + a tight contact shadow + a mid ambient + a wide, soft key light far
   below — so each surface lifts dramatically off the canvas and reads as a
   physical object floating in space. The light/ink is literal `rgba` (white
   highlight + near-ink shadow), never a palette token, so the colour axis is
   untouched and the active palette's AA contrast is preserved by construction.
2. **The 3D interaction (the `ImmersiveTilt` engine).** This is the one style
   that ships a **behaviour**, not just CSS tokens — because the standard "3D
   card" effect (vanilla-tilt.js / react-parallax-tilt / Atropos) is
   _intrinsically interactive_ and a CSS `[data-style]` block cannot express it.
   A shell-mounted engine ([`components/theme/ImmersiveTilt.tsx`](../../components/theme/ImmersiveTilt.tsx))
   reads the cursor over a `[data-tilt]` tile and tips it **toward the pointer**
   (`rotateX`/`rotateY` over a perspective), lifting it as it turns. It is active
   **only** when this style is selected and the user has **not** requested reduced
   motion (both observed live), and settles the tile flat on leave.

**How it differs from Glassmorphism:** both are soft, rounded, and floating, but
Glassmorphism is a translucent **material** (frosted backdrop-blur over a
palette-derived gradient canvas), whereas 3D / Immersive is **opaque depth** —
real layered light and lift, no blur, no tint, no gradient canvas. Glass re-tints
with the palette; 3D's depth is colour-free and stays constant across palettes.

## Feel-bearing dimensions

| Dimension             | 3D / Immersive                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Shape / silhouette    | Generously rounded dimensional tiles — 14px buttons/inputs, 20px cards, 28px modals. Soft, tactile.                      |
| Border / stroke       | Borders nearly vanish (a faint hairline) — structure is read from depth + shadow, not an outline.                        |
| Elevation philosophy  | The identity: deep, layered two-stop shadows (ambient wash + directional key light) float every surface.                 |
| Surface / background  | Opaque dimensional cards floating over the canvas; depth (not tint or glass) is the material.                            |
| Density rhythm        | Roomy and immersive — 22×12 buttons, 28px card padding, 40px controls; depth wants air.                                  |
| Motion                | The standard 3D-card **pointer-parallax tilt** — tiles tip toward the cursor (reduced-motion-gated); settle on leave.    |
| Typography            | Inherits the base editorial pairing (`motir`); the personality is in depth + light, not the type.                        |
| Component silhouettes | Deeply-shadowed rounded cards / board cards / modals that tilt toward the pointer; pill status chips. Every tile floats. |

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

### The pointer-parallax tilt (the standard 3D-card effect)

The interactive half is the **standard "3D card" tilt** — the effect
vanilla-tilt.js / react-parallax-tilt / Atropos all implement — which a CSS
token block cannot express, so **this style ships a behaviour** (the one style
that does). Two parts:

- **The engine** — [`components/theme/ImmersiveTilt.tsx`](../../components/theme/ImmersiveTilt.tsx),
  mounted once in the app shell. A single delegated `pointermove` listener finds
  the `[data-tilt]` tile under the cursor, maps the pointer to a rotation
  (`lib/theme/tilt.ts` — pure, unit-tested), and writes per-tile `--tilt-rx` /
  `--tilt-ry` vars + a `data-tilt-active` flag (rAF-coalesced, one
  `getBoundingClientRect` per frame). It is **inert** unless `<html data-style>`
  is `3d-immersive` **and** the user has not requested reduced motion — both
  watched live (a `MutationObserver` + the `prefers-reduced-motion` media query),
  so toggling the style in the Appearance picker enables/disables it with no
  reload.
- **The CSS** — `[data-style='3d-immersive'] [data-tilt]` turns those vars into
  `transform: perspective(1100px) rotateX(var(--tilt-rx)) rotateY(var(--tilt-ry))`,
  deepening the shadow to `--shadow-elevated` while active and easing the tile
  flat on leave. The whole block lives inside
  `@media (prefers-reduced-motion: no-preference)`. It pins **no hue** (only
  `transform` and `box-shadow`), so the style/palette axes stay disjoint and
  `styleRegistry.test.ts`'s material-rule check (which inspects only
  colour-painting rules) skips it.

Tiles opt in with the **`data-tilt`** hook: the shared `Card` primitive (so
every card/panel across the app tilts) and the kanban `BoardCard` (so `/boards`
tips toward the cursor). While a board card is being dragged, dnd-kit's inline
`transform` overrides the tilt transform, so the two never fight.

## Why this is more than a token swap

The feel-bearing axes a pure radius swap would miss are all moved here:

- **Elevation** flips from "modest drop shadows" to **deep, multi-layer depth**
  (specular highlight + contact + ambient + far key light) — the single biggest
  static change and the source of the floating read.
- **Motion** adds the **pointer-parallax tilt** — the genuine 3D interaction, not
  just a colour transition — so tiles respond spatially to the cursor.
- **Density** opens up (roomy padding + taller controls), giving each lifted
  tile the air depth needs to read.

Because every `motir-core` primitive consumes the semantic shape tokens
(`Card` → `--radius-card` + `--shadow-card`, `Modal` → `--radius-modal` +
`--shadow-modal`, `Button` → `--radius-btn` + `--active-scale`, `Input` →
`--radius-input` + `--height-input`, `Popover` → `--shadow-elevated`), the token
block alone re-shapes the entire UI into floating tiles; the tilt engine adds the
interactive 3D on top.

## Accessibility & performance

This style is flagged **EXPERIMENTAL — performance + accessibility heavy; gate
carefully**, and it is gated on both fronts:

- **Reduced motion.** Both the tilt engine (it checks `prefers-reduced-motion`
  and won't run) AND the tilt CSS (wrapped in `@media (prefers-reduced-motion:
no-preference)`) are disabled for a reduced-motion user — belt and suspenders.
  They keep the static deep-shadow depth, which carries the whole identity with
  zero movement.
- **Performance.** Depth is **box-shadow** (compositor-friendly); the tilt moves
  only **`transform`** (GPU-accelerated, no layout/paint). The engine is a single
  passive delegated listener, rAF-coalesced to one rect read per frame — not a
  listener per card — and is completely idle for every other style.
- **Contrast.** The style changes no colour token, so the active palette's AA
  contrast is preserved by construction; the white specular highlight and the
  shadows sit on surface edges, never under text.
- **Contrast.** The style changes no colour token, so the active palette's AA
  contrast is preserved by construction (text/background pairs are untouched).
  The shadows sit on surface edges, never under text, so no foreground/background
  contrast is reduced. Verify on the `/tokens` specimen + the design-mockup
  render checklist.
