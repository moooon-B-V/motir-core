# Type — Grotesk (`data-type="grotesk"`)

> A NEW-typeface pairing (Subtask 7.3.54) registered in
> [`lib/theme/typography.ts`](../../lib/theme/typography.ts); its
> `[data-type='grotesk']` block lives in the **AXIS 3 (TYPE)** section of
> [`app/globals.css`](../../app/globals.css). Unlike the v1 base-face trio it
> ADDS one face — **Space Grotesk** — loaded via `next/font` in
> [`app/layout.tsx`](../../app/layout.tsx) (the `--font-grotesk-source` variable);
> meta reuses the already-loaded JetBrains Mono and the body/UI reuses the new Space Grotesk face, so the only new
> payload is the display face, and only when this pairing is selected.

**Tagline:** Geometric neo-grotesque across the whole UI — tight, confident, product-y.
**Faces:** Space Grotesk headlines + body/UI · JetBrains Mono meta.
**Source:** anchored in [getdesign.md](https://getdesign.md/) — the technical,
product-y sans language of **Vercel (Geist)**, **Linear**, and **Framer**.
Space Grotesk is the license-clear Google Fonts grotesque closest to that feel
(real webfont, latin subset).

This is the TYPE (`data-type`) axis only — the third design axis. Colour
(`data-palette`) and shape (`data-style`) are independent: picking Grotesk never
changes a hue or a radius. See [`DESIGN.md`](../DESIGN.md) for the three-axis
contract.

## Role mapping (the `--font-*` tokens)

A pairing is defined entirely by the `--font-*` role tokens — the layer every
component consumes (`font-sans` / `font-serif` / `font-mono` utilities). The
shared `--font-size-*` SCALE is common across pairings (sizes are layout, not
brand). Grotesk's roles:

| Role              | `--font-*` token | Grotesk face                                           |
| ----------------- | ---------------- | ------------------------------------------------------ |
| Headlines (xl+)   | `--font-serif`   | **Space Grotesk** (re-pointed off the editorial serif) |
| Body / UI         | `--font-sans`    | Space Grotesk                                          |
| Meta / code / IDs | `--font-mono`    | JetBrains Mono                                         |

## Why it exists

The base **Motir** pairing wears an editorial serif (Source Serif 4) for
headlines — warm, magazine-like. Grotesk is its technical counterpart: a
geometric / neo-grotesque sans display face gives headlines a tighter, more
confident, product-native voice — the look modern dev-tool brands (Vercel,
Linear, Framer) wear. The body/UI also wears Space Grotesk (it reads cleanly as a UI sans), so the whole app — nav, header, buttons — re-types; the
**headline FACE** carries the whole personality shift, which is the most visible
typographic decision a UI makes.

## How it re-points (token mapping)

The `[data-type='grotesk']` block re-points ONLY `--font-serif` (the headline
role) at `var(--font-grotesk-source)` — the Space Grotesk family that
`app/layout.tsx` exposes on `<html>`. Body (`--font-sans` → Inter) and meta
(`--font-mono` → JetBrains Mono) are left at the Tier-0 defaults. No colour
(`--el-*` / `--color-*`) or shape (`--radius-*` / `--spacing-*` / `--shadow-*` /
`--height-*`) token is touched — that disjointness (type here, colour + shape on
the other axes) is what makes "style × palette × type" a product of three
independent choices, and it is enforced by
[`tests/theme/typographyRegistry.test.ts`](../../tests/theme/typographyRegistry.test.ts).

## Accessibility

Space Grotesk is set only at headline sizes (xl and up), where its medium /
semibold weights stay legible on both the light canvas and dark surfaces — no
thin hairline headline text on a tinted surface. Body and meta copy keep Inter /
JetBrains Mono, so paragraph legibility and the AA contrast of running text are
identical to every other pairing (contrast is a colour-axis property of the
active palette, which this pairing does not change). Verified by rendering the
type specimen under Grotesk in light AND dark.
