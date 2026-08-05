# `design/api-docs` — the developer documentation surface

**Story 11.4 · Subtask 11.4.2 (MOTIR-2183).** The public API reference, the
getting-started guide, the stability & deprecation policy, and the two doors that
reach them. One area, one three-file asset:

| File                 | What it is                                                     |
| -------------------- | -------------------------------------------------------------- |
| `design-notes.md`    | this spec — primitives, tokens, copy, ownership                |
| `api-docs.mock.html` | the SOURCE, built from the real design system (nine panels)    |
| `api-docs.png`       | the full-page export a reviewer skims without opening the HTML |

Built against ADR **Amendment 4** (`docs/decisions/public-api-conventions.md`),
which pins the routes, the renderer and the spec URL. This asset draws to that
answer; it does not re-decide it.

---

## ⚠️ What this design does NOT own

Stated first, because two of the nine panels draw surfaces that belong to other
designs and would otherwise read as a redesign of them.

| Element                                         | Owned by                                                                             | What THIS design does                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| The marketing top bar and footer                | `design/project-square/` (Story 6.13 · 6.13.6, Panel 1)                              | Changes ONE nav item's TREATMENT (`Docs`: label → link) and adds ONE footer link. Nothing else. |
| The API-tokens settings page header + CLI panel | `design/settings/` (`account-settings.mock.html` Panels 3–8) · `design/cli-connect/` | Places ONE link row above them. Redraws neither.                                                |
| The token manager (list, create modal, scopes)  | `design/settings/` (`account-settings.mock.html` · `token-scopes.mock.html`)         | Nothing. Drawn at 55% opacity in Panel 8 purely as position context.                            |
| The app shell / authed nav                      | `design/shell/`                                                                      | Nothing — the docs surface is PUBLIC and does not render inside the authed shell.               |
| The renderer, the routes, the spec URL          | ADR Amendment 4 (Subtask 11.4.1)                                                     | Draws to them.                                                                                  |

---

## Routes

| Route                       | Page                                      | Auth          |
| --------------------------- | ----------------------------------------- | ------------- |
| `/api-docs`                 | The API reference (catalogue + operation) | none (public) |
| `/api-docs/getting-started` | The five-step guide                       | none (public) |
| `/api-docs/stability`       | The stability & deprecation policy        | none (public) |
| `/api/openapi/v1.json`      | The spec the reference renders FROM       | none (public) |

All three pages live in `app/(public)/api-docs/`, the route group
`app/(public)/explore/` already established for unauthenticated, indexable pages.

---

## The renderer — our OWN primitives

ADR Amendment 4 Q4 rejects Scalar, Redoc and Swagger UI, and the reason matters
for this asset specifically: a third-party reference ships its own complete
visual system, which neither the `data-palette` colour axis nor the `data-style`
shape axis reaches — and it owns its own markup, so there would be nothing for
this design to specify and nothing for a reviewer to compare the built page
against. Every element below is therefore a shipped `components/ui/*` primitive.

---

