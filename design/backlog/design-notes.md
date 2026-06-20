# Backlog — design notes

Design reference for the `backlog` UI area — the Jira-style **Backlog /
sprint-planning** screen (Story 4.2). The asset is the source of truth for every
UI subtask in Story 4.2 (4.2.3 / 4.2.4 / 4.2.5), which each carry **4.2.1** in
`dependsOn`. Built FROM the real design system (`app/globals.css` `--el-*` /
shape tokens + the shipped `components/ui/*` and issue-list primitives), so the
code subtasks compose the same primitives — no Pencil→code gap.

| Surface                                | Asset                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backlog / sprint-planning screen**   | **`backlog.mock.html`** (HTML mockup)        | The whole net-new surface — `design/` had no `backlog/` area; the 4.2.1 design gate produces this. Multi-panel: layout+nav · sprint container · issue row · drag · multi-select · context menu · states. Gates 4.2.3–4.2.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Backlog at scale**                   | **`backlog-scale.mock.html`** (HTML mockup)  | The large-backlog shape (finding #57) — bounded count header + virtualized window + lazy-load on scroll. NEVER load-all. Gates 4.2.3's scale AC + the 4.2.6 at-scale E2E.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Backlog filtering (toolbar Filter)** | **`backlog-filter.mock.html`** (HTML mockup) | EXTENDS the backlog surface — wires the permanently-DISABLED `[Filter]` seam (`page.tsx:83-90`, tooltip `filterComingSoon`) into a working backlog filter. The backlog's filter was deferred to Epic 6, but Epic 6 only ever wired the BOARD filter (Story 6.15) — an orphaned deferral, so Subtask 8.8.16 picks it up. REUSES the shipped /issues filter primitives verbatim (`IssueFilterBar` quick popover incl. the shared Work type facet · `IssueAdvancedFilter`/`FilterConditionBuilder` builder · `SavedFilterDropdown` + `IssueAppliedFilterBar` picker + applied name-chip) — anchored on the backlog page-head toolbar, backlog-scoped + URL-addressable + saved-filter capable, exactly as the board did. CHROME over the reused backlog — does NOT redraw the sprint containers / ranked rows / drag / seams. Multi-panel: closed · quick-Filter popover open (incl. Work type) · Saved dropdown open · active (re-projected sprint containers AND backlog, an all-filtered-out sprint showing its empty placeholder) · filtered-EMPTY · loading. "View all issues" carries the active filter into /issues. Gates the 8.8.18 frontend wiring. See "Backlog filtering (Subtask 8.8.16)" below. |

The Backlog is a NEW nav destination (`/backlog`, project-scoped) and a NEW
design area (`design/backlog/`). It is **almost pure frontend**: the data
substrate — the `Sprint` entity + CRUD (4.1.3), the issue↔sprint association +
`backlog_rank` writes + the **bounded, cursor-paginated** `getBacklog` /
`getSprintIssues` reads (4.1.4) — is shipped by Story 4.1, and 4.2 BINDS to it.
The only net-new backend is one thin composition subtask (4.2.2: atomic **bulk**
assign + create-into-sprint). Mirror product: **Jira backlog / sprint-planning**.

## This surface REUSES existing vocabularies (reference, don't redraw)

- The issue **ROW** reuses the Story-2.x work-items list row
  (`design/work-items/list.mock.html`): the `IssueTypeIcon` in its `--el-type-*`
  hue · the mono key · the summary · the epic chip · the assignee `Avatar` · the
  status `Pill`. The asset draws the NET-NEW composition (the horizontal row with
  the drag handle + selection affordance + reserved estimate seam + `⋯` menu),
  not the primitives.
- The **DRAG** affordance reuses the Story-3.2 board drag vocabulary
  (`design/boards/board.mock.html`): the `grip` handle, the tilted `DragOverlay`
  clone, the dashed 40%-opacity ghost left in place, the drop-target ring +
  lavender tint, the insertion bar. Same `@dnd-kit/core` + `@dnd-kit/sortable` +
  `boardMove.ts` move contract; same `useRowWindow` virtualization (3.2.5).
- The **empty / loading / error** states reuse the shipped `EmptyState` /
  `ErrorState` / skeleton idioms (the 3.2.2 board scaffold).

## The asset is multi-panel (review EACH)

`backlog.mock.html`: **(0)** page layout + nav · **(1)** sprint-planning
container anatomy + empty sprint + Create-sprint · **(2)** issue row anatomy
(reserved estimate seam) · **(3)** drag states (single overlay + drop highlight +
insertion bar + multi-select "N issues" stack) · **(4)** multi-select +
bulk bar · **(5)** `⋯` context menu (+ Move-to-sprint submenu) · **(6)** states
(empty backlog · no sprints · loading · error).

`backlog-scale.mock.html`: **(0)** bounded virtualized backlog (count header +
windowed rows + lazy-load sentinel) · **(1)** lazy-load states (fetching next
page vs. all loaded).

---

## The SEAMS (the load-bearing scope decision — mistake #32 resolution)

Story points are Story **4.3** and velocity is Story **4.6**, both numbered
AFTER 4.2 — wiring 4.2 to READ them would be a forward-pointing dependency (the
mistake-#32 smell). So those concerns are **re-owned, not cut**: 4.2 renders
**documented, RESERVED seam slots** that the later stories fill, drawn as dashed
empty slots. In the mockups each seam carries a dotted-accent **review-only**
`seam-tag` naming the filling story (like `board.mock.html`'s `.virt-note`, the
tag is an annotation, **NOT shipped**). A future coding agent must NOT improvise
the seams — they are filled by the owning story:

| Seam                         | Where                           | Filled by                                                        |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| **Row estimate slot**        | each issue row, before assignee | **Story 4.3** (inline-editable estimate badge)                   |
| **Committed-points slot**    | each sprint container header    | **Story 4.3** (per-sprint roll-up — "roll-ups to sprint + epic") |
| **Velocity slot**            | each sprint container header    | **Story 4.6** ("committed vs velocity" comparison line)          |
| **Start-sprint entry point** | each planned sprint header      | **Story 4.4** (the start FLOW — 4.2 mounts the entry point only) |

The estimate slot is drawn in a **fixed slot order** so 4.3 drops a number in
with **no relayout**. This is the exact seam pattern Story 4.5 used to leave the
burndown chart to 4.6. Every `dependsOn` in Story 4.2 points backward (Story 4.1)
or sideways (a 4.2 sibling) — the forward audit passes.

---

## Where it lives

A new project-scoped route **`app/(authed)/backlog/`** (the active project from
the shell context, like `/boards`). A new **Backlog** item in `SidebarNav`
(adjacent to Boards, before Reports) with a **layout-list** glyph + an
`AppCommandPalette` ⌘K entry, both keyed `nav.backlog` (every shipped locale gets
a value). No other nav change. The page stacks two regions:

- **Top — sprint-planning containers** (zero or more), each a collapsible panel.
- **Bottom — the Backlog container** — the ranked unassigned issues
  (`sprint_id IS NULL`, in `backlog_rank` order).

Both regions hold the SAME issue-row component (one global `backlog_rank`), so a
row drags between them.

## "View all issues" — the issue-navigator affordance (mirror rung 1)

The page-head **toolbar** (right side, beside the disabled `[Filter]` seam +
`[+ New issue]`) carries a **View all issues** link (external-link glyph).

**Mirror product = Jira's "View in Issue Navigator"** (decision-ladder rung 1;
VERIFIED June 2026, Atlassian support/community — checked, not asserted, per
`notes.html` mistake #33): the Jira backlog/board does NOT flatten the grouped
planning view into an "all issues" list on the same page — it provides a link
that opens the **issue navigator** (the all-issues search/list view) with the
board's filter applied, so you can see every issue across the backlog AND all
sprints in one sortable/filterable list. Motir already ships that navigator —
the **Story-2.5 `/issues` List/Tree view** (every project issue, sortable +
filterable + server-paged) — so the backlog does NOT rebuild a flat list; it
**deep-links out to it**. (This is exactly why "see all issues from the
backlog/sprint" is the existing `/issues` navigator reached from `/backlog`, not
a new flat panel — building one here would be "complexity for nothing" against
the mirror.) The affordance is project-scoped; when Epic-6 board/saved filters
land, the link can carry the active filter query (the Jira behaviour), the same
way the disabled `[Filter]` seam reserves that surface.

**Code:** 4.2.3 wires the toolbar link to `/issues` (the active project's
navigator). A plain `<a>`, no new view — the navigator is Story 2.5.

## Sprint-planning container anatomy (panel 1)

A collapsible `<section aria-label="{name}, {state}, {n} issues">`:

- **chevron** — collapse / expand (persists client-side; rotates −90° collapsed).
- **name + state `Pill`** — Planned (lavender tint) · Active (sky) · Completed
  (mint); dot + text, never colour-alone (finding #35).
- **date range** — the sprint window (`Jun 16 – Jun 30`, calendar glyph), or
  `Not started` for a planned sprint with no dates.
- **issue count** — the bounded count badge (from the projection, not a
  loaded-row tally).
- **committed-points SEAM** (`--el-text-faint` dashed slot, hash glyph) → 4.3.
- **velocity SEAM** (dashed slot, gauge glyph) → 4.6.
- **Start-sprint** — a secondary `Button` (play glyph) → the flow is Story 4.4;
  4.2 mounts the entry point. **Disabled on an empty sprint** (nothing to
  commit).
- **`⋯` menu** — sprint actions (rename · edit dates · delete · start), the
  shipped dropdown `Menu`.
- the ranked **issue rows**, then an inline **+ Create issue** row (creates
  straight into this sprint — 4.2.2 `createBacklogIssue` with `sprintId`).
- **Empty sprint** → a dashed `No issues — drag from the backlog, or use + Create
issue.` placeholder.
- **Create-sprint affordance** — a dashed full-width button below the sprint
  stack; adds an empty planned sprint (4.1.3 `createSprint`).

## Backlog container

The bottom region: the count header (`N issues` — the **bounded** count, not a
loaded-row tally), the ranked rows, and the inline **+ Create issue** row
(creates into the backlog, rank-appended).

## Issue row (panel 2) — reuses the work-items list-row vocabulary

A `role="row"` div with **sibling** controls (no nested interactive elements —
the 2.5.19 stretched-link contract / finding #35). **Slot order, left → right:**

`grip · checkbox · type icon · key · summary (flex, truncate) · epic chip ·
estimate SEAM · assignee · status Pill · ⋯`

- **grip** — the drag handle (revealed on hover; the row is the drag target, the
  grip the cue) — the 3.2 board grip.
- **checkbox** — the selection affordance, **keyed by issue id** so selection
  survives lazy-load + virtualized scroll; checked → `--el-accent` fill + check.
- **type icon** — `IssueTypeIcon` in its `--el-type-*` hue.
- **key** — the mono identifier, `--el-text-muted`.
- **summary** — the title, single-line truncate (`min-w-0`, ellipsis), flexes to
  fill (pushes the trailing metadata cluster right, Jira-style).
- **epic chip** — a neutral pill: a small epic `zap` glyph (epic hue) + mono epic
  key + truncated epic title.
- **estimate SEAM** — a RESERVED slot (→ Story 4.3), in a fixed place so 4.3 drops
  a number in without a relayout.
- **assignee** — initial-letter `Avatar` (dashed circle when unassigned).
- **status Pill** — the lifecycle tone (To do · In progress · Done): dot + text,
  hue in the tint with `--el-text-strong`, AA-safe (finding #35).
- **`⋯` menu** — the per-row context menu (panel 5).

The row is **identical in the backlog and inside sprint containers** — one
global `backlog_rank`, so a row drags between regions unchanged.

## Drag states (panel 3) — reuse the 3.2 board drag contract

Three moves, all on the SAME `@dnd-kit` move contract + `useRowWindow`
virtualization the board ships:

- **Reorder within a region** → 4.1.4 `rankIssue` — a single-row `keyBetween`
  write between the drop neighbours (never an N-row renumber); the **insertion
  bar** (3px accent pill) marks the drop position.
- **Drag backlog → sprint** / **sprint → sprint** → 4.1.4 `assignToSprint`
  (single); the **target sprint container** shows the accent ring + the lavender
  tint on its header + a "Drop to add to this sprint" cue.
- **Drag sprint → backlog** → 4.1.4 `moveToBacklog` (reappears in `backlog_rank`
  order).

The **source** leaves a dashed 40%-opacity ghost in place; a tilted `DragOverlay`
clone follows the cursor (accent border, `--shadow-elevated`). **Multi-select
drag** lifts ONE stacked overlay with an accent **N** count badge and routes
through the atomic bulk path (4.2.2), not N moves. Drop affordances pair the
tint with a **ring + insertion bar** — redundant cues, never colour-alone
(finding #35). Moves are **optimistic with snap-back** on write error (the 3.2
board contract); counts update with the move. Drag is **keyboard-operable**
(dnd-kit keyboard sensor) with an `aria-live` region (the panel shows a sample
announcement). Drag composes with the virtualized list: the dragged node stays
attached when it scrolls out of the window, and a drop into a not-yet-loaded
region resolves to a rank-append — no load-all forced (finding #57).

## Multi-select + bulk bar (panel 4)

The Jira selection model: **click** selects · **shift-click** the range ·
**⌘/ctrl-click** toggles one. Selected rows carry the lavender tint **and** the
checked box (never colour-alone). A **selection bar** shows `N selected` + bulk
**Move to sprint ▸** (a submenu of the project's sprints) + **Move to backlog** +
**Clear**. Bulk actions call 4.2.2 `bulkAssignToSprint` / `bulkMoveToBacklog` as
**ONE atomic transaction** (not a client loop) — the whole selection moves or
none does; optimistic with snap-back; counts update; selection clears on success.
Selection is keyed by issue id, so it survives lazy-load + virtualized scroll.
The bulk bar uses the `--el-accent` surface with white-surface controls (AA-safe).

**Bulk actions are CONTEXTUAL to the selection's current origin** (behaviour spec,
not a layout change — `bug-backlog-selection-bar-move-to-backlog-always-shown`;
Jira rung 1 scopes bulk actions to where the selection lives). **Move to backlog**
is hidden when every selected item is already in the backlog; **Move to sprint ▸**
is hidden when every selected item is already in the SAME sprint — each move would
otherwise be a no-op. A mixed selection (spanning the backlog and/or ≥2 sprints)
shows both. This mirrors the `⋯` context menu (panel 5), which already only offers
**Move to backlog** for a row that lives in a sprint.

## Context menu (`⋯`, panel 5)

The shipped dropdown `Menu` primitive (no nested buttons, no hand-rolled
popover), keyboard-operable:

- **Move to sprint ▸** — a submenu of the project's sprints (each row a state-dot
  - name; the current sprint check-marked; a **New sprint…** action at the foot).
- **Move to backlog**.
- **Move to top / bottom of backlog** — rank to the boundary via 4.1.4
  `rankIssue` append/prepend.

The estimate/points seams the later stories add are NOT in this menu.

## States (panel 6) — completeness, not the happy path only

- **Empty backlog** → `EmptyState` (inbox, "Backlog is clear", create CTA).
- **No sprints planned** → the Create-sprint affordance only, over the backlog.
- **Loading** → a backlog skeleton (the 3.2.2 scaffold idiom — pulsing rows).
- **Error** → `ErrorState` (rotate glyph, "Couldn't load the backlog", Retry).

## Scale — bounded, virtualized, lazy-load (`backlog-scale.mock.html`, finding #57)

A real backlog is thousands of issues, so the list is **NEVER load-all**:

- Binds to 4.1.4's cursor-paginated `getBacklog(projectId, { cursor, limit })`.
- The header **count** is the aggregate total (`1,284 issues`) — the bounded
  count, **not** a loaded-row tally.
- Only the rows in (or near) the viewport mount — the `useRowWindow` window
  (3.2.5) keeps the DOM bounded; a spacer preserves scroll height. The windowing
  is **invisible** (documented via the review-only `.virt-note`, not shipped).
- **Lazy-load on scroll**: a bottom sentinel fetches the next cursor page and
  appends. While a page is in flight an in-flow **spinner + "Loading more…"**
  shows; a failed page leaves a focusable inline retry; when the cursor is
  exhausted a quiet **"All N issues loaded"** end-cap replaces the sentinel.
- Reordering / assigning stay **O(1) single-row** (or bounded bulk) writes
  against the fractional index. A drop into a not-yet-loaded region resolves to a
  rank-append. Sprint containers bind to `getSprintIssues` (also paged-capable)
  with the same shape.

A backlog UI that fetched every row to render the list, or summed every loaded
card, would be prototype-thinking — forbidden (finding #57).

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the issue-type hues, the `Pill`
  status tones, the lavender drop/selection tint, the accent on the bulk bar +
  insertion bar + selection check. Tints carry the hue in the BACKGROUND with
  `--el-text-strong` text (finding #35, AA — never a tinted page surface). The
  reserved seams are `--el-text-faint` dashed slots.
- **Shape** via element-semantic tokens (`--radius-card` containers/menus,
  `--radius-btn` buttons, `--radius-input` controls, `--radius-badge` pills/chips,
  `--radius-control` menu rows / icon buttons, `--shadow-subtle`/`-card`/
  `-elevated`, `--spacing-card-padding`/`-chip-*`/`-control-*`, `--height-control`/
  `-btn-md`) — so the backlog re-shapes under `data-display-style`.
- **Not colour-alone** (finding #35): the status pill pairs the dot with text;
  selected rows pair the tint with the checked box; drop targets pair the tint
  with a ring + insertion bar; the multi-select drag overlay pairs the stack with
  the **N** count badge. The backlog + each sprint container are labelled
  landmarks; counts read as text; drag is keyboard-operable with `aria-live`
  announcements; the `⋯` menu + Move-to-sprint submenu are keyboard-operable.

## Out of scope (documented extension slots)

- **Story-point estimation** + the inline-estimate badge + the committed-points
  roll-up that fills the estimate / points seams — **Story 4.3**.
- The **velocity** "committed vs velocity" comparison that fills the velocity
  seam — **Story 4.6**.
- The sprint **Start / Complete** flows + scope-lock + carry-over + sprint report
  — **Story 4.4** (4.2 mounts/seams the Start-sprint entry point only).
- The **Scrum board** view — **Story 4.5**.
- The sprint entity / association / rank writes / bounded reads themselves —
  **Story 4.1** (consumed, not built).
- Rich backlog filtering / quick filters / the filter builder / saved filters —
  was deferred to **Epic 6** (the backlog ships its data-bound list; the disabled
  `[Filter]` seam reserves it). **NOW wired by Subtask 8.8.16 / 8.8.18** — Epic 6
  only ever delivered the BOARD filter (Story 6.15), so the backlog's equivalent
  was an orphaned deferral; see "Backlog filtering (Subtask 8.8.16)" below.
  Cross-project backlogs (the backlog is single-project by 4.1's `sprint.projectId`
  model).

---

# Backlog filtering (Subtask 8.8.16) — `backlog-filter.mock.html`

Wires the backlog page-head's permanently-**disabled `[Filter]` seam**
(`app/(authed)/backlog/page.tsx:83-90` — a `disabled` `Button`, `leftIcon`
`<Filter/>`, `title={t('filterComingSoon')}`, no `onClick`, comment _"Filter is a
disabled seam here — Epic 6 wires backlog filtering"_) into a working backlog
filter. The original backlog mocks draw `[Filter]` ONLY as a disabled seam; the
COMPOSITION on the backlog — the enabled affordance, the builder + saved-picker
anchored in the page-head toolbar, the active-filter summary, the filtered +
filtered-EMPTY states, the loading state, and coexistence with the
sprint-planning containers — is net-new backlog chrome no backlog mock depicts.
Per the design gate (an element a mockup does not depict == NO design → add a
`type: design` subtask, never improvise), the 8.8.16 gate produces this; the UI
code subtask **8.8.18** `blocked_by` it.

## Why YES, wire it (the orphaned-deferral triage)

The backlog `[Filter]` is a **deliberate seam, not a stale flag and not a
defect** — but its owning work was deferred to Epic 6 and never picked up. Epic 6
only ever wired the **board** filter (Story 6.15 → `design/boards/board-filter.mock.html`,
reusing the `/issues` primitives board-scoped). The backlog's equivalent was
documented as deferred (this file's "Out of scope": _"Rich backlog filtering …
Epic 6; the disabled `[Filter]` seam reserves it"_) and **never scheduled** — an
orphaned deferral. So the answer to _"do we still need it?"_ is **YES — wire it**,
do NOT remove it.

**Mirror products (rung 1 — verified via docs, 2026-06-20).** BOTH ship working
filters on the backlog:

- **Jira** Scrum backlog has a quick-filter bar (assignee · epic · label · type ·
  custom JQL) plus saved JQL filters the board/backlog are built on.
- **Linear** Backlog is a fully filterable view like every other: one **Filter**
  button (F) → property → values → operators, URL-encoded, **persists across
  reload**, saveable as a named Custom View.

A backlog with a non-working/absent filter is a regression against both. Copy
**Linear's** model (single Filter entry, URL-addressable, persistent, saveable) —
which is exactly what Motir's shipped `/issues` + board filter already are.

## This is CHROME over the reused backlog

Exactly like `board-filter.mock.html` is chrome over the board: it does NOT
redraw the sprint-planning containers / ranked rows / drag / multi-select /
reserved seams — it adds the filter affordances to the page-head toolbar + a
summary row above the regions, and shows the regions re-projected.

## Where it lives

The `/backlog` route (`app/(authed)/backlog/page.tsx` + `BacklogContainer`).
8.8.18 drops `disabled` + the `filterComingSoon` tooltip from the existing
`[Filter]` `Button`, mounts the reused filter UI in the page-head toolbar beside
the existing **[View all issues]** link + **[+ New issue]**, and the read goes
through the 6.1 compiled predicate threaded into `getBacklog` / `getSprintIssues`.
**No new navigation wiring; no schema change.** The page-head toolbar already
exists — the design notes that, it does not draw a new entry (access path
unchanged).

## REUSE, do not redraw — the primitives this composes (8.8.18 builds with)

Every filter affordance is the SAME shipped /issues component the board already
reuses — there is **no hand-rolled backlog-specific filter UI**:

- **`IssueFilterBar`** — the quick-filter popover (`[Filter]` trigger →
  `Popover`/`role="dialog"`): a text quick-filter + the **Kind / Work type /
  Status / Assignee** multi-select listboxes (`role="listbox"
aria-multiselectable`, each option a `role="option"` row with a leading glyph —
  `IssueTypeIcon` in the kind hue / `WorkItemTypeIcon` in the work-type hue /
  status dot / `Avatar` — and a trailing accent `Check`), plus the header
  **Clear filters**. The **Work type** facet is the one 6.15.5 added to the
  SHARED bar, so the backlog inherits it for free (no net-new facet here — unlike
  6.15). The popover SCROLLS at a fixed `max-height`; Status / Assignee sit below
  the fold. (See `design/work-items/filter.mock.html`.)
- **`IssueAdvancedFilter` / `FilterConditionBuilder`** — the `[Advanced]` builder
  trigger (`i-funnel-plus`), for the structured 6.1 condition builder. (See
  `design/work-items/filter-builder.mock.html`.)
- **`SavedFilterDropdown`** — the `[Saved]` dropdown picker (`role="listbox"`):
  **Starred → My filters → Project filters → Defaults**, server-backed search, a
  per-row **star toggle** (a SIBLING `<button>` in the option row — never nested
  inside the option), owner/visibility hint (`i-users` shared · `i-lock` private ·
  "Built-in"), and a "View all filters" foot. (See
  `design/work-items/saved-filters.mock.html`.)
- **`IssueAppliedFilterBar`** — the applied-filter **summary row** between the
  toolbar and the regions: the lavender **name-chip** (`i-bookmark` + visibility
  glyph; clicking it reopens `[Saved]`) + the condition **`sum-chip`s**
  (`<strong>` field + operator + value) + **Clear** + a match-count
  (`role="status"`).

## The trigger states (identical to /issues + board)

- **Inactive** — plain toolbar `Button` (the seam's label/icon, now enabled).
- **Active** — `--el-accent` border + `--el-tint-lavender` fill + accent icon +
  the **count badge** (`.tb-count`, `--el-accent` fill, `--el-accent-text`) = the
  number of active filter values. AA: the badge text is `--el-accent-text` on
  `--el-accent`; the button label stays `--el-text`.
- **Open** — `aria-expanded="true"` on the trigger; the popover/menu is an
  elevated `--shadow-elevated` card anchored under it.

## URL-driven, backlog-scoped state (8.8.18)

The active filter lives in the **URL** — a `?filter=` AST param and/or a
saved-filter id — so it is shareable + reload-safe (the Linear behaviour). The
regions re-project server-side; the UI waits on the read response before
asserting rows (never races the optimistic UI — CLAUDE.md). The filter
**AND-composes WITH** a sprint's scope — it narrows WITHIN each region, never
widens (a sprint container shows only its matching rows; the backlog region only
its matching rows).

## "View all issues" carries the active filter (the Jira behaviour)

The existing **View all issues** link (Jira's "View in Issue Navigator")
**carries the active filter query** into `/issues` when a filter is applied
(`/issues?filter=…`). The backlog design-notes already anticipated this: _"when
Epic-6 board/saved filters land, the link can carry the active filter query (the
Jira behaviour)"_ — 8.8.16 realizes it.

## Panels (review EACH, not just the first)

0. **Closed** — toolbar = `[View all issues]` + enabled `[Filter]` + `[Advanced]`
   - `[Saved]` + `[New issue]`; full sprint container + backlog region, full
     counts. Per-row **work-type glyph** shown (the new facet's field, visible on
     the row).
1. **Quick-filter popover open** — `IssueFilterBar` anchored under `[Filter]`:
   text + Kind / **Work type** / Status / Assignee listboxes + Clear; scrolls at
   the fixed max-height.
2. **Saved dropdown open** — `SavedFilterDropdown` anchored under `[Saved]`:
   Starred/My/Project/Defaults groups + star toggles + "View all filters".
3. **Active** — the `[Filter]` count badge, the `IssueAppliedFilterBar` summary
   row (name-chip + condition chips + Clear + "3 of 17 items match"), "View all
   issues" carrying `?filter=`, and BOTH the sprint container AND the backlog
   **re-projected** (filtered count badges `1 of 5` / `2 of 12`). A sprint with
   **no match** shows its dashed `No item in this sprint matches the active
filter.` placeholder (coexistence with the sprint sections — the backlog's
   analogue of the board's `col-empty`).
4. **Filtered-EMPTY** — no item in any region matches → a **distinct
   `EmptyState`** ("No work items match this filter" + `i-search-x` glyph + a
   **Clear filter** CTA), NOT the 4.2 brand-new-backlog empty (which offers a
   create CTA). The summary + active toolbar stay so the user can see/edit what
   they filtered on.
5. **Loading** — while the filtered read is in flight, the regions show pulsing
   skeleton rows (the 3.2.2 / 4.2 scaffold idiom; `aria-busy`); the toolbar +
   summary stay so the surface never collapses.

## Scope (out of scope here)

The filter **grammar/compiler** (6.1 owns it — no change); the **Work type
facet** itself (6.15.5 already added it to the shared `IssueFilterBar`; the
backlog inherits it); the **4.5 Scrum** sprint-scope filter (the backlog filter
`AND`-composes WITH a sprint's scope, narrowing WITHIN it, never widening);
**cross-project** backlogs (single-project by 4.1's `sprint.projectId`).

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the active-trigger
  `--el-tint-lavender` fill + `--el-accent` border/icon, the count badge
  `--el-accent` / `--el-accent-text`, the name-chip `--el-tint-lavender` +
  `--el-text-strong`, the reused type hues (`--el-type-*`) + work-type hues
  (`--el-type-{code…chore}`) + status `Pill` tones. Tints carry the hue in the
  BACKGROUND with `--el-text-strong` text (finding #35 AA — never a tinted page
  surface).
- **Shape** via element-semantic tokens (`--radius-card` popover/menu/containers ·
  `--radius-btn` triggers/CTA · `--radius-input` search fields · `--radius-badge`
  chips/count/pills · `--radius-control` option rows/star/icon buttons),
  `--shadow-elevated` for the open popover/menu, `--spacing-control-*` / `-chip-*`
  / `-icon-btn` / `-card-padding` for box padding, `--height-control` / `-btn-md`
  for sizing. `rounded-full` only on the genuinely-circular status dot + avatar.
- **No nested buttons** (axe `nested-interactive`) — the `[Saved]` option row is
  a `role="option"` div whose star toggle is a SIBLING `<button>`; the applied
  name-chip / Clear / Clear-filter CTAs are standalone `<button>`s; the issue rows
  stay `role="row"` with sibling controls (the 4.2 contract). Every icon `<svg>`
  carries a 24×24 `viewBox`.
- **Listbox a11y** — the quick-filter facets are `role="listbox"
aria-multiselectable="true"` with `role="option" aria-selected`; the filtered-
  empty backlog uses `EmptyState`/`role="status"`, not an empty listbox
  (combobox-empty-listbox a11y). Keyboard-operable throughout.
- **next-intl en + zh** — every new string (the summary copy, the filtered-empty
  EmptyState, the match-count) is keyed; the `filterComingSoon` key is dropped
  when the seam is enabled (8.8.18).
