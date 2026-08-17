# Home — design notes

Design reference for the `home` UI area — **`/home`, the signed-in landing
surface** (Story MOTIR-2649, drawn by the MOTIR-2650 design gate, **revised by
MOTIR-2761**). There was no `design/home/` before this asset. It is the layout
source of truth for **MOTIR-2653** (the page) and **MOTIR-2654** (the door), and
both carry it in `blocked_by`.

| Surface                      | Asset                              | Notes                                                                                                                                                         |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The `/home` landing page** | **`home.mock.html`** (HTML mockup) | The whole surface, multi-panel: the door · populated · Watching · the all-empty page · both empty states · narrow · no active project. Exports to `home.png`. |

**Panels:** A the door · 1 populated · 2 Watching · 3 the all-empty page · 4 both
empty states · 5 narrow (`< md`) · **6 no active project** (added by MOTIR-2761).

---

## ⚠️ Scope — the ACTIVE PROJECT (revised 2026-08-17, MOTIR-2761)

**`/home` reads the active project, exactly like `/items`, `/ready` and
`/boards`.** This asset drew it **workspace-scoped**, and that was the defect
MOTIR-2761 fixed rather than a preference someone changed.

MOTIR-2649 settled the scope from external precedent — Jira Cloud "Your work",
Linear Inbox, Plane Home. The research was real and correctly summarised, and it
was applied one level too shallowly: **in all three products that surface sits
ABOVE the project selector.** Its scope is cross-project because its _placement_
is cross-project; they are one decision. Motir imported the scope and then
MOTIR-2654 put Home **first in the PROJECT tier of the rail** — `SidebarNav`'s
primary section is built inside `if (hasProject)` — directly under the
`org › workspace › project` switcher the shell renders on every authed page. The
shipped result was a switcher that did nothing on the first screen a new user
ever sees, with a passing E2E test asserting exactly that.

Three consequences for this asset, all drawn:

1. **No `Project` column**, in any panel. Every row is in the active project,
   which the switcher two rows above already names.
2. **The subtitle names the PROJECT**, not the workspace.
3. **A no-project state exists** — Panel 6 — which a workspace-scoped surface
   did not need.

**What did NOT change:** the row's other cells, the tab strip, the two empty
states, the narrow collapse, the agent badge, and the post-auth landing. The
cross-project question — _"what is on me across this whole workspace"_ — is
**retained**, at the workspace tier, as **MOTIR-2920**; it is a different
surface, not this one. `docs/decisions/home-scope.md` is the record.

---

## ⚠️ What is NOT on this page

This asset was **revised on 2026-08-11 (Yue)** and the revision is a removal, so
it belongs at the top rather than in a footnote. The first revision drew a page
of four surfaces. Two are gone:

- **Needs you** — a second mount of the notification stream. Removed as a
  **duplicate**: the bell drawer is already the notification surface, it is on
  every page, and it carries the unread badge. A copy on Home would not be more
  access to notifications; it would be two things to keep in agreement and a
  second answer to "where do I read these". If notifications ever outgrow a
  drawer, that is a change to the drawer.
- **Quick links** — user-pinned shortcuts. Removed with **MOTIR-2652**, which is
  archived. It was the only part of the story that needed a table, bought for
  shortcuts to pages the nav already reaches.

**The asset was redrawn rather than annotated.** A design asset is normally a
record of the moment it was drawn and is not chased back into line when the
product moves — but that rule is about shipped COPY drifting under a merged
asset. This one is **unmerged**, and its entire job is to gate MOTIR-2653; an
asset drawing two surfaces the product has decided not to build would mislead
the one card that reads it.

**So the page is a LIST.** Two tabs over one list, and nothing beside it. That is
the whole shape, and several things below got simpler because of it — the layout
question, the empty-state composite, and the narrow band each had a decision in
them that no longer exists.

---

## The asset is the app's own markup, not a redraw

Every element on this page already ships. Rather than re-draw them, the mock was
composed from the **real components' own emitted markup**, dumped through the
repo's vitest + RTL setup (`renderWithIntl(<Component/>)` →
`container.innerHTML`) and pasted in verbatim:

