# Boards — design notes

Design reference for the `boards` UI area. The asset is the source of truth for
every UI subtask in Story 3.2 (the Kanban board surface). Built FROM the real
design system (`app/globals.css` `--el-*`/shape tokens + the shipped
`components/ui/*` and issue-list primitives), so the code subtasks compose the
same primitives — no Pencil→code gap.

| Surface                            | Asset                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kanban board (columns + cards)** | **`board.mock.html`** (HTML mockup)         | The whole board surface — no `design/boards/` asset existed; the 3.2.1 design gate produces this. Multi-panel: board · drag · snap-back · keyboard · scale · unmapped · states · mobile. Gates 3.2.2–3.2.6. See below.                                                                                                                                                                                                    |
| **Swimlanes + WIP limits**         | **`swimlanes-wip.mock.html`** (HTML mockup) | EXTENDS the board surface — the 3.2.1 mockup drew a WIP slot only as a NON-enforced placeholder and NO swimlanes / WIP editor / over-limit treatment (unspecified == no design), so the 3.3.1 design gate produces this. Multi-panel: group-by control · swimlanes (assignee/epic/priority + catch-all) · cross-lane drag · WIP config · over-limit · states. Gates 3.3.5–3.3.6. See "Swimlanes + WIP (Story 3.3)" below. |

The board is a **pure consumer** of the Story-3.1 board API
(`GET …/board` → `BoardProjectionDto`; `GET …/board/columns/[id]/cards` → the
lazy page; `POST …/board/move` → the moved card). **Moving a card = a workflow
transition, never a board-local write**; illegal drops snap back on the 3.1
typed errors. Mirror product: Jira / Linear boards.

The asset is multi-panel (review each, not just the first): **(0)** the full
board · **(1)** drag in progress · **(2)** illegal-move snap-back · **(3)**
keyboard DnD · **(4)** scale · **(5)** unmapped-statuses tray · **(6)** loading
/ empty / error states · **(7)** mobile.

---

## Where it lives

Replaces the `/boards` stub (`app/(authed)/boards/page.tsx`, today a
`ProjectStubPage … comingIn="Epic 3"`). The sidebar "Boards" nav link + the
Cmd-K "Go to Boards" entry already point at `/boards` (Story 1.5) — **no new
navigation wiring**. The board renders the active project's single default
Kanban board (Story 3.1 auto-seeds one per project).

## Layout (panel 0)

- **Page shell** inside the app shell (1.5.1): a serif `h2` "Board" title +
  muted project subtitle, and a right-aligned toolbar — a disabled `[Filter]`
  seam (Epic 6 wires it) + the primary `[+ New issue]` (`Button variant="primary"`,
  reusing the shipped create flow).
- **The board** is a horizontally-scrolling flex row of **columns**
  (`.board`, `overflow-x: auto`, `scroll-snap-type: x proximity`). Columns are
  fixed-width (288px). Page gutter 24px.
- **Columns** are in **workflow order** (`status.position`) — the seeded default
  is To Do / Blocked / In Progress / In Review / Done / Cancelled (one column
  per status), but a column maps to a SET of statuses (Story 3.1), so this is a
  default over the durable mapping, not 1:1.

## Column anatomy (`BoardColumn` — subtask 3.2.3)

- Container: `--el-surface` fill, `--el-border`, `--radius-card`, a **uniform
  height** with an internal scroll on `.col-body`. Every column is the SAME height
  regardless of card count (3.2.8) — a sparse column shows empty space below its
  cards rather than hugging them, so the columns line up. In the app this is a
  viewport-relative `h-[calc(100dvh-12rem)]` LAYOUT height (a raw `calc`, not a
  `--height-*` token, since it is not a shaped-control size).
- **Header**: column `name` (13px semibold, `--el-text-strong`) + a **card-count
  badge** (`.col-count`, the per-column total from the projection) + a spacer +
  a **WIP-limit slot** (`.wip-slot`, drawn as a placeholder e.g. `3/5` — **NOT
  enforced here; Story 3.3 enforces** WIP + over-limit warnings) + a
  column-actions `[⋯]` icon button.
