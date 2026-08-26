# design/brand — the Motir brand mark

**Area:** `brand` · **Surface:** `brand-mark` (`brand-mark.mock.html` + `brand-mark.png`)
**Story:** MOTIR-656 (8.3 Marketing site + brand mark) · **Subtask:** MOTIR-1139 (8.3.1)
**Consumed by:** MOTIR-1150 (8.3.5, apply the mark across the app) — layout + token source of truth.
**Current mark:** the **wave band** — **APPROVED by Yue on 2026-08-06**, derived from his editable
draw.io source. MOTIR-1140 (8.3.2) is closed; see §1 for the decision and what it settled. The one
thing still open against this mark is trademark clearance (MOTIR-2267), which does not block
MOTIR-1150 but must land before public launch.
**Assets:** `design/brand/motir-logo.drawio.svg` (the editable **source**) ·
`design/brand/wave-band.svg` (native 768 × 768.5, the artwork) · `design/brand/wave-band-24.svg`
(24-grid cut).

This asset defines the logomark, the wordmark and its lockups, the light/dark colour rule, the
favicon / app-icon set, the 1200 × 630 OG template, and every shipped surface the mark enters.

**The mark is not a letterform.** An earlier revision built it from the letter M; that was rejected
(Yue, 2026-08-05) — an initial says only what the product is _called_, and Motir's name is not the
interesting thing about it. Every candidate in §1 is a **mathematical object chosen because it is
true of what Motir does**. Everything outside §1 is glyph-agnostic — the chosen mark reaches every
surface as `<path>` data alone, which is why the choice could be revisited so cheaply while it was
open, and why the alternatives are still worth keeping on record now that it is settled.

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

## 1. The logomark — the wave band (APPROVED)

**Approved by Yue on 2026-08-06** (MOTIR-1140, 8.3.2). This is the final mark: build against it.

**Its DRAWING re-approved by Yue on 2026-08-19** (MOTIR-3182, after MOTIR-3181), at
`design/brand/wave-band.svg` / `wave-band-24.svg` @ `5e67fd38`. **The concept was approved once and
the drawing twice**, and the second approval settled only the contour: the curve now meets each
vertical cap tangent-vertically (0.00000°, was 14.7° / 19.3° off), and the caps sit on the viewBox
edge so they land on whole pixels at every size (alpha 255, was 84–233 at the non-grid sizes). The
mark itself — its two crests, its rhythm, its proportions — is untouched, and MOTIR-1140's approval
is not re-opened.

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

### What the approval settled

The three items this asset previously listed as open are resolved. They are kept, with their
resolutions, because each one constrains what MOTIR-1150 may do to the mark.

- **~~It is traced, not constructed.~~ Resolved 2026-08-06** — the draw.io source replaced the
  screenshot trace, so the mark can be edited at source and re-exported exactly.

- **The two edges are not parallel — DELIBERATE.** Confirmed by Yue, 2026-08-06. Both curves start
  and end exactly **384 units** apart, but their interior control points do not: the upper curve's
  sit at y 497.25 and −226.75, the lower's at 1025.25 and 165.25, so those offsets are **144** and
  **8** rather than 384. The band pinches and swells along its length. **Do not regularise this to a
  constant-width offset** — the varying width is part of the mark, and a true offset curve would be
  a different mark.

- **~~At 24 px and below it reads as a letter M.~~ ACCEPTED, and not a defect.** What MOTIR-1140
  rejected at the start was a mark **derived from** the letter M — "an initial says only what the
  product is _called_." That is a rejection of the concept's _origin_. This mark's concept is a wave;
  a silhouette that resolves _toward_ an M once detail closes up at 16 px is a coincidence of form,
  not a return to a letterform. Every mark degrades at 16 px, and what matters in a tab strip is
  recall, not that a viewer parses the underlying idea. It is also continuity rather than regression:
  `ExploreTopBar` ships an `--el-accent` tile bearing a literal letter `M` today.

  **The consequence: the 40 px minimum is withdrawn.** It was a _reading_ floor, not a legibility
  one, so accepting the reading dissolves it. **The wave band ships as one artwork at every size** —
  no second cut, no simplified small-size variant, no permanent two-artwork tax. Where extra
  distinctiveness is wanted at favicon size, the tiled form (§5) already supplies it at zero cost.