| Element                                   | Dumped from                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| the work-item row + its cells             | `app/(authed)/items/_components/IssueListTable.tsx` (via `issueColumns`) |
| the sidebar rail                          | `app/(authed)/_components/SidebarNav.tsx`                                |
| `EmptyState` · `Card` · `Button` · `Pill` | `@motir/design-system` (the `components/ui/*` shims)                     |

The stylesheet inlined in the mock is **Tailwind's real output for that file**,
compiled from `app/globals.css`'s own `@import 'tailwindcss'` +
`@motir/design-system/theme.css` — so the token layer is the shipped one
byte-for-byte, not a hand-copied block. A reviewer diffing a row in the mock
against a screenshot of `/items` sees the same cells, and the asset cannot drift
from the running UI (the MOTIR-1196 failure this rule exists for).

The tab strip is the shipped **link-based Segmented** from
`app/(public)/_components/PublicTabNav.tsx` — chosen over the client `Segmented`
because the selected tab must live in the URL (below).

---

## Where it lives, and how it is reached

A new authed route **`app/(authed)/home/page.tsx`** (Server Component), rendering
inside the shipped shell (`AppLayout`: top nav, the 240px rail, `<main id="main">`
with `px-4 py-6 sm:px-6 lg:px-8`). It resolves the session and the **ACTIVE
PROJECT** — `getActiveProject()`, the same resolver `/items`, `/ready` and
`/boards` use — and calls `homeService` with it (§Scope; MOTIR-2761).

**Two doors, both drawn in Panel A:**

1. **The rail.** A **Home** entry, lucide `House`, as the **FIRST** primary nav
   item, **above Dashboard**, in `SidebarNav`'s existing item grammar
   (`--height-control` row, `--radius-control`, the glyph slot,
   `--el-sidebar-item-bg-active` + `--el-icon-active` when current). `/dashboard`
   keeps its route **and its own entry**, one row below — nothing is re-homed.
   The `<md` drawer renders the same `SidebarNav`, so it inherits the entry for
   free.
2. **The post-auth landing.** Signing in with no `?next=` lands on `/home`
   (MOTIR-2654 moves the `callbackURL` default). `?next=` still wins; the
   `draftId → /onboarding` branch is untouched. **Unchanged by MOTIR-2761** —
   including for an actor with no project, who lands on Panel 6 rather than being
   branched away by the auth page (`docs/decisions/home-scope.md` §2.3).

**And with NO active project, there is NO rail row — Panel 6.** The `!hasProject`
duplicate Home entry MOTIR-2654 added is deleted: it justified itself by _"Home is
workspace-scoped: it works with no project"_, the property §Scope removed. Home is
now correctly absent there alongside every other primary entry, so `/home` is only
ever LANDED on — which is why its no-project state is the **create-first door**
(the shipped `ProjectsEmptyState`, reused from `/dashboard`) rather than the
actionless `noProject` notice `/ready`, `/items` and `/boards` show.

The halo around the Home entry in Panel A is **review decoration** — it is not
part of the design.

---

## Layout — one column, and the column set is the real decision

With no widgets, "where do the widgets go" is not a question this asset has to
answer. What it does have to answer, and what MOTIR-2653 must not re-decide, is
**which columns the row carries** — because the shipped `/items` row does not fit
and never did.

### Measurements (taken in Chromium against this mock, not asserted)

The shipped `/items` row is a nine-column grid:

```
minmax(10rem,1fr) 116px 120px 150px 150px 72px 80px 108px 76px
gap-x-4 (8 gaps × 16) · pl-4 (16) · pr-7 (28)
```

→ **its minimum width is 1204px.** Content width available to a page in the
shell is `viewport − 240 (rail) − 64 (lg:px-8)`:

| viewport | content available | shipped 9-col row (needs 1204) |
| -------- | ----------------- | ------------------------------ |
| 1200     | **896**           | ✗ clips                        |
| 1280     | **976**           | ✗ clips                        |
| 1440     | 1136              | ✗ clips                        |

