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
`<code>` span, two stat pairs — and differ only in `data-type`. Anything you can
see between them is the pairing; anything you cannot see is not.

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

## ⚠️ The specimen is ONE ROLE BEHIND the pairing it specifies

**`mono-technical.mock.html`'s own `[data-type='mono-technical']` block re-points
two role tokens. The shipped block re-points three.**

```css
/* the mock, line ~40 — as drawn 2026-06-18 */
[data-type='mono-technical'] {
  --font-serif: var(--font-mono-technical-source), ui-monospace, monospace;
  --font-mono: var(--font-mono-technical-source), ui-monospace, monospace;
}

/* packages/design-system/theme.css — as shipped */
[data-type='mono-technical'] {
  --font-serif: var(--font-mono-technical-source, ui-monospace), 'SF Mono', Menlo, monospace;
  --font-mono: var(--font-mono-technical-source, ui-monospace), 'SF Mono', Menlo, monospace;
  --font-sans: var(--font-mono-technical-source, ui-monospace), 'SF Mono', Menlo, monospace;
}
```

The mock's comment above that block reads _"exactly the block shipped in
app/globals.css"_, and on **2026-06-18** it was. **One day later** the whole-UI
re-typing decision landed (Yue, 2026-06-19: a type pairing re-types the whole
app, chrome included, not just headlines) and `--font-sans` joined the block. The
asset was not re-rendered.

**What it costs the reader.** The specimen's right-hand panel keeps its **body,
buttons and chip in Inter** while the shipped pairing sets them in IBM Plex Mono.
So the asset understates the change on the axis it exists to demonstrate — and it
understates it in the body copy, which is the bulk of any real screen. Read the
shipped block, not the panel.

**It is the only asset in the tree that is behind.** Eleven mocks carry a
`[data-type='mono-technical']` block; ten of them machine-copied the current
three-role version (`ai-chat` ×2, `boards`, `brand`, `cli-guide`, `home`,
`settings`, `shell` ×2, `work-items`). This one is hand-written, which is why it
did not follow.

**And `docs/typography/mono-technical.md` disagrees with itself about the same
thing** — its role table lists `--font-sans` → IBM Plex Mono, and a paragraph
below it says the block _"re-points ONLY `--font-serif` and `--font-mono`"_. The
table is right.

Both are recorded here rather than corrected in this card's diff: the asset is a
record of the moment it was drawn (Yue, 2026-08-10), and the correction is
somebody's card, not a silent edit inside a notes-writing pass (`notes.html` #27).

---

## ⚠️ The specimen's palette is INVENTED, deliberately, and must not be copied

The mock declares its own colours as raw hex — `--bg: #ffffff`,
`--text: #1c1b1a`, `--accent: #6d4aff`, `--code-bg: #f2f0ee`, and a
`--text-*` ramp — under the comment _"Representative warm-neutral light palette
(focus is type)."_

That is a **violation of the never-invent-a-colour rule** (`CLAUDE.md` §
"Colour flows through `--el-*` element tokens"), which binds a design mock
exactly as it binds component code. It survives
`tests/design-ink-contrast.test.ts` only because that guard measures `--el-*`
ink against `--el-*` surfaces, and these names are neither.

It is called out here rather than treated as a pattern, because the reasoning is
visible and narrow: the asset isolates ONE axis, and routing its colours through
the live palette would have let a `data-palette` change move the thing being
compared. **The correct expression of that intent is `[data-palette]` pinned to
the base and the colours still taken from `--el-*`** — the axes are already
independent, so nothing had to be invented to hold colour still.

**Nothing composes from this palette.** No `--el-*` token, no component, and no
other asset reads these values; they exist inside this one file. Do not lift them
into anything, and do not treat the file as precedent for a mock with its own
hues.

---

## Panels

### Panel 1 — `data-type="motir"` · base · light

The control. Left column of the light row.