- **Empty column**: a dashed `.col-empty` "No issues" placeholder inside the
  column body (distinct from the board-level empty state).

## Card anatomy (`BoardCard` — subtask 3.2.3) — REUSES the issue primitives

A board card is the same issue, compact. It composes the EXACT primitives from
`app/(authed)/issues/_components/issueCellPrimitives.tsx` + `components/ui/*` —
**no new card vocabulary**:

- **Top row**: `IssueTypeIcon` (lucide glyph in the kind hue via `--el-type-*` —
  epic=zap, story=book, task=square-check, bug=bug, subtask=list-checks) · the
  mono issue `key` (`PROD-23`, `--el-text-muted`) · a spacer · a **drag grip**
  (`grip-vertical`, revealed on hover; the whole card is the drag handle, the
  grip is the affordance cue).
- **Title**: 2-line clamp (`-webkit-line-clamp: 2`), `--el-text`.
- **Meta row**: the **priority `Pill`** (`PRIORITY_META` tone + direction icon —
  highest/high = rose + arrow-up, medium = sky + minus, low = mint + arrow-down)
  · a **story-point / estimate chip** (`.pts`, mono) · a spacer · the **assignee
  `Avatar`** (initial-letter; unassigned = dashed circle).
- **Blocked cards** swap the priority pill for a **"Blocked" peach pill**
  (`--el-tint-peach` + `circle-alert` in `--el-warning`) — the `ReadinessBadge`
  tone, driven by the finding-#21 readiness signal on `BoardCardDto` (Story
  3.1.4). State is carried by TEXT + icon, never colour alone (finding #35).
- **Interaction**: `cursor: grab`; hover raises `--el-border-strong` + underlines
  the title. Clicking the card opens the **existing `IssueQuickView`** (Story 2.5)
  — no new detail surface.
- Shape: `--radius-card`, `--shadow-subtle`; colour strictly `--el-*` (finding
  #54 — the palette, not grey + one accent).

## Drag-drop (subtask 3.2.4) — dnd-kit

dnd-kit (`@dnd-kit/core` + `@dnd-kit/sortable`) — the accessible standard
(pointer + keyboard sensors, `DragOverlay`, `announcements`). New dependency;
mirror-product standard, not a deviation.

### Pointer drag (panel 1)

- The **source card** leaves a dashed, 40%-opacity **ghost** in place while
  lifted.
- A **`DragOverlay` clone** follows the cursor — tilted ~2.5°, `--shadow-elevated`,
  `cursor: grabbing`, accent border.
- The **target column** shows an accent **ring** (`outline`) + a lavender
  **tint** AND an **insertion bar** (`.insertion`, 3px accent pill) at the drop
  position — redundant cues, never colour alone (finding #35).
- **Optimistic**: the card moves to the drop position immediately, then
  reconciles against `POST …/move`.

### Snap-back (panel 2)

- **200** → reconcile to the returned `BoardCardDto` (confirmed status/position;
  update both column counts).
- **409 `IllegalBoardMoveError`** → revert the optimistic move (card **animates
  back** to its origin, brief focus ring) + a **danger `Toast`** naming the
  rejected transition (`"To Do → Done" isn't a permitted transition…`).
- **422 `UnmappedColumnTargetError`** and **network/other errors** → snap back
  the same way with a toast. The card never stays in a rejected position; the
  issue status is unchanged.

### Keyboard DnD (panel 3) — operable with no mouse

- **Space/Enter** pick up & drop · **↑↓** move within a column · **←→** move
  across columns · **Esc** cancel.
- The picked-up card shows a **strong focus ring + elevation** (`aria-grabbed`).
- Every step reads from an **`aria-live`** region (sr-only in prod; shown in the
  mock for review). Announcement copy:
  - pick up: `Picked up {key}. Over column {col}, position {i} of {n}.`
  - move: `{key} moved to {col}, position {i} of {n}. Press Space to drop, Escape to cancel.`
  - drop: `{key} dropped into {col}.`
  - rejected: `Move not allowed: {from} → {to}. {key} returned.`
  - cancel: `Move cancelled. {key} returned to {col}.`

## Scale (subtask 3.2.5) — finding #57, panel 4

The board never loads every card. From the 3.1 projection each column carries a
bounded first page + a `total` + a `cursor`.

- The column header **count** shows the full total (e.g. `214`, `1,280`) — the
  denominator. It **stays**; it is the column's issue count, distinct from "how
  many are loaded".
- Paging is **PURE auto scroll-to-load (3.2.8)**: an `IntersectionObserver`
  sentinel at the bottom of the scroll area fetches
  `GET …/columns/[id]/cards?cursor=` and **appends** the next page (advancing the
  cursor) when it scrolls into view. There is **no explicit "Load more" button**
  and **no "{n} loaded" note** — both were dropped. While a page is in flight a
  small in-flow **`Spinner` + "Loading…"** (`.load-spin`) shows at the bottom; a
  **failed** page leaves a minimal, **focusable inline retry** (`.load-retry`) so
  it is recoverable without a reload and reachable by keyboard (the card links are
  focusable, so keyboard scroll also trips the sentinel).
- Tall columns **virtualize** (only viewport rows render — bounded DOM),
  **reusing the windowing primitive Story 2.5.15** established (no second lib).
  Virtualization is invisible — it is documented here, not surfaced on the column.
- **Done/terminal columns** are additionally **windowed** server-side to a recent
  set (mirroring Jira's "hide done older than ~14 days") with the full count still
  in the header; the windowing is invisible on the column (no on-column note).

## Unmapped-statuses tray (subtask 3.2.6) — panel 5

From `BoardProjectionDto.unmappedStatuses` (project statuses mapped to no column;
the Jira behaviour — Story 3.1.4 surfaces them, never drops them). Rendered as a
**yellow tray** (`--el-tint-yellow`) above the board: an alert-triangle, the copy
`These statuses aren't on this board — work items in them are hidden here:` + the
status names as neutral pills + a link to the workflow admin (Story 2.2.5).
**Absent when `unmappedStatuses` is empty.**

> **CTA reality (3.2.6 build note):** the mock drew a `Map columns →` link, but a
> column→status **mapping admin is not in v1** (Story 3.1/3.2/3.3 defer "board
> CRUD / column-remap admin"; Story 3.1 deliberately leaves a later-added status
> **unmapped, not auto-columned**). So the shipped link is labelled
> **`Manage statuses →`** and points at the workflow editor — the real place to
> review / rename / remove a stray status — rather than promising a mapping
> action that doesn't exist. When a board-column admin lands, repoint + relabel.

## States (panels 6) — completeness, not the happy path only

- **Loading** (ships in 3.2.2): a column scaffold of pulsing skeleton cards
  (`Spinner`/skeleton) while the projection streams.
- **Empty board** (ships in 3.2.6): `EmptyState` — inbox icon, "No issues yet",
  a "New issue" CTA (reuses the shipped create flow). NOT six blank columns.
- **Error / no-board** (ships in 3.2.2): `ErrorState` — alert icon, "Couldn't
  load the board", a **Retry**.

## Mobile (subtask 3.2.6) — panel 7

Narrow viewports: a single-column horizontal scroll with a **pager** (dots +
`To Do · 1 of 5`). Card anatomy is unchanged. Drag still works (pointer +
keyboard); long-press lifts a card on touch.

## Token / a11y rules honoured

- **Colour** strictly through `--el-*` (finding #54 — uses the palette: type
  hues, pill tones, the lavender drop tint, the yellow tray — not grey + one
  accent). Tints carry the hue in the BACKGROUND with `--el-text-strong` text
  (finding #35 AA).
- **Shape** through element-semantic tokens (`--radius-card`/`-btn`/`-badge`/
  `-control`, `--shadow-subtle`/`-card`/`-elevated`, `--spacing-chip-*`).
- **Not colour-alone** (finding #35): drop targets pair the tint with a ring +
  insertion bar; blocked/priority/readiness carry text + icon; sort/state never
  rely on hue alone.
- Columns are landmarked (`<section aria-label="{name}, {n} issues">`) and the
  drag flow is fully keyboard-operable with live announcements.

---

# Swimlanes + WIP (Story 3.3)

Design reference for Story 3.3 — the board's flow-management layer on top of the
3.2 Kanban surface. Asset: **`swimlanes-wip.mock.html`** (+ `swimlanes-wip.png`
export). It is the source of truth for the UI subtasks **3.3.5** (swimlanes +
cross-lane drag) and **3.3.6** (WIP config + over-limit warning), which both
carry **3.3.1** in `dependsOn`.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and **reuses the shipped board/issue primitives unchanged** —
the `BoardColumn`, the `BoardCard` (`IssueTypeIcon` in the `--el-type-*` hue ·
mono key · 2-line title · priority `Pill` · story-point chip · assignee
`Avatar` · the Blocked peach pill), the column `[⋯]` menu, `Tooltip`. Swimlanes

- WIP are a **new arrangement + two new affordances**, not a new board.

Mirror product = **Jira / Linear** swimlanes + column WIP (decision-ladder rung
1). Config is persisted on the `board` entity and shared across viewers.

The asset is multi-panel (review EACH): **(0)** group-by control · **(1)**
swimlanes by Assignee (+ collapse + catch-all) · **(2)** by Epic · **(3)** by
Priority · **(4)** cross-lane drag = reassign · **(5)** WIP config · **(6)**
over-limit (SOFT) · **(7)** states.

## Composing primitives (what 3.3.5 / 3.3.6 build with)

- **Group-by control** — the shipped **Segmented** control (`components/ui`,
  the `.seg`), in the 3.2.1-reserved 3.3-controls slot in the board header.
  Options **None / Assignee / Epic / Priority** with a leading lucide glyph
  (`user` / `zap` / `flag`); the active option carries `aria-pressed="true"` +
  the `--el-page-bg` raised treatment. Do NOT invent a control.
- **Lane header** — chevron (`chevron-down`, rotated −90° when collapsed) +
  the group label + a `.lane-count` aggregate badge. Label by dimension:
  - assignee → the `Avatar` (initial-letter, `.sm`) + name;
  - epic → the epic `IssueTypeIcon` (`zap`, `--el-type-epic`) + mono `epic-key`
    - `epic-title`;
  - priority → the priority `Pill` (the exact `PRIORITY_META` tone + direction
    icon the cards use);
  - catch-all → a muted label ("No assignee" / "No epic") + dashed/faint marker.
- **Card** — the unchanged 3.2.3 `BoardCard`, bucketed into `(lane, column)`
  cells by the projection's `swimlaneKey`.
- **WIP config** — the column `[⋯]` **menu** primitive gains a **"Set WIP
  limit"** item opening an inline integer field + **Clear** / **Save** (the
  shipped input + small buttons). `Tooltip` on the over-limit chip.

## Lane layout + order

- A lane is a horizontal row slicing **every** column; the board is a grid of
  `(column × lane)` cells. Column headers stay **pinned** at the top; the lane
  header is **sticky-left** so it stays visible while the board scrolls
  horizontally. Column boundaries align across lanes (same fixed 288px column
  width + gutters as the flat board).
- **Only group values present on the board get a lane** (no empty 200-row
  assignee list). The **catch-all** lane ("No assignee" / "No epic" — the
  unassigned / no-ancestor-epic bucket) **always sorts LAST**.
- **Lane-order rule:** assignee → alphabetical by name; priority → priority
  rank (Highest → Lowest); epic → epic backlog/position order; **catch-all last
  in every mode.**
- **Collapse** is per-lane and **persists client-side** (e.g. localStorage
  keyed by `boardId + laneKey`). A collapsed lane shows only its header +
  count; its card bodies unmount (cheap) — but the per-column total (which
  drives the WIP chip) still counts its cards.
- **group-by None** is the flat 3.2 board, unchanged (no lanes).

## Cross-lane drag = reassign the grouped field

Dragging a card to a **different lane** must DO something (a lane that silently
snaps back is a broken affordance). It reassigns the grouped field via the
**existing Story-2.5 issue-field update endpoints** (the same paths
`IssueInlineEdit` calls) — **NOT** the board/move endpoint (status only) and
**NOT** a new backend:

- assignee lane → reassign assignee · priority lane → change priority · epic
  lane → reparent to that epic · drop into the **catch-all** → clear the field
  (unassign / remove epic) where legal.
- A **column** change is the 3.2 transition (`POST …/board/move`). A
  **diagonal** drop (different column AND lane) applies **both** writes.
- Each write is **optimistic with INDEPENDENT snap-back** (the 3.2.4 pattern):
  if the transition is rejected (409) only the column axis reverts; the lane
  reassign stays (and vice-versa). The card never rests in a lying position.
- **Drop affordances (not colour-alone, finding #35):** the target lane shows a
  ring + `--el-tint-lavender` tint; the specific target cell (diagonal) shows
  its own ring + an **insertion bar**. Keyboard DnD moves a card across lanes
  too (`Shift`+`↑/↓`).
- **`aria-live` copy** (distinct per move kind):
  - reassign (lane only): `{key} moved to {group}'s lane. {Field} changed to {value}.`
  - transition (column only): `{key} moved to {col}, position {i} of {n}.`
  - diagonal (column + lane): `{key} moved to {col} and reassigned to {value}.`
  - catch-all clear: `{key} unassigned.` / `{key} removed from its epic.`

## WIP limits — per-column, SOFT (advisory, never blocks)

- The limit is **per-column** (Jira-classic), counted across **all** swimlanes
  (the per-column total, not per lane). Per-lane WIP is out of scope (no stated
  use case → match the mirror).
- The header count renders as **`n/limit`** (the `.wip` chip). States:
  - **under** (`3/5`) and **at** (`5/5`) → **quiet** (no warning). At-limit is
    `n == limit` and is **NOT** warned.
  - **over** (`n > limit`, strictly greater, e.g. `6/5`) → the over-limit
    treatment: a warning hue (`--el-tint-peach` background + `--el-warning`
    alert icon) **PAIRED with the icon + the `n/limit` label** so it is **not
    colour-alone** (finding #35), and announced via `role="status"`.
- **SOFT = advisory:** an over-limit column does **NOT** reject drops — the
  3.2.4 move contract is untouched; a drop into an at/over-limit column still
  succeeds and the warning persists. There is **no HARD/blocking enforcement**
  (the stub says soft).
- No limit set → the count renders **plain** (the neutral `.col-count` badge,
  no `n/limit` chip, no warning). Clearing a limit returns to this state.

## States (completeness)

- **group-by re-lay** — switching group-by shows a loading transition (the new
  layout streams in; the old layout does NOT flash).
- **single-lane** — one group value present collapses to one lane sensibly.
- **catch-all-only** — the catch-all lane renders even as the only populated
  lane.
- **over-limit + collapsed** — the WIP warning is independent of lane collapse;
  a collapsed lane keeps its header + count, and the per-column total still
  drives the chip.

## Permissions

Group-by + WIP are board-config **writes**. Roles/permissions are Epic 6.4, so
(matching the 2.2.5 workflow editor) they are **membership-gated now** with a
`TODO(6.4)` to role-gate later — no early RBAC build.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): type hues, `Pill` tones, the
  lavender drop tint, the peach over-limit tint. Tints carry the hue in the
  BACKGROUND with `--el-text-strong` text (finding #35, AA).
- **Shape** via element-semantic tokens (`--radius-card`/`-btn`/`-input`/
  `-badge`/`-control`, `--shadow-subtle`/`-elevated`, `--spacing-*`,
  `--height-control`).
- **Not colour-alone** (finding #35): the over-limit chip pairs hue with an
  icon + the `n/limit` label; drop targets pair the tint with a ring +
  insertion bar; lane state carries text + chevron, never hue alone.
- Lane headers are operable as `role="button"` with `aria-expanded`; group-by +
  collapse are keyboard-operable; the over-limit state is announced
  (`role="status"`), not signalled by colour alone.
