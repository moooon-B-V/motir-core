# Palette — Sienna (`data-palette="sienna"`)

> A warm, vivid **flame-orange** re-skin. Registered in
> [`lib/theme/palettes.ts`](../../lib/theme/palettes.ts); its override lives in
> the **AXIS 1 (COLOUR)** section of
> [`app/globals.css`](../../app/globals.css) as the `[data-palette='sienna']`
> block (light) + a `[data-palette='sienna'][data-theme='dark']` companion.

**Tagline:** Warm and vivid — a Mistral flame-orange primary over terracotta-warm
neutrals; Mediterranean and inviting.
**Inspiration:** Mistral AI — its signature **Block gradient** (yellow → amber →
flame → **Mistral Orange `#fa520f`**) over Mediterranean warm neutrals, the mood +
signature hue from **getdesign.md**
([mistral.ai/design-md](https://getdesign.md/mistral.ai/design-md)) — mapped onto
Motir's `--el-*` roles; the actual light/dark ramps and UI-state steps are drawn
from **Radix Colors** (Orange / Tomato / Sand / Red / Grass / Blue), the
accessibility-first 12-step scales designed for UI states. The neutral is Radix
**Sand**, warmed toward terracotta, so the scheme reads warm.

This is the COLOUR (palette) axis only. Shape/feel is the independent
`data-style` axis — picking Sienna never changes a radius. `data-theme`
(`light` | `dark`) is the base _within_ the palette. See
[`DESIGN.md`](../DESIGN.md) §2 for the full colour system and the two-axis
contract.

## Accent-text — DARK ink on the flame, in both themes (the Mistral treatment)

Like Amber's luminous gold, Mistral's bright flame-orange FILL (`#fa520f` light /
`#ff7a38` dark) **cannot carry white text at AA** (white on `#fa520f` is only
~3.3:1). So Sienna follows Mistral's own dark-on-orange treatment:
`--color-primary-foreground` (the source of `--el-accent-text`) is a **dark warm
ink** (`#2a1205`) in **both** themes — dark ink on the flame clears AA at ~5.3:1
(light) / ~6.8:1 (dark). `--color-primary` (the accent used AS text/icon on a
surface) is a darkened flame (`#bb4810` / `#ff8a4c`) chosen to pass AA on the
page.

## How it re-skins (token mapping)

Every Tier-3 `--el-*` element token references a Tier-0 `--color-*` source var.
So — exactly like the `[data-theme='dark']` block — Sienna re-skins by overriding
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

| Role group          | Sienna (light → dark)                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Text scale          | warm terracotta-brown ink hierarchy — ink `#23190f` → `#f3ebe2`; secondary `#6a5444` → `#bda595`                         |
| Accent (CTA)        | Mistral flame fill `#fa520f` → `#ff7a38`, **dark ink labels** `#2a1205` both themes; flame `#bb4810` → `#ff8a4c` as text |
| Surfaces            | white canvas over terracotta-cream sections — `#f7f0ea` / `#fbf6f1` → warm-black `#181109` / `#22170e`                   |
| Borders             | warm terracotta hairlines — `#ece0d6` → `#352a1d`                                                                        |
| Links               | clear blue, distinct from the orange primary — `#1366c4` → `#7bb8ff`                                                     |
| Semantic            | danger `#c92a2a`/`#e0586a` (kept distinct from the orange brand) · success `#18804a` · warning `#b45309`                 |
| Pastel tints        | warm feature washes — `--el-tint-{peach,rose,mint,lavender,sky,yellow}`                                                  |
| Work-item type hues | re-skin automatically via the `--color-*` they map to — review/warning read warm orange; the rest stay apart             |

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** light and dark — verified
numerically and by a rendered specimen, never eyeballed. Notable margins:

- Primary ink on canvas — **17.3:1** (light) / **15.8:1** (dark).
- Secondary `--el-text-secondary` on surface — **6.3:1** / **7.5:1**.
- Captions `--el-text-muted` on surface — **6.1:1** / **6.3:1**.
- Flame `--el-accent-on-surface` on a surface — **4.6:1** / **7.5:1**; **dark
  ink** on the Mistral-flame fill — **5.3:1** (light) / **6.8:1** (dark) (the
  same yellow-trap treatment as Amber).
- Link on the soft (hovered) surface — **5.3:1** / **8.8:1**.
- `--el-text-strong` on every pastel tint — **≥11.2:1** both themes.
