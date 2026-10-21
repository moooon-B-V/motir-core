# CLAUDE.md

This file provides guidance to Claude Code and any other coding agent working
in this repository.

**The repository's rules live in its coding convention on the Codebase page
(`/code`), readable with `get_coding_convention { projectKey: "MOTIR", repo: "motir-core" }`
— layering, email, navigation and streaming, page state after a mutation, tests,
migrations, debugging and commits.** Motir's product rules (approval gates, the
acceptance-receipt lifecycle, drafts and republishing) are stated in the run
prompt. This file keeps only the design-token and design-asset reference below,
which the token lints and design guards point back to.

---

## ⚠️ Colour flows through `--el-*` element tokens, NEVER `--color-*` directly

**EXTREMELY IMPORTANT: A component references the Tier-3 `--el-*` element
tokens for every colour it renders. It MUST NOT reach for a Tier-0
`--color-*` token — neither the arbitrary form `text-(--color-slate)` nor
the Tailwind utilities auto-generated from `--color-*` (`text-foreground`,
`bg-surface`, `text-muted-foreground`, `border-border`, `bg-primary`, …),
all of which resolve straight to Tier 0 and bypass the swap layer.**

`app/globals.css` is layered (see its header comment):

- **Tier 0 — `--color-*`** raw palette values (`--color-foreground`,
  `--color-slate`, `--color-accent`, `--color-tint-*`, …). Light defaults
  in `@theme`; `[data-theme="dark"]` flips them.
- **Tier 3 — `--el-*`** the _semantic element tokens_ components consume.
  This is the single layer a future `data-palette="…"` overrides to
  re-skin the whole app without touching one component.

So in JSX, use arbitrary-value utilities pointing at `--el-*`:

```tsx
// ✅ right — routed through the swap layer
<p className="text-(--el-text-muted)">caption</p>
<div className="bg-(--el-surface) border-(--el-border)">…</div>
<Icon className="text-(--el-type-task)" />            // issue-type hue

// ❌ wrong — Tier-0 utilities / arbitrary --color-* bypass --el-*
<p className="text-muted-foreground">caption</p>
<div className="bg-surface border-border">…</div>
<span className="text-(--color-slate)">…</span>
```

### The token map (what to reach for)

| Need                                    | `--el-*` token                                                |
| --------------------------------------- | ------------------------------------------------------------- |
| primary text / ink                      | `--el-text`                                                   |
| emphasis, AA text on a tint             | `--el-text-strong`                                            |
| secondary copy                          | `--el-text-secondary`                                         |
| muted / caption                         | `--el-text-muted`                                             |
| tertiary / footer · faint label         | `--el-text-tertiary` · `--el-text-faint` (⚠️ see below)       |
| text on an ink/accent fill              | `--el-text-inverted`                                          |
| CTA accent FILL · its text · pressed    | `--el-accent` · `--el-accent-text` · `--el-accent-pressed`    |
| accent AS text / icon on a page surface | `--el-accent-on-surface`                                      |
| brand-pink decorative highlight         | `--el-highlight`                                              |
| section surface · quieter · faint fill  | `--el-surface` · `--el-surface-soft` · `--el-muted`           |
| border · soft · strong                  | `--el-border` · `--el-border-soft` · `--el-border-strong`     |
| link · pressed                          | `--el-link` · `--el-link-pressed`                             |
| danger/success/warning/info FILL        | `--el-danger` / `--el-success` / `--el-warning` / `--el-info` |
| ink ON a danger fill ⚠️ nothing else    | `--el-danger-text` (see the danger rule below)                |
| danger AS text / icon on a page surface | `--el-danger-on-surface`                                      |
| pastel tints                            | `--el-tint-{peach,rose,mint,lavender,sky,yellow}`             |
| **issue-type hue (by kind)**            | `--el-type-{epic,story,task,bug,subtask}`                     |

### Rules

