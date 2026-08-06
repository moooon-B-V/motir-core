# design/brand — the Motir brand mark

**Area:** `brand` · **Surface:** `brand-mark` (`brand-mark.mock.html` + `brand-mark.png`)
**Story:** MOTIR-656 (8.3 Marketing site + brand mark) · **Subtask:** MOTIR-1139 (8.3.1)
**Consumed by:** MOTIR-1150 (8.3.5, apply the mark across the app) — layout + token source of truth.
**Current mark:** the **wave band**, traced from Yue's reference drawing on 2026-08-05 and adopted
"for now" — see §1 for how it was fitted and what it still owes. MOTIR-1140 (8.3.2) stays open until
that provisional status is resolved.
**Assets:** `design/brand/motir-logo.drawio.svg` (the editable **source**) ·
`design/brand/wave-band.svg` (native 768 × 768.5, the artwork) · `design/brand/wave-band-24.svg`
(24-grid cut).

This asset defines the logomark, the wordmark and its lockups, the light/dark colour rule, the
favicon / app-icon set, the 1200 × 630 OG template, and every shipped surface the mark enters.

**The mark is not a letterform.** An earlier revision built it from the letter M; that was rejected
(Yue, 2026-08-05) — an initial says only what the product is _called_, and Motir's name is not the
interesting thing about it. Every candidate in §1 is a **mathematical object chosen because it is
true of what Motir does**. Everything outside §1 is glyph-agnostic, so MOTIR-1140 can substitute one
candidate for another by swapping `<path>` data alone.

---

## 0. Drawn against shipped reality

Every surface this mark lands in already exists, so each was **rendered before anything was drawn**
(`notes.html` #73 — reading the `.tsx` is not seeing what renders). Four components were rendered
through the repo's own vitest + RTL (`tests/helpers/renderWithIntl` with the real
`messages/en.json`) against `origin/main` @ `82529aa0`, and their emitted markup is reproduced in the
mock class-for-class:

| Rendered                                              | Panel  | What the render established                                                                                   |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `app/(public)/explore/_components/ExploreTopBar.tsx`  | 0a, 7c | The **only** shipped brand lockup: a 28 px `--el-accent` tile with the letter `M`, plus "Motir" at 15 px/700. |
| `app/(public)/_components/PublicTopBar.tsx`           | 0b, 7d | Its tile renders `name.charAt(0)` — the **project's** initial, not the brand.                                 |
| `app/(auth)/layout.tsx` + `_components/AuthShell.tsx` | 0c, 7b | No mark at all; the layout's docstring records the deferral this card closes.                                 |
| `app/(authed)/_components/ProjectSwitcher.tsx`        | 0d     | The rail head is entirely project context.                                                                    |

Read but not re-rendered (no visual surface of their own): `TopNav.tsx` (its docstring reserves the
brand slot), `lib/emailTemplates/_components/EmailLayout.tsx`, both `opengraph-image.tsx` routes, and
`packages/design-system/theme.css` (every token value and contrast ratio in Panel 4 comes from its
literals).

**The mock's stylesheet is Tailwind's real output** — Tailwind v4 compiled against the page plus
`@motir/design-system/theme.css` verbatim (Tier-0, the `[data-theme='dark']` flip, the whole Tier-3
`--el-*` layer), inlined. No hex was retyped, so the asset cannot drift from the shipped token layer.

### Three findings the renders produced

1. **The shipped wordmark re-letters itself under the type axis.** `ExploreTopBar`'s "Motir" carries
   no font class, so it inherits `--font-sans` from `body` — and
   `[data-type='motir-mono' | 'grotesk' | 'mono-technical']` each re-point that role. A user picking a
   type pairing in Appearance changes the brand's typeface. §3 fixes it (pin the raw face variable).
2. **`PublicTopBar` is not a brand surface**, though MOTIR-1150's card lists it as one. Its tile is
   project identity. §7d gives the brand its own quiet slot there instead of overwriting it.
3. **`SidebarHeader` — which MOTIR-1150's card also names — has no room for the brand.** It is
   `ProjectSwitcher` (or the create-project CTA). The shell needs a **new** slot, and `TopNav`'s own
   docstring already reserved one: _"No wordmark slot (brand-mark deferral, MOTIR.md)."_ §7a fills it.

---

## 1. The logomark — the wave band (current, provisional)