**Still open, and not blocking:** no prior-art check has been run on this mark. The check below was
performed against the _lattice_. A wave band is a much less crowded shape than a concentric rhombus,
but "less crowded" is not "checked" — **MOTIR-2267** (trademark clearance, classes 9 + 42) searches
this shape, not that one. It does not block MOTIR-1150; it must land before public launch, ahead of
MOTIR-1130.

### On record — the lattice, chosen and then set aside

The Hasse diagram of a fork–join, nested inside itself at exactly half scale. A plan is a **finite
partially ordered set** and the rhombus is how mathematics draws the smallest non-trivial one — one
start, two independent paths, one convergence; nesting a second at half scale says the other true
thing, that a plan is **self-similar**. Chosen on 2026-08-05, then set aside in favour of the wave
band, which was approved on 2026-08-06. Its argument still stands and so does its prior-art record,
which is why both are kept rather than deleted.

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

### ⚠️ Refined 2026-08-19 — the contour, not the shape (MOTIR-3181)

**The reported defect, in Yue's words:** _"the points where the vertical line meet the curve — the
middle point of the box, the angle looks sharp, I want the curve turn to the vertical line
smoothly."_ It was sharp: the band ends in a straight VERTICAL cap at each side, and the curve
arrived at it **14.7° (right) and 19.3° (left) off vertical** — a corner at exactly the box's
vertical midpoint, `(0, 12)` and `(24, 12)`.

**The fix is local.** A quadratic's end tangent is `E − C`, so "arrives vertical" means the control
sits on the cap's own line (`C.x === E.x`). Forcing that on the full-length final segment drags the
control far outside the frame and turns the mark into a 0.66-aspect ribbon. So each final quadratic
is **split at 0.75** and only its TAIL re-aimed: the head is the de Casteljau restriction of the
original curve (unchanged), the tail starts with the same tangent (so the new join is
tangent-continuous) and ends vertical. Both junctions now measure **0.00000°**, every interior join
is under 0.001°, and the aspect stays at 0.999. Overlaying the old outline on the new fill, the two
diverge only in the last stretch before each cap.

0.75 is chosen rather than arbitrary: below ~0.70 the ease starts early enough to visibly fatten the
ends; at 0.85 the turn is too short and the corner is still legible. That is why the path now has
**six quadratics rather than four** — the two extra segments are the eased tails, not a re-fit.

Yue: _"the contour of the logo is not good, the left/right vertical line is maybe 1px out."_ It was.
**The curve is unchanged** — same control points, same silhouette, same approval. Two artifacts of
the hand-derivation were removed:

1. **A stray `+0.54` on every `y`**, and a `768.54` viewBox height, so no coordinate sat on a whole
   unit. Every number is now exact (`M0 0Q224 496 416 134…` at native size; the 24-grid cut
   terminates exactly at `15.5 / 4.1875 / −7.125 / 5.125 / 18.5625`).
2. **A ~1-unit MARGIN in the 24-grid cut** (caps at `x = 1.008` and `22.992` inside a 24 box) that
   the native artwork never had.

**The margin was the defect, and the reason is worth stating because it is counter-intuitive.** An
INSET vertical edge lands on a whole device pixel only at exact multiples of the grid; the **viewBox
boundary is pixel-aligned at every scale**. So a straight cap that sits ON the edge is crisp at every
size, and one that sits just inside it is not. Measured left/right cap alpha (0–255), before → after:

| size   | 16      | 24      | 26      | 28      | 32      | 48      | 56      | 64      |
| ------ | ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- |
| before | 84      | 254     | 233     | 211     | 168     | 255     | 166     | 80      |
| after  | **255** | **255** | **255** | **255** | **255** | **255** | **255** | **255** |

Before, only 24 px and 48 px — the exact grid multiples — were clean; everywhere else each cap
antialiased across two columns into a soft, uneven seam. That is the "about a pixel out".