- ✅ **Reference `--el-*`.** Need a colour not exposed yet? ADD the `--el-*`
  token to globals.css Tier 3 (mapping it to the right `--color-*`) and
  consume that — the per-component growth pattern (notes.html mistake #20).
- ✅ **Use the palette's colour, not just grey + primary (finding #54).**
  Issue-type icons take their type's hue via `--el-type-*` (prefer the
  `IssueTypeIcon` component, which applies it); status/priority go through
  `Pill`'s tones; feature surfaces use the pastel tints. A screen that is
  _only_ grey + primary purple is the finding-#54 tell.
- ✅ **AA contrast holds** — colored chips put the hue in the tint
  BACKGROUND with `--el-text-strong` text (finding #35); never tint a
  page-level surface.
- ⚠️ **CONTRAST IS A PROPERTY OF THE PAIR, NOT OF THE INK — and two grey
  tokens are traps (MOTIR-2455).** Measured with axe on a real route, light
  theme (the binding one; every ink clears AA on every dark surface):

  | ink                   | page / card `#ffffff` | `--el-surface` | `--el-muted` | `--el-surface-soft` |
  | --------------------- | --------------------- | -------------- | ------------ | ------------------- |
  | `--el-text-faint`     | 2.61 ✗                | 2.39 ✗         | 2.37 ✗       | 2.50 ✗              |
  | `--el-text-muted`     | **4.54 ✓**            | 4.17 ✗         | 4.12 ✗       | 4.34 ✗              |
  | `--el-text-secondary` | 6.80 ✓                | 6.24 ✓         | 6.18 ✓       | 6.51 ✓              |

  So: **`--el-text-faint` NEVER carries text WCAG measures** — it is for
  decorative glyphs (`aria-hidden`, or a `role="img"` whose label carries the
  meaning) and for **disabled / inactive** text, which 1.4.3 exempts. And
  **`--el-text-muted` is safe only on the white page/card**, with 0.04 of
  headroom — put a muted caption on `--el-surface` / `--el-muted` /
  `--el-surface-soft` and it fails. When in doubt reach for
  `--el-text-secondary`, which clears AA everywhere in both themes. A design
  mock is NOT authority here: the roles asset specified faint on surface and
  had to be corrected.

- ⚠️ **`--el-danger-text` IS NOT A DANGER TEXT TOKEN. It is the ink FOR a
  danger FILL, and it is legal ONLY on an element that also carries
  `bg-(--el-danger)` (MOTIR-3663).** It resolves to
  `--color-destructive-foreground`, which every palette defines as whatever
  contrasts with its red fill — white, or in a dark-first palette a near-black.
  Painted on a page instead, measured across all ten palettes:

  | theme | what it does                                                                                                                                                                                                      |
  | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | light | **1.00–1.04:1 in ALL TEN palettes** — the ink and the page are the same white                                                                                                                                     |
  | dark  | **1.00:1 in six** (amber · candy · citrine · evergreen · garnet · sienna)                                                                                                                                         |
  | dark  | 18.59–19.44:1 in the other four (base · cobalt · motir · spectrum) — legible, and still the bug: it renders near-white, indistinguishable from `--el-text`, so the **danger SIGNAL is lost rather than the text** |

  On the `--el-danger-surface` tint it is 1.14–1.29:1 in all twenty. Its one
  correct use in the whole tree is `Button`'s danger variant,
  `bg-(--el-danger) text-(--el-danger-text)`.

- ✅ **Danger text on a surface takes `--el-danger-on-surface`** —
  `color-mix(in srgb, var(--el-danger) 70%, var(--el-text))`, the palette's own
  danger hue pulled toward that theme's body ink until it is readable. It is
  **≥ 4.77:1 on the page, `--el-surface`, `--el-surface-soft`, `--el-muted`,
  `--el-tint-rose` and `--el-danger-surface`, in all 20 palette × theme
  combinations**, so it is right whichever surface the element lands on — the
  same property that makes `--el-text-secondary` the answer on the grey inks.
  **Raw `--el-danger` is NOT that token**: it is 4.25 / 4.11 / 4.24:1 on the
  DARK page in the base, cobalt and motir palettes, and under AA on most
  tints. For a big label or a glyph beside one, putting the hue in the
  **border + glyph** and keeping the label on `--el-text` is still the better
  composition (graphics need only 3:1) — `DeviceApproval` is the worked example.

  Both rules are enforced, at zero, over `components/**`, `app/**`, `lib/**`,
  the design system's `src/**` (`tests/theme/inkContrastLint.test.ts`'s danger
  arm) **and over `design/**`** (`tests/design-ink-contrast.test.ts`). The
