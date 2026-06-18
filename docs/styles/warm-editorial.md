# Style — Warm Editorial (`data-style="warm-editorial"`)

> The Motir house style and the **Tier-0 base** in
> [`app/globals.css`](../../app/globals.css). It needs no `[data-style]`
> override block — the base scale _is_ Warm Editorial. Registered in
> [`lib/theme/styles.ts`](../../lib/theme/styles.ts).

**Tagline:** Thoughtful, warm, technical-but-not-cold, slightly editorial.
**Inspiration:** Notion's warm palette + Source Serif 4 headlines over Inter
body.
**Wrong moods:** terminal, dashboard, cyber.

This is the STYLE (shape/feel) axis only. Colour is the independent
`data-palette` axis — picking this style never changes a hue. See
[`DESIGN.md`](../DESIGN.md) for the colour system and the two-axis contract.

## Feel-bearing dimensions

| Dimension             | Warm Editorial                                                               |
| --------------------- | ---------------------------------------------------------------------------- |
| Shape / silhouette    | Sober rectangles — 8px buttons, 12px cards. Restrained, document-like.       |
| Border / stroke       | Hairline borders (1px warm-grey); structure drawn quietly, never heavy.      |
| Elevation philosophy  | Modest, low-spread shadows; surfaces sit close to the page.                  |
| Surface / background  | Opaque cream surfaces over a white canvas; pastel tints for feature cards.   |
| Density rhythm        | Comfortable default — 18×10 button padding, 24px card padding.               |
| Motion                | Brisk 150ms ease; understated, gets out of the way.                          |
| Typography            | Source Serif 4 editorial headlines + Inter body + JetBrains Mono meta.       |
| Component silhouettes | Rectangular buttons/inputs, hairline-bordered cards, badge pills for status. |

## Token mapping

Warm Editorial is the Tier-0 default, so its values are the `@theme` block —
there is no override. The shape/feel tokens that define it:

- **Radius:** `--radius-btn: 8px`, `--radius-card: 12px`, `--radius-input: 8px`,
  `--radius-modal: 12px`, `--radius-control: 6px`, `--radius-badge: 9999px`.
- **Elevation:** the `--shadow-{subtle,card,elevated,modal}` low-spread set.
- **Density:** `--spacing-btn-x/y: 18/10`, `--spacing-card-padding: 24px`,
  `--height-control: 36px`.
- **Motion:** `--transition-duration: 150ms`, `--active-scale: 0.98`.

A new style overrides these (and only shape/feel tokens — never colour) in its
own `[data-style='<id>']` block.
