# Palette — Garnet (`data-palette="garnet"`)

> A rich, bold **deep-wine-red** re-skin. Registered in
> [`lib/theme/palettes.ts`](../../lib/theme/palettes.ts); its override lives in
> the **AXIS 1 (COLOUR)** section of
> [`app/globals.css`](../../app/globals.css) as the `[data-palette='garnet']`
> block (light) + a `[data-palette='garnet'][data-theme='dark']` companion.

**Tagline:** Rich and bold — a deep wine-red primary over warm rose-grey
neutrals; white labels on the garnet.
**Inspiration:** Ferrari (Ferrari red), Pinterest and Sanity (red accent) — the
bold-red mood from **getdesign.md** — mapped onto Motir's `--el-*` roles; the
actual light/dark ramps and UI-state steps are drawn from **Radix Colors** (Red /
Ruby / Crimson / Mauve / Grass / Blue), the accessibility-first 12-step scales
designed for UI states. The neutral is Radix **Mauve**, warmed toward rose, so
the scheme reads warm rather than a cold grey with a red accent.

This is the COLOUR (palette) axis only. Shape/feel is the independent
`data-style` axis — picking Garnet never changes a radius. `data-theme`
(`light` | `dark`) is the base _within_ the palette. See
[`DESIGN.md`](../DESIGN.md) §2 for the full colour system and the two-axis
contract.

## Accent-text — white in both themes (a deep, not bright, fill)

Garnet keeps its identity by staying **deep**: the primary FILL is a rich wine
(`#b21e3f` light / `#c12642` dark) that carries **white** labels at AA in BOTH
themes (~6.7:1 / ~5.8:1) — it never flips to a bright fill with dark ink the way
Amber and Sienna do in dark. To keep the brand from blurring into status, the
**danger** hue is held as a distinct, more orange-leaning pure red
(`#c12030` / `#f0606f`), separate from the wine primary.

## How it re-skins (token mapping)

Every Tier-3 `--el-*` element token references a Tier-0 `--color-*` source var.
So — exactly like the `[data-theme='dark']` block — Garnet re-skins by overriding
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

| Role group          | Garnet (light → dark)                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Text scale          | warm rose-grey ink hierarchy — ink `#221318` → `#f3e6e9`; secondary `#6b4a53` → `#bf9aa3`                  |
| Accent (CTA)        | deep-wine fill `#b21e3f` → `#c12642` with **white labels**; garnet `#b01a3f` → `#ff6b85` as text           |
| Surfaces            | white canvas over rose-grey sections — `#f7eef0` / `#fbf6f7` → warm-black `#170b0e` / `#211016`            |
| Borders             | warm rose-grey hairlines — `#ecdce0` → `#341c23`                                                           |
| Links               | clear blue, distinct from the garnet primary — `#1366c4` → `#7bb8ff`                                       |
| Semantic            | danger held distinct as a pure red `#c12030`/`#f0606f` · success `#18804a` · warning `#b45309` · info blue |
| Pastel tints        | warm feature washes — `--el-tint-{peach,rose,mint,lavender,sky,yellow}`                                    |
| Work-item type hues | re-skin automatically via the `--color-*` they map to — bug/deploy read warm red; design/epic read plum    |

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** light and dark — verified
numerically and by a rendered specimen, never eyeballed. Notable margins:

- Primary ink on canvas — **17.9:1** (light) / **15.9:1** (dark).
- Secondary `--el-text-secondary` on surface — **6.8:1** / **7.3:1**.
- Captions `--el-text-muted` on surface — **6.5:1** / **6.2:1**.
- Garnet `--el-accent-on-surface` on a surface — **6.0:1** / **6.7:1**; white on
  the wine `--el-accent` fill — **6.7:1** / **5.8:1** (deep fill, white labels).
- Link on the soft (hovered) surface — **5.3:1** / **9.2:1**.
- White on the danger fill (light) — **6.0:1**; dark ink on the bright danger
  fill (dark) — **6.1:1**.
- `--el-text-strong` on every pastel tint — **≥10.5:1** both themes.