So Home cannot render the full `/items` column set at any common laptop width.
(Nor can `/items` — that is the known MOTIR-1307 clipping; Home must not inherit
it.)

**Home's column set — the same cells, a Home-specific set:**

```
Title (minmax(10rem,1fr)) · Your role (96) · Assignee (140) · Status (108)
```

→ minimum **622px**; measured title track **440px** at the 1200 viewport, 520 at
1280, 680 at 1440. Rows stay the shipped 44px. _(Was five columns with `Project`
at 116px and a 754px minimum, until MOTIR-2761 — §Scope.)_

**What was dropped, and why.** `Reporter` (on a list defined by _you are the
assignee or the reporter_, a Reporter column answers a question the list has
already answered — "Your role" carries it), `Est.`, `Points`, and the trailing
row-actions `⋯` (the whole-row link + the `?peek=` quick view are the two
affordances Home needs; bulk actions belong on `/items`).

**What was added.** `Your role` — see below. _(`Project` was also added, and
REMOVED again by MOTIR-2761: it existed because Home spanned projects, and once
the surface reads the active project every row would repeat the value the
switcher two rows above already names.)_

---

## The one cell that only exists here

### `Your role` — "Assigned" · "Reported" · "Both" (and "Watching" on tab 2)

Plain `text-xs` in `--el-text-secondary`; the **`Both`** value takes
`--el-text-strong` + `font-medium` as a non-colour cue (finding #35 — never
colour alone).

This cell exists because of the story's central decision: assigned and reported
are **merged into one list**. That merge is what creates the dedupe requirement,
and this is the only place a human can see it hold — row 1 of Panel 1 reads
`Both` and appears **once**. It is partially derivable from Assignee (a row
assigned to someone else is one you reported), but a column that is usually
derivable and never wrong is cheaper to read than a rule the reader has to apply
per row — and the one case it is _not_ derivable, `Both`, is the case the story's
E2E asserts numerically.

On the **Watching** tab the same cell distinguishes watch-only (`Watching`) from
watch-and-own (`Both`), which is why an item can legitimately appear in both
tabs. Watching is a different audience, not a partition of My work.

---

## The agent state — a row-level state, never a section

An item with `executor: coding_agent` renders **in My work like any other row**.
There is no agent section, no agent widget and no agent tab anywhere in this
asset; the human assignee still answers for the item, so it belongs in that
human's list.

**How the row shows it:** the assignee's avatar carries a **glyph badge** — the
same avatar-with-badge composition the shipped `NotificationRow` uses:

```html
<span class="relative shrink-0">
  <span
    class="inline-flex h-[22px] w-[22px] … rounded-full bg-(--el-text) text-(--el-text-inverted)"
    >Z</span
  >
  <span
    class="absolute -right-0.5 -bottom-0.5 inline-flex h-3.5 w-3.5 items-center justify-center
               rounded-full bg-(--el-executor-agent) text-(--el-accent-text) ring-2 ring-(--el-page-bg)"
  >
    <Bot class="h-2.5 w-2.5" />
  </span>
</span>
<span class="sr-only">An agent is executing this item</span>
```

The glyph is lucide **`Bot`** — the same glyph the shipped `ExecutorIndicator`
(`CoreFieldsPanel`, `IssueQuickViewPanel`) already uses for
`executor: coding_agent`, so the row and the detail rail agree. The badge is
`aria-hidden`; the `sr-only` span carries the meaning (a decorative glyph never
carries text meaning).

### ⚠️ ONE TOKEN MOTIR-2653 MUST ADD

`--el-executor-agent` does not exist in `packages/design-system/theme.css`. Add
it to the Tier-3 block, next to the `--el-notif-*` set, whose form it copies:

```css
--el-executor-agent: var(--color-primary-fill); /* the accent fill, decoupled so a
                                                   palette can move agent badges
                                                   without dragging the CTA */
```

This is the `--el-notif-*` precedent from MOTIR-1274 exactly: same resolved hue
as `--el-accent` today, its own slot so it is independently swappable. The mock
declares the same line in its review-chrome block so it renders standalone —
**do not** ship the badge against a raw hue or against `--el-accent` directly.

