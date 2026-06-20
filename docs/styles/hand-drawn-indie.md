# Style — Hand-Drawn / Indie (`data-style="hand-drawn-indie"`)

> The sketchy, friendly, zine-like alternate (a DEFERRED post-v1 follow-up,
> Subtask 7.3.41). Shipped as the `[data-style='hand-drawn-indie']` block in
> [`app/globals.css`](../../app/globals.css) (Tier 2) plus a style-scoped
> component-variant rule for the ink border, registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Sketchy and friendly — wobbly hand-inked corners, soft offset
shadows, a playful bounce.
**Inspiration:** Indie / zine + hand-drawn web design — Excalidraw's rough
hand-sketched strokes and doodled notebook UIs: warm, imperfect, human.
**Wrong moods:** machined, precise, corporate, glassy, harsh, cold.

This is the STYLE (shape/feel) axis only. Colour is the independent
`data-palette` axis — Hand-Drawn / Indie inherits whatever palette is active and
changes no hue. The block overrides ONLY shape/feel tokens. See
[`DESIGN.md`](../DESIGN.md) for the colour system and the two-axis contract.

**How it differs from the Soft / Playful style:** both are friendly and rounded,
but Soft / Playful is **smooth and machined** — clean, symmetric pill/large radii
on every corner — whereas Hand-Drawn / Indie is **irregular and human**: each
corner of a surface gets a _different_ radius (the asymmetric "drawn box"), the
border thickens to a visible ink stroke, and the shadow is a hand-placed
down-right doodle rather than an even float. Soft / Playful is the polished end of
the rounded family; Hand-Drawn / Indie is the hand-sketched end.

## Feel-bearing dimensions

| Dimension             | Hand-Drawn / Indie                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Shape / silhouette    | Wobbly, hand-inked corners — an irregular asymmetric radius per surface; drawn boxes.       |
| Border / stroke       | Sketchy 1.5px ink outlines — heavier than a hairline so the drawn edge reads; pen on paper. |
| Elevation philosophy  | Soft, hand-placed offset shadows — a gentle blurred drop nudged down-right (a doodle).      |
| Surface / background  | Opaque, warm, paper-like panels; the irregular outline + soft shadow carry the feel.        |
| Density rhythm        | Roomy and relaxed (20×12 buttons, 26px card pad, 38px controls) — margins round the sketch. |
| Motion                | Springy + playful — 200ms transitions, a bouncy hover lift (1.02) + press squish (0.97).    |
| Typography            | Editorial pairing (Fraunces display headlines + Inter body), via `defaultTypeId`.           |
| Component silhouettes | Wobbly-cornered buttons/inputs/cards/modals, irregular (non-pill) chips, ink-bordered.      |

## Token overrides (`[data-style='hand-drawn-indie']`)

Only shape/feel tokens — no colour token appears in the block (the disjoint-axis
acceptance criterion; enforced by `tests/theme/styleRegistry.test.ts`):

- **Radius (silhouette):** the generic scale stays soft + single-valued
  (`--radius-xs … -xl: 5 → 20px`), but every **semantic surface** token takes an
  asymmetric **multi-value** radius — `--radius-btn / -input / -card / -modal /
-badge / -control / -kbd` each use the `a b c d / e f g h` (horizontal /
  vertical corner) syntax so no two corners share a radius. That is the
  hand-drawn tell: e.g. `--radius-card: 20px 14px 22px 13px / 13px 22px 14px 20px`
  renders a box whose four corners are each a little different — a _drawn_
  rectangle. **`--radius-badge`** is intentionally irregular (not a clean pill) so
  status chips read as hand-inked, and `--radius-pill` is **left untouched** so
  genuinely-circular affordances (avatars, status dots, the spinner) stay round.
- **Elevation:** `--shadow-{subtle,card,elevated,modal,hero-mockup}` become
  **soft, blurred, down-right-offset** shadows — `1px 2px 4px -1px` through
  `6px 12px 40px -10px`, all a warm `rgba(38, 30, 22, …)` ink at low opacity. A
  gentle, hand-placed drop (a doodled shadow), never a hard brutalist block nor a
  flat removal. The warm `rgba` literal is decorative shadow ink (it is NOT a
  `--color-*` token, so the colour axis stays disjoint — the same way the base
  shadows hard-code their `rgba`).