Yue supplied a reference drawing on 2026-08-05 and asked for it to be used as the logo for now, so
the mark was **traced from that image** rather than constructed.

**It is not a trace.** Yue supplied the mark as an editable **draw.io vector file**
(`design/brand/motir-logo.drawio.svg`), which draws it as four _open_ strokes: an upper curve, a
lower curve and two straight end caps. The artwork is that same geometry **closed and filled** —
upper curve → right cap → lower curve reversed → left cap — built from the source's _own control
points_.

**Four quadratic curves and two straight caps: six segments, ~110 bytes.** There is no fitting error
to measure, because nothing was fitted — the path _is_ the source's geometry.

**One path, `fill="currentColor"`.** It carries no colour of its own, so it takes whatever `color`
the surface sets — which is how it follows the theme and a `data-palette` swap for free (§4).

> **Superseded, and worth remembering.** Until 2026-08-06 this mark was traced from a _screenshot_.
> The first trace sampled the drawn strokes' centrelines and was **3.17% off** — 1,745 of 55,000
> pixels, all missing, the whole shape ~1 px thin all round. Refitting against the flood-filled
> region got it to **0.069%**, and reaching 0.000% required an 822-point staircase that visibly
> stepped when enlarged. All of that disappeared the moment a real vector source existed. **The
> lesson: ask for the source before tracing the picture** — and if you must trace, measure the
> result rather than eyeballing it, because a 3% error was invisible by eye.

### What this mark does not yet have

- **~~It is traced, not constructed.~~ Resolved 2026-08-06** — the draw.io source replaced the
  screenshot trace, so the mark can be edited at source and re-exported exactly. The items below
  still stand.

- **The two edges are not parallel** — and the source now says so precisely. Both curves start and
  end exactly **384 units** apart, but their interior control points do not: the upper curve's sit at
  y 497.25 and −226.75, the lower's at 1025.25 and 165.25, so those offsets are 144 and 8 rather than 384. The band pinches and swells along its length. That is how it was drawn; only worth changing if
  it was not deliberate.

- **⚠️ At 24 px and below it reads as a letter M.** The two peaks and the central dip land squarely
  in M territory once the detail closes up. That is the one thing this card ruled out at the start,
  and it is the reason the mark is provisional rather than settled. It reads as an abstract wave at
  40 px and above, and on the app tile. **Minimum size is therefore 40 px** — a _reading_ floor, not
  a legibility one.
- **No prior-art check has been run on it.** The check below was performed against the _lattice_. A
  wave band is a much less crowded shape than a concentric rhombus, but "less crowded" is not
  "checked" — **MOTIR-2267** (trademark clearance) now needs to search this shape, not that one.

### On record — the lattice, chosen and then set aside

The Hasse diagram of a fork–join, nested inside itself at exactly half scale. A plan is a **finite
partially ordered set** and the rhombus is how mathematics draws the smallest non-trivial one — one
start, two independent paths, one convergence; nesting a second at half scale says the other true
thing, that a plan is **self-similar**. Chosen on 2026-08-05, then set aside in favour of the traced
wave band. Its argument still stands and so does its prior-art record, which is why both are kept
rather than deleted.

### Prior art — the check that was run on the LATTICE

Kept because it is the only prior-art work done on this card so far, and because it is a worked
example of the check any mark needs. **It concerns the lattice, not the wave band.** A plain
concentric rhombus is one of the most occupied geometric marks in existence — checked against public
sources on 2026-08-05:

| Mark               | Construction                                                                                                                  | Distance from a plain concentric rhombus                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Binance**        | A large diamond with an intersecting form cut out of it — four outer corner elements around a central diamond                 | **The closest, and the most dangerous.** Adjacent sector, and at small size the gestalt is exactly diamond-inside-diamond |
| **Renault** (2021) | Two interlocking diamonds, flat monoline, weaving through each other                                                          | Different construction, but the most famous monoline diamond mark there is                                                |
| **Umbro**          | The "double diamond" — overlapping rhombi, since 1924                                                                         | The mark that defined the nested-diamond category                                                                         |
| **Mitsubishi**     | Three rhombi arranged into an implied fourth                                                                                  | The most recognised rhombus mark in the world                                                                             |
| Stock              | 100,000+ "diamond shape logo" assets; "diamond inside a diamond" is a documented stock trope explicitly sold to tech startups | The shape carries no ownership at all on its own                                                                          |

