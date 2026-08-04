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
coherently with no per-token churn. Three `--el-*` tokens are overridden
directly:

- `--el-sidebar-item-bg-hover` — a concrete hex in Tier 3, not a `--color-*`
  reference, so there is no source to re-skin.
- `--el-status-in-review` — the one place this palette's identity **collides**
  with the indirection (MOTIR-2073). See _the status ramp_ below.
- `--el-priority-high` — where two chromatic **semantics** land too close to
  each other for a glyph to carry (MOTIR-2094). See _the priority ramp_ below.

### The status ramp — why `in_review` is set directly

The Tier-0 indirection is not collision-proof: two `--el-*` tokens whose whole
purpose is to differ converge whenever a palette unifies their sources.
`--el-status-in-progress` rides `--color-info` and `--el-status-in-review` rides
`--color-primary` (MOTIR-1273 gave each status its own source precisely so the
two read apart). Graphite deliberately sets **`--color-info` = the accent blue**
— correct for a monochrome palette with one chromatic accent — which re-collapsed
`in_review` onto `in_progress` one layer down.

Both choices are kept. `--color-info` still equals the accent, and the **status
ramp gets its own second step of that same accent** rather than a second hue
family: **Radix Blue 12**, one step deeper than the accent in light
(`#113264`) and one step _paler_ in dark (`#c2e6ff`) — the same
light/dark inversion the ink CTA already uses. One accent, two depths.

Separation from `in_progress`: **ΔE2000 16.9** (light) / **15.3** (dark) —
clear of this palette's tightest deliberate status pair (`todo` / `cancelled`
at ΔE 11.8). `tests/theme/statusHueSeparation.test.ts` pins it, and the dot is
never the sole carrier: every consumer renders it beside the status label.

### The priority ramp — why `high` is set directly

The same shape one family over, and **not** a monochrome-identity choice
(MOTIR-2094). `--el-priority-highest` rides `--color-destructive` (`#c92a2a`)
and `--el-priority-high` rides `--color-warning` (`#c2410c`) — but Graphite's
warning is a **red-leaning burnt orange** sitting beside its danger red, so in
light the two land ΔE2000 **10.02** apart.

That **passed** the ΔE 10 bar a coloured priority GLYPH needs (the bar
calibrated for the status dot in MOTIR-2073). It passed by 0.02, which is
rounding, not margin: the two marks sat at the perceptual minimum, and any
later nudge to either semantic would have tipped them under the floor as a
surprise red. It is the same collision Cobalt shipped at ΔE 9.9 — the only
difference between the two numbers is which side of the bar they rounded to —
so it takes the same fix rather than a note explaining it away.

Neither semantic moves: danger stays danger, warning stays warning. The
**priority ramp takes its own step of a hue Graphite already owns**: **Radix
Amber 11** `#ab6400`, from the palette's documented Radix source set. Separation
from `highest` **ΔE 24.7** (the nearest other step, `medium`, is ΔE 32.2);
contrast **4.6:1** on `--el-card` and **4.0:1** on `--el-surface`, past the 3:1
icon/UI bar. A warm amber against a greyscale chrome is the same licence the
palette already takes for `warning` itself — the monochrome statement is the
chrome and the ink CTA, never the semantic hues (the finding-#54 guard).

Dark needs no change (its `#d83847` / `#f08a4b` are already ΔE **25.8** apart)
but **re-asserts `var(--color-warning)`** for the same cascade reason as the
status override above: a light-only override would keep its LIGHT value on the
dark canvas, where it was never measured.
`tests/theme/familyHueSeparation.test.ts` enforces both the floor and the
pairing.

The block overrides **only colour tokens** (`--color-*` / `--el-*`) — never a
shape/feel token (`--radius-*` / `--spacing-*` / `--shadow-*` / `--height-*` /
`--transition-*`). That disjointness — colour here, shape on the `data-style`
axis — is what makes "style × palette" a product of two independent choices, and
`tests/theme/paletteRegistry.test.ts` enforces it.

## Colour roles (the `--el-*` element-token layer)

| Role group          | Graphite (light → dark)                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Text scale          | cool-slate ink hierarchy — ink `#16191d` → `#edeef0`; secondary `#565c64` → `#a9adb5`                                  |
| Accent (CTA)        | INK fill `#1a1d21` → `#edeef0` (the monochrome statement); on-surface/link cool blue `#155bc4` → `#7db1ff`             |
| Surfaces            | stark white canvas over cool-slate sections — `#eef0f3` / `#f8f9fa` → near-black `#0c0d0f` / `#18191c` / `#141517`     |
| Recessed canvas     | planning board — recessed below the page and `--el-surface` — `#e6e8ed` → `#08090b`                                    |
| Borders             | cool slate hairlines — `#e2e4e9` → `#282a2e`                                                                           |
| Links               | the accent cool blue — `#155bc4` → `#7db1ff`                                                                           |
| Semantic            | danger `#c92a2a`/`#d83847` · success `#18804a`/`#34b86e` · warning `#c2410c`/`#f08a4b` · info `#155bc4` (= accent)     |
| Status ramp         | rides the semantic sources, EXCEPT `in_review` — its own deeper/paler accent step, Radix Blue 12 `#113264` → `#c2e6ff` |
| Priority ramp       | `--el-priority-high` set directly — Radix Amber 11 `#ab6400` (light) / rides `--color-warning` (dark) — see below      |
| Pastel tints        | cooled feature washes — `--el-tint-{peach,rose,mint,lavender,sky,yellow}` (sky/lavender lead the cool set)             |
| Work-item type hues | re-skin automatically via the `--color-*` they map to — cooled blue/green/red/teal/orange, kept distinguishable        |

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
- The `in_review` status step on the surface — **11.1:1** / **13.4:1**; on the
  card fill — **12.6:1** / **14.9:1** (well past the ≥3.0 icon/UI bar).
- The `high` priority step (light only) on the surface — **4.0:1**; on the card
  fill — **4.6:1** (past the ≥3.0 icon/UI bar).

Tertiary (`--el-text-tertiary`) and faint (`--el-text-faint`) labels are
intentionally sub-AA decorative steps (≈5.0:1 / ≈3.3:1 light), mirroring the
Motir base palette's own `steel` / `stone` hierarchy — they are non-essential
labels, never body or caption copy.