- **Density:** roomy, relaxed controls — `--spacing-btn-x/y: 20/12`,
  `--spacing-input-x/y: 16/12`, `--spacing-control-x/y: 12/8`,
  `--height-control: 38px`, `--height-input: 44px` — against a generous
  `--spacing-card-padding: 26px`. The sketch wants air around it.
- **Motion:** `--transition-duration: 200ms` (`--transition-fast: 130ms`,
  `--transition-slow: 320ms`) with **`--hover-scale: 1.02` / `--active-scale:
0.97`** — a bouncy hover lift and a deeper press squish, for a friendly wobble.

## Typography — via the type axis, not this block

Type is the independent `data-type` axis now (Subtask 7.3.53): a style keeps its
out-of-the-box typographic feel through **`defaultTypeId`**, never by overriding
`--font-*` in its own block (which the disjoint-axis test forbids). Hand-Drawn /
Indie ships **`defaultTypeId: 'editorial'`** — the Fraunces display-serif pairing
(characterful, soft, slightly-wonky headlines over an Inter body). Of the
registered pairings it is the warmest and most hand-cut, so its optical wonk
echoes the irregular shapes while the Inter body stays fully legible. (A true
marker / handwritten / script face would be the most literal match; that is a
future `data-type` addition — this style adopts the closest registered pairing
today, and will re-point `defaultTypeId` at a handwritten face when one ships.)
The user can still pin any other type; this is only the curated default.

## The ink border — a component-variant override

The sketchy-stroke axis — a **visible, slightly-heavier ink line** — has no
Tier-0 token: every primitive draws a 1px Tailwind `.border` coloured by
`--el-border*`, so a token swap alone cannot reach border WIDTH. Hand-Drawn /
Indie therefore ships the one **component-variant override** it needs (the
deliverable's "component-variant overrides" axis), a single style-scoped rule in
`app/globals.css`:

```css
[data-style='hand-drawn-indie'] .border {
  border-width: 1.5px;
}
```

It thickens the full box border on every framed surface (Button outline, Card,
Input, Modal, Pill, Popover, …) to a hand-inked 1.5px — **without** touching a
colour token or any component file, and **only** when this style is active (no
other style is affected). It is intentionally NOT a `[data-style='…'] { … }`
token block, so the disjoint-axis guard test (which inspects token blocks) leaves
it alone — and it sets no colour, so the two axes stay disjoint regardless.

## Why this is more than a token swap

The feel-bearing axes a pure radius swap would miss are all moved here:

- **Silhouette becomes irregular, not just rounded.** The signature move is the
  per-corner asymmetric radius — a machined rounded box (Soft / Playful) and a
  hand-drawn box are both "round", but only the asymmetric one reads as _drawn_.
- **Stroke** becomes a visible ink line: the 1.5px border (the component-variant
  override) is part of the sketch, not a quiet hairline.
- **Elevation** flips to a soft, intentionally-offset doodle shadow — warm, low,
  nudged down-right — rather than an even, centred float.
- **Motion** gains a springy hover lift + press squish, so the UI has a friendly
  bounce rather than a flat or mechanical response.

Because every `motir-core` primitive consumes the semantic shape tokens
(`Button` → `--radius-btn` + `--hover-scale`/`--active-scale`, `Card` →
`--radius-card` + `--shadow-card`, `Pill` → `--radius-badge`, `Input` →
`--radius-input` + `--height-input`, `Modal` → `--radius-modal` +
`--shadow-modal`) and the full `.border` utility, this token block plus the one
component-variant rule re-shapes the entire UI — no per-component edits are
needed (the same token-driven approach as `soft-playful`, `swiss-minimal-flat`,
and `neo-brutalism`).

## Accessibility

The style changes no colour token, so the active palette's AA contrast is
preserved by construction (text/background pairs are untouched), and the type
pairing (`editorial`) keeps the legible Inter body. The shape-side AA
considerations are satisfied too: the soft offset shadow is decorative (it
frames, it carries no text); structure stays unmistakably legible because the
1.5px ink border on every framed surface does the dividing work; and the
irregular radii are gentle (±a few px) — enough to read as hand-drawn without
clipping content or distorting hit targets. Verified by rendering the `/tokens`
specimen + style vignette in light and dark themes.
