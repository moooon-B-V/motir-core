# Style — 3D / Immersive (`data-style="3d-immersive"`)

> **DEFERRED follow-up (post-v1), EXPERIMENTAL.** A complete design **direction**
> (shape/feel axis), authored in the Motir `DESIGN.md` shape so the onboarding
> **design wizard** can emit it for a user's product: pick "3D / Immersive" and
> this is the design language the build agent reads. Shipped in `motir-core` as
> the `[data-style='3d-immersive']` block in
> [`app/globals.css`](../../app/globals.css), the registry entry in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts), and the pointer-parallax
> engine [`components/theme/ImmersiveTilt.tsx`](../../components/theme/ImmersiveTilt.tsx)
> — so the spec below is a real, running reference, not an aspiration.

**Tagline:** Spatial depth — surfaces are physical objects on layered planes that
tip toward you and parallax under the light.
**Inspiration:** Spatial / depth UI — visionOS layers, Stripe-era layered cards,
the standard "3D card" tilt (vanilla-tilt.js / react-parallax-tilt / Atropos).
**Wrong moods:** flat, austere, gridded, papery, hard-edged, static.

This is the STYLE (shape/feel) axis only — **colour is the independent
`data-palette` axis**. Every depth effect here is colour-free or palette-derived,
so a palette swap re-tints the atmosphere and leaves the geometry alone, and a
style swap leaves hues alone. See [`../DESIGN.md`](../DESIGN.md) for the two-axis
contract.

---

## 1. Visual theme & atmosphere

The whole UI reads as a **shallow 3D scene**: an immersive depth field behind the
content, with every panel a physical object floating above it and tipping toward
the cursor. Nothing is flat-on-the-page. The mood is tactile, spatial, alive —
the opposite of a flat document. Calm depth, not a gimmick: motion is gated,
hierarchy comes from _Z-distance_ (how far a surface floats) as much as from size
or colour.

The single most important rule of this direction, and the one a half-hearted
implementation gets wrong: **3D is layered parallax, not a tilting flat plane.**
A card whose contents are glued to its face and rotates as one rigid rectangle
reads as "flat-with-a-tilt." A _real_ 3D surface puts its contents on **separate
depth planes** that move relative to each other as it tips. That separation —
`perspective` + `transform-style: preserve-3d` + per-layer `translateZ` — is §6.

## 2. Colour

3D / Immersive sets **no hue** — it inherits whatever `data-palette` is active and
preserves its AA contrast by construction. The two places this direction paints
pixels are both **palette-derived**, never a raw hue:

- the **immersive background** (a `color-mix()` depth field over `--el-accent` /
  `--el-link` / `--el-text` — §6), and
- the **glare** specular sweep (a `color-mix()` over `--el-page-bg` — §6/§7).

A palette swap re-tints both; a style swap touches neither. (Shadows use a fixed
near-ink `rgba`, the same the base shadows do — a shadow is not a palette colour.)

## 3. Typography

Inherits the base editorial pairing (`defaultTypeId: 'motir'`) — the personality
is depth and light, not type. (Type is the independent `data-type` axis; this
direction sets no `--font-*`.) One caveat the depth imposes: text on a tilted /
`translateZ`-lifted plane sub-pixel-softens slightly — keep body copy **on the
card face** (Z 0), and lift only short, large headers/labels onto a forward plane
where the softening is invisible.

## 4. Component depth treatment (the plane ladder)

Every surface is assigned a **depth plane**. The ladder (nearest the viewer →
farthest) and the elevation each surface carries:

| Surface                                                      | Plane / treatment                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Modal / dialog**                                           | Highest float — `--shadow-modal`; the page behind dims and recedes.                                                                                                                                                                                                                                                                                                      |
| **Popover / dropdown / menu**                                | Floats on `--shadow-elevated`; tips with the cursor like a small card.                                                                                                                                                                                                                                                                                                   |
| **Card — the reference 3D object**                           | Floats on `--shadow-card`. On tilt: the **header/title** rides a **front** plane (`translateZ ~42px`), the **footer** a nearer **back** plane (`~14px`), the **body stays on the face** (Z 0). A cursor-tracked **glare** sweeps the face.                                                                                                                               |
| **Board card (kanban tile)**                                 | A small card — tips toward the cursor, lifts on hover.                                                                                                                                                                                                                                                                                                                   |
| **Page panels** (work-item table, backlog, dashboard widget) | **Float, but do not tilt** — they're large; a full table tipping is disorienting and clips sticky headers. They carry the deep resting shadow only (see size-gating, §7).                                                                                                                                                                                                |
| **Board column**                                             | A tall panel in an `overflow-x-auto` row (which clips its drop shadow + occludes between neighbours). Gets a **tighter, clip/occlusion-safe** float shadow (small horizontal bleed) + extra row gap + bottom room, so **each column floats as its own distinct card** — never one backing slab. Its cards tilt individually.                                             |
| **Button — a PHYSICAL key**                                  | NOT flat. A filled button (primary / danger) has visible **thickness** — a solid base edge in a darker shade of its own fill (`--el-accent-pressed` / a darkened `--el-danger`, palette-derived) — and on click **presses DOWN onto its base** (`translateY(3px)`, the base compresses). Secondary gets a subtle neutral base edge; ghost stays flat (the quiet button). |
| **Input / control**                                          | On the face; generous rounded dimensional silhouette.                                                                                                                                                                                                                                                                                                                    |
| **Status pill / badge**                                      | Stays a flat pill on its parent's plane (a chip doesn't float).                                                                                                                                                                                                                                                                                                          |

The plane a surface sits on is the hierarchy: a modal is "closer" than a card,
which is "closer" than the table it sits in, which floats over the canvas.

## 5. Layout & density

Roomy and immersive — depth wants air around each floating object so its shadow
can read. Generous control padding (`--spacing-btn 22/12`, `--spacing-card-padding
28px`, `--height-control 40px`) and generous dimensional radii (cards 20px,
modals 28px, buttons/inputs 14px) — soft, tactile tiles, never sharp.

## 6. Depth & Elevation — the core of this direction

Two halves: **static depth** (always on, even under reduced motion) and the
**3D interaction** (gated).

### 6a. Static depth — the float

- **The shadow ladder is deep and multi-layer.** Every elevation token is a
  specular top highlight + a tight contact shadow + a mid ambient + a wide, soft
  key light far below — so a surface reads as a physical object lifted off the
  canvas, not a card with a faint drop shadow. Scales `--shadow-subtle` →
  `--shadow-card` → `--shadow-elevated` → `--shadow-modal` → `--shadow-hero-mockup`.
- **Every floating surface carries a resting shadow.** Default cards have none in
  the base style; here every `[data-tilt]` tile gets `--shadow-card` at rest so it
  lifts off the canvas. Static — applies under reduced motion too.
- **The immersive background.** `body` wears a palette-derived depth field —
  soft `color-mix()` washes from `--el-accent` (top) and `--el-link` (corner) plus
  a centre vignette from `--el-text`, `background-attachment: fixed`. It gives
  _every_ page (even flat tables) atmosphere and a sense of space the floating
  panels sit within.

### 6b. The 3D interaction — layered parallax (the proper technique)

This is what separates real 3D from a flat-plane tilt, and it is the standard
vanilla-tilt / Atropos technique:

1. **Perspective + `preserve-3d`.** While a tile is active the engine applies
   `transform: perspective(900px) rotateX(var(--tilt-rx)) rotateY(var(--tilt-ry))`
   AND `transform-style: preserve-3d` — establishing a real 3D coordinate space so
   the tile's children render _in depth_, not flattened onto its face.
2. **Per-layer `translateZ` (the parallax).** The card's slots ride different
   planes — header on a **front** plane (`translateZ(42px)`), footer on a **back**
   plane (`translateZ(14px)`), body on the **face** (Z 0). As the card tips, the
   planes shift relative to each other: the title visibly floats _above_ the body.
   That inter-layer motion is the 3D read; without it you get the "halfway" look.
3. **Cursor-tracked glare.** A `radial-gradient` specular sweep (palette-derived,
   `color-mix` over `--el-page-bg`) follows the pointer across the face
   (`--tilt-glare-x/y`), fading in only while active — the light catching a
   tilted surface.
4. **The tip itself.** Rotation maxes at ~7° at the edges, flat at the centre, on
   a tight `perspective(900px)` for a tangible (not extreme) tip; a gentle scale /
   deeper shadow as it lifts; eases flat on leave.

