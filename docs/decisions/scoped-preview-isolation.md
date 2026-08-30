# Scoped preview isolation — how a nested `[data-style]` stops the material layer

**Status:** accepted · **Date:** 2026-08-30 · **Card:** MOTIR-3947 (epic MOTIR-3875)

`StyleVignette` in SCOPED mode puts `data-style` on a nested wrapper so a gallery
can render one tile per registered style. The style axis's **material layer** —
translucency, gradient canvases, frosted `backdrop-filter`, light borders — ships
as _descendant_ rules (`[data-style='X'] [data-surface='card']`), and a descendant
combinator does not stop at a nested `data-style`. Every such rule therefore
matches straight through the boundary, so a tile labelled _Neo-Brutalism_ under an
active _Glassmorphism_ renders as glass.

This decides the mechanism that stops it, before any of the 69 rules is touched.
It ships no behaviour change; it decides, and it names the cards that build.

> **On the file name.** `docs/decisions/` is slug-named, not numbered. This slug
> was checked against `origin/main` **and** every `refs/remotes/origin/*` branch
> (`git ls-tree <branch> docs/decisions/`) before being taken, because two
> parallel runs picking the same name collide exactly as two picking the same
> number would.

---

## Q1 — what is broken, re-measured on `origin/main`

MOTIR-3947 was filed at a base predating **motir-core#2465** (MOTIR-3933), which
merged into `packages/design-system/theme.css` at `2026-08-30T10:55:41Z` — after
the card was written. `validate_work_item` raised that as a `subsumption`
advisory, so the card's numbers were re-taken rather than inherited.

**The count holds.** At `origin/main` (`0068da2f4`), counting with the claim's own
predicate — a selector block carrying a combinator after its `[data-style='X']`
compound, minus the ones already anchored to a scope:

```
$ node transform.mjs packages/design-system/theme.css   # the prototype rewriter, Q3
converted 69 rule blocks; left alone 15:
  10 bare [data-style='…'] token blocks
   1 compound token block ([data-style='neumorphism'][data-theme='dark'])
   4 already scope-anchored rules (.style-vignette[data-style='…'] > .sv-canvas)
```

**69**, unchanged by #2465 — that pull request added 156 lines to the file and no
new material rule. The same count at `d851bbb32^` (its own base) is also 69.

**The render holds too.** Eleven `<div data-style="ID" data-appearance-scope>`
tiles carrying the five `data-surface` hooks plus `.border` and `.sv-canvas`,
under one `<html data-style="ACTIVE">`, each compared against **what that same
tile renders when `<html>` carries its own style** — identical DOM in both arms,
so the only variable is the ancestor. Headless Chromium 1228, twelve computed
properties per element plus `::after`:

| `<html>` `data-style`                                             | card's figure | measured here |
| ----------------------------------------------------------------- | ------------- | ------------- |
| `warm-editorial` (the base — ships no block, so nothing can leak) | 11 / 11       | **11 / 11**   |
| `aurora`                                                          | 3 / 11        | **2 / 11**    |
| `glassmorphism`                                                   | 1 / 11        | **1 / 11**    |

The exemplar the card names reproduces exactly: under `glassmorphism`, the
`neo-brutalism` and `aurora` tiles compute `backdrop-filter: blur(18px)
saturate(1.8)` and a translucent `color(srgb 1 1 1 / 0.5)` fill.

**On the one differing cell.** `aurora` reads 2/11 here, not 3/11. The extra
failing tile is `neumorphism`, which differs from its own render in exactly three
declarations, all `background-image` (aurora's wash on `card` / `modal` /
`sidebar`) and nothing else. A narrower probe — fewer elements, or fewer
properties — scores it a pass. This is **probe breadth, not drift**: the two
measurements are of the same defect at the same ref, and the direction is
stricter, so the card's number is a floor rather than a ceiling. Recorded here
rather than absorbed, because a count that comes back worse arrives with an
innocent explanation already attached.

**And the card measured three ancestors out of eleven.** The full matrix — every
style as the active one, eleven scoped tiles under each — is the number that
should have been in the card:

```
ancestor              tiles wearing their OWN material
  warm-editorial        11 / 11
  soft-playful          11 / 11
  swiss-minimal-flat    11 / 11
  neo-brutalism         11 / 11
  glassmorphism          1 / 11
  cybercore-y2k         11 / 11
  aurora                 2 / 11
  3d-immersive           3 / 11
  neumorphism            1 / 11
  hand-drawn-indie       1 / 11
  retrofuturism          1 / 11
                  TOTAL 64 / 121
```

**Six of the eleven styles leak.** The five that do not are the four that ship no
material rules at all plus `cybercore-y2k`, whose only descendant rule targets
`body` — an element a tile has no counterpart for. So "clean" here means "has
nothing to leak", never "is isolated".

---

## Q2 — why a base token block is the wrong remedy

MOTIR-3933 framed the style half as a missing base entry, remediable with a
`[data-style='warm-editorial']` block mirroring the palette fix. It is not, and
the distinction is the reason this card exists.

A base block would make a **resolved-token** assertion pass — `--radius-card`
would come back correct on every tile — on a tile that still paints as glass,
because the material layer is not a token layer. The assertion would be green
over a wrong page, which is the exact failure the isolation work exists to close.
`StyleVignette`'s header already carries the instruction not to add one; this ADR
is the reasoning behind it.

The two axes need different remedies because they break in different layers:

| axis                   | how a nested scope breaks it                                                                                                                          | remedy                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **palette** / **type** | `--el-*` are declared `--el-x: var(--color-y)`, and `var()` substitutes where the property is _declared_; a nested override of Tier-0 reaches nothing | `data-appearance-scope` re-emits the Tier-3 layer locally — **shipped, MOTIR-3933** |
| **style**              | the material rules are _selectors_, and a descendant combinator crosses the boundary regardless of what any token resolves to                         | this ADR                                                                            |

**The instrument matters as much as the remedy.** `tests/theme/paletteCascade.ts`
— the model `scopedPreviewIsolation.test.ts` resolves against — states in its own
header that it "deliberately does NOT understand descendant/child combinators …
any rule carrying one is component-scoped and is skipped". So the suite that
proves the palette axis isolated is **structurally incapable of seeing this
defect**. That is not a gap in the suite; it is why the guard for this axis has to
be a rendered one (Q7, card B).

---

## Q3 — the three candidates, tested rather than argued

Each candidate has to satisfy four cases at once. Run in Chromium 1228; the
probe is a `[data-surface='card']` whose base rule is out-specified by the
candidate, read back through `getComputedStyle`.

| case                                                   | must paint? |
| ------------------------------------------------------ | ----------- |
| app: `glass` active on `<html>`, ordinary page content | yes         |
| gallery: another style active, tile scoped to `glass`  | yes         |
| gallery: `glass` active, tile scoped to `brutal`       | **no**      |
| gallery: `glass` active, tile scoped to `glass`        | yes         |

```
FAIL  baseline (shipped, descendant)
        ✗ glass active, tile scoped to brutal    painted=true  expected=false
FAIL  A · [data-style='glass'] :not([data-style]) [data-surface='card']
        ✗ other active, tile scoped to glass     painted=false expected=true
        ✗ glass active, tile scoped to brutal    painted=true  expected=false
FAIL  B · … [data-surface='card']:not(:where([data-style] [data-style] [data-surface='card']))
        ✗ other active, tile scoped to glass     painted=false expected=true
        ✗ glass active, tile scoped to glass     painted=false expected=true
PASS  C · @scope ([data-style='glass']) to ([data-style]) { [data-surface='card'] { … } }
        ✓ ✓ ✓ ✓
```

### Candidate 1 — a per-rule `:not()` barrier. **Rejected, and not on cost.**

The card offered `[data-style='X'] :not([data-style]) [data-surface='…']` as the
cheap-per-rule option. It does not work, in both directions:

- **It still leaks.** The `:not([data-style])` step is satisfied by _any_
  intervening element without the attribute — `<body>`, the gallery's grid
  wrapper, the tile's own inner `<div>`. `html[X] › body › div[data-style=Y] ›
