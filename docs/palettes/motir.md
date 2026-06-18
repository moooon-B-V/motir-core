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
