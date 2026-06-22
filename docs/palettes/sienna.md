# Palette — Sienna (`data-palette="sienna"`)

> Mistral AI's **flame-orange** — the whole Mediterranean palette. Registered in
> [`lib/theme/palettes.ts`](../../lib/theme/palettes.ts); its override lives in
> the **AXIS 1 (COLOUR)** section of
> [`app/globals.css`](../../app/globals.css) as the `[data-palette='sienna']`
> block (light) + a `[data-palette='sienna'][data-theme='dark']` companion.

**Tagline:** Warm and vivid — Mistral flame-orange over the Mediterranean
warm-cream surfaces; dark labels on the flame.
**Inspiration:** **Mistral AI** — transcribed from its documented system
([getdesign.md/mistral.ai](https://getdesign.md/mistral.ai/design-md), corroborated
by oh-my-design.kr + Brandfetch), the whole palette not just the orange: the
**Mistral Orange `#fa520f`** + **Flame `#fb6424`** primary, the **Block gradient**
(yellow→amber→flame→orange), the **Sunshine** family (`#ff8a00`/`#ffa110`/`#ffb83e`),
**Block Gold `#ffe295`**, the **Mediterranean Warm-Ivory creams** (`#fffaeb` →
`#fff0c2`), and **Mistral-Black `#1f1f1f`** ink. Mistral ships **no semantic
colours**, so success/warning/danger/info are added warm-consistent + AA-safe.

This is the COLOUR (palette) axis only — picking Sienna never changes a radius.
See [`DESIGN.md`](../DESIGN.md) §2.

## ⚠️ Dark ink on the flame, in both themes (the Mistral treatment)

Like Amber's gold, Mistral's bright flame FILL (`#fa520f` light / `#ff7a38` dark)
**cannot carry white at AA** (white-on-`#fa520f` is ~3.3:1). So Sienna follows
Mistral's own dark-on-orange treatment: `--color-primary-foreground` is a **dark
warm ink** (`#2a1205`) in **both** themes — dark-on-flame clears AA at ~5.3:1
(light) / ~6.8:1 (dark). `--color-primary` (the flame used AS text/icon) is a
darkened flame (`#c4400a` / `#ff8a4c`). Per Mistral, **links are the brand
orange** too (a darkened flame, AA-safe), not a cool blue.

## How it re-skins (token mapping)

Sienna re-skins by overriding the Tier-0 `--color-*` source the `--el-*` layer
references (as `[data-theme='dark']` does), so every `--el-*` token follows
coherently; only `--el-sidebar-item-bg-hover` is set directly. The block sets
**only colour tokens** — never a shape/feel token (the independent `data-style`
axis; `tests/theme/paletteRegistry.test.ts` enforces it).

## Colour roles (the `--el-*` element-token layer)

| Role group          | Sienna / Mistral (light → dark)                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Text scale          | Mistral warm-charcoal ink — `#1f1f1f` → `#f5efe2`; secondary `#4a4a4a` → `#b3a892`                                     |
| Accent (CTA)        | Mistral-orange fill `#fa520f` → `#ff7a38`, **dark ink labels** `#2a1205` both themes; flame `#c4400a` → `#ff8a4c` text |
| Surfaces            | Mediterranean Warm-Ivory `#fffaeb` over cream `#fbf1d3` → warm-black `#15120d` / `#1f1d17`                             |
| Borders             | warm beige hairlines — `#ece0c4` → `#322c1d`                                                                           |
| Links               | the brand orange (darkened flame) — `#c4400a` → `#ff9a5c`                                                              |
| Semantic            | added warm-consistent (Mistral ships none) — success/warning/danger/info, AA-safe in both themes                       |
| Pastel tints        | Mistral's golden washes (`tint-yellow` = Block Gold `#ffe295`) + warm feature hues                                     |
| Work-item type hues | re-skin via the `--color-*` they map to — review/warning read warm amber; the rest stay distinguishable                |

## Accessibility

Every text-on-surface, accent-text-on-fill, link, and chip-tint pairing clears
**WCAG AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** themes — verified
numerically and by the rendered specimen. Notable margins:

- Primary ink on canvas — **15.8:1** (light) / **16.3:1** (dark).
- Secondary `--el-text-secondary` on surface — **7.9:1** / **7.2:1**.
- Captions `--el-text-muted` on surface — **5.7:1** / **6.3:1**.
- Flame `--el-accent-on-surface` — **4.9:1** / **8.0:1**; **dark ink** on the
  Mistral-flame fill — **5.3:1** (light) / **6.8:1** (dark) (the yellow-trap
  treatment, same as Amber).
- Link (brand orange) on the soft surface — **4.8:1** / **8.5:1**.
- `--el-text-strong` on every pastel tint — **≥10.4:1** both themes.
