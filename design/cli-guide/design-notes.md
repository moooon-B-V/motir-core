# `design/cli-guide` — the published Motir CLI guide

**Story MOTIR-2308 · Subtask MOTIR-2326.** The published first hour with the
Motir CLI, for someone who has run `npm install -g @motir/cli` and has no
checkout of this repository. Route: **`/docs/cli`**. One area, one three-file
asset:

| File                  | What it is                                                            |
| --------------------- | --------------------------------------------------------------------- |
| `design-notes.md`     | this spec — structure, primitives, tokens, ownership, the access path |
| `cli-guide.mock.html` | the SOURCE, built from the real design system (five panels)           |
| `cli-guide.png`       | the full-page export a reviewer skims without opening the HTML        |

Built against ADR **Amendment 12** (`docs/decisions/public-api-conventions.md`,
Subtask MOTIR-2322), which pins the route and the ONE-PAGE shape (Q1), the
derivation seam the command table reads (Q2), which facts the page derives and
which it points at (Q3), and the import boundary (Q4). This asset draws to those
answers; it does not re-decide them.

> **⚠️ WHAT THIS PAGE IS.** It gets a stranger from `npm install` to **one work
> item dispatched**, and it stops there. It is not the manual. `docs/cli.md` is
> 1,147 lines and stays the reference — the three run shapes, session-branch
> semantics, the failure policy, troubleshooting, and every flag all live there,
> and the page's finish line hands off to it by name. Amendment 9 Q2's rule is
> what draws that line and Amendment 12 Q3 applies it fact by fact.

> **Why its own area, and not an amendment to `design/api-docs/`.** Same argument
> the sandbox guide made one story earlier: this is a page with its own content,
> its own procedure and its own failure modes, which only happens to be served by
> a shell somebody else designed. **`design/api-docs/` is not touched by this
> story**, and neither is `design/agent-sandbox/`.

---

## ⚠️ Nothing in the mock is redrawn from a mental model

The mock is GENERATED, in two steps, and that is the reason to trust it:

1. **Every class string on a shipped element was dumped out of the REAL
   component** through the repo's own vitest + RTL setup — `CatalogueNav`,
   `DocBlock` (`prose` / `code` / `callout` / `table`), `CodeBlock`,
   `ConnectCliPanel`. The mock is the app's own output, not a stylised
   stand-in, so it cannot diverge from what the app actually renders.
2. **Every command-table row was generated from the REAL `buildProgram()`
   tree** — all twenty-three of them, with their argument signatures, their
   one-line descriptions and their help groups. The table in the mock is the
   CLI's, not an invented list.

The stylesheet is Tailwind's own output over the mock plus the real
`@motir/design-system/theme.css` layer, so there are no retyped hexes and no
hand-copied token block. Toggling dark mode on the review page flips the whole
asset, which is the check that the Tier-3 layer is genuinely doing the work.

---

## ⚠️ What this design does NOT own

| Element                                                   | Owned by                                         | What THIS design does                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The docs shell — top bar, content column, footer          | `design/api-docs/` (Story 11.4 · MOTIR-2188)     | Mounts into it unchanged. Reproduced in Panel 1 only as the frame this page sits in.                                                                   |
| The **two-tier rail** and its grouping                    | `design/api-docs/` (regrouped by MOTIR-2311)     | Adds ONE row to the surface tier. The tier structure, the row treatment and the `aria-current` behaviour are that asset's and are unchanged.           |
| `DocBlocks`' `prose` / `code` / `callout` / `table` kinds | `design/api-docs/` (11.4.8 · MOTIR-2189)         | Uses all four as-is. Asks for ONE optional addition to the `table` kind — see the allocation table below. Changes no kind's rendering.                 |
| `CodeBlock` and its copy affordance                       | `design/api-docs/` (11.4.7)                      | Uses it. Every runnable command on this page is a copyable block.                                                                                      |
| The **Connect the CLI panel**                             | `design/cli-connect/` (Panels 9–11 · MOTIR-1869) | Does NOT redraw it. Draws one link row's TARGET and treatment (Panel 5), the way `design/api-docs/` draws its one link row without redrawing the pane. |
| The marketing top bar and footer                          | `design/project-square/` (Story 6.13)            | Nothing.                                                                                                                                               |
| The CLI itself — every command, flag and output line      | Story 7.9 (`packages/cli/`)                      | Nothing. Every fact drawn here is READ off the shipped tool.                                                                                           |
| The route, the one-page shape, the derivation seam        | ADR Amendment 12 (MOTIR-2322)                    | Draws to them.                                                                                                                                         |

**The one thing it changes in someone else's surface** is the rail's row list:
one row, drawn in Panel 2.

---

## ⚠️ ONE page, and NO second-tier rail index — a decision, not an omission