**So: do not "tidy" a margin back into the artwork.** Whitespace around the mark belongs to the
CONSUMER — that is what §5's glyph-box scales are for. Both assets are now the same geometry at a
1:32 ratio, so the mark renders at the same relative size whichever file a surface reads; before this
they disagreed (native: no margin; 24-grid: 4.2%).

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
| **minimum size**      | **16 px**, a legibility floor. The earlier 40 px _reading_ floor was withdrawn on approval (§1): below ~24 px the mark resolves toward a letter M, and that was accepted rather than designed around. Below 16 px use the tiled form (§5).                                                        |
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

| File                  | Size    | Radius | Notes                                                                                                                                                             |
| --------------------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/icon.svg`        | 32      | rx 7   | Modern browsers; resolution-free. Uses the **tiled** form (glyph knocked out of an `--el-accent` field) — a browser tab has no surface behind it to tint against. |
| `app/apple-icon.png`  | 180     | rx 40  | iOS masks corners itself but supplies **no background** — the tile must be opaque `--el-accent`, and the file must be PNG, not SVG.                               |
| `public/icon-192.png` | 192     | rx 0   | `purpose: 'maskable'`, full bleed. **In `public/`, not `app/` — see the note below.**                                                                             |
| `public/icon-512.png` | 512     | rx 0   | `purpose: 'maskable'`, full bleed. **In `public/`, not `app/`.**                                                                                                  |
| `app/favicon.ico`     | 16 + 32 | rx 7   | Kept for old clients and anything requesting `/favicon.ico` by path. Re-cut from the same glyph so the two never disagree.                                        |

> **⚠️ The two maskable icons moved to `public/` during MOTIR-1150 — shipped reality, not preference.**
> This table originally put them in `app/`, where Next's static-metadata matcher would never have found
> them: it accepts one optional **digit** after `icon` (`variantsMatcher = '\d?'`,
> `next/dist/lib/metadata/is-metadata-route.js`), so `app/icon-192.png` matches nothing, is served at no
> URL, and the manifest entry naming it would 404. Renaming them to `app/icon1.png` / `icon2.png` matches
> but is worse: Next would then inject the full-bleed maskable renders as browser favicons, and it serves
> them from a content-hashed URL a static manifest cannot name. `public/` gives them the stable root path
> the manifest promises. `app/icon.svg` and `app/apple-icon.png` DO match the convention and stay put.

- **Corner radius** = **0.22 × the canvas** (32 → 7, 180 → 40). 0.22 is `--radius-lg` (12) over a
  56 px tile — the app's own container ratio, so the icon reads as the same family as the UI.
- **Safe zone — ⚠️ the wave band is expensive here, and this figure changed with the mark.** Maskable
  icons are cropped to an arbitrary OS shape, so the glyph must sit inside the centred circle of
  diameter **0.8 × canvas**. The band's extreme point is its **bounding-box corner** — the end cap at
  (22.992, 23.0) on the 24-grid — so its circumradius from the centre is the full diagonal,
  the full diagonal of the glyph box. It pays the √2 penalty that the earlier rhombus mark avoided,
  and **the 0.66 scale written here for that rhombus does not carry over.**

  **⚠️ Both numbers were RE-DERIVED on 2026-08-19 when the artwork lost its margin (§1).** The 24-grid
  asset used to inset by ~1 unit, so its bbox was `21.984 / 24` and the circumradius `0.648 × the