design-side arm matters most: MOTIR-1553's root cause was a MOCK that
specified `--el-danger-text`for a row-menu Delete, which was then copied into
two components and shipped invisible. **Unlike the two grey arms, the danger
arm grants no`aria-hidden` / disabled exemption\*\* — 1.4.3 not measuring a
  hidden glyph does not make a white-on-white one visible.

- ❌ `text-foreground` / `bg-surface` / `text-muted-foreground` /
  `border-border` / `bg-primary` and friends — Tier-0 utilities, forbidden
  in component code.
- ❌ `text-(--color-*)` / `bg-(--color-*)` arbitrary values — Tier-0,
  forbidden. (`--focus-ring-color` is a semantic `@theme` token, not a
  `--color-*`, so `ring-(--focus-ring-color)` is fine.)
- ❌ Only `globals.css` (the Tier-0→Tier-3 wiring) and the `/tokens`
  specimen route name `--color-*` directly.
- ❌ **NEVER INVENT A COLOUR.** Do not write a raw hex hue (`#3b82c4`,
  `bg-[#dcecfa]`), an `rgb()/hsl()` literal, a named CSS colour, or a
  `color-mix()` over a **raw hue** for any element's colour — in component
  code **OR in a design mock**. Every colour MUST come from an existing
  palette token (`--el-*`, including the `--el-tint-*` set; or a `color-mix`
  whose inputs are ALL `--el-*`/`--color-*` tokens). If the palette has no
  colour that fits, ADD an `--el-*` token to `globals.css` Tier 3 (mapped to
  a `--color-*`) and consume THAT — never hardcode the hue inline. **Why it
  matters:** a palette token flips with `data-palette` and is kept mutually
  distinct from its siblings by the palette author; an invented hue does
  neither — it won't swap, and it can collide with a token under another
  palette. (When you need a card/state colour "clearly different" from
  another, reach for a _different tint slot_ — e.g. `--el-tint-sky` vs
  `--el-tint-mint` — not a new hex.) The ONLY raw values allowed in a mock
  are NON-semantic decoration that never carries meaning (the canvas
  grid-dot texture, the body backdrop) — never a card/pill/state fill,
  border, or text colour. (Yue, 2026-06-27: a done-card mock used invented
  `#3b82c4`/`#d98a3d` border hues — wrong; the fill must be a `--el-tint-*`.)

This rule was adopted after finding #54 (the UI had collapsed to grey +
primary because almost every component referenced Tier 0 directly).

---

## ⚠️ Shape (radius + spacing + sizing) flows through element-semantic shape tokens

**EXTREMELY IMPORTANT: SHAPE/FEEL is the second swappable axis (alongside COLOR).
The `data-style="…"` named-style axis (registry in `lib/theme/styles.ts`) — and
ultimately a whole different getdesign.md design system — must be able to
re-shape the WHOLE UI the same way `data-palette="…"` re-skins it. "Shape" is NOT
just radius: it is radius + component padding + control sizing + shadow. So every
shaped surface a component renders MUST reference an element-semantic shape token
— the ones a `[data-style]` block in `globals.css` overrides — NEVER the generic
Tier-0 scale (`--radius-xs/sm/md/lg/xl`, `--spacing-xs/sm/md/…`) and NEVER a
fixed raw utility (`rounded-md`, `p-1`, `px-2.5`, `h-9`, `shadow-md`). All of
those bypass the swap layer: flipping the style leaves them unshaped.**