Amendment 12 Q1, applied here rather than re-argued: **`/docs/cli` is one page,
one row in the rail's surface tier, and it carries no second tier.**

A reader looking at Panel 2 will see the CLI's rail is shorter than the API's,
and that is the intended reading. Amendment 11 Q1 gives the two tiers their
meanings — tier 1 lists **surfaces**, tier 2 lists **that surface's pages** — and
the CLI surface has one page. A second tier here would have to list either that
one page (a rail row pointing at the rail's own row) or the page's **headings**,
which is a table of contents wearing the tier's clothes. A rail that sometimes
means _pages_ and sometimes means _headings on this page_ cannot be read at a
glance, and being readable at a glance is its whole job.

So **the command table is a SECTION of the page, not a rail.** If the CLI ever
earns a second page — a recipes page, an unattended-loop page — that page creates
the `/docs/cli/*` prefix, this page becomes the sub-area index, and the tier
arrives with real rows to list.

Panel 2 draws both rails side by side for exactly this reason: the absence is
only legible next to the presence.

---

## ⚠️ The page is a PROCEDURE, and is drawn as one

```
  lede                                    ← what you will have in five minutes
  Before you start                        ← two things, and one of them is an account
  1 · Install                  npm install -g @motir/cli
  2 · Sign in                  motir login
  3 · Link your workspace root motir link --project ACME
  4 · Check it                 motir doctor
  5 · See what is ready        motir status / sprint / ready
  6 · Dispatch one item        motir show → motir next --print → motir done
  Where Motir keeps things                ← the two files, and which one is a secret
  Every command                           ← the DERIVED table
  What next                               ← the hand-off, not a seventh step
```

The numbered-`h2` rhythm is the shipped one: the getting-started page already
reads `1 · Mint a token`, `2 · Your first call`, and the sandbox guide reads the
same way. This page is consistent with its neighbours rather than inventing a
form.

Four things about that ordering are decisions, not sequence:

- **The install step is FIRST and the account is a PRECONDITION, not step 0.**
  A reader arriving here has already decided to try Motir; making them do account
  chores before the one command they came for reads as a gate. _Before you start_
  says "a Motir account, and Node ≥ 22. That is the list."
- **`motir login` is step 2, and it needs nothing to exist first.** The device
  grant prints a code and a URL and waits — no token to mint by hand, no file to
  create. The page says so, and the callout covers the machine with no browser
  (SSH, a container) because that is the reader most likely to stall here.
- **`motir doctor` is a STEP, not a troubleshooting appendix.** Steps 1–3 each
  set something up; step 4 is where the reader finds out whether they did. A
  setup procedure that ends without a check has no finish line, which is what
  makes it trail off instead of stopping.
- **Step 6 ends at `motir done`, not at the agent.** The page hands over one
  prompt and closes one item; what an agent does with the prompt is not this
  page's business, and the unattended loop (`motir auto`) is named once in a
  callout and handed to the reference. Conflating _set the tool up_ with _run
  the loop_ is the exact defect the sandbox guide's design records.

### The lede promises a time, and that is deliberate

_"in about five minutes, without cloning anything"_ — six steps, four of which
are one command. The second clause is the whole reason the page exists: the CLI
is published to npm precisely so nobody needs the repository, and until this page
ships, the only instructions for it are in the repository.

---

## The command table — DERIVED, and grouped the way the CLI groups itself

Panel 3. Every row comes out of `packages/cli/src/commandCatalog.ts` (MOTIR-2324
· Amendment 12 Q2): the invocation (name + argument signature), the one-line
description, and the help group. **Nothing in it is typed on the page**, which is
the property this whole story is buying — a command the CLI gains appears here
with no edit to any file the page owns.

**Four tables, one per help group** — SETUP · READ · WORK LOOP · HELP — rather
than one table with a repeated _Group_ column. Two reasons: it mirrors what
`motir help` already prints, so the published table and the tool's own overview
teach the same shape; and it removes the column that would have cost the most in
the narrow rendering, where every cell carries its column name as a label.

**The first column is pinned to `w-[34%]`** so the four tables align down the
page. Without it each table auto-sizes independently and the description column
walks left and right between groups, which reads as four unrelated tables rather
than one list in four parts. This is the one thing the design asks of a shipped
component — see the allocation table.

A subcommand (`motir auth status`, `motir link add <repo> <path>`) renders under
its parent's group, because that is where a reader looks for it and because
commander gives a subcommand no group of its own.

---

## Every viewport — Panel 4

`DocBlocks`' `table` kind already ships two renderings, and this page is exactly
the case it was built for:

- **Wide (≥ `md`)** — a real `<table>`. Panel 4's 768 px frame shows it survives
  a tablet comfortably: two columns, one of them short and monospaced.
- **Narrow (< `md`)** — the same rows as one card per row, each cell keeping its
  column name as its label. Each rendering is `display: none` at the other width,
  so a screen reader is offered one of them and never both.

Twenty-three rows of two columns is well inside what the narrow arm handles,
which is the reason the _Group_ column was folded into headings rather than kept:
a third column would have made each phone card three label/value pairs deep.

**The code blocks are the other wide-content risk**, and they are already
handled: `CodeBlock`'s `<pre>` scrolls inside its own `overflow-x-auto` container
and its wrapper clips, so the longest line on this page — `motir show MOTIR-42

# the item you are about to hand an agent` — never makes the PAGE scroll

sideways.

> _Harness note:_ the phone and tablet frames in Panel 4 force the narrow and
> wide arms respectively, because a Tailwind media query reads the VIEWPORT and
> the review page is 1200 px wide. The markup inside each frame is the shipped
> markup, unmodified.

---

## ⚠️ The access path — TWO entrances, and the second is the one that matters

### 1 · The docs rail's surface tier — for a stranger

A new third row, **Motir CLI**, beside _API reference_ and _Agent sandbox_
(Panel 2). It is drawn in the tier's existing markup with the shipped active
treatment: `aria-current="page"` on the row for the page being read,
`--el-sidebar-item-bg-active` fill, `--el-text` at `font-semibold`, and
`--shadow-subtle`. Idle rows are `--el-text-secondary` with an
`--el-sidebar-item-bg-hover` hover.

This is the door for someone who has never used Motir and is reading the
documentation to decide whether to. It is also the only route to the page for
anyone without a session.

### 2 · Settings → Account → _Connect the CLI_ → **Read the CLI guide** — for a signed-in user

Panel 5. `ConnectCliPanel` is, by its own header comment, _"the ONLY place in the
product that says the CLI exists."_ It prints `npm install -g @motir/cli`, then
`motir login`, and then its footer offers **Read the CLI guide** — today pointing
at `https://github.com/moooon-B-V/motir-core/blob/main/docs/cli.md`, a raw
Markdown file on a source host, opened in a new tab.

**This is the entrance that matters, and it is the reason the page exists.**
Nobody browses documentation for a tool they have already been handed; they click
the link the product just gave them. Once `/docs/cli` exists, that link has
somewhere better to go.

What changes, and only this:

|              | Today                                                            | After                               |
| ------------ | ---------------------------------------------------------------- | ----------------------------------- |
| `href`       | `https://github.com/moooon-B-V/motir-core/blob/main/docs/cli.md` | `/docs/cli`                         |
| element      | `<a target="_blank" rel="noreferrer">`                           | an in-product `next/link`, same tab |
| label + icon | _Read the CLI guide_ + lucide `BookOpen`                         | **unchanged**                       |

The in-product treatment follows from the target: the link no longer leaves the
application, and the new-tab/`noreferrer` pair is the treatment for one that
does. **Nothing else in the panel changes** — not its copy, not its two copy
controls, not the tie line, not the layout. `MCP_GUIDE_HREF` in
`ApiTokensManager.tsx` deliberately keeps its GitHub target: there is no
published MCP page for it to point at, and that link belongs to MOTIR-2309.

---

## Primitives and tokens, element by element

Every element on the page composes a shipped component. Nothing here is new, and
nothing reaches a Tier-0 `--color-*` or a raw `rounded-*` / `p-*` / `h-*`.

| Element                    | Primitive / source                       | Colour tokens                                                                                                                   | Shape tokens                                                  |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Page title                 | `<h1 class="font-serif text-2xl">`       | `--el-text`                                                                                                                     | —                                                             |
| Lede                       | `<p class="text-[15px]">`                | `--el-text-muted`                                                                                                               | —                                                             |
| Step heading (`1 ·`)       | the sandbox page's `StepHeading`         | `--el-text`; the ordinal `--el-text-faint`                                                                                      | —                                                             |
| Body prose                 | `DocBlock` `prose`                       | `--el-text-secondary`; `**bold**` → `--el-text`                                                                                 | —                                                             |
| Inline code                | `DocBlock` `renderInline`                | `--el-code-text` on `--el-code-bg`                                                                                              | `--radius-kbd`                                                |
| Command block              | `CodeBlock` (`copyable`)                 | `--el-code-text` on `--el-code-bg`; caption `--el-text-faint` on `--el-surface-soft`; border `--el-border` / `--el-border-soft` | `--radius-card`                                               |
| Copy button                | `Button` `variant="secondary" size="sm"` | `--el-text`, border `--el-button-border`, hover `--el-surface`                                                                  | `--radius-btn`, `--height-btn-sm`                             |
| Info callout               | `DocBlock` `callout` `tone="info"`       | `--el-text-strong` on `--el-tint-sky`                                                                                           | `--radius-card`                                               |
| Warning callout            | `DocBlock` `callout` `tone="warning"`    | `--el-text-strong` on `--el-tint-peach`                                                                                         | `--radius-card`                                               |
| Table (wide)               | `DocBlock` `table`                       | header `--el-text-faint` over `--el-border`; cells `--el-text-secondary` over `--el-border-soft`                                | —                                                             |
| Table (narrow card)        | `DocBlock` `table`                       | `--el-surface` fill, `--el-border-soft` border, labels `--el-text-faint`                                                        | `--radius-card`                                               |
| Group caption (`setup`, …) | `DocBlock` `table` `caption`             | `--el-text-faint`                                                                                                               | —                                                             |
| Rail                       | `CatalogueNav`                           | `--el-sidebar-bg`, `--el-border`                                                                                                | —                                                             |
| Rail section label         | `SectionLabel`                           | `--el-text-eyebrow`                                                                                                             | —                                                             |
| Rail row — idle            | `CatalogueNav` `rowClass(false)`         | `--el-text-secondary`, hover `--el-sidebar-item-bg-hover`                                                                       | `--radius-control`, `--height-control`, `--spacing-control-x` |
| Rail row — current         | `CatalogueNav` `rowClass(true)`          | `--el-text` on `--el-sidebar-item-bg-active`                                                                                    | `--radius-control`, `--height-control`, `--shadow-subtle`     |
| Finish-line link row       | the sandbox page's `guideNext` footer    | `--el-link`, rule `--el-border-soft`                                                                                            | —                                                             |
| Settings link              | `ConnectCliPanel` footer `<a>`           | `--el-link`, hover `--el-link-pressed`                                                                                          | —                                                             |

**AA contrast holds** where a tint carries text: both callout tones put the hue
in the BACKGROUND and the ink in `--el-text-strong`, which is the shipped
treatment. **No page-level surface is tinted.** No colour on this page is
invented — the review harness's own chrome (panel labels, device frames, the
before/after tags) is likewise built only from `--el-*` and element-semantic
shape tokens, so even the board this asset is pinned to cannot introduce a hue
the palette does not have.