| Element     | Copy                                                                                                       | Type role                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Panel tag   | `data-type = "motir" · base`                                                                               | `--font-mono`, 11px/0.14em, uppercase, accent ink                                              |
| Eyebrow     | "Sprint 30 · Planning"                                                                                     | `--font-mono`, 12px/0.16em, uppercase, muted                                                   |
| Headline    | "Ship the design axes"                                                                                     | **`--font-serif`**, 44px/1.08, −0.01em, weight 700                                             |
| Body        | "The base Motir pairing sets headlines in an editorial serif over an Inter body — warm and document-like." | `--font-sans`, 15px/1.6, `46ch` measure                                                        |
| Sub-heading | "Acceptance"                                                                                               | `--font-serif`, 21px/1.2, weight 600                                                           |
| Body + code | "Selectable from `/tokens` and Appearance settings; renders under every palette."                          | `--font-sans`; the `<code>` span `--font-mono`, 13px                                           |
| Stat pair   | "Story pts" / "2" · "Item" / "MOTIR-1073"                                                                  | keys `--font-mono` 11px/0.12em uppercase; values `--font-mono` 26px weight 600, `tabular-nums` |

**The stat values are `tabular-nums`.** It is the one non-face property the
specimen fixes, and it is load-bearing: a mono pairing whose numerals are
proportional defeats the point of the pairing.

### Panel 2 — `data-type="mono-technical"` · light

Identical content, plus a control row the base panel does not carry:

| Element   | Copy                                                                                                                        | Type role                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel tag | `data-type = "mono-technical" · 7.3.56`                                                                                     | as panel 1                                                                                                                                     |
| Body      | "Mono-Technical dresses headlines _and_ meta in IBM Plex Mono over the same neutral Inter body — precise, developer-grade." | `--font-sans` — **and this sentence is the drift**: "the same neutral Inter body" describes the two-role block, not the shipped three-role one |
| Button    | "Dispatch"                                                                                                                  | `--font-sans`, 14px weight 600                                                                                                                 |
| Chip      | `subtask/MOTIR-1073`                                                                                                        | `--font-mono`, 12px weight 500                                                                                                                 |

The button and chip are here for a reason worth keeping: they are the two places
a **UI** face shows rather than a content face, so the panel can demonstrate that
the pairing reaches chrome. Under the shipped block the button re-types too;
under the mock's block it does not.

### Panel 3 — `data-type="mono-technical"` · dark

The legibility check, and the panel that justifies the choice of face: _"IBM Plex
Mono stays legible on the dark surface — sufficient weight, no thin hairline
headlines."_ Three stat pairs — "Velocity"/"42", "Ready"/"07", "Done"/"128" —
exercise the tabular numerals at width, and two inline `<code>` spans exercise
the meta role.

**Its second `<code>` span reads `PROD-1073`** — a pre-rebrand key prefix the
2026-06-11 sweep missed inside this file, while the panel's own stat value two
sections up says `MOTIR-1073`. The correct prefix is `MOTIR-`.

---

## Board chrome

Two `.heading-bar` captions label the rows — "data-type comparison · light theme"
and "Mono-Technical · dark theme" — on a `#d9d6d2` backdrop that is also the
`body` background. That backdrop is the one raw value the colour rule permits
(non-semantic board decoration that carries no meaning); the caption ink is not,
and is part of the invented palette noted above.

## Faces loaded

The mock pulls four families from Google Fonts — IBM Plex Mono, Inter, JetBrains
Mono, Source Serif 4 — over a `<link>`, because a specimen is worthless rendering
in a fallback face. The app loads its faces through `next/font` in
`app/layout.tsx` instead; the `--font-*-source` variable names are the same on
both sides, which is what lets the same `[data-type]` block work in either.

## Rules honoured, and the one that is not

- ✅ **Only `--font-*` role tokens move.** The `[data-type]` block touches no
  colour and no shape token — the disjointness guard the type axis is held to
  (`tests/theme/typographyRegistry.test.ts`). Picking a pairing never changes a
  hue or a radius.
- ✅ **The comparison is content-identical**, so the only variable is the axis.
- ✅ **Tabular numerals** on every stat value.
- ❌ **The colours are invented** rather than `--el-*` (see above).
- ❌ **The `[data-type]` block is one role behind the shipped one** (see above).