This is the exact analogue of the colour rule above. The generic Tier-0 scales
are inert (like Tier-0 `--color-*`); the element-semantic tokens are the swap
layer (like `--el-*`). Only `[data-style]` tokens flip. A `[data-style]` TOKEN
block overrides ONLY shape/feel tokens, never a colour token — colour is the
independent `data-palette` axis.

**Surface-MATERIAL styles — the one sanctioned exception (glassmorphism, 7.3.35;
later cybercore / aurora / neumorphism).** Some styles own the SURFACE itself —
translucency, a gradient canvas, frosted backdrop-blur, light borders — which
the shape-only token block cannot express. They add a **palette-DERIVED material
layer**: style-scoped component rules
`[data-style='id'] [data-surface='…'] { … }` (NOT the bare token block) whose
colour comes ONLY from `color-mix()` / `var(--color-*|--el-*)` over the ACTIVE
palette — **never a raw hex hue**. That keeps the axes disjoint (a palette swap
re-tints the material; a style swap leaves hues untouched). Surfaces opt in via a
`data-surface` attribute on the shared primitive (`Card`/`Modal`/`Popover`/
`Sidebar`/`Input` emit it). Two invariants hold and are enforced by
`tests/theme/styleRegistry.test.ts`: (1) the bare `[data-style] { … }` token
block still carries NO `--color-*`/`--el-*`; (2) a material rule must be
palette-derived (a `var(--color|--el-…)` reference, no hex literal). Do NOT
"fix" a `data-surface` material rule by deleting its `color-mix` — it is the
blessed mechanism, not a colour-rule violation. See `docs/styles/glassmorphism.md`.

### Radius — by surface

| Surface                                                                                    | token              |
| ------------------------------------------------------------------------------------------ | ------------------ |
| button                                                                                     | `--radius-btn`     |
| card · popover/dropdown container · callout box                                            | `--radius-card`    |
| input · textarea · combobox trigger · editor surface                                       | `--radius-input`   |
| modal / dialog panel                                                                       | `--radius-modal`   |
| badge / pill / status chip                                                                 | `--radius-badge`   |
| **small affordance** — menu/list row, icon & close button, tooltip, sidebar row, code chip | `--radius-control` |
| keyboard-hint chip (`<kbd>`)                                                               | `--radius-kbd`     |

### Padding · sizing · elevation — by surface

| Surface                                               | padding / size token(s)                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| button                                                | `--spacing-btn-x/y` (`-sm`) · `--height-btn-{sm,md,lg}` — no density steps                                                                                                                                                                                                                                                                                                                                 |
| input · textarea                                      | `--spacing-input-x/y` · `--height-input` — no density steps                                                                                                                                                                                                                                                                                                                                                |
| card                                                  | `--spacing-card-padding` (default) · steps `--spacing-card-padding-16` `--spacing-card-padding-12` `--spacing-card-padding-8` `--spacing-card-padding-4`                                                                                                                                                                                                                                                   |
| menu/list row · combobox trigger/search · sidebar row | `--spacing-control-x` · steps `--spacing-control-x-16` `--spacing-control-x-12` `--spacing-control-x-8` `--spacing-control-x-6` `--spacing-control-x-4` `--spacing-control-x-2`; `--spacing-control-y` · steps `--spacing-control-y-8` `--spacing-control-y-4` `--spacing-control-y-2`; `--height-control` · steps `--height-control-28` `--height-control-32` `--height-control-40` `--height-control-48` |
| square icon / close button                            | `--spacing-icon-btn` — no density steps                                                                                                                                                                                                                                                                                                                                                                    |
| badge / pill chip                                     | `--spacing-chip-x` · steps `--spacing-chip-x-8` `--spacing-chip-x-6` `--spacing-chip-x-4` `--spacing-chip-x-2`; `--spacing-chip-y`                                                                                                                                                                                                                                                                         |
| `<kbd>` chip                                          | `--spacing-kbd-x/y` — no density steps                                                                                                                                                                                                                                                                                                                                                                     |
| tooltip · inline code block                           | `--spacing-tooltip-x/y` — no density steps                                                                                                                                                                                                                                                                                                                                                                 |
| shadow / elevation                                    | `--shadow-{subtle,card,elevated,modal}`                                                                                                                                                                                                                                                                                                                                                                    |

