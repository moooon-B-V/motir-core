# Type — Motir (`data-type="motir"`)

> The Motir house type pairing and the **Tier-0 base** in
> [`app/globals.css`](../../app/globals.css). It needs no `[data-type]` override
> block — the base `--font-*` role tokens _are_ the Motir pairing. Registered in
> [`lib/theme/typography.ts`](../../lib/theme/typography.ts).

**Tagline:** Editorial serif headlines over a clean sans body — the house pairing.
**Faces:** Source Serif 4 headlines · Inter body · JetBrains Mono meta.

This is the TYPE (`data-type`) axis only — the third design axis. Colour
(`data-palette`) and shape (`data-style`) are independent: picking a pairing
never changes a hue or a radius. See [`DESIGN.md`](../DESIGN.md) for the
three-axis contract.

## Role mapping (the `--font-*` tokens)

A pairing is defined entirely by the `--font-*` role tokens — the layer every
component consumes (`font-sans` / `font-serif` / `font-mono` utilities). The
shared `--font-size-*` SCALE is common across pairings (sizes are layout, not
brand). Motir's roles:

| Role              | `--font-*` token | Motir face                       |
| ----------------- | ---------------- | -------------------------------- |
| Headlines (xl+)   | `--font-serif`   | Source Serif 4 (editorial serif) |
| Body / UI         | `--font-sans`    | Inter                            |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono                   |

## Token mapping

Motir is the Tier-0 base, so its values are the `@theme` `--font-*` defaults —
there is no override block. Setting `data-type="motir"` simply leaves the base
role tokens in force, exactly as the `motir` palette / `warm-editorial` style
need no override block.

A new pairing overrides these `--font-*` role tokens (and ONLY font tokens —
never a colour `--el-*` or shape `--radius-*`/`--spacing-*` token) in its own
`[data-type='<id>']` block, loading any new faces via next/font in
`app/layout.tsx`. That disjointness — type here, colour + shape on the other
axes — is what makes "style × palette × type" a product of three independent
choices.
