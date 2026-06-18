# Type — Editorial (`data-type="editorial"`)

> A new-face pairing registered in
> [`lib/theme/typography.ts`](../../lib/theme/typography.ts); its
> `html[data-type='editorial']` block lives in
> [`app/globals.css`](../../app/globals.css). Unlike the base-face pairings
> (`motir` / `motir-sans` / `motir-mono`), it **adds one new face — Fraunces** —
> loaded via next/font in [`app/layout.tsx`](../../app/layout.tsx).

**Tagline:** A characterful display serif over a humanist sans — magazine, considered.
**Faces:** Fraunces display headlines · Inter body · JetBrains Mono meta.

![Editorial type specimen — Fraunces headlines over Inter body, light and dark, with a Motir-base vs Editorial comparison](./editorial.png)

This is the TYPE (`data-type`) axis only — the third design axis. Colour
(`data-palette`) and shape (`data-style`) are independent: picking Editorial
never changes a hue or a radius. See [`DESIGN.md`](../DESIGN.md) for the
three-axis contract.

## Role mapping (the `--font-*` tokens)

| Role              | `--font-*` token | Editorial face                             |
| ----------------- | ---------------- | ------------------------------------------ |
| Headlines (xl+)   | `--font-serif`   | **Fraunces** (high-contrast display serif) |
| Body / UI         | `--font-sans`    | Inter (the base humanist sans — unchanged) |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono (unchanged)                 |

Only the headline (serif) role is re-pointed; body and mono keep the base
roles. That is the whole pairing: a real, visible **face** swap — Motir's
neutral Source Serif 4 headlines become Fraunces' soft, high-contrast,
old-style display letterforms — not a size or weight tweak. The body stays Inter
so long-form UI copy keeps its proven legibility (and Inter is already loaded —
no extra payload there).

## Why Fraunces

Anchored in **getdesign.md — Notion (serif) / WIRED / Sanity** — editorial
brands that pair an expressive display serif with a clean sans for running text.
Fraunces is a variable font with an optical-size axis, so it reads as a
characterful magazine display face at headline sizes while staying composed.
It is the only new face this pairing introduces; it is loaded `display: 'swap'`
and only pays its weight once a user actually selects Editorial.

## Token mapping (the override block)

```css
html[data-type='editorial'] {
  --font-serif: var(--font-editorial-serif), 'Fraunces', Georgia, serif;
}
```

Two deliberate choices in that one rule:

- **`--font-editorial-serif`** is the variable `app/layout.tsx` binds to the
  Fraunces next/font load — a _defined_ variable, so the headline genuinely
  renders Fraunces (with `'Fraunces', Georgia, serif` as the graceful fallback
  chain before the webfont swaps in).
- **`html[data-type='editorial']`** (not a bare `[data-type='editorial']`) is a
  specificity choice. next/font sets the base `--font-serif` via a generated
  _class_ on `<html>` (specificity 0,1,0); a bare attribute block is also 0,1,0
  and would tie on source order. The `html` element qualifier (0,1,1) guarantees
  the re-point wins regardless of stylesheet order.

The block sets **only** `--font-*` role tokens — never a colour `--el-*`/
`--color-*` or shape `--radius-*`/`--spacing-*`/`--shadow-*` token. That
disjointness — type here, colour + shape on the other axes — is what makes
"style × palette × type" a product of three independent choices, and it is
enforced by the disjointness guard in
[`tests/theme/typographyRegistry.test.ts`](../../tests/theme/typographyRegistry.test.ts).

## Accessibility

Body copy stays Inter at the shared `--font-size-*` scale, so reading sizes and
weight contrast are unchanged from the base. Fraunces is used only at headline
sizes (xl+), where its higher stroke contrast is legible; it is never used for
small body or hairline text on a tinted surface. Verified against light AND dark
palettes via the type specimen.
