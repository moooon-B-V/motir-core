# Palette — Sienna (`data-palette="sienna"`)

> A warm, friendly **burnt-orange** re-skin. Registered in
> [`lib/theme/palettes.ts`](../../lib/theme/palettes.ts); its override lives in
> the **AXIS 1 (COLOUR)** section of
> [`app/globals.css`](../../app/globals.css) as the `[data-palette='sienna']`
> block (light) + a `[data-palette='sienna'][data-theme='dark']` companion.

**Tagline:** Warm and friendly — a burnt-orange primary over terracotta-warm
neutrals; an inviting, workshop feel.
**Inspiration:** Zapier's warm, friendly, illustration-driven orange — the mood
from **getdesign.md** — mapped onto Motir's `--el-*` roles; the actual light/dark
ramps and UI-state steps are drawn from **Radix Colors** (Orange / Tomato / Sand
/ Red / Grass / Blue), the accessibility-first 12-step scales designed for UI
states. The neutral is Radix **Sand**, warmed toward terracotta, so the scheme
reads warm.

This is the COLOUR (palette) axis only. Shape/feel is the independent
`data-style` axis — picking Sienna never changes a radius. `data-theme`
(`light` | `dark`) is the base _within_ the palette. See
[`DESIGN.md`](../DESIGN.md) §2 for the full colour system and the two-axis
contract.

## Accent-text — white in light, dark in dark

Unlike Amber's luminous gold, Sienna's burnt-orange primary FILL in **light**
(`#c2480c`) is deep enough to carry **white** labels at AA (~5:1). In **dark**
the fill brightens to a vivid orange (`#ff8a4c`, the Supabase-style bright-fill
pattern), which then carries **dark ink** labels (`#2a1205`, ~7.6:1) — so the
`--el-accent-text` source (`--color-primary-foreground`) flips white → dark
between the themes, each chosen to pass AA on its own fill.

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

| Role group          | Sienna (light → dark)                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Text scale          | warm terracotta-brown ink hierarchy — ink `#23190f` → `#f3ebe2`; secondary `#6a5444` → `#bda595`             |
| Accent (CTA)        | burnt-orange fill `#c2480c` (white labels) → vivid `#ff8a4c` (dark labels); terracotta `#bb4810` as text     |
| Surfaces            | white canvas over terracotta-cream sections — `#f7f0ea` / `#fbf6f1` → warm-black `#181109` / `#22170e`       |
| Borders             | warm terracotta hairlines — `#ece0d6` → `#352a1d`                                                            |
| Links               | clear blue, distinct from the orange primary — `#1366c4` → `#7bb8ff`                                         |
| Semantic            | danger `#c92a2a`/`#e0586a` (kept distinct from the orange brand) · success `#18804a` · warning `#b45309`     |
| Pastel tints        | warm feature washes — `--el-tint-{peach,rose,mint,lavender,sky,yellow}`                                      |
| Work-item type hues | re-skin automatically via the `--color-*` they map to — review/warning read warm orange; the rest stay apart |

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** light and dark — verified
numerically and by a rendered specimen, never eyeballed. Notable margins:

- Primary ink on canvas — **17.3:1** (light) / **15.8:1** (dark).
- Secondary `--el-text-secondary` on surface — **6.3:1** / **7.5:1**.
- Captions `--el-text-muted` on surface — **6.1:1** / **6.3:1**.
- Burnt-orange `--el-accent-on-surface` on a surface — **4.6:1** / **7.5:1**;
  white on the orange fill (light) — **5.0:1**; dark ink on the bright fill
  (dark) — **7.6:1**.
- Link on the soft (hovered) surface — **5.3:1** / **8.8:1**.
- `--el-text-strong` on every pastel tint — **≥11.2:1** both themes.
