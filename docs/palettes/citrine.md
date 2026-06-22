# Palette — Citrine (`data-palette="citrine"`)

> Miro's **Sunglow yellow** — the whole Mirotone palette. Registered in
> [`lib/theme/palettes.ts`](../../lib/theme/palettes.ts); its override lives in
> the **AXIS 1 (COLOUR)** section of
> [`app/globals.css`](../../app/globals.css) as the `[data-palette='citrine']`
> block (light) + a `[data-palette='citrine'][data-theme='dark']` companion.

**Tagline:** Bright and collaborative — Miro's Sunglow yellow over the whiteboard
greys, with the Miro action-blue accent.
**Inspiration:** **Miro** — transcribed verbatim from its **Mirotone** design
system (npm `mirotone@5.3.2`, the `--colors-{hue}-{step}` primitives) plus Miro's
brand sheet. **Every value in the block is a documented Mirotone step or Miro
brand token — nothing is invented or hand-darkened;** where a role needs a darker
shade for AA, a documented deeper ramp step is used (e.g. yellow-700 `#746019`
for on-surface gold text). Miro is a **5-hue system** (yellow / blue / green /
red / gray): the warm **Sunglow yellow `#FFD02F`** (`yellow-500`, the brand/logo
colour) is the primary, the **action-blue `#3859FF`** (`blue-500`) is the accent,
ink is **Stratos `#050038`**, and the semantics are `green-500 #1c8f00` /
`red-500 #d8182c`. The warm yellow primary makes this a "warm" palette; the
neutrals are Mirotone's own cool gray ramp.

This is the COLOUR (palette) axis only — picking Citrine never changes a radius
(the independent `data-style` axis). See [`DESIGN.md`](../DESIGN.md) §2.

## ⚠️ The yellow-primary trap (why the accent-text is DARK)

A Sunglow FILL **cannot carry white text at AA**. So the accent-text
(`--color-primary-foreground`, the label on the CTA) is **Miro's Stratos ink
`#050038`**, not `#fff` — Miro's own dark-on-yellow treatment (dark-on-Sunglow
~13.5:1). `--color-primary` (the yellow used AS text/icon on a surface) is the
documented dark step `yellow-700 #746019` (AA ~6.1:1 on white), not an invented
darkening.

## How it re-skins (token mapping)

Citrine re-skins by overriding the Tier-0 `--color-*` source the `--el-*` layer
references (as `[data-theme='dark']` does), so every `--el-*` token follows
coherently; only `--el-sidebar-item-bg-hover` is set directly. The block sets
**only colour tokens** — never a shape/feel token (the independent `data-style`
axis; `tests/theme/paletteRegistry.test.ts` enforces it).

Miro has no orange or teal primitive ramp, so the `--color-accent-orange` /
`-teal` type-hue roles map to documented Mirotone steps from the families Miro
does ship (a dark gold `yellow-650` and a deep `blue-650`) rather than to an
invented hue — keeping the palette a faithful Miro 5-hue system.

## Colour roles (the `--el-*` element-token layer)

| Role group          | Citrine / Miro (light → dark) — all Mirotone steps                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Text scale          | Stratos ink `#050038` + Mirotone gray ramp — secondary `gray-600 #4a4e5e` → `gray-300 #c1c3cd`                |
| Accent (CTA)        | Sunglow fill `#ffd02f` (`yellow-500`) with **dark Stratos labels** `#050038`; gold `#746019` → `#ffd02f` text |
| Surfaces            | white over `gray-100 #f3f4f6` → Miro-black `#090909` / `gray-900 #1a1b1e`                                     |
| Borders             | Mirotone gray hairlines — `gray-200 #e0e1e6` → `gray-750 #2b2e35`                                             |
| Accent / links      | Miro action-blue `#3859ff` (`blue-500`) → `blue-400 #7a90fe`                                                  |
| Semantic            | Mirotone `green-500 #1c8f00` / `red-500 #d8182c` ramps (brightened one step on dark) · warning gold           |
| Pastel tints        | Mirotone light ramp steps (`tint-yellow` = `yellow-150`, `tint-sky` = `blue-100`, `tint-mint` = `green-150`)  |
| Work-item type hues | re-skin via the `--color-*` they map to — Miro's 5-hue set (yellow / blue / green / red + the dark golds)     |

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** themes — verified
numerically and by the rendered specimen. All hues are documented Mirotone steps;
where AA required a deeper shade, a documented step was chosen. Notable margins:

- Primary (Stratos) ink on canvas — **19.8:1** (light) / **18.6:1** (dark).
- Secondary `--el-text-secondary` on surface — **7.5:1** / **9.8:1**.
- Captions `--el-text-muted` on surface — **6.0:1** / **8.0:1**.
- Gold `--el-accent-on-surface` (`yellow-700`) — **6.1:1** (light); Sunglow as
  text on dark — **11.7:1**. **Dark Stratos ink** on the Sunglow `--el-accent`
  fill — **13.5:1** both themes (the yellow trap).
- Miro action-blue link on the soft surface — **4.9:1** / **6.1:1**.
- White on the red-500 danger fill (light) — **5.1:1**; dark ink on the bright
  `red-400` danger (dark) — **6.1:1**.
- `--el-text-strong` on every pastel tint — **≥11.8:1** both themes.