[data-surface]` matches, because `body` discharges the barrier before the
  nested scope is ever reached.
- **It breaks the legitimate case.** A tile scoped to `glass` under a _different_
  active style stops painting, because its own `[data-style='glass']` wrapper is
  the anchor and the very next element is the surface — with no unmarked ancestor
  in between to satisfy the `:not()`.

Cost was never the deciding factor, and it is worth saying plainly: 69 cheap
edits that each encode a wrong rule is worse than one expensive edit, not better.

### Candidate 2 — an isolated render tree (iframe or shadow root). **Rejected.**

It is the only candidate that isolates from _everything_, and that is also what
disqualifies it here:

- **It is a document per tile.** `/tokens` and `motir.co/design` each render
  eleven at once, and each needs its own copy of the compiled token layer.
- **It changes how the component is consumed**, at every call site — sizing
  becomes a measurement problem, and `role="img"` + `aria-label` (the vignette's
  whole accessibility contract, it being decorative chrome announced as one
  labelled image) does not survive a frame boundary intact.
- **A shadow root does not solve it more cheaply.** The design system ships one
  global stylesheet plus Tailwind utility classes; neither crosses a shadow
  boundary, so every root needs the layer adopted into it and the utilities
  re-emitted.
- **And it isolates too much.** A preview should inherit the _page's_ theme for
  everything it is not previewing. An iframe severs that, so a tile in a dark
  Motir would need the theme piped in by hand.

### Candidate 3 — a scope-anchored emission. **Accepted.**

```css
@scope ([data-style='glassmorphism']) to ([data-style]) {
  [data-surface='card'] { … }
}
```

`to (…)` is a scoping **limit**: elements matching it, and their descendants,
leave the scope. So "the nearest `[data-style]` ancestor wins" becomes structural
rather than a per-rule opt-out — which is the property none of the selector-level
barriers can express, because CSS has no _nearest-ancestor_ combinator.

**It is also the shipped precedent in the same file.** The four
`.style-vignette[data-style='X'] > .sv-canvas` rules already anchor to the marked
wrapper, and their comment says why: _"scoped to a DIRECT child of the marked
wrapper so an ancestor `<html data-style>` can't bleed the wrong canvas into a
differently-scoped vignette."_ That is this decision, made once, for the one
element somebody noticed. This generalises it.

---

## Q4 — what the decision costs, measured

A prototype rewrote all 69 rules mechanically and was measured against
`origin/main`'s file. Nothing below is projected.

**1 · It fixes the defect completely.** The full matrix goes **64 / 121 →
121 / 121**: every style, as tile and as ancestor.

**2 · It changes nothing in the app.** The shipped shape — page content directly
under `<html data-style="X">`, no nested scope — was compared property by
property between the two stylesheets across 11 styles × 2 themes × 16 elements
(the seven `data-surface` values, `.border`, the two radius/shadow utility hooks,
`[data-tilt]`, `[data-board-col-panel]`, `[data-menu-surface]`,
`[data-variant='primary']`, `[role='group']` and its pressed child), twelve
computed properties plus three `::after` reads each:

```
APP NON-REGRESSION: 5610 computed declarations compared — 0 difference(s)
```

**3 · Specificity is unchanged, which is the non-obvious half.** A relative
selector inside `@scope` is implicitly `:scope <sel>`, and `:scope` carries
pseudo-class specificity — so `:scope [data-surface='card']` is `(0,2,0)`,
exactly what `[data-style='X'] [data-surface='card']` was. Verified against a
competing `(0,1,0)` utility declared both before and after the material rule; the
material rule wins in all four combinations, before and after.

**4 · Scope proximity is a new cascade criterion and is inert here.** Between two
in-scope rules of equal specificity, proximity to the scope root outranks source
order. Every material rule is anchored to a different style, at most one anchor is
the nearest for any element, and rules sharing an anchor share a proximity — which
is why the 5610-declaration comparison finds nothing. Named because a future rule
anchored at two depths of the same style would be the first case where it bites.

**5 · The build pipeline preserves it.** Compiled through the repo's own
`@tailwindcss/postcss@4.3.0`: `@scope` and its limit survive to the output
verbatim, all 69 blocks. The package also ships `theme.css` raw
(`exports['./theme.css']`), so a downstream consumer's toolchain must not
downlevel it either — motir-marketing is on the same Tailwind major.

**6 · It raises the browser floor, and the degradation is small and measured.**
An engine that cannot parse `@scope` drops the whole block. Modelled by deleting
the 69 blocks and re-running the app comparison:

```
186 of 5610 computed declarations change (3.3%)
  46 background-color · 44 box-shadow · 38 background-image · 14 border-color
  14 border · 12 backdrop-filter · 10 ::after content · 4 transform · 4 ::after background-image