## 7. Motion & accessibility

- **The engine.** [`ImmersiveTilt`](../../components/theme/ImmersiveTilt.tsx),
  mounted once in the shell: one delegated, rAF-coalesced `pointermove` listener
  maps the cursor over a `[data-tilt]` tile to a rotation + glare position
  (`lib/theme/tilt.ts`, pure + unit-tested) and writes per-tile CSS vars. No
  per-tile listeners.
- **Size-gating.** Only tile-sized surfaces (≤ `MAX_TILE_PX` 560 in either
  dimension) _tilt_; larger panels (tables, columns, backlog) **float without
  tilting** — tipping a full table would be disorienting and could clip sticky
  headers / portaled menus.
- **Reduced motion (the "gate carefully" caveat).** The tilt + parallax + glare
  are disabled in **both** the engine (it checks `prefers-reduced-motion`) and the
  CSS (the whole interaction block is inside `@media (prefers-reduced-motion:
no-preference)`). A reduced-motion user keeps the full _static_ depth (deep
  shadows, immersive background, floating panels) with zero movement.
- **Performance.** Depth is `box-shadow` (compositor-friendly); the interaction
  animates only `transform` (GPU). Idle for every other style.
- **Contrast.** No colour token changes, so the palette's AA holds. Body copy
  stays on the face (Z 0) to avoid tilt sub-pixel softening; only short headers
  lift.

## 8. Do's & Don'ts

**Do**

- Put content on **depth planes** — lift short headers/labels onto a forward
  plane; keep body copy on the face.
- Express hierarchy with **Z-distance** (how far a surface floats) + the shadow
  ladder, not just size.
- Keep the immersive background and glare **palette-derived** (`color-mix` over
  `--el-*`), never a raw hue.

**Don't**

- ❌ Tilt a card as a **rigid flat plane** (no `preserve-3d`, no per-layer
  `translateZ`) — that is the "flat-design + 3D mix" failure this direction
  exists to avoid.
- ❌ Tilt **large panels** (tables, columns) — float them instead.
- ❌ Leave **buttons flat** — a 3D button has thickness and presses down; a flat
  button beside floating 3D cards is the inconsistency that reads as "half-3D".
- ❌ Give a **tall panel in a clipped scroll row** the wide card shadow — it
  clips at the bottom and occludes between neighbours, reading as one backing
  slab. Use a tighter shadow + gap (the board-column treatment, §4).
- ❌ Lift **body text / dense content** onto a Z-plane — it softens; only short
  headers/labels.
- ❌ Pin a hue in the background or glare — keep the colour axis disjoint.

---

## Implementation map (the running reference)

| Piece                                                           | Where                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Token block (radius / shadow ladder / density / motion)         | `[data-style='3d-immersive']` in [`app/globals.css`](../../app/globals.css)                                                       |
| Immersive background + resting float + tilt/parallax/glare CSS  | same file, the `[data-style='3d-immersive'] body` + `[data-tilt]` rules                                                           |
| Pointer-parallax engine (cursor → rotation + glare vars, gated) | [`components/theme/ImmersiveTilt.tsx`](../../components/theme/ImmersiveTilt.tsx) + [`lib/theme/tilt.ts`](../../lib/theme/tilt.ts) |
| Depth-plane hooks                                               | `data-tilt` (the floating tile) + `data-tilt-layer="front                                                                         | back"`(the parallax slots) — emitted by`Card`, `BoardCard`, and the page panels |
| Registry entry (the rubric dimensions)                          | `STYLE_REGISTRY['3d-immersive']` in [`lib/theme/styles.ts`](../../lib/theme/styles.ts)                                            |

**How the wizard uses this.** The onboarding design step lets a user pick a design
direction; "3D / Immersive" maps to **this document** as the design language, and
to the `[data-style='3d-immersive']` implementation as the reference build. The
emitted product `DESIGN.md` carries §1–§8 above (atmosphere, colour approach,
type, component plane ladder, layout, depth & elevation, motion, do/don't) — the
same shape as Motir's own [`DESIGN.md`](../DESIGN.md), grounded in
[getdesign.md](https://getdesign.md) references for the palette/type axes it
composes with.
