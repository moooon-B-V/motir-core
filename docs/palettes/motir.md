# Palette — Motir (`data-palette="motir"`)

> The Motir house palette and the **Tier-3 base** in
> [`app/globals.css`](../../app/globals.css). It needs no `[data-palette]`
> override block — the base `--el-*` layer _is_ the Motir palette. Registered in
> [`lib/theme/palettes.ts`](../../lib/theme/palettes.ts).

**Tagline:** Warm and editorial — cream surfaces, charcoal ink, a purple
primary, pastel tints.
**Inspiration:** Notion's warm marketing palette — the product's house colours.

This is the COLOUR (palette) axis only. Shape/feel is the independent
`data-style` axis — picking this palette never changes a radius. `data-theme`
(`light` | `dark`) is the base _within_ a palette. See
[`DESIGN.md`](../DESIGN.md) §2 for the full colour system and the two-axis
contract.

## Colour roles (the `--el-*` element-token layer)

A palette is defined entirely by the values of the Tier-3 `--el-*` tokens —
the layer every component consumes. Motir's roles (light base; the Tier-1
`[data-theme="dark"]` block flips the underlying `--color-*` vars):

| Role group          | Motir                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Text scale          | charcoal/slate ink hierarchy — `--el-text`, `-strong`, `-secondary`, `-muted`, `-tertiary`, `-faint` |
| Accent (CTA)        | Notion purple — `--el-accent` fill + `--el-accent-on-surface`; brand-pink `--el-highlight`           |
| Surfaces            | cream over a white canvas — `--el-surface`, `--el-surface-soft`, `--el-muted`                        |
| Recessed canvas     | planning board — `--el-canvas`, recessed below `--el-page-bg` and `--el-surface`                     |
| Borders             | warm hairlines — `--el-border`, `-soft`, `-strong`                                                   |
| Links               | `--el-link` / `--el-link-pressed`                                                                    |
| Semantic            | `--el-danger` / `--el-success` / `--el-warning` / `--el-info` (+ danger text)                        |
| Pastel tints        | `--el-tint-{peach,rose,mint,lavender,sky,yellow}` — feature-card washes                              |
| Work-item type hues | `--el-type-{epic,story,task,bug,subtask,code,design,test,…}`                                         |

## Token mapping

Motir is the Tier-3 base, so its values are the `:root --el-*` block (which
reference the Tier-0 `--color-*` palette) — there is no override block. Setting
`data-palette="motir"` simply leaves the base `--el-*` tokens in force, exactly
as the `warm-editorial` base style needs no `[data-style]` block.

A new palette overrides these `--el-*` tokens (and ONLY colour tokens — never a
shape/feel token like `--radius-*` / `--spacing-*` / `--shadow-*`) in its own
`[data-palette='<id>']` block, with a
`[data-palette='<id>'][data-theme='dark']` companion wherever it diverges from
the base dark flip. That disjointness — colour here, shape on the `data-style`
axis — is what makes "style × palette" a product of two independent choices.

## The status ramp — why `done` takes its own step

`--el-status-done` rides `--color-success` (`#1aae39`) — but the bare source was
**2.93:1** on `--el-card` and **2.69:1** on `--el-surface` in the light theme,
under the 3:1 icon/UI bar `statusHueSeparation.test.ts` holds the base palette
to since MOTIR-3954. `--color-success` is NOT free to move: the same Tier-0 hue
paints `--el-success-surface`'s companion ink, the success toast/notice family
and the chart-success step, each at its own AA bar that pulls opposite to a
dot's 3:1. So the ramp takes one step of the palette's own emphasis ink instead
of re-tuning the source — **`color-mix(in srgb, var(--color-success) 85%,
var(--color-charcoal))`**, which resolves to `#1e9c38`. Contrast **3.58 / 3.29 /
3.58** on card / surface / page-bg in light and **7.29 / 6.62 / 7.29** in dark,
past the bar both ways; ΔE2000 to the nearest sibling stays **11.3+** across all
ten palettes × both themes.

`--el-status-implemented` carries the same shape for the same reason (MOTIR-3954):
its `--color-accent` source was 2.66:1, so it steps 75% toward `--color-charcoal`.

Because Motir is the base palette, these steps live in the Tier-3 `:root` block
rather than a `[data-palette='motir']` override — `<html>` carries no
`data-appearance-scope`, so the base layer IS how the browser reaches them, and
a root palette block would be a second cascade nobody renders.