```

Every one is a **material** property. Nothing in layout, radius, spacing, sizing
or text colour moves — the token blocks are untouched by the rewrite. So the
degradation is "flatter", not "broken", and it is confined to the six styles that
own a material layer.

**Whose engines.** `@scope` with a limit: Chrome/Edge 118, Safari 17.4, Firefox
128 — Baseline newly-available since July 2024. The layer already requires
`color-mix()` (Chrome 111 / Safari 16.2 / Firefox 113), which **36 of the 69
bodies use**, so today's behaviour in a pre-`@scope` engine is already a partial
material layer with those 36 rules invalid at computed-value time. The floor moves
from mid-2023 to mid-2024, with Firefox binding. ⚠️ **Those three version numbers
are read off the published support tables, not measured here** — the only engine
measured in this ADR is the bundled Chromium. If the floor turns out to be
unacceptable, the fallback is candidate 2 for the gallery surfaces only, not
candidate 1, which does not work at any price.

**7 · It moves a test's ground truth.** `tests/theme/styleRegistry.test.ts` finds
the material layer with a text regex — `/\[data-style='[^']+'\]\s+[^{};]+\{/` —
which no longer matches once the anchor moves into an `@scope` prelude. It fails
loudly rather than silently (`materialRulesChecked` drops to 0 against a
`toBeGreaterThanOrEqual(4)` floor), so the rewrite cannot land without updating
it. That is a virtue and it is still work: it is part of card A, not a follow-up.

---

## Q5 — what a nested preview IS and IS NOT isolated from

Stated once, so the next reader does not re-derive it. After this decision ships:

| the tile controls                                  | isolated? | by what                                                                                     |
| -------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| **colour** (`data-palette`)                        | **yes**   | `data-appearance-scope` re-emits the Tier-3 `--el-*` layer locally (MOTIR-3933)             |
| **type** (`data-type`)                             | **yes**   | same mechanism, plus a base `[data-type='motir']` block; the axis ships no descendant rules |
| **shape / feel tokens** (`data-style` token block) | **yes**   | they are plain custom properties on the wrapper and inherit down                            |
| **material** (`data-style` descendant rules)       | **yes**   | this decision — `@scope … to ([data-style])`                                                |

And what a nested preview is deliberately **not** isolated from, in every case:

- **`data-theme`.** A tile inherits light/dark from its ancestor unless it sets
  its own. That is wanted: a gallery in a dark Motir should be dark.
- **Tailwind utility classes and the base/preflight layer.** They are global and
  unscoped, by design.
- **Everything outside the three axes** — font loading, motion preferences,
  container widths, the page's own layout.
- **A style's `body`-anchored rules.** `[data-style='X'] body` has no counterpart
  inside a tile; the vignette's `.sv-canvas` is the substitute, and it is
  anchored to the wrapper already.
- **An ancestor's material, if a future rule is authored as an unscoped
  descendant.** The mechanism is structural but not automatic. Card B is what
  makes a regression visible.

---

## Q6 — the consumers, and what each has to change

**Nothing.** That is the strongest practical argument for candidate 3 over
candidate 2, and it is worth stating per call site rather than in the abstract.
`StyleVignette` already emits `data-style` on the scoped wrapper, and that
attribute _is_ the scope limit — the component is the boundary the mechanism
needs, with no new prop, no new element and no changed markup.

