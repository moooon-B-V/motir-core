# Palette — Graphite (`data-palette="graphite"`)

> A stark, editorial, **cool-neutral monochrome** re-skin — the cool foil to
> Motir's warmth. Registered in
> [`lib/theme/palettes.ts`](../../lib/theme/palettes.ts); its override lives in
> the **AXIS 1 (COLOUR)** section of
> [`app/globals.css`](../../app/globals.css) as the `[data-palette='graphite']`
> block (light) + a `[data-palette='graphite'][data-theme='dark']` companion.

**Tagline:** Stark and editorial — cool greyscale surfaces + ink, an ink CTA, a
single restrained cool-blue accent.
**Inspiration:** Vercel's black-and-white precision and Linear's ultra-minimal
(getdesign.md), mapped onto Motir's `--el-*` roles; the actual light/dark ramps
and UI-state steps are drawn from **Radix Colors** (Slate / Blue / Red / Grass /
Amber / Teal) — the accessibility-first 12-step scales designed for UI states.
Slate is the cool neutral closest to the brand anchor.

This is the COLOUR (palette) axis only. Shape/feel is the independent
`data-style` axis — picking Graphite never changes a radius. `data-theme`
(`light` | `dark`) is the base _within_ the palette. See
[`DESIGN.md`](../DESIGN.md) §2 for the full colour system and the two-axis
contract.

## The idea — monochrome chrome, one accent

Graphite is the palette where the **chrome is greyscale**: surfaces, ink, and
borders are a pure cool slate scale with no hue. The accent is expressed exactly
as Vercel / Linear do it, two ways from one idea:

- The **primary CTA is a high-contrast INK fill** — near-black on light,
  near-white on dark. That inversion _is_ the monochrome statement; it is not a
  second colour.
- The **single chromatic accent** is a restrained **cool blue**, and it carries
  only the roles that genuinely need a hue: links, active/selected states, the
  focus ring, and the decorative highlight.

Semantic status (danger / success / warning / info) and work-item **type hues**
stay chromatic — cooled to harmonise with the slate, but never collapsed to grey
— so status and kind remain legible (the finding-#54 guard: never reduce the UI
to grey + one colour).

## How it re-skins (token mapping)

Every Tier-3 `--el-*` element token references a Tier-0 `--color-*` source
var. So — exactly like the `[data-theme='dark']` block — Graphite re-skins by
overriding the **`--color-*` source**, and the whole `--el-*` layer (surfaces,
ink, accent, links, semantic, pastel tints, work-item type hues, charts) follows
coherently with no per-token churn. The only `--el-*` token overridden directly
is `--el-sidebar-item-bg-hover` — a concrete hex in Tier 3, not a `--color-*`
reference.

The block overrides **only colour tokens** (`--color-*` / `--el-*`) — never a
shape/feel token (`--radius-*` / `--spacing-*` / `--shadow-*` / `--height-*` /
`--transition-*`). That disjointness — colour here, shape on the `data-style`
axis — is what makes "style × palette" a product of two independent choices, and
`tests/theme/paletteRegistry.test.ts` enforces it.

## Colour roles (the `--el-*` element-token layer)

| Role group          | Graphite (light → dark)                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Text scale          | cool-slate ink hierarchy — ink `#16191d` → `#edeef0`; secondary `#565c64` → `#a9adb5`                              |
| Accent (CTA)        | INK fill `#1a1d21` → `#edeef0` (the monochrome statement); on-surface/link cool blue `#155bc4` → `#7db1ff`         |
| Surfaces            | stark white canvas over cool-slate sections — `#eef0f3` / `#f8f9fa` → near-black `#0c0d0f` / `#18191c` / `#141517` |
| Borders             | cool slate hairlines — `#e2e4e9` → `#282a2e`                                                                       |
| Links               | the accent cool blue — `#155bc4` → `#7db1ff`                                                                       |
| Semantic            | danger `#c92a2a`/`#d83847` · success `#18804a`/`#34b86e` · warning `#c2410c`/`#f08a4b` · info `#155bc4` (= accent) |
| Pastel tints        | cooled feature washes — `--el-tint-{peach,rose,mint,lavender,sky,yellow}` (sky/lavender lead the cool set)         |
| Work-item type hues | re-skin automatically via the `--color-*` they map to — cooled blue/green/red/teal/orange, kept distinguishable    |

## Accessibility

Every text-on-surface, white-on-fill, link, and chip-tint pairing clears **WCAG
AA** (≥4.5; ≥3.0 for icon/UI hues) in **both** light and dark — verified
numerically and by a rendered specimen, never eyeballed (the `--el-*` AA +
design-mockup render checklist). Notable margins:

- Primary ink on canvas — **17.6:1** (light) / **16.8:1** (dark).
- `--el-text-strong` on the surface — **13.7:1** / **12.4:1**.
- Secondary `--el-text-secondary` on surface — **5.9:1** / **7.8:1**.
- Captions `--el-text-muted` on the soft surface a hovered row paints —
  **5.8:1** / **7.3:1**.
- Cool-blue `--el-accent-on-surface` on a surface — **5.5:1** / **8.0:1**; white
  on the ink `--el-accent` fill — **16.9:1** / **16.8:1** (black on the dark
  white-ink fill).
- Link on the soft (hovered) surface — **6.0:1** / **8.4:1**.
- White on the danger fill — **5.5:1** / **4.6:1**.
- `--el-text-strong` on every pastel tint — **≥10.6:1** both themes.

Tertiary (`--el-text-tertiary`) and faint (`--el-text-faint`) labels are
intentionally sub-AA decorative steps (≈5.0:1 / ≈3.3:1 light), mirroring the
Motir base palette's own `steel` / `stone` hierarchy — they are non-essential
labels, never body or caption copy.