**Density steps.** A surface's own padding and height is a SCALE, not one value,
so the bases above carry derived steps. A step's name is its pixel value in the
default style (`warm-editorial`): `--spacing-control-x-8` is 8px there. Every
step is derived from its base in ONE shared rule on `:root, [data-style]` in
`packages/design-system/theme.css` (`round(nearest, calc(var(<base>) * N / <ref>), 1px)`),
so it follows the active style and re-resolves inside a nested `[data-style]`
scope. Steps are never written per style. A new step is one line in that rule,
added only when at least three real sites need it. In a class a step reads
`px-(--spacing-control-x-8)` / `h-(--height-control-40)`.

**Snap rule.** A raw own-box value routes to the NEAREST step of its surface's
base, ties to the smaller one. A sweep PR names every value that changed.

**Stays raw** (layout, not a surface's own box): gaps, `space-*`, margins,
heights of 24px and under, padding of 32px and over, `rounded-full` surfaces
and zero padding. A value that fits no step and that a reviewer accepts goes
into the `shapeSwapLint` allowlist with its reason.

### Rules

- ✅ **Reference an element-semantic shape token** for a surface's radius,
  its own padding, and its height/size. Need a role not exposed yet? ADD the
  token to `globals.css` `@theme` AND to the `[data-style='soft-playful']`
  block (so it actually flips), then consume it — the same per-component growth
  pattern the colour rule uses.
- ✅ `rounded-full` is fine ONLY for genuinely circular things (spinner, avatar,
  colour swatch, status dot) — not style-dependent.
- ✅ Layout-only spacing — gaps between siblings (`gap-2`), `space-*`, one-off
  margins (`mb-1`), page gutters, heights of 24px and under, padding of 32px and
  over, `rounded-full` surfaces and zero padding — may stay raw; it is not a
  surface's shape. Only a control's OWN box padding / radius / size is shape.
- ❌ `rounded-md` / `rounded-lg` / `rounded-xl`, or `rounded-(--radius-sm|xs)`
  and the rest of the generic radius scale (Tier-0, inert). A pill chip is
  `--radius-badge`, not `--radius-pill`.
- ❌ A fixed `p-1` / `px-2.5` / `h-9` for a control's own padding or height —
  use the surface's density step (`px-(--spacing-control-x-8)`, `h-(--height-control-40)`)
  so density flips too. A `shadow-md` on a surface — use `--shadow-*`.

This rule was adopted alongside the shape-swap work: components had collapsed
the SHAPE axis by reaching for the generic radius scale (`--radius-sm` ×11) +
raw `rounded-md` and fixed `p-1`/`px-2.5`/`h-9`, so the style swap only
reshaped buttons/cards/inputs/modals and left menus, dialog-close buttons,
tooltips, badges, kbd, and sidebar rows fixed. The same token set + migration
lands in the upstream `nextjs-prisma-vercel-starter-with-design`, so a getdesign
swap can redefine the full shape language, not just colour.

---

## ⚠️ Design assets — TWO files per surface (notes + mock)

**EXTREMELY IMPORTANT: a design surface under `design/<area>/` is only complete
when BOTH files exist together — neither is optional.** When you produce or
update a design asset (a `type: design` subtask, or any change to a mock), you
MUST land both:

1. **`design-notes.md`** — the spec: every primitive used, the exact copy, and
   the `--el-*` colour + `[data-style]` shape-token role for every
   element. (One per area; it indexes that area's surfaces.)
2. **`<surface>.mock.html`** — a self-contained mock built from the real design
   system (the `components/ui/*` primitives' markup + the `globals.css` `--el-*`
   / shape tokens — NEVER Tier-0 `--color-*` or raw `rounded-*`/`p-*`/`h-*`; the
   colour + shape token rules above apply to mocks exactly as to components). The
   HTML is the source of truth.

**There is no `.png` export any more, and a NEW `.pen` source is not accepted**
(`docs/decisions/design-result.md` AMENDMENT 4). The export existed so a design
could be skimmed on its pull request; the mock now renders on the card, so an
export is a second copy of what the reviewer already sees. A `.pen` can only be
reviewed through an export, so a new surface is drawn as a mock. The existing
exports and the 14 legacy `.pen` sources stay as records — do not delete them,
and do not update them. `tests/design-three-file-set.test.ts` fails an area that
ships an asset with no `design-notes.md`, and fails any `.pen` not on its legacy
list.

### A change to an existing design is a NEW DELTA MOCK

**Do not edit the existing mock.** Draw the change in a new
**`<surface>--<change>.mock.html`** beside it, holding **only the panels that
change** — the changed state, the new element, the altered layout — composed
from the real shipped components exactly as a full mock is. Add a new `##`
section to the area's `design-notes.md` that cites the section and the mock it
amends by path. An older mock is a record of the moment it was drawn, never a
specification to keep current: every run renders what `main` actually ships
before it builds on it. What counts as "only the changed panels" is a drawing
judgement — no guard measures it.

### Rendering a mock to an image — an OPTIONAL local tool

**`node scripts/render-design-mock.mjs <mock.html>` still works, for anyone who
wants to look at a mock as an image** — to self-review a layout, or to compare a
render against what ships. **Nothing requires its output and nothing publishes
it**, so do not commit a new `.png` as part of a design card. Two facts about the
tool, for when you do reach for it: it SEARCHES the viewport and refuses with
`REFLOW` rather than writing an image more than 25% from a committed export's
height (MOTIR-4374) — re-run with `--width <N>` if the delta is real; and for a
legacy surface that ships a `<name>.dark.png` it renders both boards, which
`tests/design-dark-board-parity.test.ts` holds to matching dimensions.

**⚠️ The ink rules apply to a mock's OWN `<style>` block and its board chrome,
not only to its utility classes.** `--el-text-muted` fails AA on `--el-surface` /
`--el-surface-soft` / `--el-muted` (4.12–4.34:1), and that is true of a
`.panelNote { color: var(--el-text-muted) }` rule and a panel caption exactly as
it is of `text-(--el-text-muted)` on a row — a design board's annotations owe AA
too (`docs/decisions/design-board-chrome-aa.md`). Reach for
`--el-text-secondary`, which is 6.18–6.80:1 on all four surfaces in both themes
and so is right whichever surface the element lands on. **The same holds for
`--el-text-faint`, which is 2.37–2.61:1 and clears AA on NO surface** — it is for
decorative glyphs and disabled text only, and saying so on the element
(`aria-hidden`, a labelled `role="img"`, `disabled`) is what makes it legitimate.
`tests/design-ink-contrast.test.ts` enforces BOTH inks at zero over the whole
tree, over both layers a mock paints in, and it resolves descendant / child /
compound selectors as well as bare ones (MOTIR-3122) — a rule nested two levels
deep is as visible to it as a top-level class.

**⚠️ That arm rules on the RESTING state ONLY, and its green is not a claim about
a hovered row (MOTIR-4255).** Its scanner abstains, deliberately and correctly,
on every selector carrying a pseudo-class: a static walk cannot know whether a
state obtains, so it may neither clear an ink on one nor claim a tint from one.
The consequence is that `.lt-row:hover { background: var(--el-surface) }` with a
`--el-text-muted` key inside it was invisible to a guard enforced at ZERO — 216
such elements across 22 assets. **`tests/design-state-ink-contrast.test.ts` is
the arm that measures them**: it renders each mock in happy-dom and resolves the
state surface from the TREE rather than from the selector text. So when you
write a `:hover` / `:focus` / `:active` tint into a mock, the ink inside it is
ruled on — reach for `--el-text-secondary`, or `--el-text-identifier` for a
monospace item key, and note that most mocks must DECLARE the latter in their own
token block (it is newer than they are).

---