---

## The tab strip

The link-based Segmented (`PublicTabNav`'s markup): an `--el-tabnav-track` track
at `--radius-btn` with a `p-0.5` inset; each tab an `<a>` at `--height-control`,
`--radius-control`, `--spacing-control-x`, `text-[12.5px] font-medium`. The
active tab takes `--el-page-bg` + `--shadow-subtle` + `--el-text-strong` and its
glyph `--el-tabnav-active`; the inactive one `--el-text-secondary` with an
`--el-text-faint` glyph.

- **Copy:** `My work` (lucide `CircleDot`) · `Watching` (lucide `Star`).
- **Counts** ride each tab as the shipped board count badge
  (`bg-(--el-count-bg)` / `text-(--el-count-text)`, `--radius-badge`,
  `h-[18px] min-w-[20px] text-[11px] font-semibold`).
- **The selection is a URL, not component state** — `/home` and
  `/home?tab=watching` are real hrefs with `aria-current="page"`. A reload stays
  on the tab and the tab is linkable; that is also why the link form was chosen
  over the client `Segmented`.
- **Both counts are suppressed when the page is empty** (Panel 3). A `0` beside a
  tab is noise a brand-new user has to parse.

It is now the **only control on the page**, which is worth knowing at the narrow
band (below).

---

## Empty states — Panels 3 and 4

The composite-empty problem this asset was originally drawn to solve no longer
exists: with four surfaces there were four nothing-yet states on one screen, and
somebody had to design the whole. With two tabs there is exactly one empty
visible at a time, so each is simply the full-page `EmptyState` primitive.

- **My work · empty** — lucide `CircleCheck`, _"Nothing is waiting on you"_,
  _"Work you are assigned or filed will show up here. Pick something up from
  Ready to get started."_ + a secondary `Button` → **`/ready`**.
- **Watching · empty** — lucide `Star`, _"You are not watching anything"_,
  _"Watch an item from its detail page to follow it without owning it."_ **No
  action** — there is no button that would make you start watching something, so
  it offers none rather than inventing one.

Both render at full page scale (`h-12` glyph, `text-xl` serif title,
`--el-text-subtitle` body) — the `EmptyState` primitive's own markup, unchanged.
The tab strip stays above them; it is their header, which is why neither empty
carries a card header of its own.

---

## Narrow (`< md`) — Panel 5

The rail goes off-canvas into the shipped drawer; content is `viewport − 32`
(`px-4`). At 420px that is **388px**, and a five-column grid cannot survive it.

**The row COLLAPSES to two lines rather than clipping.** Line 1: type glyph +
mono key + title. Line 2, indented to the title and wrapping: the role, the
assignee (avatar + name, **agent badge intact**), the status chip. The row grows
44px → ~60px. The whole-row stretched link is unchanged.

The **tab strip keeps its counts and does not shrink** — it is how the reader
switches audience, and with the widgets gone it is the only control on the page,
so there is nothing to trade it against.

---

## Page header

The `/items` · `/ready` page-header grammar:

- `h1` — `font-serif text-2xl font-semibold text-(--el-text)` reading **"Home"**.
- Subtitle — `text-sm text-(--el-text-muted)` reading **"Everything in {project}
  that is waiting on you."** The noun is the **project**, matching the switcher
  directly above it in the shell. _(It read "across {workspace}" until
  MOTIR-2761 — §Scope. The key keeps its name, `home.subtitle`, in both
  catalogues; only its placeholder and copy change, so parity holds.)_

No count chip beside the title: the tabs carry the counts, and a third number
would be a fourth thing to reconcile.

---

## Token map

| Element                           | Colour                                                                                                                               | Shape                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| page `h1` / subtitle              | `--el-text` / `--el-text-muted`                                                                                                      | —                                                                                              |
| tab track / active tab / inactive | `--el-tabnav-track` · `--el-page-bg` + `--el-text-strong` · `--el-text-secondary`                                                    | `--radius-btn` (track) · `--radius-control` (tab) · `--height-control` · `--spacing-control-x` |
| tab glyph active / inactive       | `--el-tabnav-active` / `--el-text-faint`                                                                                             | —                                                                                              |
| tab count badge                   | `--el-count-bg` / `--el-count-text`                                                                                                  | `--radius-badge` · `--spacing-chip-x`                                                          |
| list container                    | `--el-border`                                                                                                                        | `--radius-card`                                                                                |
| column header strip               | `--el-surface-soft` / `--el-text-secondary`                                                                                          | 40px                                                                                           |
| row · row hover                   | `--el-border` (rule) · `--el-surface` (hover)                                                                                        | 44px · `pl-4 pr-7` · `gap-x-4`                                                                 |
| type glyph                        | `--el-type-{epic,story,task,bug,subtask}`                                                                                            | `h-4 w-4`                                                                                      |
| identifier                        | `--el-text-muted`, `font-mono text-xs`                                                                                               | —                                                                                              |
| title                             | `--el-text`                                                                                                                          | truncate                                                                                       |
| Your role · `Both`                | `--el-text-secondary` · `--el-text-strong` + `font-medium`                                                                           | `text-xs`                                                                                      |
| avatar                            | `bg-(--el-text)` / `--el-text-inverted`                                                                                              | `rounded-full` 22px                                                                            |
| **agent badge**                   | **`--el-executor-agent`** / `--el-accent-text`, `ring-(--el-page-bg)`                                                                | `rounded-full` 14px                                                                            |
| status chip                       | `Pill` tones — `--el-tint-sky` (in progress / in review), `--el-tint-mint` (done), `--el-chip-bg` (to do), all on `--el-text-strong` | `--radius-badge`                                                                               |
| unassigned                        | `--el-text-muted`                                                                                                                    | —                                                                                              |
| empty-state glyph / title / body  | `--el-icon-muted` · `--el-text` (serif) · `--el-text-subtitle`                                                                       | `--radius-card` · `--spacing-card-padding`                                                     |
| rail Home entry (active)          | `--el-sidebar-item-bg-active` · `--el-text` · `--el-icon-active`                                                                     | `--radius-control` · `--height-control`                                                        |

**AA:** `--el-text-faint` appears only on `aria-hidden` glyphs.
`--el-text-muted` appears only on the white page/card surface, never on
`--el-surface` / `--el-muted` (the CLAUDE.md contrast table).

---

## What this asset does NOT decide

- **Ordering** of My work / Watching. MOTIR-2651 owns it and specifies
  updated-desc with a total, stable tiebreak; nothing here overrides that.
- **The paging affordance** — the mock shows one page. MOTIR-2651's reads are
  cursor-paged and hand back an opaque `nextCursor`; MOTIR-2653 picks the control
  (the shipped `IssueListPager` is the obvious reuse) and keeps the cursor in the
  URL beside `?tab=`.
- **Where a newly signed-up user lands** — MOTIR-2654 decides and justifies it,
  and MOTIR-2921 corrects sign-UP's divergent `/dashboard` default. Not this
  asset's call either way.
- **The cross-project "my work" surface** — retained at the workspace tier as
  MOTIR-2920 (`docs/decisions/home-scope.md` §3). It will have its own design
  area; nothing here draws it.

## Context refs

- `app/(authed)/items/_components/` — `IssueListTable`, `issueColumns`,
  `issueCellPrimitives` (the row and every cell reused here).
- `app/(authed)/_components/SidebarNav.tsx` — where the Home entry goes.
- `app/(public)/_components/PublicTabNav.tsx` — the link-based tab strip.
- `components/ui/AppLayout.tsx` · `app/(authed)/layout.tsx` — the shell geometry
  the measurements above come from (240px rail; `px-4 py-6 sm:px-6 lg:px-8`).
- `packages/design-system/theme.css` — the Tier-3 block `--el-executor-agent`
  must be added to.
- `design/ready/` · `design/reports/` — the three-file convention and PNG render
  settings this asset follows.