## The shell (all three pages share it)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ExploreTopBar (shipped)                     Sign in · Start free    │
├───────────────┬──────────────────────────────────┬───────────────────┤
│ catalogue     │  content column                  │  on this page     │
│ 264px         │  flex, min-width 0               │  200px            │
│ ─ search      │                                  │  ─ section links  │
│ ─ Documentation                                  │  ─ spec link      │
│ ─ operations  │                                  │                   │
│   by resource │                                  │                   │
├───────────────┴──────────────────────────────────┴───────────────────┤
│  ExploreFooter (shipped)                                             │
└──────────────────────────────────────────────────────────────────────┘
```

The three pages are the **top group in the same left nav** (`Documentation`:
API reference · Getting started · Stability & deprecation), which is what makes
them read as one surface rather than three unrelated pages.

| Element             | Primitive         | Colour                                                                        | Shape                                                         |
| ------------------- | ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Catalogue rail      | `Sidebar` grammar | `--el-sidebar-bg`, border `--el-border`                                       | —                                                             |
| Search box          | `Input`           | bg `--el-page-bg`, border `--el-border-strong`, placeholder `--el-text-faint` | `--radius-input`, `--height-control`, `--spacing-control-x`   |
| `/` hint            | `<kbd>` chip      | border `--el-border`, text `--el-text-faint`                                  | `--radius-kbd`, `--spacing-kbd-x/y`                           |
| Nav group heading   | `SectionLabel`    | `--el-text-faint`                                                             | —                                                             |
| Nav row             | sidebar row       | `--el-text-secondary`; hover `--el-sidebar-item-bg-hover`                     | `--radius-control`, `--height-control`, `--spacing-control-x` |
| Nav row, active     | sidebar row       | bg `--el-sidebar-item-bg-active`, text `--el-text`                            | `--shadow-subtle`                                             |
| Right-hand contents | plain list        | `--el-text-muted`; active `--el-text`                                         | —                                                             |

**Content-column typography.** `h1` is `--font-serif` at 26px (the app's page-title
convention); `h2` is 16px semibold; `h3` is an 11–13px uppercase
`--el-text-faint` label, the same eyebrow the settings panes use. Body copy is
14px / 1.65 at `max-width: 68ch` — long-form prose, so the measure is the reading
constraint rather than the container.

---

## The HTTP method chip

The one element with no exact shipped precedent, so it is derived rather than
invented: a `Pill` whose **hue lives in the BACKGROUND** with `--el-text-strong`
ink, which is the AA rule every coloured chip in this codebase already follows
(finding #35). Each verb takes a different **tint slot** — never a new hue.

| Verb     | Token             |
| -------- | ----------------- |
| `GET`    | `--el-tint-sky`   |
| `POST`   | `--el-tint-mint`  |
| `PATCH`  | `--el-tint-peach` |
| `DELETE` | `--el-tint-rose`  |

Shape: `--radius-badge`, `--spacing-chip-x/y`, `--font-mono` at 10.5px, and a
`min-width: 52px` so the paths beside them align down the rail.

**Status chips reuse the same three-tint logic by CLASS, not by code**: 2xx →
`--el-tint-mint`, 4xx → `--el-tint-peach`, 5xx → `--el-tint-rose`. A reader
learns three colours, not eleven.

**The scope chip** is a `Pill` on `--el-tint-lavender` with `--el-text-strong`,
`--font-mono` — deliberately a fourth tint, because a scope is a different KIND
of fact from a verb and must not be mistaken for one.

---

## Panel-by-panel

### Panel 1 — `/api-docs`, the default view

The catalogue is the **default landing content**: an integrator arriving cold
sees what the API can do before being asked to choose. Operations are grouped by
resource (`Work items` · `Sprints` · `Projects · Backlog · Ready`), matching the
per-resource `operations.ts` modules the document is assembled from.

The right rail carries **On this page** plus a permanent **Spec** block linking
`/api/openapi/v1.json` and stating `OpenAPI 3.1 · v1.0.0` — a code generator's
first stop, and the honest place to state that `info.version` is the CONTRACT's
version rather than the app's release.

### Panel 2 — operation detail, a WRITE

Drawn on the operation with the most to say (`PATCH /api/v1/work-items/{key}`):
a request body, a conditional header, and the two statuses Story 11.2 added.
**The section order is fixed** — scope → request → body → example → responses —
so a reader who has read one operation can skim the next.

The `curl` is copy-pasteable and carries `Bearer motir_pat_<your-token>`, a
placeholder rather than a plausible-looking fake token. The `Copy` button is a
`Button` (`variant="secondary"`, `size="sm"`) pinned to the block's top-right.

Copy that must survive to the build (each is a decision a reader would otherwise
have to discover from a 404):

- 401 — _"the five token failures are deliberately undifferentiated"_
- 404 — _"No such item, **or** it is outside this token's workspace — the same answer, on purpose"_
- 500 — _"An unexpected fault — no `code`, by design"_
- The `X-Request-Id` callout, because the id is only useful if a reader knows to quote it.

### Panel 3 — the in-page FIND

At ~28 operations today the rail is already longer than a viewport, and the API
grows. Typing filters in place and **keeps the group headings of surviving
matches**, so a reader learns where an operation LIVES rather than only that it
exists. A count line (`5 of 28 operations`) is the honest signal at scale.
`/` focuses the box, `Esc` clears it — the app's existing search-shortcut
convention. Nothing navigates until a row is chosen.

### Panel 4 — getting started

The words are 11.4.8's. This panel fixes the **rhythm** they land in: a numbered
`h2`, one short paragraph, one code block, and a `callout` only where a reader
would otherwise get it wrong. Five steps, always in this order — mint → first
call → paginate → read an error → read the rate-limit headers.

Two callouts are load-bearing rather than decorative:

- **Info** (`--el-tint-sky`): _a token is bound to ONE workspace and its scopes NARROW your role — they never widen it._
- **Warning** (`--el-tint-peach`): _on a 429, back off until `X-RateLimit-Reset`. There is no `Retry-After`._

### Panel 5 — stability & deprecation

A short prose page, deliberately plainer than the reference: it is read once, in
order, and then cited. The two lists (additive / never) are the load-bearing
content and are the page's only structure. Amendment 4 Q5 requires the page be
**generated from ADR §8's lists rather than re-typed** — a second hand-written
copy of a stability promise is the same drift this story exists to prevent,
applied to prose.

The reader's own obligation gets a warning callout rather than a bullet, because
it is the one thing on the page the reader must DO: tolerate unknown fields and
unknown enum values, and never parse the human `error` sentence.

### Panel 6 — the spec-unavailable state

The reference renders from `/api/openapi/v1.json`. When that cannot be read the
page must **not** render an empty catalogue, which reads as _"this API has no
operations"_. It says what happened, offers **Try again**, and — because the spec
is public — offers the raw document. The shell and both doors stay intact, so a
reader is never stranded, and the copy names what still works: _"Getting started
and the stability policy are unaffected."_

Composition: a centred `EmptyState` — a `--el-tint-peach` glyph badge,
`--font-serif` heading, `--el-text-muted` body at `max-width: 46ch`, and two
`Button`s (primary + secondary).

### Panel 7 — THE PUBLIC DOOR

**Not a new nav pattern, and this is the panel's whole point.** The shipped
`ExploreTopBar` (`app/(public)/explore/_components/ExploreTopBar.tsx`) already
renders `Product`, `Docs` and `Pricing` — as **non-interactive labels**, for the
reason its own comment gives:

> `Explore` is the only nav item that resolves to a real page today; `Product` /
> `Docs` / `Pricing` are future marketing pages, so they render as
> non-interactive labels rather than dead links a crawler would 404 on.

This design makes **`Docs` the first of the three to resolve**, so it takes the
treatment the bar already has for a real page — the one `Explore` uses. BEFORE
and AFTER are drawn side by side because the change is a TREATMENT, not a new
element.

| State                        | Treatment                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| Label (unresolved, shipped)  | `<span>`, `--el-text-muted`, 13.5px                                  |
| Link (resolved, this design) | `<a>`, `--el-text-secondary`, 13.5px                                 |
| Current page                 | `<a aria-current="page">`, `--el-accent-on-surface`, 13.5px semibold |

The **footer's Product column** gains an `API docs` link on the same reasoning —
`ExploreFooter`'s Product/Company columns are non-interactive labels today, and
this is the first of them that resolves. It matters because the footer is the
crawl surface: a docs page nothing links to is a docs page search does not find.

### Panel 8 — THE IN-APP DOOR

The reader with the sharpest need is someone who has **just minted a PAT** and is
holding a secret with nothing to do with it. One link row on
`app/(authed)/settings/account/api-tokens/page.tsx`, placed **directly under the
page header and ABOVE the CLI panel and the token manager**.

That placement is the same argument MOTIR-1869 used to put `ConnectCliPanel`
above the token list — _the route out reads first_ — applied one line higher,
because reading the docs is a cheaper first step than either minting a token by
hand or installing a CLI.

Composition: a `Card` with an accent border (`--el-accent`) holding one settings
row — label `--el-text` 14px, description `--el-text-muted` 12.5px at
`max-width: 58ch`, and two `Button`s (`secondary` → getting started, `primary` →
the reference). Copy:

> **Build against the API**
> Every endpoint, its scopes and a copy-pasteable example — plus a five-step
> guide from a fresh token to a working call.

### Panel 9 — mobile, 390 px

- The 264px catalogue collapses to a **disclosure button** above the content
  (`API reference · 28 operations`), full width, `Button` `secondary` `sm`.
- The right-hand contents **drops entirely** — on a phone the page IS the
  contents.
- **The rule that matters:** a `curl` line is wider than any phone, so the CODE
  BLOCK scrolls inside its own container (`overflow-x: auto` on the `<pre>`,
  `overflow: hidden` on the bordered wrapper) and the **PAGE never scrolls
  sideways**. The block's caption says so (`scrolls here, not the page →`).
- The spec tables become **stacked rows** (status chip + condition) rather than
  shrinking three columns to unreadable widths.

---

## Light and dark

Every colour resolves to an `--el-*` token, so dark mode is the token layer's
job and not a second design. The mock's toggle flips `data-theme` on `<html>`;
review both. Two things worth checking on the flip:

- The four verb tints stay mutually distinguishable in the dark ramp (they are
  the four `--el-tint-*` slots the palette author keeps distinct).
- The code block's `--el-code-bg` sits ABOVE `--el-page-bg` in dark, so a block
  reads as raised rather than as a hole.

**No invented colour.** Every value in the mock is an `--el-*` token or the
Tier-0 `--color-*` block copied 1:1 from `@motir/design-system/theme.css` (via
`app/globals.css`). The only non-token values are the review-page chrome — the
panel labels and the `NEW` annotation badges — which are not part of the design.

---

## Accessibility

- Verb, status and scope chips carry their meaning in **text**, never in colour
  alone; the tint is redundant reinforcement.
- The catalogue is a `<nav aria-label="API reference">`; the current page carries
  `aria-current="page"`, matching `ExploreTopBar`'s shipped treatment.
- Code blocks are `<pre>` inside a labelled container, so a screen reader
  announces the caption before the content.
- Every tint chip pairs its hue background with `--el-text-strong` for AA.
- The search box is a real `<input>` with a visible label affordance and the
  `/` hint exposed as text, not as a tooltip.

---

## Deviations from this asset, and why

Recorded here per 11.4.7's acceptance criterion — _"any deliberate deviation is
recorded in `design/api-docs/design-notes.md` with its reason."_

| Drawn                                                            | Built                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The scope chip on `--el-tint-lavender`                           | `Pill tone="neutral"` + `font-mono`                                                                 | The shipped `Pill` has no lavender tone that is not already semantically claimed (`status="planned"`, `tone="private"`), and adding one is a `packages/design-system` change outside 11.4.7's boundary. `neutral` still keeps the scope chip distinct from all four verb tints — the property the lavender was for — and the monospace face carries the rest. Revisit if a `tone="scope"` ever earns its place in the shared primitive. |
| `DELETE` in the verb chip                                        | `DEL` visible, `DELETE` in the accessible name                                                      | Every verb fits one 52 px chip so the paths align down the rail. The full verb stays in the accessible tree via `sr-only`, so a screen reader is not handed a truncation.                                                                                                                                                                                                                                                               |
| Panel 1's catalogue rail beside a persistent right-hand contents | The rail collapses ABOVE the content below `lg`, and the right-hand contents is not built in 11.4.7 | The in-page contents is per-PAGE navigation and the reference is one long page of anchored sections, so the catalogue already serves that role; a second list of the same anchors would be two things to keep in step. The mobile treatment (Panel 9) is what ships at every width below `lg`.                                                                                                                                          |

---

## What the code cards build from this

| Card                     | Builds                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **11.4.7** (MOTIR-2188)  | the docs shell, the reference (Panels 1–3, 6), and BOTH doors (7, 8)                                                  |
| **11.4.8** (MOTIR-2189)  | the getting-started and stability pages' COPY, into Panels 4–5's rhythm                                               |
| **11.4.10** (MOTIR-2191) | the E2E: a developer finds the reference, reads an operation, follows getting-started, and reaches it from both doors |