glyph box`. Edge to edge the glyph spans the FULL square, so the circumradius is now
  `√2 / 2 = 0.7071` and the safe-circle ceiling tightens to `0.8 / (2 × 0.7071) = 0.5657`. The scales
  are ALSO divided by `24 / 21.984 = 1.092`, so the icons render at the size they already did rather
  than jumping 9.2% on a refinement that was not asked to resize anything.

  **Maskable icons render the glyph at 0.55 × canvas** (0.778 across — inside 0.8, with margin for
  the OS shapes that crop tighter than a circle). The arithmetic ceiling is 0.5657; 0.55 is the round
  number below it, and it is also the compensated size. **Non-maskable icons use 0.605**, centred — they are not cropped, so the safe
  circle does not apply and the mark should read as large as the tile allows.

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

|        | Surface           | Form                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ----------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **7a** | App shell top bar | mark only, 24 px, **in a filled tile** | A **new** slot at the extreme left of `TopNav`'s left cluster, before the mobile hamburger. Mark only, because that cluster already carries the org › workspace › project path as text and a wordmark would read as a fourth level of context — the brand sits _outside_ that hierarchy. **Amended 2026-08-10 (MOTIR-2555):** the 32 px box the mark already sat in is now PAINTED — an `--el-surface` field with an `--el-border` hairline, `--radius-control` — and the hairline **divider that followed it is REMOVED**, because the tile's own edge now says what the divider said. The glyph is unchanged. |
| **7b** | Auth card         | horizontal lockup, 28 px               | In `AuthLayout` — **not** per page — so all five auth screens inherit it from one place. Sits above the `AuthShell` header inside the existing `gap-8` column; adds ~40 px.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **7c** | `ExploreTopBar`   | horizontal lockup, 26 px               | Replaces the tile + letter at the same optical height, so the bar's `py-3` rhythm is unchanged. Keeps its existing `<Link href="/">`; the wordmark gains its pinned face.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **7d** | `PublicTopBar`    | quiet lockup, 18 px, right             | "on Motir", before the auth CTAs. The project's tile is **left alone** — a visitor is here for the project; the brand is the host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **7e** | `EmailLayout`     | 20 px **hosted PNG** + "Motir"         | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **7f** | Browser chrome    | 16 px tiled icon                       | The one place the mark is judged with no wordmark, no colour context and no second chance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**⚠ 7a's tile is a FIELD, not a recolour (amended 2026-08-10, MOTIR-2555).** §9 says the mark takes
one token, never a hex and never a second hue — and it still does: the glyph in the shell slot keeps
`--el-accent-on-surface`, the same token it had before, so `.brand-glyph`'s global rule (shared with
7b, 7c, 7d, the OG images and the specimen) is untouched. What changed is the surface BEHIND it. The
field is deliberately NEUTRAL rather than a tint: `OrgControl`'s avatar is a 20 px
`--el-tint-lavender` tile and `ProjectAvatar` an `--el-avatar-lavender` one, so a third lavender
square 20 px away would read as another tier chip instead of as the brand. Measured glyph-on-fill:
**6.03:1** light, **4.24:1** dark (WCAG 1.4.11 asks 3:1). The full reasoning, the measurements and
the frames are in `design/shell/design-notes.md` § _The context row_ and
`design/shell/context-row.mock.html`.

**⚠ 7b has one exception: `/device`.** That screen's fold budget is _measured_
(`design/cli-connect/design-notes.md`: 1106 px single-column, which is why `AuthShell`'s `tight` mode
exists). It takes the **mark-only** form at 24 px — 24 px instead of 40 — or the lockup is suppressed
under `has-[[data-auth-wide]]`. MOTIR-1150 must **re-measure** that screen; do not assume.

**7e — email is a raster-and-tables world.** The mark is an `<img>`, never an inline `<svg>` element
and never a CSS variable: Outlook's Word renderer drops inline SVG entirely and Gmail strips
`<style>`. It needs a literal `#5645d4` baked into the pixels, explicit `width`/`height` attributes,
and `alt="Motir"` — roughly 40% of clients block images by default and the alt text is then the entire
header. One colour for both themes: email has no reliable dark-mode signal, and `#5645d4` holds 6.57:1
on the white body `EmailLayout` hardcodes.

**⚠️ Amended 2026-08-25 (MOTIR-3505) — a PNG at an ABSOLUTE `https://` URL, and NOT a data-URI SVG.**
This paragraph used to read _"a PNG or a data-URI SVG"_, and `EmailLayout` took the second option. It
rendered in no mail client at all: all eight transactional templates wrap in this layout, so every one
of them shipped an empty header that degraded to the alt text for **100%** of recipients rather than
the 40% the budget above is for — which is also why it went unnoticed until Yue read an invite in
Gmail. The two causes are independent and either is sufficient on its own, so the alternative had to
move on both axes at once:

| axis          | what fails                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **transport** | `data:` is not a source Gmail can use. It rewrites every image through its `googleusercontent.com` proxy and drops what it cannot FETCH; a data URI has nothing to proxy. |
| **format**    | SVG renders in email in **no** major client — Gmail, Outlook and Yahoo alike — hosted or inline. A hosted `.svg` would fix the transport and change nothing.              |

So the shipped rule is one line: **the `src` is an absolute `https://` URL to a raster.** Not a `data:`
URI, not SVG, and not a root-relative path either — an email is not a document, so it has no base URL
to resolve one against.

- **The asset** is `public/email-mark-40.png`, a build output of
  `scripts/brand/generate-brand-icons.mts` beside the icon set (§5) and asserted against the generator
  by `tests/brand/iconAssets.test.ts`. It is the **bare glyph** in `#5645d4` on transparency — the same
  artwork this section always specified — and deliberately **not** one of §5's tiles, which are opaque
  accent fields with the glyph knocked out in its ink and sized against the maskable safe circle.
- **40 px for a 20 px slot**, constrained by the `<img>`'s own `width`/`height`: a mail client has no
  `srcset` worth relying on, so the retina density has to be in the file.
- **It lives in `public/`**, which is the same trap §5 records for `icon-192.png` — Next's
  static-metadata matcher takes one optional _digit_ after `icon`, so an `app/`-convention name
  carrying a size is served at no URL at all.
- **The origin is `MOTIR_BASE_URL`** (`lib/baseUrl.ts`), resolved per send, never the literal
  `app.motir.co`: a self-hosted Motir serves its own mark from its own origin.
- **A guard asserts the transport**, in `tests/brand/emailBrandHeader.test.tsx`. The rendering test
  that was already here read the `src` and asserted what it DREW — the path data, the fill — which is
  why it stayed green throughout. Assert what a `src` IS, not only what it depicts.

**On panel 7e of `brand-mark.mock.html`:** the mock embeds its mark as a data URI because a mock is a
self-contained HTML page a browser renders — that is the correct choice _there_ and carries no
implication for the shipped email. (Its panel also still draws the **lattice**, the mark set aside in
§1, rather than the wave band; that is a stale-artwork defect of the asset, tracked separately.)

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
glyph on an accent field (on a filled surface it reverses to `--el-accent-text`) · **don't regularise
the band to a constant width** — the pinch and swell is deliberate (§1) · don't hand-edit the path
(edit the draw.io source and re-derive it — §2).

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
- **The glyph is settled** — the wave band, approved 2026-08-06 (§1). It is **one** `<path>`, six
  segments, `fill="currentColor"`. Keep that path string in ONE module anyway, so a future change is
  a single-file edit.
- **One artwork at every size.** The 40 px reading floor was withdrawn on approval (§1), so there is
  no small-size cut to author and no second file to keep in sync. The only variant is a
  **baked-colour** export of the same path for the contexts where `currentColor` cannot reach it —
  `<img>`, favicon, email, `next/og` (§2). That is a colour bake, not a second artwork; do not let it
  become one.
- **⚠️ Maskable icons render at 0.55 × canvas, not 0.605** (§5). The band's extreme point is its
  bounding-box corner, so at the non-maskable scale it overflows the 0.8 safe circle and the OS mask
  clips it. (Both numbers moved on 2026-08-19 with the margin removal — §1.)
- **Neither prior-art check nor trademark clearance covers this mark.** §1's visual-similarity table
  was run against the _lattice_, which is a different shape. **MOTIR-2267** searches the wave band in
  classes 9 and 42 and must land before launch — it does not block this card.
- **If a motion identity is ever wanted, D is on file** with two motions already built. That would be
  its own card, and the motion surfaces live in `motir-marketing`, not here.

## File-name note

The card's acceptance criteria name `design/brand/brand-mark.design-notes.md`. This file is
`design/brand/design-notes.md` instead, which is the convention `motir-core/CLAUDE.md` states and
every other area follows (`design/<area>/design-notes.md`, one per area, indexing that area's
surfaces). The mock and PNG keep the `brand-mark` basename the card asks for.