| consumer                                                                                                                                                           | shape               | changes                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------ |
| **`packages/design-system/src/specimen/TokensSpecimen.tsx:103`** — the packaged specimen's style gallery, 11 scoped tiles. This is what `motir.co/design` renders. | SCOPED × 11         | none in source; **needs the package republished** (Q7 card C)                  |
| **`app/tokens/page.tsx:349`** — motir-core's `/tokens` composer, the same gallery in-app                                                                           | SCOPED × 11         | none                                                                           |
| **`components/onboarding/DesignStep.tsx`** — the design step's root `<section>` carries `data-style` + `data-appearance-scope`, with ONE LIVE vignette inside      | SCOPED × 1          | none                                                                           |
| `TokensSpecimen.tsx:112`, the palette gallery                                                                                                                      | SCOPED (palette)    | none — different axis, fixed by MOTIR-3933                                     |
| `AppearanceCard.tsx:161`, `DesignStep.tsx:196`, `app/tokens/page.tsx:332`                                                                                          | LIVE (no axis prop) | none — a LIVE vignette sets no axis attribute and is not a nested scope at all |

> ⚠️ **A correction to this card's second acceptance criterion, on the record.**
> It names _"the onboarding Style gallery"_ as one of the two known consumers.
> At `origin/main` there is no such gallery: `DesignStep` renders a chip-row
> `StylePicker` and **one** LIVE vignette, inside a section that is itself one
> nested scope. The consumer is real and it is affected — a Motir user whose own
> appearance is set to a material style sees the wizard's preview wearing Motir's
> material rather than the project's — but it is a single-tile nested scope, not
> a gallery. The two galleries are `TokensSpecimen` and `/tokens`. All three are
> covered above, so the criterion is satisfied by a superset of what it asked
> for; the label was wrong, not the requirement.

---

## Q7 — the cards this decides

Authored as proposals in the same pass, on plan `cmtfw5tjr0078hwphimogujvl`
(`planned`, three items, awaiting review in Motir). Each is placed BESIDE
MOTIR-3947 under epic MOTIR-3875 and wired `blocked_by` it — a prerequisite is a
sibling, never a child of the card it gates. All three ship in `motir-core`, and
each was validated by projection over the plan before it closed. No behaviour
ships from this card.

**A · Move the style axis's 69 material rules under `@scope … to ([data-style])`.**
`packages/design-system/theme.css` plus `tests/theme/styleRegistry.test.ts`'s
material-layer parser, which cannot survive the move (Q4·7) and must land in the
same commit; plus the `StyleVignette` header paragraph and `AppearancePickers`'
comment, both of which currently state the leak as open. Mechanical and scripted,
but the test parser is judgement: its palette-derived / no-raw-hue guard must go
on asserting over the same population, with its count floor ratcheted to 69 so a
rule that escapes the scope in future fails rather than goes uncounted.

**B · A rendered isolation guard for the style axis.** The vitest theme lane
cannot host it — `paletteCascade.ts` skips every combinator by construction
(Q2) — so it belongs in the browser lane beside `appearance-sync.spec.ts`,
asserting over `/tokens`' gallery that each scoped tile computes its own
material. It is a separate card from A because it is a different lane, a
different file and a different discipline, and because A + B together sit over
the estimation gate's minutes proxy. **Its own first criterion is that it FAILS
on the pre-A commit** — a guard written after its fix, never run against the
defect, is a guard that asserts a tautology.

**C · Publish the package and re-pin motir-marketing** (`blocked_by` A and B).
MOTIR-3965 says outright
that _"3947 will owe its own publish, which is the accepted cost"_ — a correct
judgement recorded in a place nothing walks back from. It is filed here rather
than left as that sentence, because that is the exact failure MOTIR-3965 itself
was filed to correct.

---

## Reproduction

Every figure above is reproducible from `origin/main` with a headless Chromium
and no repo install. The harness (rewriter, matrix, non-regression and
candidate probes) is not committed — it is a measurement, not a deliverable — and
the commands that produced each number are quoted in the pull-request body of the
card that carries this file.
