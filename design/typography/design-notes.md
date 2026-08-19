# Typography — design notes

Design reference for the `typography` area. It holds **one asset, and it is a
SPECIMEN rather than a surface**: `mono-technical.mock.html` does not draw a page
the app serves — it draws the **Mono-Technical type pairing** (`data-type="mono-technical"`,
Subtask 7.3.56 / MOTIR-1073) side by side with the base `motir` pairing, so a
reader can see what choosing it actually does.

| Asset                                       | What it is                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`mono-technical.mock.html`** + its `.png` | Three panels: base `motir` vs `mono-technical` in light, then `mono-technical` in dark. A comparison board for ONE axis-3 pairing. **Gates 7.3.56.** |

---

## What this specimen is FOR

**Axis 3 of the three-axis design system.** Motir's UI is swappable on three
independent axes — colour (`data-palette`), shape (`data-style`), and type
(`data-type`) — and this asset belongs to the third. Its job is to answer a
question no token table can: _is this pairing actually distinct from the base,
and is it legible?_

That is why it is drawn as a **comparison**, not as a page. The left panel and
the right panel carry identical content — the same eyebrow, headline, body,
`<code>` span, two stat pairs, and the same control row — and differ only in
`data-type`. Anything you can see between them is the pairing; anything you
cannot see is not.

**Who takes the role.** `mono-technical` is a **user preference**, not a surface
decision. It is registered in `packages/design-system/src/theme/typography.ts`
and selected by a person from the Appearance pane
(`/settings/account/appearance`) or from the `/tokens` specimen route; picking it
re-types the **whole app** — chrome included. So the answer to "which surfaces
take this role" is **all of them**, which is exactly what makes the specimen
worth a spec: a surface built against the base pairing's proportions has to
survive this one too.

Its prose companion is `docs/typography/mono-technical.md` (the payload, the
licence, the rationale); `docs/DESIGN.md` carries the three-axis contract. This
file specifies the **asset**.

---

## The asset is GENERATED from the shipped layer, not hand-copied (MOTIR-3137)

**Every token in the mock's `<style>` block is extracted from
`packages/design-system/theme.css`, and nothing in it is retyped.** That is the
whole correction MOTIR-3137 made, and the reason it is worth stating here is
that the previous version's defect was not a typo — it was a hand-written copy
of a generated thing, which drifted the day after it was written (below).

Four blocks are lifted verbatim, comments stripped, in this order:

| Block in `packages/design-system/theme.css` | Emitted into the mock as    | Why                                                   |
| ------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| `@theme { … }`                              | `:root { … }`               | Tier 0 — the palette, the shape scale, the font roles |
| `[data-theme='dark'] { … }` (the first)     | `[data-theme='dark'] { … }` | Tier 0's dark flips                                   |
| `:root, [data-appearance-scope] { … }`      | the same selector list      | Tier 3 — the `--el-*` element tokens                  |
| `[data-type='mono-technical'] { … }`        | the AXIS 3 block            | the pairing itself — the thing the specimen pictures  |

Reproduced inline rather than committed as a script, because a design PR ships
`design/**` only and a notes file that cites a deleted generator fails
`tests/design-asset-addresses.test.ts`:

```js
// Brace-count each block out of theme.css and strip its comments.
const css = readFileSync('packages/design-system/theme.css', 'utf8');
const at = (re) => [...css.matchAll(re)].map((m) => m.index);
// LINE-ANCHOR every selector: an unanchored search for [data-theme='dark'] hits
// the @custom-variant line near the top and brace-counts the WRONG block.
const DARK = at(/^\[data-theme='dark'\]\s*\{/gm); // [0] = Tier 0, [1] = Tier 3
const THEME = at(/^@theme\s*\{/gm)[0];
const TIER3 = at(/^:root,\s*\n\[data-appearance-scope\]\s*\{/gm)[0];
const MONO = at(/^\[data-type='mono-technical'\]\s*\{/gm)[0];
// blockAt(i) walks braces from the first `{` after i; strip() drops /* … */ and
// blank lines — theme.css's prose cites source paths this asset does not author.
```

Three properties this buys, each of which the hand-written version lacked:

1. **The axis-3 block cannot drift again.** It is the same bytes the app serves,
   so a fourth role added tomorrow lands here on the next re-export.
2. **No colour is invented.** Every `--el-*` the mock consumes is the shipped
   definition, resolving through the shipped `--color-*` palette.
3. **The dark row picks the flips up.** The dark panel's wrapper carries
   `data-appearance-scope` beside `data-theme="dark"`, which is what makes the
   Tier-3 layer re-emit on that subtree — `var()` resolves at the DECLARING
   element, so `data-theme` alone would leave the panel light.

**Colour is PINNED, not invented.** `<html>` carries `data-palette="motir"` — the
base palette, which needs no override block because it IS the Tier-0 defaults.
That is what holds the colour axis still while the type axis varies, and it is
the correct expression of the intent the old invented ramp was reaching for: the
axes are already independent, so nothing had to be made up to keep one of them
fixed.

> **One honest limit, stated rather than glossed.** The Tier-0 block the mock
> embeds is a table of hex values, because a palette IS hex values and a
> `.mock.html` is a standalone file no build resolves. So the file still
> CONTAINS hex — the same hex `theme.css` ships, machine-extracted, in the
> token table alone. What it no longer contains is an INVENTED colour: nothing
> the mock renders reads a raw value, every element colour resolves through an
> `--el-*` token, and there is no hex anywhere below the token layer. That is
> the never-invent-a-colour rule as it can be met by a self-contained asset, and
> it is how the other ten mocks carrying this axis-3 block are built.

---

## ⚠️ It WAS one role behind the pairing it specifies — corrected 2026-08-19

**Kept because the mechanism is the useful part.** From 2026-06-18 to
2026-08-19 the mock's own `[data-type='mono-technical']` block re-pointed **two**
role tokens while the shipped block re-pointed **three**:

```css
/* the mock, as drawn 2026-06-18 — WRONG since 2026-06-19 */
[data-type='mono-technical'] {
  --font-serif: var(--font-mono-technical-source), ui-monospace, monospace;
  --font-mono: var(--font-mono-technical-source), ui-monospace, monospace;
}
```

The mock's comment above that block read _"exactly the block shipped in
app/globals.css"_, and on the day it was written it was. **One day later** the
whole-UI re-typing decision landed (Yue, 2026-06-19: a type pairing re-types the
whole app, chrome included, not just headlines), `--font-sans` joined the block,
and the asset was not re-rendered.

**What it cost the reader.** The specimen's right-hand panel kept its **body,
buttons and chip in Inter** while the shipped pairing set them in IBM Plex Mono
— so the asset understated the change on the axis it exists to demonstrate, in
the body copy, which is the bulk of any real screen.

**It was the only asset in the tree that was behind.** Eleven mocks carry a
`[data-type='mono-technical']` block; ten of them machine-copied the current
three-role version (`ai-chat` ×2, `boards`, `brand`, `cli-guide`, `home`,
`settings`, `shell` ×2, `work-items`). This one was hand-written, which is why
it did not follow — and why the correction above replaced the hand-copy with an
extraction rather than editing two lines.

**And `docs/typography/mono-technical.md` disagreed with itself about the same
thing** — its role table listed `--font-sans` → IBM Plex Mono while a paragraph
below it said the block _"re-points ONLY `--font-serif` and `--font-mono`"_. The
table was right; the paragraph is gone, and the doc now states the three-role
mapping once.

---

## ⚠️ The dark panel's headline was invisible — corrected in the same pass

Found while re-exporting, and worth recording because it hid in plain sight for
two months on the one panel whose job is to prove legibility.

The panel's own copy reads _"IBM Plex Mono stays legible on the dark surface —
sufficient weight, no thin hairline headlines"_ — and in every export since
2026-06-18 the headline above that sentence was **near-black ink on a near-black
surface**, i.e. not visible at all. The cause is a CSS rule, not a token: `color`
inherits its **computed** value, so `body { color: var(--el-text) }` resolves ONCE
against the light `:root` and every descendant inherits that literal — the dark
subtree's re-declared `--el-text` never reaches an element that only inherits.
Elements with their own `color` (the body copy, the stat values, the chip) were
unaffected, which is why the panel looked fine apart from the missing headline.

The fix is one declaration: `.panel { color: var(--el-text) }`, so the ink is
resolved AT the panel, inside whichever theme scope it sits in. **The general
form is worth carrying:** in a mock with a nested theme scope, declare `color` on
the scoped container, never only on `body`.

---

## Panels

### Panel 1 — `data-type="motir"` · base · light

The control. Left column of the light row.

| Element     | Copy                                                                                                       | Type role                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Panel tag   | `data-type = "motir" · base`                                                                               | `--font-mono`, 11px/0.14em, uppercase, `--el-accent-on-surface`                                |
| Eyebrow     | "Sprint 30 · Planning"                                                                                     | `--font-mono`, 12px/0.16em, uppercase, `--el-text-eyebrow`                                     |
| Headline    | "Ship the design axes"                                                                                     | **`--font-serif`**, 44px/1.08, −0.01em, weight 700                                             |
| Body        | "The base Motir pairing sets headlines in an editorial serif over an Inter body — warm and document-like." | `--font-sans`, 15px/1.6, `46ch` measure, `--el-text-secondary`                                 |
| Sub-heading | "Acceptance"                                                                                               | `--font-serif`, 21px/1.2, weight 600                                                           |
| Body + code | "Selectable from `/tokens` and Appearance settings; renders under every palette."                          | `--font-sans`; the `<code>` span `--font-mono`, 13px, on `--el-muted`                          |
| Stat pair   | "Story pts" / "2" · "Item" / "MOTIR-1073"                                                                  | keys `--font-mono` 11px/0.12em uppercase; values `--font-mono` 26px weight 600, `tabular-nums` |
| Button      | "Dispatch"                                                                                                 | `--font-sans`, 14px weight 600, `--el-accent` fill / `--el-accent-text` ink                    |
| Chip        | `subtask/MOTIR-1073`                                                                                       | `--font-mono`, 12px weight 500, `--el-chip-bg` / `--el-chip-border`                            |

**The stat values are `tabular-nums`.** It is the one non-face property the
specimen fixes, and it is load-bearing: a mono pairing whose numerals are
proportional defeats the point of the pairing.

**The button and chip are the comparison's chrome row**, and both panels carry
it. They are the two places a **UI** face shows rather than a content face, so
the pair demonstrates that the pairing reaches chrome — which is exactly the
role the mock used to under-report. Before MOTIR-3137 only panel 2 had this row,
which left the button's face change with nothing to be compared against.

### Panel 2 — `data-type="mono-technical"` · light

Identical content to panel 1, element for element. The only difference is the
attribute:

| Element   | Copy                                                                                                                                    | Type role                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Panel tag | `data-type = "mono-technical" · 7.3.56`                                                                                                 | as panel 1                                                                                     |
| Body      | "Mono-Technical sets headlines, body _and_ meta in IBM Plex Mono — the whole surface re-types, chrome included, not just the headline." | `--font-sans` — which this pairing re-points, so the sentence renders in the face it describes |
| Button    | "Dispatch"                                                                                                                              | `--font-sans` — re-typed, and this is the chrome half of the pairing                           |
| Chip      | `subtask/MOTIR-1073`                                                                                                                    | `--font-mono`, already mono in both pairings                                                   |

The body sentence is the one piece of copy that is deliberately NOT identical
across the panels, because each panel's body describes its own pairing. Its
previous wording — _"over the same neutral Inter body"_ — was the prose half of
the two-role drift and is corrected above.

### Panel 3 — `data-type="mono-technical"` · dark

The legibility check, and the panel that justifies the choice of face: _"IBM Plex
Mono stays legible on the dark surface — sufficient weight, no thin hairline
headlines."_ Three stat pairs — "Velocity"/"42", "Ready"/"07", "Done"/"128" —
exercise the tabular numerals at width, and two inline `<code>` spans exercise
the meta role.

Its wrapper carries `data-theme="dark"` **and** `data-appearance-scope`; the
second is what re-emits the `--el-*` layer on the subtree so the panel actually
renders dark. Its two inline `<code>` spans read `MOTIR-1073` and
`resolveType()`. Until MOTIR-3137 the first carried the pre-rebrand key prefix
that the 2026-06-11 rebrand sweep missed inside this file, while the panel's own
stat value two sections up already carried the current one. The area is now free
of it, and `grep` over `design/typography/` is the check.

---

## Board chrome

Two `.heading-bar` captions label the rows — "data-type comparison · light theme"
and "Mono-Technical · dark theme" — over `--el-canvas`, the recessed-board
surface, with `--el-text-secondary` ink (6.18–6.80:1 on every surface in both
themes). The dark row's caption sits inside that row's theme scope, so it flips
with the panel it labels. Nothing on this board is a raw value, including the
backdrop the colour rule would have permitted as non-semantic decoration.

## Faces loaded

The mock pulls four families from Google Fonts — IBM Plex Mono, Inter, JetBrains
Mono, Source Serif 4 — over a `<link>`, because a specimen is worthless rendering
in a fallback face. The app loads its faces through `next/font` in
`app/layout.tsx` instead; the `--font-*-source` variable names are the same on
both sides, which is what lets the same `[data-type]` block work in either. The
four `--font-*-source` declarations are the only `--font-*` values the mock
authors — the roles themselves come from the extracted Tier-0 block.

## Re-exporting

`node scripts/render-design-mock.mjs design/typography/mono-technical.mock.html`,
**after** `prettier --write` on the mock — prettier reformats the markup, so a
PNG rendered from the pre-format source is not an export of what lands. The
committed export is 2400×2630 at `deviceScaleFactor: 2` (a 1200×900 viewport).

## Rules honoured

- ✅ **Only `--font-*` role tokens move.** The `[data-type]` block touches no
  colour and no shape token — the disjointness guard the type axis is held to
  (`tests/theme/typographyRegistry.test.ts`). Picking a pairing never changes a
  hue or a radius.
- ✅ **The comparison is content-identical**, control row included, so the only
  variable is the axis.
- ✅ **Tabular numerals** on every stat value.
- ✅ **Colour flows through `--el-*`**, over a pinned base palette; the mock
  authors no colour of its own, and `tests/design-ink-contrast.test.ts` rules on
  the board's own `<style>` block as much as on its elements
  (`docs/decisions/design-board-chrome-aa.md`).
- ✅ **The axis-3 block is the shipped one**, extracted rather than copied, so
  the drift this file used to record cannot recur.
