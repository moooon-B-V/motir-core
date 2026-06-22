# Palette — Amber (`data-palette="amber"`)

> A warm, energetic **trading-floor gold** re-skin — the first WARM-PRIMARY
> palette. Registered in [`lib/theme/palettes.ts`](../../lib/theme/palettes.ts);
> its override lives in the **AXIS 1 (COLOUR)** section of
> [`app/globals.css`](../../app/globals.css) as the `[data-palette='amber']`
> block (light) + a `[data-palette='amber'][data-theme='dark']` companion.

**Tagline:** Warm and energetic — a bright trading-floor gold primary over warm
sand neutrals; dark labels on the gold.
**Inspiration:** Binance (bold yellow on monochrome), ClickHouse and Miro (bright
yellow) — the warm-gold mood from **getdesign.md** — mapped onto Motir's `--el-*`
roles; the actual light/dark ramps and UI-state steps are drawn from **Radix
Colors** (Amber / Yellow / Sand / Red / Grass / Blue), the accessibility-first
12-step scales designed for UI states. The signature fill is anchored on
Binance's gold (`#f0b90b`). The neutral is Radix **Sand** — a WARM grey — so the
scheme reads warm, not a gold accent on cold grey.

This is the COLOUR (palette) axis only. Shape/feel is the independent
`data-style` axis — picking Amber never changes a radius. `data-theme`
(`light` | `dark`) is the base _within_ the palette. See
[`DESIGN.md`](../DESIGN.md) §2 for the full colour system and the two-axis
contract.

## ⚠️ The yellow-primary trap (why the accent-text is DARK)

A gold/amber accent FILL **cannot carry white text at AA** — the hue is too
luminous. So Amber breaks from the cool palettes: `--color-primary-foreground`
(the source of `--el-accent-text`, the label on the CTA fill) is a **dark warm
ink** (`#2a1c00`), not `#fff`. Dark ink on the gold clears AA at ~9.2:1 (light)
/ ~10.5:1 (dark). This is the `el-text-inverted-flips-in-dark` lesson applied at
the palette level, and finding #35 in spirit — put the hue in the FILL with dark
text, never tint a page surface.

## How it re-skins (token mapping)

Every Tier-3 `--el-*` element token references a Tier-0 `--color-*` source var.
So — exactly like the `[data-theme='dark']` block — Amber re-skins by overriding
the **`--color-*` source**, and the whole `--el-*` layer (surfaces, ink, accent,
links, semantic, pastel tints, work-item type hues, charts) follows coherently
with no per-token churn. The only `--el-*` token overridden directly is
`--el-sidebar-item-bg-hover` — a concrete hex in Tier 3, not a `--color-*`
reference.

The block overrides **only colour tokens** (`--color-*` / `--el-*`) — never a
shape/feel token (`--radius-*` / `--spacing-*` / `--shadow-*` / `--height-*` /
`--transition-*`). That disjointness — colour here, shape on the `data-style`
axis — is what makes "style × palette" a product of two independent choices, and
`tests/theme/paletteRegistry.test.ts` enforces it.

## Colour roles (the `--el-*` element-token layer)

| Role group          | Amber (light → dark)                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Text scale          | warm-sand ink hierarchy — ink `#211c14` → `#f0ebe0`; secondary `#5f5640` → `#b0a589`                    |
| Accent (CTA)        | bright gold FILL `#f0b90b` → `#ffc53d` with **dark ink labels** `#2a1c00`; gold-brown `#955d00` as text |
| Surfaces            | white canvas over warm sand-cream sections — `#f6f1e8` / `#faf7f0` → warm-black `#16130c` / `#201b12`   |
| Borders             | warm sand hairlines — `#e8e0d0` → `#322a1c`                                                             |
| Links               | clear blue, distinct from the gold primary — `#1366c4` → `#7bb8ff`                                      |
| Semantic            | danger `#c92a2a`/`#e0586a` · success `#18804a`/`#34d27a` · warning `#b45309`/`#fb923c` · info `#1366c4` |
| Pastel tints        | warm feature washes — `--el-tint-{peach,rose,mint,lavender,sky,yellow}` (the gold yellow wash leads)    |
| Work-item type hues | re-skin automatically via the `--color-*` they map to — code/research read warm; design/epic read amber |

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** light and dark — verified
numerically and by a rendered specimen, never eyeballed (the `--el-*` AA +
design-mockup render checklist). Notable margins:

- Primary ink on canvas — **16.9:1** (light) / **15.6:1** (dark).
- Secondary `--el-text-secondary` on surface — **6.5:1** / **7.0:1**.
- Captions `--el-text-muted` on surface — **5.5:1** / **6.4:1**.
- Gold `--el-accent-on-surface` on a surface — **4.9:1** / **10.8:1**; **dark
  ink** on the gold `--el-accent` fill — **9.2:1** / **10.5:1** (the yellow trap).
- Link on the soft (hovered) surface — **5.3:1** / **8.7:1**.
- White on the danger fill (light) — **5.5:1**; dark ink on the bright danger
  fill (dark) — **5.1:1**.
- `--el-text-strong` on every pastel tint — **≥11.0:1** both themes.
