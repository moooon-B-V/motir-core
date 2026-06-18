# Style — Soft / Playful (`data-style="soft-playful"`)

> The energetic pill-shape alternate. Shipped as the `[data-style='soft-playful']`
> block in [`app/globals.css`](../../app/globals.css) (Tier 2), registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** More energy — rounded, generous, gently animated.
**Inspiration:** Figma's pill-shape language (50px pills, roomy spacing).

This is the STYLE (shape/feel) axis only. Colour is the independent
`data-palette` axis — Soft / Playful inherits whatever palette is active and
changes no hue. The block overrides ONLY shape/feel tokens.

## Feel-bearing dimensions

| Dimension             | Soft / Playful                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| Shape / silhouette    | Pill buttons (fully rounded) and large 24px card/input radii. Friendly.       |
| Border / stroke       | Same hairline borders as the base; identity comes from radius, not weight.    |
| Elevation philosophy  | Softer, more diffused shadows — surfaces float a touch more.                  |
| Surface / background  | Opaque, like the base — only the shape softens (colour stays the palette).    |
| Density rhythm        | Roomier — 20×12 button padding, 28px card padding, taller controls.           |
| Motion                | Gentler 200ms ease and a slightly deeper press scale for a springy feel.      |
| Typography            | Inherits the base type pairing; the personality is in shape, not type.        |
| Component silhouettes | Pill buttons, heavily-rounded inputs/cards/modals, rounder small affordances. |

## Token overrides (`[data-style='soft-playful']`)

Only shape/feel tokens — no colour token appears in the block:

- **Radius:** `--radius-btn: 9999px` (pill), `--radius-input: 24px`,
  `--radius-card: 24px`, `--radius-modal: 32px`, `--radius-control: 12px`,
  `--radius-kbd: 8px`.
- **Elevation:** softened `--shadow-card / -elevated / -modal`.
- **Density:** `--spacing-btn-x/y: 20/12`, `--spacing-input-x/y: 18/14`,
  `--spacing-card-padding: 28px`, roomier control/chip/kbd/tooltip spacing,
  `--height-control: 40px`.
- **Motion:** `--transition-duration: 200ms`, `--active-scale: 0.97`.