**The conclusion, and the fix.** The idea behind the mark is Motir's; the plain concentric drawing of
it is nobody's. Adding the vertices moves it from _decorative shape_ to _the mathematical object it
actually is_, and walks it out of that neighbourhood without changing the idea by a single degree.
Four alternatives were drawn and compared — breaking the edges at the vertices, breaking both rings,
a square inside the diamond, and an outer ring with nodes but no inner rhombus. Nodes-on-the-outer-
vertices was chosen: the smallest change that buys the most separation, and the only one that keeps
the mark legible at 16 px.

**⚠️ Still outstanding:** this is a visual-similarity check against public sources, **not a
trademark clearance search**. A registered-mark search in classes 9 and 42 is a separate job. It does
not block MOTIR-1150, but it must happen before launch — surface it as its own `manual` card.

Sources: [Renault 2021 (designboom)](https://www.designboom.com/design/renault-diamond-logo-new-flatified-op-art-version-03-23-2021/) ·
[Binance logo construction](https://www.binance.com/en/square/post/2023-09-18-binance-logo-design-a-unique-blend-of-symbolism-and-geometry-1164689) ·
[Famous rhombus logos](https://1000logos.net/most-famous-logos-with-a-rhombus/) ·
[Diamond-in-diamond as a stock trope](https://smartscience.blog/diamond-inside-diamond-logo-meaning) ·
[Diamond logo stock volume](https://www.shutterstock.com/search/diamond-shape-logo)

### The three alternatives, kept on record

- **B · Hypocycloid** — the curve traced by a point on a circle rolling inside a circle five times
  larger; a sprint inside a roadmap. _Not chosen:_ a solid concave star is a silhouette, and five
  cusps sit one cusp from the four-cusp astroid — the ✨ Motir's own "Plan with AI" launcher renders.
- **C · Borromean** — three rings, no two linked, all three inseparable; exactly the three-pillar
  thesis. _Not chosen:_ the most on-message and the least legible; it fails below 24 px and would
  cost a permanent second artwork.
- **D · Wave** — the outline of a band swept along one period of a sine; a wave advances while it
  oscillates, which is the sprint. _Not chosen_, but it is the one that could **animate as itself**:
  travel (the phase advances, the band stays put) and frequency (one period stretches to two), both
  re-derived from a changed curve rather than tweened, each frame a single path. Kept in the mock in
  case a motion identity is wanted later.

### Considered and dropped

The **isometric cube** (the Hasse diagram of B₃ — the mark one dimension up) and the **Penrose
tribar** (locally consistent everywhere, globally impossible — a precise description of a plan that
does not close). Both mathematically apt, both built and rendered, both among the most heavily used
marks in software — the cube is lucide's own `Box`.

Three more were built and dropped while chasing a three-dimensional form: the **astroidal ellipsoid**
(|x|^(2/3) + |y|^(2/3) + |z|^(2/3) = 1), too complicated at a faceted mesh of 80 paths; the
**hypocycloid plate**, candidate B cut thick and tilted; and the wave as a **shaded solid**, which
had the volume but not the elegance. **Straight extrusion** of a flat curve was tried before any of
them — it yields slivers of wall that read as a drop shadow. And a **diagonally-rolled wave** was
rejected for reading plainly as the letter Z, the very thing this card ruled out at the start.

---

## 2. Construction

**Source of truth: `design/brand/motir-logo.drawio.svg`** — Yue's editable draw.io file, kept beside
the artwork. **To change the mark, edit the source and re-derive the artwork; do not hand-edit the
path.**

|                       |                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **path**              | **One closed path: four quadratic curves + two straight caps** — six segments, ~110 bytes. `wave-band.svg` is the native artwork (768 × 768.5); `wave-band-24.svg` is the 24-grid cut.                                                                                                            |
| **how it is derived** | The source draws four _open_ strokes. The artwork closes and fills them — upper curve → right cap → lower curve reversed → left cap — using the source's own control points. Reversing a quadratic just swaps its endpoints and keeps its control point, which is why the derivation is lossless. |
| **accuracy**          | **Exact by construction.** Nothing is fitted, so there is no deviation to measure.                                                                                                                                                                                                                |
| **paint**             | `fill="currentColor"`, no stroke. The mark carries **no colour of its own** — it inherits `color` from whatever renders it, which is what makes it follow theme and palette (§4).                                                                                                                 |
| **extent**            | x 1.01 → 22.99, y 1.0 → 23.0 on the 24-grid — **21.98 × 22**, all but square, centred on (12, 12). Aspect preserved from the source, so it is a hair taller than wide; **do not stretch it to fill a square**.                                                                                    |
| **clear space**       | **3 units** (12.5% of the box edge) on all four sides, measured from the extent. A solid form needs less air than an outline of the same size.                                                                                                                                                    |
| **minimum size**      | **⚠️ 40 px.** Not a legibility floor — the shape survives far smaller — but a _reading_ floor: at 24 px and below it reads as a letter M (§1).                                                                                                                                                    |
| **colour**            | ONE colour. Monochrome by construction — never a gradient, a second hue or a shadow.                                                                                                                                                                                                              |

> **⚠️ Never write `--` inside an SVG comment.** XML forbids a double hyphen in a comment, so an
> otherwise-harmless line like `color: var(--el-accent-on-surface)` in a file header makes the
> whole SVG malformed. It still renders in a browser (HTML parsing is lenient) but fails anywhere
> that parses it as XML — GitHub shows _"Error rendering embedded code — Invalid image source"_ in the
> PR diff, which is how this was found. Refer to tokens by name in SVG comments, not by `var()`
> syntax.

**`currentColor` only themes when the SVG is inline.** `<svg>` / `<use>` / an imported React
component all inherit `color` and therefore follow the theme. Referenced via `<img src>`, as a CSS
`background-image`, or as a favicon, `currentColor` resolves to **black** — those contexts need a
baked-colour variant (§5, §6 and §7e all hit this).

## 3. Wordmark and lockups

Three forms, all in the mock: **horizontal** (the default — every chrome surface), **stacked** (the OG
card and any square-ish field), and **mark only** (where the product name is already on screen, or
below 96 px of width).

|                              |                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **face**                     | **Inter**, weight **700**, tracking **-0.02em** — already loaded by `app/layout.tsx`, so the wordmark costs no new font payload.                                                                                                                                                                               |
| **⚠ the pin**                | The wordmark MUST read `font-family: var(--font-sans-source), …` — the raw **face** variable — and **never `var(--font-sans)`**, the role token, which three `[data-type]` blocks re-point. The mark is brand; the type axis is chrome; they must not be wired to the same variable. This is finding #1 above. |
| **proportion**               | wordmark `font-size = 0.72 × glyph box`; gap `= 0.33 × glyph box`. Baselines optically aligned by centring the wordmark's cap-height on the glyph's **extent**, not its viewBox. At a 32 px glyph: 23 px type, 10.5 px gap.                                                                                    |
| **colour**                   | glyph `--el-accent-on-surface`; wordmark `--el-text`. Two tokens, both themes, no exceptions.                                                                                                                                                                                                                  |
| **on a filled accent field** | both reverse to `--el-accent-text`.                                                                                                                                                                                                                                                                            |
| **raster surfaces**          | `next/og` renders outside the CSS tree, so the OG template passes Inter through `ImageResponse`'s `fonts` option (§6). Email uses the client's own sans stack (§7e).                                                                                                                                           |

The reference implementation, as CSS (the mock's `.brand-lockup` — copy it):

```css
.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--brand-size) * 0.33);
}
.brand-glyph {
  color: var(--el-accent-on-surface);
  flex: none;
}
.brand-word {
  font-family:
    var(--font-sans-source, Inter),
    -apple-system,
    BlinkMacSystemFont,
    sans-serif;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-size: calc(var(--brand-size) * 0.72);
  line-height: 1;
  color: var(--el-text);
}
```

---

## 4. Colour and the dark variant

The mark is a graphical object, so the bar is WCAG 1.4.11's **3:1**; the wordmark is live text and
takes 1.4.3's **4.5:1**. Every ratio below was computed from the literal token values in
`packages/design-system/theme.css`.

| Element                           | Token                    | Resolved  | On                         | Ratio   | Bar                |
| --------------------------------- | ------------------------ | --------- | -------------------------- | ------- | ------------------ |
| glyph, light                      | `--el-accent-on-surface` | `#5645d4` | `--el-page-bg` `#ffffff`   | 6.57:1  | ≥3 ✓               |
| glyph, light                      | `--el-accent-on-surface` | `#5645d4` | `--el-surface` `#f6f5f4`   | 6.03:1  | ≥3 ✓               |
| glyph, light                      | `--el-accent-on-surface` | `#5645d4` | `--el-auth-wash` `#dcecfa` | 5.45:1  | ≥3 ✓               |
| glyph, dark                       | `--el-accent-on-surface` | `#7b6ce5` | `--el-page-bg` `#0f0f0f`   | 4.67:1  | ≥3 ✓               |
| glyph, dark                       | `--el-accent-on-surface` | `#7b6ce5` | `--el-surface` `#1a1a1a`   | 4.24:1  | ≥3 ✓               |
| glyph, dark — **the wrong token** | `--el-accent`            | `#6c5cdd` | `--el-page-bg` `#0f0f0f`   | 3.85:1  | passes, but dimmer |
| glyph on tile, light              | `--el-accent-text`       | `#ffffff` | `--el-accent` `#5645d4`    | 6.57:1  | ≥3 ✓               |
| glyph on tile, dark               | `--el-accent-text`       | `#ffffff` | `--el-accent` `#6c5cdd`    | 4.99:1  | ≥3 ✓               |
| wordmark, light                   | `--el-text`              | `#1a1a1a` | `--el-page-bg` `#ffffff`   | 17.40:1 | ≥4.5 ✓             |
| wordmark, dark                    | `--el-text`              | `#f3f4f6` | `--el-page-bg` `#0f0f0f`   | 17.42:1 | ≥4.5 ✓             |

Three rules follow:

- **The dark variant is a token choice, not a second asset.** The glyph paints `currentColor` and the
  lockup sets `color: var(--el-accent-on-surface)`, which resolves to `#5645d4` light and `#7b6ce5`
  dark on its own. There is no `brand-dark.svg` to keep in sync.
- **Use `--el-accent-on-surface`, not `--el-accent`.** The two are the same colour in light and
  diverge in dark; `--el-accent` is the darker FILL built to carry white ink, and it loses 0.8 of a
  ratio point as a glyph.
- **Never `--el-text-inverted`.** It is `var(--color-background)` — white in light, `#0f0f0f` in dark.
  It is the ink FOR a filled field, so a mark painted with it **disappears on the page background in
  light mode**: the exact flip the card warns about. On a filled tile the correct ink is
  `--el-accent-text`.

---

## 5. Favicon / app-icon set

`app/favicon.ico` (16 + 32) is the only icon that ships today and stays as the legacy fallback.
Everything else is new — and Next.js only auto-wires files it _finds_, so each of these has to exist:

| File                 | Size    | Radius | Notes                                                                                                                                                             |
| -------------------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/icon.svg`       | 32      | rx 7   | Modern browsers; resolution-free. Uses the **tiled** form (glyph knocked out of an `--el-accent` field) — a browser tab has no surface behind it to tint against. |
| `app/apple-icon.png` | 180     | rx 40  | iOS masks corners itself but supplies **no background** — the tile must be opaque `--el-accent`, and the file must be PNG, not SVG.                               |
| `app/icon-192.png`   | 192     | rx 0   | `purpose: 'maskable'`, full bleed.                                                                                                                                |
| `app/icon-512.png`   | 512     | rx 0   | `purpose: 'maskable'`, full bleed.                                                                                                                                |
| `app/favicon.ico`    | 16 + 32 | rx 7   | Kept for old clients and anything requesting `/favicon.ico` by path. Re-cut from the same glyph so the two never disagree.                                        |

- **Corner radius** = **0.22 × the canvas** (32 → 7, 180 → 40). 0.22 is `--radius-lg` (12) over a
  56 px tile — the app's own container ratio, so the icon reads as the same family as the UI.
- **Safe zone.** Maskable icons are cropped to an arbitrary OS shape, so the glyph must sit inside the
  centred circle of diameter **0.8 × canvas**. A rhombus makes this cheap: its extreme points lie on
  the axes, not at bounding-box corners, so its circumradius is only `10.3 / 24 = 0.429 × the glyph
box`. Rendered at **0.66 × canvas** that is 0.57 × canvas across — comfortably inside 0.8. (A square
  or a letterform pays √2 for the same extent and has to be shrunk to fit.) Non-maskable icons use the
  same 0.66, centred.
- **`app/manifest.ts`** declares both maskable entries plus `name: 'Motir'`, `short_name: 'Motir'`,
  `theme_color` = the light `--el-accent` literal and `background_color` = the light `--el-page-bg`
  literal. A manifest is static JSON and cannot read a CSS variable, so those two are hex literals —
  their provenance is recorded here, and that is what must be kept in sync.

Today, with none of these present, an iOS "Add to Home Screen" gets a screenshot of the page.

---

## 6. OG template · 1200 × 630

Both shipped OG routes render from one template. `ImageResponse` renders outside the CSS tree and
cannot read a variable, so these files carry inline hexes — the exception both files already document.
Each literal below names the token it came from; that provenance is the thing to keep in sync.

|             |                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **canvas**  | 1200 × 630, padding 80. `background: linear-gradient(135deg, #e6e0f5 0%, #dcecfa 100%)` — kept as-is: those are `--color-tint-lavender` → `--color-tint-sky`, so the wash was already token-traceable.                                   |
| **lockup**  | glyph 72 × 72 in `#5645d4` (`--color-primary`), wordmark 30 px / 700 in `#2a2342`, gap 20. Replaces the 72 px purple tile bearing the letter M.                                                                                          |
| **type**    | headline 60 / 800 / 1.1 in `#1f1b2e`; lede 28 in `#473f63`, max-width 920. Unchanged — only the brand row changes.                                                                                                                       |
| **⚠ fonts** | Pass Inter via `ImageResponse({ fonts: [{ name: 'Inter', data, weight: 700 }] })` and set `fontFamily: 'Inter'`. Both files say `'sans-serif'` today, so the current cards are set in whatever face the build container happens to ship. |
| **alt**     | `export const alt` exists on the explore route and must exist on the project route too — it is the only accessible name a social embed gets.                                                                                             |

**Two layouts, not one.** The _section_ card (`explore`) puts the brand lockup top-left with headline
and lede anchoring the bottom. The _project_ card (`p/[identifier]`) keeps its big project tile — the
project is the subject — and moves the brand to a **footer lockup**, so the two identities never
compete.

---

## 7. Where the mark goes (the access path)

The mark is not a page you navigate to; its "entrance" is the set of slots it occupies. In five of the
six it is also the **home link**.

|        | Surface           | Form                       | Notes                                                                                                                                                                                                                                                                                                                            |
| ------ | ----------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **7a** | App shell top bar | mark only, 24 px           | A **new** slot at the extreme left of `TopNav`'s left cluster, before the mobile hamburger, with a hairline divider separating it from `ShellTierNav`. Mark only, because that cluster already carries org › workspace as text and a wordmark would read as a fourth level of context — the brand sits _outside_ that hierarchy. |
| **7b** | Auth card         | horizontal lockup, 28 px   | In `AuthLayout` — **not** per page — so all five auth screens inherit it from one place. Sits above the `AuthShell` header inside the existing `gap-8` column; adds ~40 px.                                                                                                                                                      |
| **7c** | `ExploreTopBar`   | horizontal lockup, 26 px   | Replaces the tile + letter at the same optical height, so the bar's `py-3` rhythm is unchanged. Keeps its existing `<Link href="/">`; the wordmark gains its pinned face.                                                                                                                                                        |
| **7d** | `PublicTopBar`    | quiet lockup, 18 px, right | "on Motir", before the auth CTAs. The project's tile is **left alone** — a visitor is here for the project; the brand is the host.                                                                                                                                                                                               |
| **7e** | `EmailLayout`     | 20 px image + "Motir"      | See below.                                                                                                                                                                                                                                                                                                                       |
| **7f** | Browser chrome    | 16 px tiled icon           | The one place the mark is judged with no wordmark, no colour context and no second chance.                                                                                                                                                                                                                                       |

**⚠ 7b has one exception: `/device`.** That screen's fold budget is _measured_
(`design/cli-connect/design-notes.md`: 1106 px single-column, which is why `AuthShell`'s `tight` mode
exists). It takes the **mark-only** form at 24 px — 24 px instead of 40 — or the lockup is suppressed
under `has-[[data-auth-wide]]`. MOTIR-1150 must **re-measure** that screen; do not assume.

**7e — email is a raster-and-tables world.** The mark is an `<img>` (a PNG or a data-URI SVG), never
an inline `<svg>` element and never a CSS variable: Outlook's Word renderer drops inline SVG entirely
and Gmail strips `<style>`. It needs a literal `#5645d4` stroke, explicit `width`/`height` attributes,
and `alt="Motir"` — roughly 40% of clients block images by default and the alt text is then the entire
header. One colour for both themes: email has no reliable dark-mode signal, and `#5645d4` holds 6.57:1
on the white body `EmailLayout` hardcodes.

---

## 8. Accessible names — decorative vs informative

The rule is about the **container**, not the mark: _if the visible wordmark is beside it, the glyph is
decorative; if the glyph stands alone, it carries the name._

| Slot                   | Form                    | Markup                                                         | Accessible name                    |
| ---------------------- | ----------------------- | -------------------------------------------------------------- | ---------------------------------- |
| Shell top bar (7a)     | mark only, is a link    | `<Link aria-label="Motir — go to dashboard"><svg aria-hidden>` | **informative** — the link's label |
| Auth card (7b)         | lockup, is a link       | `<svg aria-hidden>` + visible "Motir"                          | **decorative**                     |
| `ExploreTopBar` (7c)   | lockup, is a link       | `<svg aria-hidden>` + visible "Motir"                          | **decorative**                     |
| `PublicTopBar` (7d)    | quiet lockup, is a link | `<svg aria-hidden>` + visible "on Motir"                       | **decorative**                     |
| Email (7e)             | image, not a link       | `<img alt="Motir">`                                            | **informative**                    |
| Favicon / app icon (5) | image, OS chrome        | `manifest.name = 'Motir'`                                      | **informative**                    |
| OG card (6)            | image, social embed     | `export const alt`                                             | **informative**                    |

- **Never both.** An `aria-label` on the link _plus_ a visible wordmark inside it makes a screen reader
  announce "Motir" twice, or announce the label and silently drop the visible text. One per slot — the
  table above is the pick.
- **The wordmark stays live text** on every DOM surface: selectable, translatable, searchable, and it
  survives a user's font-size preference. `next/og` and email are the two exceptions, and both are
  raster surfaces.

---

## 9. Don'ts

Don't stretch it (scale both axes) · don't recolour it (one token, never a hex, never a second hue) ·
don't add effects (no shadow, glow, bevel, gradient) · don't crowd it (2 × the stroke weight of clear
space, minimum) · don't use the bare glyph below 16 px (use the tiled form) · don't put the accent
glyph on an accent field (on a filled surface it reverses to `--el-accent-text`).

---

## Notes for MOTIR-1150

- Ship **one** `BrandMark` component with a `variant` (`lockup` | `mark` | `stacked`) and a `size`
  prop, and let every surface compose it. The glyph is `currentColor`, so the _only_ thing a surface
  chooses is size, variant, and whether it is a link.
- The type-axis pin (§3) is the one non-obvious requirement. A wordmark that reads `font-sans` will
  look correct in review and re-letter itself the moment someone changes their Appearance pairing.
- `SidebarHeader` and `PublicTopBar` are named on MOTIR-1150's card as brand surfaces but are project
  identity in shipped code (findings #2 and #3). §7a and §7d say what to do instead; the card's
  acceptance criteria should be read against those sections, not literally.
- The artifact this card does **not** produce is the raster set itself (`apple-icon.png`,
  `icon-192/512.png`). Those are build outputs — MOTIR-1150 renders them from the single SVG source
  defined in §2 at the sizes and safe zones in §5.
- **The glyph is settled** (A, with nodes — §1). Keep the two `<path>` strings and the four node
  circles in ONE module anyway, so a future change is a single-file edit. - **The prior-art check is done; the trademark clearance is not.** §1 records a visual-similarity
  check against public sources. A registered-mark search in classes 9 and 42 is a separate `manual`
  card that must land before launch — it does not block this one.
- **If a motion identity is ever wanted, D is on file** with two motions already built. That would be
  its own card, and the motion surfaces live in `motir-marketing`, not here.

## File-name note

The card's acceptance criteria name `design/brand/brand-mark.design-notes.md`. This file is
`design/brand/design-notes.md` instead, which is the convention `motir-core/CLAUDE.md` states and
every other area follows (`design/<area>/design-notes.md`, one per area, indexing that area's
surfaces). The mock and PNG keep the `brand-mark` basename the card asks for.
