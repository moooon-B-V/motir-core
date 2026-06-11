# Boards — design notes

Design reference for the `boards` UI area. The asset is the source of truth for
every UI subtask in Story 3.2 (the Kanban board surface). Built FROM the real
design system (`app/globals.css` `--el-*`/shape tokens + the shipped
`components/ui/*` and issue-list primitives), so the code subtasks compose the
same primitives — no Pencil→code gap.

| Surface                               | Asset                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kanban board (columns + cards)**    | **`board.mock.html`** (HTML mockup)              | The whole board surface — no `design/boards/` asset existed; the 3.2.1 design gate produces this. Multi-panel: board · drag · snap-back · keyboard · scale · unmapped · states · mobile. Gates 3.2.2–3.2.6. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Swimlanes + WIP limits**            | **`swimlanes-wip.mock.html`** (HTML mockup)      | EXTENDS the board surface — the 3.2.1 mockup drew a WIP slot only as a NON-enforced placeholder and NO swimlanes / WIP editor / over-limit treatment (unspecified == no design), so the 3.3.1 design gate produces this. Multi-panel: group-by control · swimlanes (assignee/epic/priority + catch-all) · cross-lane drag · WIP config · over-limit · states. Gates 3.3.5–3.3.6. See "Swimlanes + WIP (Story 3.3)" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Board configuration (admin)**       | **`board-config.mock.html`** (HTML mockup)       | The board ADMIN surface — the column manager + column ↔ status mapping the 3.2.6 unmapped tray points at; NO `design/boards/` asset drew it (the 3.2.1 board mockup is the board itself; its `[⋯]` menu is a disabled seam), so the 3.6.1 design gate produces this. A SIBLING of the Workflow editor (`settings/project/board`). Multi-panel: page · rename/add column · map-by-drag · map-by-keyboard · delete-confirm + guard · read-only · states · cross-links. Gates 3.6.3. See "Board configuration (Story 3.6)" below.                                                                                                                                                                                                                                                                                                                                                          |
| **Board load model (correction)**     | **`board-scale.mock.html`** (HTML mockup)        | EXTENDS the board surface — CORRECTS the scale UI (notes.html mistake #33). The 3.2.1/3.2.8 scale panel paged columns ("Load more" → auto scroll-to-load); Jira does NOT page a board, so the corrected model (whole bounded set + virtualize + over-cap "refine filter" banner + Done-age window) was unspecified (== no design), so the 3.8.1 design gate produces this. Multi-panel: bounded whole-set load · Done-age window · over-cap banner · swimlanes-sans-footer. Gates 3.8.3 / 3.8.4 / 3.8.5. See "Board load model (Story 3.8)" below.                                                                                                                                                                                                                                                                                                                                      |
| **Multiple boards (switcher + CRUD)** | **`multi-board.mock.html`** (HTML mockup)        | EXTENDS the board surface — the **board switcher** + **create / rename / set-default / delete** board UI. The 3.2.1 board mockup draws a SINGLE default board (its column `[⋯]` a disabled seam); the switcher + board-CRUD surfaces are unspecified (== no design), so the 3.7.1 design gate produces this. Multi-panel: header switcher (closed) · switcher open (active checked · default badged · New board) · manage menu (rename/set-default/delete) · New-board modal · rename modal · delete confirm · last-board guard + one-board state · states + permissions. Gates 3.7.4. See "Multiple boards (Story 3.7)" below.                                                                                                                                                                                                                                                         |
| **Per-board settings (entry + page)** | **`per-board-settings.mock.html`** (HTML mockup) | EXTENDS the 3.6.1 board-config page + the 3.7.1 switcher — makes board SETTINGS **per-board**. The 3.6 admin only configures the project DEFAULT board, and every entry point links there with NO board context; with many boards per project (3.7) each board has its OWN config, so settings must target the SELECTED board. That gap is unspecified (== no design), so the 3.7.7 design gate produces this. Multi-panel: board-scoped settings page (header names the board + switcher) · switcher open (change which board) · manage menu "Board settings" item · cross-links carrying `?board=` · states + permissions. Gates 3.7.8. See "Per-board settings (Story 3.7)" below.                                                                                                                                                                                                   |
| **Scrum board (sprint view)**         | **`scrum.mock.html`** (HTML mockup)              | EXTENDS the board surface — the SCRUM variant: the same 3.2/3.3 board scoped to a board's active sprint, under a **sprint header** (name + state · goal-with-reveal · dates + time remaining · committed/completed/remaining points · complete-sprint entry point) + **per-column point totals**. The 3.2.1 board mockup drew the Kanban surface only — the sprint header / points / no-active-sprint state / complete-sprint affordance were unspecified (== no design), so the 4.5.1 design gate produces this. CHROME over the reused board — it does NOT redraw columns / cards / drag / swimlanes / WIP. Multi-panel: full scrum board · sprint-header anatomy (Tooltip reveal) · no-active-sprint EmptyState (→ Backlog) · edge states ("—" unestimated · "Ended" overdue · loading skeleton) · column-header slot coexistence. Gates 4.5.3. See "Scrum board (Story 4.5)" below. |

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

> **CTA reality (updated by Subtask 3.6.3):** the board-column admin now exists
> (`settings/project/board`, Story 3.6 — the column manager + status mapping), so
> the tray's link finally does what this mock drew: it reads **`Map columns →`**
> and deep-links to Board settings. This SUPERSEDES the interim 3.2.6 build note,
> where the link was labelled `Manage statuses →` and pointed at the workflow
> editor while no mapping admin existed. The `boards` i18n key was renamed
> `unmappedManageStatuses` → `unmappedMapColumns` (en + zh) to match.

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

---

# Board configuration (Story 3.6)

Design reference for Story 3.6 — the board's **administration** surface. Asset:
**`board-config.mock.html`** (+ `board-config.png` export). It is the source of
truth for the UI subtask **3.6.3** (the column manager + status mapping + the
unmapped-tray repoint), which carries **3.6.1** in `dependsOn`. The service /
API it consumes is **3.6.2**.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and reuses shipped vocabulary: the **settings-page grammar**
from `app/(authed)/settings/project/workflow` (serif `h2` + muted subtitle + an
`mx-auto` editor), the **board column visual language** from `board.mock.html`
(3.2.1), the **neutral `Pill`** from the 3.2.6 unmapped tray, `Input`, `Button`,
`Modal`/confirm, and the dropdown **Menu** (the keyboard fallback). No new card
vocabulary — a new ARRANGEMENT of shipped pieces.

**Mirror product = Jira board settings → COLUMNS** (decision-ladder rung 1): the
column manager where an admin creates columns and maps statuses into them.

The asset is multi-panel (review EACH): **(0)** the full board-settings page ·
**(1)** inline column rename + the Add-column input · **(2)** map a status by
DRAG · **(3)** map by the non-drag KEYBOARD fallback · **(4)** delete-column
confirm (normal + guard) · **(5)** read-only (non-admin) · **(6)** states ·
**(7)** cross-links + the settings nav.

## Where it lives

A new project-settings page **`app/(authed)/settings/project/board/`**, a
**SIBLING of the Workflow editor** (`settings/project/workflow`, Story 2.2.5).
The two are reached from the **project-settings landing page's nav CARDS** (the
`WorkflowSettingsCard` pattern, finding #47) — there is **no settings sidebar**,
so "the Board nav entry, next to Workflow" means a new sibling `Card`-as-`Link`
("Board", "Columns and which statuses each column shows.") added to
`settings/project/page.tsx` beside the existing Workflow card. The page mirrors
the Workflow page grammar: a server component resolves the active project + the
caller's admin role and hands typed data to a client `BoardConfigEditor`.

**Division of labour:** the **Workflow** editor owns the statuses and the
transitions between them; **Board** settings owns how those statuses map onto
board columns. Renaming/adding a status is Workflow; putting it on the board is
Board.

## Composing primitives (what 3.6.3 builds with)

- **Page** — the `settings/project/workflow` page shell: serif title (with a
  leading `columns` glyph), muted subtitle, an `mx-auto max-w-[…]` editor column.
- **Board-name field** — `Input` + an auto-save reconcile indicator (a
  "Saving…/Saved" chip, mirroring the 3.3 WIP-limit save feedback). No explicit
  Save button needed — writes are optimistic-with-reconcile.
- **Unmapped-statuses rail** — a bordered surface (header + body) listing the
  statuses with no column (`BoardProjectionDto.unmappedStatuses`) as draggable
  status chips. It carries the same warning hue as the 3.2.6 board tray, but the
  hue lives in a small icon + a count badge (NOT a tinted page surface — finding
  #35); it is an interactive drop source AND drop target (drop a chip back to
  unmap). Empty state = a positive "Every status is on the board — nothing is
  hidden."
- **Column manager** — a horizontally-scrolling row of columns reusing the board
  column language. Each column: a **drag handle** (`grip`, reorder), an editable
  **name** (a `pencil` swaps it for an accent-bordered `Input` with check/cancel;
  Enter commits, Esc cancels), a **count** badge (mapped-status count), a
  **delete** (`trash`) affordance, the **mapped status chips** (full-width neutral
  `Pill` rows, each with a grip + an `×` remove that unmaps it), and a dashed
  **"Add status"** button. A trailing dashed **"Add column"** ghost column
  appends a new column already in name-edit mode.
- **Status chip (`.schip`)** — the mappable unit: the 3.2.6 neutral `Pill` tone
  as a moveable row (grip + label + `×`). The drag affordance is the grip + the
  cursor, never colour alone (finding #35).
- **Delete-column confirm** — a `Modal`/confirm. Two shapes (see below).
- **Per-column status picker** — the dropdown `Menu` primitive, the non-drag
  keyboard path (see "Status mapping").

## The mapping contract (the invariant the UI must respect)

`board_column_status` carries `@@unique([boardId, statusId])` (Story 3.1.1) — a
status maps to **at most one column per board**. So mapping is a **MOVE, never a
duplicate**:

- Dragging a status from the rail (or from another column) into column C
  **moves** its mapping to C (`mapStatusToColumn`, the 3.6.2 transactional
  delete-then-create). It never appears in two columns.
- The `×` on a chip (or dropping it back on the rail) **unmaps** it — it returns
  to the unmapped rail, and its work items are **hidden from the board but never
  deleted** (a card's column is DERIVED from `work_item.status` — config never
  touches work items).
- Every write is **optimistic-with-reconcile** against the 3.6.2 endpoints; a
  failed write reverts the optimistic change + surfaces a danger `Toast`.

## Status mapping — drag AND a non-drag keyboard path (finding #35)

Mapping is **NOT drag-only**. Two equivalent paths, both firing the same 3.6.2
write:

- **Drag (panel 2)** — dnd-kit (reuses the 3.2.4 board setup, no second DnD
  lib). The source chip leaves a dashed 40%-opacity ghost; a tilted
  `DragOverlay` clone follows the cursor; the **target column** shows an accent
  **ring** + a lavender **tint** AND an **insertion bar** — redundant cues, never
  colour-alone (finding #35).
- **Keyboard / non-drag (panel 3)** — every column's **"Add status"** button
  opens a `Menu` of the currently-unmapped statuses; choosing one maps it. Chip
  reorder/move-across-columns is keyboard-operable via the dnd-kit **keyboard
  sensor** (`Space` pick up · `↑↓` within · `←→` across · `Space` drop · `Esc`
  cancel). Both paths drive an **`aria-live`** region that announces each step,
  so a keyboard or screen-reader user can fully configure the board.

## Delete-column — confirm + the Jira-style guard

`deleteColumn` unmaps the column's statuses (they return to the rail) and removes
only the `board_column` row — **never a work item** (decided at 3.6.2). Two
confirm shapes:

- **Normal (panel 4a)** — "Delete '{column}'? Its mapped status(es) return to
  Unmapped statuses — work items keep their status and are not deleted." An info
  callout names which statuses return. Destructive (`Button` danger) confirm.
- **Guard (panel 4b)** — when a mapped status **still holds board cards**, the
  delete is refused (`ColumnNotEmptyError` → 409, mirroring Jira's "you can't
  delete a column with issues"). The confirm becomes a guard: a warning callout
  naming the status + its card count, and a **primary action that deep-links to
  remap** that status first. No work item is ever removed by a board change.

State is carried by **text + icon**, never colour alone (finding #35); the
peach/danger callouts put the hue in the BACKGROUND with `--el-text-strong`
(finding #35 AA).

## Cross-links — the three entry points (panel 7)

1. **The board's 3.2.6 unmapped-statuses tray (the headline).** 3.6.3 repoints
   its CTA from the interim **"Manage statuses →"** (which went to the Workflow
   editor because no mapping admin existed) to **"Map columns →"** →
   `settings/project/board` — the real surface. The `boards` i18n keys update
   (en + zh) and this note's **"CTA reality"** block (in the Story-3.2 section
   above) is superseded: the tray now does what its copy promises.
2. **The board column `[⋯]` menu (3.2.3)** — a disabled seam until now — gains a
   **"Board settings →"** item that opens this surface.
3. **The project-settings nav** — a new **"Board"** card beside **"Workflow"** on
   `settings/project`.

## States (completeness)

- **Loading** — a header + name-field + column skeletons stream in.
- **Error / no-board** — an `ErrorState` with Retry (the 3.2.2 board pattern).
- **All-mapped** — the unmapped rail shows a positive empty state, not a blank
  box. (A board always auto-seeds ≥1 column per the Story-3.1 seed — 3.1.2 — so
  there is no zero-column state; "empty / brand-new board" means its only column
  holds the initial status and the rail is empty.)
- **Save feedback** — the per-write "Saving…/Saved" chip on the name field; a
  failed write surfaces a danger `Toast` and reverts the optimistic change.

## Permissions

Column + mapping writes are board-config **writes**. Roles/permissions are Epic
6.4, so (matching the 2.2.5 workflow editor + the 3.3 board config) the surface
is **membership-gated now** with a `TODO(6.4)` to role-gate later — no early RBAC
build. A non-admin sees the surface **read-only** (panel 5): no grips, no
rename/delete, no "Add status", the name field disabled, no rail drop target; the
server re-gates every write 403 regardless of the rendered affordances.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the warning hue on the rail +
  guard callout, the `--el-accent` drop ring/tint + rename border, the success
  green on "Saved" / all-mapped, the danger red on delete. Tints carry the hue in
  the BACKGROUND with `--el-text-strong` text (finding #35 AA — never a tinted
  page surface).
- **Shape** via element-semantic tokens (`--radius-card`/`-btn`/`-input`/
  `-modal`/`-badge`/`-control`, `--shadow-subtle`/`-elevated`/`-modal`,
  `--spacing-*`, `--height-input`/`-btn-sm`/`-control`).
- **Not colour-alone** (finding #35): the drop target pairs the tint with a ring
  - insertion bar; the rail icon + the chip grip signal interactivity; delete /
    guard state carries text + icon. Mapping is operable by keyboard (the picker
    menu + the dnd-kit keyboard sensor) with `aria-live` announcements, not
    drag-only.
- Columns are landmarked (`role="listitem"` with an `aria-label` carrying the
  name + mapped-status count); the rename/add/delete controls have explicit
  `aria-label`s; the picker is a `role="menu"`.

---

# Board load model (Story 3.8)

Design reference for Story 3.8 — the **correction** to the board's scale UI.
Asset: **`board-scale.mock.html`** (+ `board-scale.png` export). It is the source
of truth for the UI subtasks **3.8.3** (flat board), **3.8.4** (over-cap banner),
and **3.8.5** (swimlanes), which all carry **3.8.1** in `dependsOn`.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and **reuses the shipped board / lane primitives unchanged** —
the `BoardCard`, the column header + `[⋯]`, the swimlane lane/cell grammar
(3.3.1), and — for the over-cap banner — the **yellow-tray treatment the shipped
`UnmappedStatusesTray` (3.2.6) already uses, verbatim**. No new card / column /
lane vocabulary; this is a new LOAD behaviour over the shipped arrangement.

## Why this is a correction (notes.html mistake #33)

The earlier scale UI **paged the board**: first a per-column **"Load more"**
button (3.2.5), then **PURE auto scroll-to-load** + an in-flight spinner (3.2.8).
Both are a paging affordance the **mirror product does NOT use**. VERIFIED against
Jira (June 2026, Atlassian docs): a board renders the **whole saved-filter set up
to a hard cap** (5,000 Software / 3,000 Business), shows a **"maximum number of
viewable issues exceeded — refine your filter"** warning past the cap, windows the
**Done** column to issues resolved in the **last ~14 days**, and **virtualizes**
the render — it never paginates columns and has no "Load more." **Per surface
(mistake #33):** Jira's issue _navigator_ DOES paginate, so finding #57's
list/tree pagination stays correct and is **untouched** — only the _board_
loads-the-set. This asset is **STILL bounded** (the cap is the bound; it never
"loads every row," so finding #57 holds): the cap bounds the load, the Done-age
window trims terminal columns, and virtualization keeps the DOM bounded.

> This story does NOT edit the done subtasks it supersedes (3.1.4 / 3.2.5 / 3.3.4
> / 3.3.5) — what is done is done; the new 3.8 subtasks supersede them in code.

## The asset is multi-panel (review EACH)

- **(0) Bounded whole-set load** — a tall column rendering its **full bounded
  card list** with **NO "Load more" button, no scroll-to-load sentinel, no
  in-flight spinner, no `.col-foot` footer**. The only affordance is the column's
  own scroll. The header **count** is the FULL total (the denominator),
  unchanged. A dashed `.virt-note` (a **review-only** annotation, NOT shipped)
  documents that the rest of the cards render the same way and that tall columns
  virtualize via the 2.5.15 `useRowWindow` (kept) so the DOM stays bounded. A
  crossed-out `.removed` box shows the 3.2.5 "Load more" + 3.2.8 scroll-to-load
  spinner that 3.8.3 / 3.8.5 delete.
- **(1) Done-age window** — the **terminal** (resolved/closed) column windowed
  server-side to issues resolved in the **last ~14 days** (newest first), with the
  **full count still in the header**. Refines 3.2.5's count-based window to Jira's
  age-based behaviour. The window applies to every terminal status (by workflow
  status category), not just "Done" by name. Invisible on the column (the
  `.virt-note` is review-only; no on-column note ships).
- **(2) Over-cap banner** — when the projection signals **`truncated: true`**
  (board total > `cap`), a board-level banner renders **above the board** (in
  `BoardContainer`, so it shows for flat AND swimlane layouts). It **reuses the
  3.2.6 yellow-tray treatment** (`--el-tint-yellow` background + an
  `AlertTriangle` in `--el-warning` + `--el-text-strong` copy), pairs **hue +
  icon + text** (finding #35), and is announced via `role="status"`. Copy: _"This
  board has more than {cap} work items — refine the board filter to see them all.
  Only the first {cap} are shown."_ The affordance is the **Epic-6 `[Filter]`
  seam** (the disabled toolbar `[Filter]` button 3.2 already reserves) — rendered
  **disabled** (`aria-disabled`, "Board filters arrive in Epic 6") until Epic 6
  lands board filters. **Absent when `truncated` is false** (panels 0–1 show no
  banner).
- **(3) Swimlanes, no per-column footer** — the lane × column grid (3.3.1) with
  each `(lane, column)` cell rendered **in full**, virtualized per cell via
  `useRowWindow` (kept). The awkward per-column **"Load more" footer row** (3.3.5)
  is **gone** (3.8.5). Everything else is unchanged: group-by, collapsible lanes,
  the catch-all lane (always last), cross-lane drag-reassign, and the per-column
  WIP chip in the pinned column-header row.

## The cap is a generous bound, not a paging knob

`BOARD_ISSUE_CAP` (3.8.2) is a **generous bound** — a real team's active board
fits comfortably under it (Jira's figure is 5,000 Software / 3,000 Business). It
is **not** a page size and there is **no "next page"**: the board loads up to the
cap and stops. The rare board that exceeds it gets the over-cap banner, exactly as
Jira does. The control that lets a user shrink an over-cap board is the **board
filter / saved query — Epic 6**; until it lands, the banner explains the cap and
the `[Filter]` seam stays **disabled** (a documented seam, not an invented
control). This is **finding-#57-bounded** (the cap is the bound), the opposite of
"load all rows."

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): type hues, `Pill` tones, the
  `--el-tint-yellow` over-cap tray, `--el-warning` alert icon. The tray carries
  the hue in the BACKGROUND with `--el-text-strong` text (finding #35, AA — never
  a tinted page surface).
- **Shape** via element-semantic tokens (`--radius-card`/`-btn`/`-badge`/
  `-control`, `--shadow-subtle`, `--spacing-control-*`/`-chip-*`,
  `--height-control`).
- **Not colour-alone** (finding #35): the over-cap banner pairs the yellow hue
  with the alert-triangle icon + the cap text; nothing relies on hue alone.
- The over-cap banner is announced (`role="status"`); the column landmarks
  (`<section aria-label="{name}, {n} issues">`) and keyboard operability from
  3.2.1 are unchanged (this story changes loading, not interaction).

---

# Multiple boards (Story 3.7)

Design reference for Story 3.7 — turning the project's **single** auto-seeded
board into **many boards per project**. Asset: **`multi-board.mock.html`** (+
`multi-board.png` export). It is the source of truth for the UI subtask
**3.7.4** (the board switcher + create / rename / set-default / delete), which
carries **3.7.1** in `dependsOn`. The service / API it consumes is **3.7.3**;
the default-board flag + ordering it relies on is **3.7.2**; the selected-board
read it threads is **3.7.5**.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and reuses shipped vocabulary — the **board page-head +
toolbar** and the **group-by Segmented slot** (`board.mock.html` /
`swimlanes-wip.mock.html`), the **dropdown Menu** + **`Modal`/confirm** + the
**info `callout`** (`board-config.mock.html`), `Input`, `Button`, and the
**neutral `Pill`** (the "Default" badge). No new card / column vocabulary — a new
ARRANGEMENT of shipped pieces.

**Mirror product = Jira's board switcher + create / manage board** (decision-
ladder rung 1; VERIFIED June 2026, Atlassian docs — checked, not asserted, per
`notes.html` mistake #33): a project has many boards; any member creates one, an
admin renames/deletes from board settings; one board is the team's landing
board. A Jira board is ultimately backed by a saved **filter** (so it can span
projects) — but filters are **Epic 6**, so 3.7 ships **project-scoped** boards
and the JQL backing is the Epic-6 extension (the disabled `[Filter]` seam already
reserves it).

The asset is multi-panel (review EACH): **(0)** header switcher (closed) ·
**(1)** switcher open (the board list) · **(2)** the manage menu · **(3)**
New-board modal · **(4)** rename modal · **(5)** delete confirm · **(6)**
last-board guard + one-board state · **(7)** states + permissions.

## Where it lives

The board header on `/boards` (`app/(authed)/boards/page.tsx` +
`_components/BoardContainer.tsx`). The switcher sits at the **left of the header
toolbar**, before the 3.3 group-by `Segmented`, the disabled `[Filter]` seam, and
`[+ New issue]` — no new page, no new nav. The selected board is URL-addressable
via `?board=<id>` (mirroring the 2.5.19 `?peek` pattern — shareable, reload-safe),
defaulting to the project's `isDefault` board when absent (3.7.5).

## Composing primitives (what 3.7.4 builds with)

- **Switcher trigger** (`.bsw-trigger`) — a select-like `Button`/trigger
  (`--radius-input`, `--height-control`): a leading `columns` glyph + the active
  board's `name` + the **Default** `Pill` (only when the active board is the
  project default) + a trailing `chevron-down`. `aria-haspopup="menu"` +
  `aria-expanded`.
- **Switcher menu** — the shipped dropdown **Menu** (the board-config picker
  vocabulary: `--radius-card`, `--shadow-elevated`). A `menu-cap` header
  ("Boards · {project}"), then one row per board **ordered by `board.position`**
  (3.7.2), a separator, and a **New board** create action. Each board row is a
  flex container holding TWO sibling buttons (never nested):
  - **`.bsw-pick`** (`role="menuitemradio"`, `aria-checked`) — a leading
    **check** on the active board (hidden but space-reserved otherwise), the
    board `name`, and the **Default** `Pill` on the default board. Picking it
    sets `?board=<id>` and re-lays the board from that board's projection (3.7.5).
  - **`.icon-btn`** (the `[⋯]` manage affordance) — opens the per-board manage
    menu (panel 2).
- **Manage menu** — a second Menu opened from a row's `[⋯]`: **Rename** (`pencil`
  → panel 4), **Set as default** (`star` → promotes this board, 3.7.3), and a
  **danger Delete** (`trash` → panel 5). On the already-default board **Set as
  default** is disabled; on the last remaining board **Delete** is disabled
  (panel 6).
- **New-board / rename `Modal`** (`--radius-modal`) — an `Input` (name) and, for
  create, a two-option **type** picker: **Kanban** selected (the only enabled
  option) and **Scrum** disabled with an **Epic 4** `Pill` (Story 4.5 — the Scrum
  board variant is out of scope here). A `hint` notes new boards seed default
  columns off the project workflow.
- **Delete confirm `Modal`** — a danger `trash` glyph title + an **info
  `callout`** (the hue in the tinted box with `--el-text-strong`, finding #35)
  making the board-≠-issue-owner contract explicit; a danger confirm `Button`.

## Lifecycle contract (the invariants the UI must respect)

A board is **not** the owner of work items — a card's column is DERIVED from
`work_item.status`; the board only carries column/swimlane **config**. So:

- **Create** (`POST /api/boards`, 3.7.3) — names a board + seeds its default
  columns off the project workflow (so it's usable immediately), non-default,
  then the switcher switches to it.
- **Rename** (`PATCH …/[id]`) — label only; issues + config untouched.
- **Set as default** (`PATCH …/[id]`) — flips the project's single default in one
  tx (exactly one default per project, the 3.7.2 partial-unique invariant). New
  sessions open the default board.
- **Delete** (`DELETE …/[id]`) — removes the board + its column/config rows;
  **work items are never deleted** (they stay on the project, visible on the
  other boards). Two guards: the **last board can't be deleted** (typed `409`,
  mirrored as the disabled affordance + a `menu-note` explanation), and deleting
  the **default promotes** the next board by position to default.

Every write is **optimistic-with-reconcile** against the 3.7.3 endpoints; a
failed write reverts the optimistic change + a danger `Toast`. Outcomes (switch,
delete-and-promote) are announced via an `aria-live`/`role="status"` region.

## One-board + last-board (panel 6)

A project always keeps **≥1 board**, so the switcher is **always present** even
with one board (one row, no clutter). That board's manage menu disables **Set as
default** (it already is) and **Delete**, with a `menu-note` naming the
last-board guard. The disabled affordance is the **client mirror** of the API
guard — the server still rejects the last-board delete `409` regardless of what
is rendered.

## States (completeness)

- **Loading** — the switcher trigger renders as a skeleton while
  `GET /api/boards` resolves; the board still shows the current selection.
- **Error** — a failed board-**list** load shows an inline `ErrorState` with
  Retry (the 3.2.2 board pattern) and never blanks the board itself.
- **Empty** — there is no zero-board state (the project always has ≥1 board); the
  one-board case is panel 6.

## Permissions

Board CRUD is a project-config **write**. Roles/permissions are Epic 6.4, so
(matching the 2.2.5 workflow editor + the 3.3 / 3.6 board config) the surface is
**membership-gated now** (any project member) with a `TODO(6.4)` to role-gate
later — **board admin becomes project-admin-gated under Story 6.4**, after which a
non-admin sees the switcher (to switch boards) with the New / manage affordances
hidden and the server re-gating every write `403`. No early RBAC build.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the accent on the active-board
  check + the New-board action + the selected type option, the neutral `Pill` for
  the Default badge, the info-tint callout, the danger red on Delete, the
  issue-type hues on the board-preview cards. Tints carry the hue in the
  BACKGROUND with `--el-text-strong` text (finding #35 AA — never a tinted page
  surface).
- **Shape** via element-semantic tokens (`--radius-input`/`-card`/`-modal`/
  `-btn`/`-control`/`-badge`, `--shadow-subtle`/`-elevated`/`-modal`,
  `--spacing-control-*`/`-chip-*`/`-input-*`, `--height-control`/`-input`/
  `-btn-sm`).
- **Not colour-alone** (finding #35): the active board carries a check (not just
  the highlight), the default carries the **Default** Pill (not just position),
  delete/guard state carries text + icon. The switcher is a `role="menu"` with
  `menuitemradio` rows; the manage menu's disabled items carry `aria-disabled` +
  the explanatory note; outcomes are announced (`aria-live`).
- **No nested buttons** — a board row is a `div` holding the `.bsw-pick` and the
  `.icon-btn` as siblings, so the pick target and the manage target are distinct
  controls.

---

# Per-board settings (Story 3.7)

Design reference for Story 3.7's per-board **settings** delta. Asset:
**`per-board-settings.mock.html`** (+ `per-board-settings.png` export). It is the
source of truth for the UI subtask **3.7.8** (thread the selected board through
the settings page + entries), which carries **3.7.7** in `dependsOn`. The
selected-board read it relies on is **3.7.5**; the settings surface it scopes is
**3.6.3**; the switcher + manage menu it extends are **3.7.4**.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and **EXTENDS two shipped surfaces with NO new vocabulary** —
the **3.6.1 board-config page** (the `settings/project/workflow` grammar: serif
`h2` + muted subtitle + an `mx-auto` editor; the unmapped tray; the column `[⋯]`
menu; the settings-landing nav cards) and the **3.7.1 board switcher** (the
trigger + dropdown `Menu` + the per-board manage menu). It is a new ARRANGEMENT
of shipped pieces, not a new screen.

## Why this is a delta (the gap it closes)

Today board settings configure the project **default** board only:
`settings/project/board` resolves the default board (`boardsService.getBoard`
without a `boardId`), and every entry point — the column `[⋯]` "Board
settings →", the unmapped-tray "Map columns", the settings landing card — links
there with **no board context**. With many boards per project (Story 3.7) each
board carries its OWN columns / column→status mapping / swimlane group-by / WIP
(all already board-scoped in the schema), so settings must target the
**selected** board. That scoping was unspecified in `design/boards/`, so the
planning-time design gate (3.7.7) produces this asset FIRST — it gates 3.7.8.

**Mirror product = Jira's per-board "Configure board"** (decision-ladder rung 1;
VERIFIED June 2026, Atlassian docs — checked, not asserted, per `notes.html`
mistake #33): each board has its OWN configuration, reached FROM that board
(board → ⋯ → **Board settings / Configure board**), and the config screen NAMES
the board it edits and lets you switch board. Per-board settings reached from the
board is the standard; default-only is the gap.

## The asset is multi-panel (review EACH)

- **(0) Board-scoped settings page** — the 3.6.1 page, now board-scoped. The new
  header element is a right-aligned **board switcher** under a **"Configuring
  board"** label that NAMES the board being edited (here `Triage`, not the
  default); the crumb carries the board name (`Settings · motir · Board ·
Triage`). The editor body (name field · unmapped rail · column manager) is the
  **unchanged 3.6.3 surface**, just built from THAT board's projection.
- **(1) Switcher open on the settings page** — reuses the 3.7.4 switcher
  vocabulary (the dropdown `Menu` with `menuitemradio` rows ordered by
  `board.position`, the active board's **check**, the project default's
  **Default** Pill), but picking a board **re-targets which board you
  configure**: it updates `?board=<id>` and re-lays the settings editor. There is
  **no "New board" action here** — creating a board is the 3.7.4 switcher's job
  on `/boards`; this menu only switches the configured board.
- **(2) Manage-menu "Board settings" item** — the 3.7.4 switcher manage menu
  (a board row's `[⋯]`) gains a **"Board settings"** item (a `sliders` glyph)
  between **Set as default** and the destructive **Delete**. It navigates to
  `/settings/project/board?board=<id>` for THAT board — the Jira-faithful
  reached-from-the-board path.
- **(3) Cross-links carry the active board** — the column `[⋯]` **"Board
  settings →"** (`ColumnActionsMenu`), the unmapped-tray **"Map columns →"**
  (`UnmappedStatusesTray`), and the settings landing **"Board"** card all reflect
  board context. The three reached **from `/boards`** (manage menu, tray, column
  menu) carry `?board=<id>` so they open the board being viewed; the
  **settings-landing card** has no board context (it lives outside `/boards`), so
  it opens the **default** board, and the in-page switcher (panel 1) is then the
  way to any other board's settings.
- **(4) States + permissions** — **absent `?board=`** resolves the project's
  `isDefault` board (the default-only behaviour preserved, never broken); a
  **board outside the active project / workspace** → a 404 `ErrorState`, never a
  cross-tenant read (the 3.7.5 tenant-safety guard); **membership-gated now**,
  project-admin-gated under Story 6.4 (a non-admin then sees the 3.6.1 panel-5
  read-only treatment and the server re-gates every write `403`).

## Composing primitives (what 3.7.8 builds with)

- **Settings-page header** — the 3.6.1 `ed-head` (serif title + muted subtitle),
  PLUS a right-aligned **board switcher** reusing the 3.7.4 `BoardSwitcher`
  trigger + menu vocabulary, under a small "Configuring board" `SectionLabel`.
  The page reads `?board=<id>` (defaulting to the default board) and builds its
  `BoardConfigModel` from that board.
- **Manage-menu item** — a new `MenuItem` ("Board settings", `sliders`
  glyph) added to the 3.7.4 manage `Menu`, a `Link` to
  `/settings/project/board?board=<id>`.
- **Cross-link entries** — the existing `ColumnActionsMenu` "Board settings →",
  `UnmappedStatusesTray` "Map columns →", and `BoardSettingsCard` thread the
  active `?board=` (the board ones from the `/boards` URL; the landing card opens
  the default).

No service / schema change: 3.7.5 already taught `getBoard` to take a `boardId`,
and the 3.6.2 config writes are already board-scoped — this is a UI/URL threading
of the selected board.

## Permissions

Board settings is a board-config **write**. Roles/permissions are Epic 6.4, so
(matching the 2.2.5 workflow editor + the 3.3 / 3.6 / 3.7 board config) the
surface is **membership-gated now** with a `TODO(6.4)` to role-gate later —
board admin becomes **project-admin-gated under Story 6.4**, after which a
non-admin sees the page read-only and the server re-gates every write `403`. No
early RBAC build.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the `--el-accent` on the active
  board's check, the neutral `Pill` for the Default badge, the `--el-tint-yellow`
  unmapped tray + `--el-tint-peach` warn callout (the cross-tenant not-found
  note), the `--el-info` info callouts, the danger red on Delete. Tints carry the
  hue in the BACKGROUND with `--el-text-strong` text (finding #35 AA — never a
  tinted page surface).
- **Shape** via element-semantic tokens (`--radius-input`/`-card`/`-badge`/
  `-control`, `--shadow-subtle`/`-elevated`, `--spacing-control-*`/`-chip-*`/
  `-input-*`/`-card-padding`, `--height-control`/`-input`).
- **Not colour-alone** (finding #35): the active board carries a check (not just
  the highlight); the default carries the **Default** Pill; the "Board settings"
  item carries the `sliders` icon + label; the state callouts pair hue with an
  icon + text.
- **No nested buttons** — the switcher board rows stay the 3.7.1 `div` holding
  the `.bsw-pick` + `.icon-btn` siblings; the navcards are `<a>` links. The
  switcher is a `role="menu"` with `menuitemradio` rows; the settings-page
  switcher is announced as "Configure which board"; board switches re-lay the
  editor (the 3.7.5 selected-board re-read).

---

# Scrum board (Story 4.5)

Design reference for the **Scrum** variant of the board. Asset:
**`scrum.mock.html`** (+ `scrum.png` export). It is the source of truth for the
UI subtask **4.5.3** (scrum page resolution + sprint header + per-column point
totals + no-active-sprint state), which carries **4.5.1** in `dependsOn` and
binds to the **4.5.2** projection (`sprint` + `columnPoints`). The complete-
sprint flow it mounts is **Story 4.4**; the Backlog its empty-state links to is
**Story 4.2**; the burndown chart it seams for is **Story 4.6**.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and is **CHROME over the EXISTING board with NO new board
vocabulary** — it REUSES the **3.2 board** (columns, cards, drag-as-transition,
load-more / virtualization) and the **3.3 swimlanes / WIP** layer wholesale, fed
the 4.5.2 sprint-scoped projection. It draws ONLY the net-new Scrum surfaces (the
sprint header, the per-column point pill, the no-active-sprint state); it does
**not** redraw columns / cards / drag states / swimlanes / WIP (those are
referenced from `board.mock.html` + `swimlanes-wip.mock.html`, not re-spec'd).

## Why this is an extension (the gap it closes)

The 3.2.1 board mockup drew the **Kanban** surface only. A Scrum board is the
same board scoped to a board's **active sprint**, under a sprint header — and the
header (name / goal / dates / time remaining / points), the per-column point
totals, the **no-active-sprint** empty state, and the **complete-sprint** entry
point were all unspecified in `design/boards/` (== no design under the gate). So
the planning-time design gate (4.5.1) produces this asset FIRST — it gates 4.5.3.

**Mirror product = Jira's scrum board active-sprint view** (decision-ladder
rung 1; VERIFIED June 2026, Atlassian docs — checked, not asserted, per
`notes.html` mistake #33): a scrum board shows the **active sprint** under a
sprint header carrying the sprint name + goal + dates + a **sprint-health** points
summary, with **per-column point totals** in the column headers and a **Complete
sprint** button; before a sprint is started (or after it completes) the board
area shows a no-active-sprint state pointing at the Backlog. The numeric points +
per-column totals are the standard; the burndown CHART is a separate report
(here, Story 4.6).

## The asset is multi-panel (review EACH)

- **(0) The full scrum board** — the 3.2.2 page shell, then the **sprint header**
  (a labelled landmark), then the REUSED 3.2/3.3 board scoped to the active
  sprint, each reused column header gaining a muted **point-total pill**. A
  `reuse-note` ribbon marks what is reused vs net-new.
- **(1) Sprint-header anatomy** — name + state `Pill`; the **goal** truncated to
  one line with the `Tooltip` reveal shown OPEN (full goal text); the **date
  range** + **time remaining**; the **points summary** (committed / completed /
  remaining as labelled numbers, Remaining on the lavender emphasis tile); the
  **Complete-sprint** entry point.
- **(2) No active sprint** — `sprint: null` → the board area is replaced by an
  `EmptyState` (a **flag** icon, "No active sprint", a one-line explainer, a
  **Go to Backlog →** CTA). Distinct from the 3.2.6 "No issues yet" _inbox_
  empty-board state.
- **(3) Edge states** — **unestimated** (point figures show "—", never `NaN`);
  **overdue** (time-remaining becomes an "Ended" peach chip with an alert glyph +
  the word — never colour alone); **loading** (a header skeleton over the 3.2.2
  column-skeleton scaffold).
- **(4) Column-header slot coexistence** — the read order **name → card-count
  badge (3.2.1) → point-total pill (NEW) → spacer → WIP slot (3.3) → actions**,
  shown with and without a WIP limit so the three header slots are seen not to
  crowd.

## The sprint header (`SprintHeader` — subtask 4.5.3)

A **labelled landmark** (`<section aria-label="Sprint … — <state>, <remaining>">`)
above the reused board, built from the 4.5.2 `SprintSummaryDto`. It is a quiet
card BAND (`--el-surface-soft` + `--el-border` + `--radius-card`), NOT a tinted
page surface (finding #35). Two clusters:

- **Left (`.sh-main`)** — the sprint **name** (serif, `--el-text-strong`) + a
  state **`Pill`** (`Active` mint dot · `Planned` muted · `Complete` lavender);
  the **goal** on one line (`target` glyph + a bold `Goal ·` lead + the text),
  truncated with `text-overflow: ellipsis` and a `Tooltip` revealing the full
  text on hover/focus (keyboard-operable, not hover-only); the **dates** line
  (`calendar` glyph + `Jun 2 – Jun 14`) and **time remaining** (`clock` glyph +
  "5 days remaining" / "Ends Jun 14" / the "Ended" chip).
- **Right (`.sh-right`)** — the **points summary** (three `.stat` blocks —
  Committed / Completed / **Remaining**; Remaining on `--el-tint-lavender`, the
  others on `--el-muted`) + the **Complete-sprint** `Button`
  (`secondary`, `check-check` glyph).

`daysRemaining` (from `SprintSummaryDto`) drives time-remaining; it is floored at
0 (an overdue sprint reads **"Ended"**, never a negative number). The points are
the `SprintSummaryDto.points` aggregate (NOT a sum over the loaded card page —
finding #57). The **burndown CHART is Story 4.6** — the header shows numeric
remaining only and leaves a chart seam.

## Complete-sprint is an ENTRY POINT only (the flow is Story 4.4)

The header mounts a **Complete sprint** button, but the complete-sprint FLOW
(confirm modal + carry-over of unfinished issues + the sprint report) is **Story
4.4**. 4.5.3 mounts 4.4's exposed action if available, otherwise renders the
button as a **seam 4.4 wires** — the same seam pattern 3.2 used for the Epic-6
**Filter** button. 4.5 implements neither carry-over nor the report.

## Per-column point totals (the "sprint health" pill)

Each REUSED column header gains a `.col-pts` pill (muted, mono, `N pts`) from
`SprintSummaryDto.columnPoints[columnId]`. It sits in the **left** group, right
after the 3.2.1 card-count badge (both describe the column's contents), while the
3.3 **WIP slot** stays right-aligned by the `[⋯]` actions — so count · points ·
(spacer) · WIP · actions coexist without crowding. Same column-header component
as the Kanban board; the pill is **conditional** on a scrum board having an
active sprint (a kanban board never renders it).

## No-active-sprint state (`sprint: null`)

When the 4.5.2 projection returns `sprint: null` for a scrum board (the common
pre-start / post-complete state), the board area is replaced by an `EmptyState`
— a **flag** icon (distinct from the 3.2.6 inbox), "No active sprint", a one-line
explainer, and a CTA **Go to Backlog →** (Story 4.2 route). 4.5 does NOT start a
sprint (that's 4.2 / 4.4); it links there. It never falls back to showing the
unscoped backlog as if it were a sprint, and never shows an empty six-column
board. A project with **no scrum board at all** falls through to the existing
Kanban board (3.2) — 4.5 only _replaces_ the view when a scrum board is resolved.

## Reuse, not rebuild (the load-bearing scope decision)

The columns, cards, drag-as-transition, snap-back, keyboard DnD, per-column
load-more + virtualization (3.2) and the swimlanes + WIP layer (3.3) are the
**SAME** components, rendered with the sprint-scoped projection. Swimlanes / WIP
compose on the scrum board for free (Jira scrum boards have both) because it is
the same board component. The ONLY net-new UI is `SprintHeader` + the per-column
point pill + the no-active-sprint state + the page-level `type == scrum`
resolution. A card move is still a workflow transition (the 3.2 contract is
unchanged) and never changes the sprint.

## States (completeness)

- **Loading** — the 3.2.2 board scaffold PLUS a header **skeleton** (name / goal
  / points / button placeholders).
- **Error / no board** — the 3.2.2 `ErrorState` (Retry) — referenced from
  `board.mock.html` panel 6, not redrawn.
- **No active sprint** — the `EmptyState` above (NOT an empty board).
- **Unestimated sprint** — point figures show "—" (the DTO stays total, returns
  0s; the UI owns the "—" presentation). The board still renders.
- **Overdue sprint** — the "Ended" chip; `daysRemaining` floored at 0.

## Permissions

The scrum board is a **read** of the sprint-scoped projection; viewing is
**membership-gated now** (matching the 3.2 board), with the finding-#26
application-layer `workspaceId` gate on `getBoard` covering the new sprint reads.
The complete-sprint action's gating is **Story 4.4**'s concern (the flow 4.5
mounts); 4.5 only places the entry point.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the **state Pill** tones
  (`--el-tint-mint` Active · `--el-muted` Planned · `--el-tint-lavender`
  Complete), the Remaining emphasis tile (`--el-tint-lavender`), the "Ended" chip
  (`--el-tint-peach` bg + `--el-warning` glyph), the reused card type-hues
  (`--el-type-*`) + priority `Pill` tones. Tints carry the hue in the BACKGROUND
  with `--el-text-strong` text (finding #35 AA — never a tinted page surface; the
  header band is `--el-surface-soft`, not a tint).
- **Shape** via element-semantic tokens (`--radius-card`/`-btn`/`-badge`/
  `-control`, `--shadow-subtle`/`-elevated`, `--spacing-chip-*`/`-control-*`/
  `-btn-x`/`-card-padding`, `--height-btn-sm`/`-control`). `rounded-full` only on
  the genuinely-circular state dot + avatar.
- **Not colour-alone** (finding #35): time remaining is **text** ("5 days
  remaining" / "Ended"), never colour; the state is a Pill with a **dot + word**;
  the points are **labelled numbers** (not a colour-coded bar); the "Ended"
  treatment pairs the peach tint with an alert glyph + the word.
- **Landmark + labels** — the sprint header is a labelled `<section>`; the points
  summary carries an `aria-label` naming the committed/completed/remaining
  figures so assistive tech reads them as a sentence; the loading header is
  `aria-busy`.
- **No nested buttons** — the header's only controls are the standalone
  Complete-sprint `<button>` and (in the board) the column `[⋯]` buttons; the
  empty-state CTA is an `<a>`; cards stay `<a>` (the 3.2 whole-card link). Every
  icon `<svg>` carries a 24×24 `viewBox`.