---

## Allocation — what this design GIVES each card, and what it TAKES

| Card                                  | GIVES / TAKES | What                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-2329** (the `/docs/cli` page) | **GIVES**     | The whole page: six numbered steps in this order, the copy, the block kind per element, the four grouped command tables, the finish line's three named hand-offs, and the rail's third row.                                                                                                                                                                                                                                           |
| **MOTIR-2329**                        | **TAKES**     | One optional addition to `DocBlock`'s `table` kind: a `columnWidths?: readonly (string \| null)[]` whose entries are Tailwind width classes applied to the wide rendering's `<th>`s (here `['w-[34%]', null]`). Without it the four grouped tables do not align. It changes no existing call site — the field is optional and every shipped `table` block omits it. **Applied to that card's acceptance criteria in this same pass.** |
| **MOTIR-2331** (the in-app door)      | **GIVES**     | The link's target (`/docs/cli`), its in-product treatment (same tab, no `noreferrer`), and confirmation that the label, the icon and everything else in the panel are unchanged.                                                                                                                                                                                                                                                      |
| **MOTIR-2324** (the command record)   | **TAKES**     | Nothing beyond what Amendment 12 Q2 already required. The table reads `path`, `signature`, `description` and `helpGroup` — the four facts that card already builds `program.ts` from.                                                                                                                                                                                                                                                 |
| **MOTIR-2334** (E2E)                  | **GIVES**     | Both entrances to drive, and the fact that the rail row is the ONLY route for a session-less reader — so flow 1 must arrive by CLICKING it.                                                                                                                                                                                                                                                                                           |
| `design/api-docs/`                    | —             | Untouched. The rail gains a row through `CatalogueNav`'s existing `pages` list; no structural change.                                                                                                                                                                                                                                                                                                                                 |
| `design/cli-connect/`                 | —             | Untouched. One link's `href` and element type change; the panel does not.                                                                                                                                                                                                                                                                                                                                                             |

---

## Panels — review EACH (`notes.html` mistake #31)

| Panel | What to check                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | `/docs/cli` at 1200 px, in the shipped shell — the whole procedure top to bottom, and that every step is one command with somewhere to copy it from. |
| **2** | The rail on this page (one tier) beside the rail on an API page (two tiers) — Amendment 12 Q1 made visible.                                          |
| **3** | The derived command table at desktop: twenty-three real rows in four groups, first column aligned across all four.                                   |
| **4** | The same table at 768 px and 375 px — the wide `<table>` and the card-per-row arm.                                                                   |
| **5** | The Settings → Account link row, before and after re-pointing. The panel itself is NOT redrawn, on purpose.                                          |

Toggle dark mode on the review page to confirm token parity; the asset flips
entirely, which is the check that nothing bypassed the Tier-3 layer.
