# Work-items — design notes

Design reference for the `work-items` UI area. Each surface names the design
asset it lives in, the primitives it composes from, copy strings, and placement.

| Surface                                          | Asset                                       | Notes                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issue detail page                                | `detail.pen` (Pencil) + `detail.png`        | header eyebrow + Description / Explanation / Activity (left) · core-fields rail (right). Built across 2.4.1–2.4.4.                                                                                                                                                                               |
| Create issue modal                               | `create.pen` + `create.png`                 | type/parent/title/description/priority + optional Explanation (panel 3).                                                                                                                                                                                                                         |
| Tree view (issue list, nested)                   | `tree.pen` + `tree.png`                     | issue tree rows + the `[Filter]`·`[Tree ▾]`·`[+ New issue]` toolbar.                                                                                                                                                                                                                             |
| **Tree view at scale (sort · lazy · virtual)**   | **`tree-scale.mock.html`** (HTML mockup)    | The scale shape `tree.png` leaves unspecified (it loads the whole forest, no sort headers) — sortable treegrid headers + lazy-expand + virtualization. Finding #57. Gates 2.5.13 + 2.5.14. See below.                                                                                            |
| **Flat sortable List view + view switcher**      | **`list.mock.html`** (HTML mockup)          | The List mode `tree.png` leaves unspecified (it draws only Tree + a disabled switcher seam). Gates 2.5.8. See below.                                                                                                                                                                             |
| **Filter bar (kind · status · assignee · text)** | **`filter.mock.html`** (HTML mockup)        | The open `[Filter]` popover `tree.png` leaves unspecified (it draws only a disabled `[Filter]` seam). Gates 2.5.4. See below.                                                                                                                                                                    |
| **Relationships panel + ready/blocked badge**    | **`relationships.mock.html`** (HTML mockup) | The element `detail.pen` does NOT specify. See below.                                                                                                                                                                                                                                            |
| **Link management (add / remove links)**         | **`links.mock.html`** (HTML mockup)         | Extends the relationships panel with the add/remove UI (2.4.8 → 2.4.9). See below.                                                                                                                                                                                                               |
| **DatePicker calendar (Due-date field)**         | **`datepicker.mock.html`** (HTML mockup)    | The design-system replacement for the native `<input type="date">` popup; consumed by the Due-date fields (2.4.11 → 2.4.12). See below.                                                                                                                                                          |
| **Create modal — Due date field**                | **`create.mock.html`** (HTML mockup)        | Extends `create.pen` with a Due-date row (`DatePicker`, after Priority) — finding #56 / "mirror Jira" (2.3.11 → 2.3.12). See below.                                                                                                                                                              |
| **Work-item quick view (peek)**                  | **`quick-view.mock.html`** (HTML mockup)    | The peek modal + row trigger neither `tree.png` nor the 2.4 detail design specifies — a large two-column in-list preview (full description + core-fields rail) with "Open full page →", plus the **ready/blocked readiness banner** in the peek (2.5.20). Gates 2.5.19 + 2.5.21. See below.      |
| **Comments + @mentions (Activity section)**      | **`comments.mock.html`** (HTML mockup)      | The comment thread, composer, mention popup and every comment state — `detail.pen` draws ONLY the Activity placeholder ("Comments coming in Epic 5"). Single-level threading, oldest-first + sort toggle, "Edited" tag, hard-delete confirm, "Show more" paging. Gates 5.1.4 + 5.1.5. See below. |

---

## Relationships panel + ready/blocked badge (Story 2.4 · 2.4.5)

`detail.pen` stops at the Parent rail field — it specifies no dependency/link
surface and no readiness signal. This HTML mockup (`relationships.mock.html`,
built from the live `--el-*` tokens + the shipped primitives) is the design
asset for that surface. The code subtask (2.4.5) composes the same primitives.

### Placement

A **left-column section card** (`Card` + `ContentSectionCard` header grammar),
a sibling of Description / Explanation / Activity, placed **after Explanation,
before Activity**. NOT a rail field-box — the rail holds single scalar values,
while relationships is a grouped, multi-row list that needs the content width.
On the **edit page** the same block renders read-only (panel 4), so an editor
keeps dependency context while editing.

### Anatomy

- **Header** — `ContentSectionCard` title `Relationships` + muted gloss
  `— dependencies & links`. Header-right carries a muted, non-interactive
  `Manage in Epic 5` note (link create/remove is Epic 5 — this surface is
  read-only; the note is the documented extension slot, mirroring Activity's
  "Comments coming in Epic 5").
- **Readiness banner** (the prominent ready/blocked treatment; the reusable
  `ReadinessBadge` primitive Epic 3 boards / Epic 6 reports reuse) — a
  full-width tinted row at the TOP of the card:
  - **Blocked** → `--el-tint-peach` bg, `circle-alert` icon in `--color-warning`,
    bold **Blocked**, detail `Waiting on N issue(s) — PROD-3, PROD-8` (the open,
    non-terminal blockers NAMED as mono links).
  - **Ready** → `--el-tint-mint` bg, `circle-check-big` icon in `--color-success`,
    **Ready to start** / `All blockers resolved`.
  - **Shown only when the item has blockers** (a "blocked by" in-edge). An item
    nothing blocks shows no banner — there is no readiness signal to give.
- **Groups** — one per kind, each rendered only when non-empty, in this order:
  **Blocked by · Blocks · Relates to · Duplicates · Clones**. Each group =
  a `SectionLabel` header + a mono count + a list of rows.
- **Row** (mirrors the 2.4.3 `ChildList` row): `IssueTypeIcon` (lucide glyph in
  the type's `--el-type-*` hue) · identifier (mono, muted) · title (truncates) ·
  status `Pill`. The whole row is a link to that issue's detail page. An **open
  blocker** (non-terminal, in the Blocked-by group) carries a small
  `--color-warning` dot before its icon so the banner's named blockers are
  locatable in the list.
  - **Alignment:** the identifier and title share a **baseline** (the smaller
    mono id sits on the title's line, not vertically centered against it); the
    icon, dot, and status pill are vertically centered. In code (2.4.5) use
    `items-baseline` on the row with the icon/pill `self-center`, and truncate
    the title inside a `min-w-0` child so it keeps both the ellipsis and the
    text baseline.
- **Empty** (no links at all) → muted italic `No linked issues yet.` (never
  blank), and no readiness banner.

### States in the mockup

Panels, in order: **(0)** placement in the detail page · **(1)** blocked
(multi-group) · **(2)** ready · **(3)** no links · **(4)** edit-page read-only
block.

### Tokens / a11y

- Status pills go through `Pill`'s tones (`planned`/`in-progress`/`done` →
  lavender/sky/mint tint with `--el-text-strong` text — finding #35 AA-safe). A
  cross-project linked status the bundled workflow can't classify falls back to
  `Pill tone="neutral"` showing the raw key.
- Readiness state is conveyed by **text** ("Blocked" / "Ready to start"), never
  colour alone — the icon + tint are redundant cues. Clears the shell-a11y axe
  sweep (the detail-route sweep is 2.4.6's scope).
- Colour flows only through `--el-*` (the mockup copies the Tier-0→Tier-3 wiring
  from `globals.css`); toggle dark mode in the mockup to confirm token parity.

### Out of scope (documented extension slots)

Link **create/remove** UI (the "Manage" affordance) is Epic 5 collaboration —
this surface reads links only. `ReadinessBadge` is built reusable for Epic 3
boards + Epic 6 reports.

---

## Link management — add / remove relationship links (Story 2.4 · 2.4.8 → 2.4.9)

`links.mock.html` extends the relationships panel with the add/remove
interaction 2.4.5 deferred (it was read-only). Backend already ships —
`workItemsService.linkWorkItems` / `unlinkWorkItems` (1.4.4) + the typed trigger
errors. Mirror product: Jira's "Link issue" affordance on the issue detail view.

### Entry point

The read-only "Manage in Epic 5" header note is REPLACED by a quiet **"+ Link
issue"** button (`--el-link`, `Plus` icon) in the relationships card header.
Clicking it reveals the inline add form at the top of the card body (above the
banner/groups); it toggles to a "Cancel" affordance while open.

### Add form (inline, not a modal)

A `--el-surface-soft` bordered block holding one row:

- **Kind selector** — a `Combobox`/`Popover` trigger (`role="combobox"`) showing
  the current kind + chevron; the menu lists the five kinds **Blocked by ·
  Blocks · Relates to · Duplicates · Clones** (default "Blocked by"), the active
  one check-marked. Maps to `WorkItemLinkKindDto` (note: "blocks" is the inverse
  direction of `is_blocked_by` — the action layer flips from/to accordingly).
- **Issue-search Combobox** (the shipped 2.3.4 `Combobox`, listbox-combobox, not
  Radix Popover) — `Search` icon + input; the anchored `role="listbox"` shows
  candidate rows (type icon · identifier · title) from a workspace-scoped
  `listLinkCandidates` read (excludes self + already-linked; cross-project
  allowed per the link model). Empty results → muted "No matching issues."
- **Actions** — `Button variant="primary"` **Add** (disabled until an issue is
  selected) + ghost **Cancel**.
- A selected target shows as a **chip** (icon · id · title · clear ×) replacing
  the input until cleared.

### Errors (inline, AA-safe)

The 1.4.4 trigger errors round-trip to an inline **rose-tint banner**
(`--el-tint-rose` bg + `--el-text-strong` text + a `CircleAlert` in `--el-danger`
— finding #35, not red text on white): **self-link** ("PROD-N can't link to
itself"), **duplicate** ("This link already exists"), **cycle** ("That would
create a dependency cycle"), **cross-workspace** (candidate list already
prevents it, but the trigger backstops). Nothing persists on error.

### Remove

Each link row gains a quiet **× remove** button (`--el-text-muted`, hover →
`--el-tint-rose`/`--el-danger`) at the row end. Clicking opens a small **confirm
popover** ("Remove the blocked-by link to PROD-N? The issue isn't deleted — only
the link.") with a `--el-danger` Remove + ghost Cancel. Removing a `relates_to`
link drops both reciprocal rows (the service already does this).

### Tokens / a11y

- Reuses the relationships row grammar (id+title baseline, icon/pill centered).
- All new surfaces route through `--el-*`; the add combobox reuses the 2.3.4
  `Combobox` a11y (clears the STRICT axe sweep). Errors use strong-on-tint (AA),
  NOT `--el-danger` text on white. Light + dark parity (toggle in the mock).

### Create modal — Linked issues (panel 5)

`create.pen` ALSO designs a **"Linked issues"** section in the create modal (a
relationship-kind chip + a linked row + an "Add link" affordance + "Choose a
relationship") — but it was **never built** (2.3.3/2.3.4 shipped the modal
without it). It reuses the SAME kind selector + issue-search `Combobox` + remove
affordance as the detail panel, so the design is shared. The one real
difference is **timing**: at create the issue has no id yet, so chosen links are
**collected in form state** (rendered as pending rows with a relationship-kind
chip) and **written when the issue is created** — in / right after
`createWorkItem`, in the same flow — NOT immediately. Errors that need the new
id (cycle) are validated on create; self-link is impossible (no id yet);
duplicate is prevented in the pending list. This is a distinct code path from
the detail-page immediate write, so it's its own subtask (**2.4.10**), built on
the same AddLink control (2.4.9) + this design.

### States in the mockup

Panels: **(0)** entry point + per-row remove · **(1)** add form open + kind menu ·
**(2)** combobox typing (candidates) · **(3)** selected → Add enabled + the inline
error states · **(4)** remove confirm · **(5)** the create-modal Linked-issues
section (collect-then-write-on-create).

### Out of scope

Bulk-link / link from the list/board surfaces (Epic 3/2.5), and a typed
relationship beyond the five kinds, are not in 2.4.9 / 2.4.10.

---

## DatePicker calendar (Story 2.4 · 2.4.11 → 2.4.12)

The design-system **date picker** — the replacement for the native
`<input type="date">` calendar popup. The Due-date FIELD already uses the
`Input` primitive, but the native browser _calendar_ is OS chrome and breaks the
design system. This designs the in-system calendar so the 2.4.12 code subtask
(`components/ui/DatePicker`) composes our own primitives instead of improvising
(the design gate — there is no calendar in the system today). Asset:
`design/work-items/datepicker.mock.html`.

### Where it's used

The Due-date field on the issue **create modal** (2.3.3), the **edit form**
(2.3.6), and the **detail core-fields rail** (2.4.2). All three swap the native
control for `DatePicker`. Due date is **nullable**, so cleared is a first-class
state, not an error.

### Anatomy

- **Trigger** — an `Input`-styled field (composes `Input.tsx`'s chrome:
  `--height-input` 44px, `--radius-input`, `--el-border-strong` hairline,
  `--spacing-input-x` padding, the standard `focus` ring). A leading
  **calendar glyph** (lucide `calendar`, `--el-text-muted`); the value formats
  through the existing `formatDate` helper ("Jun 4, 2026"); a placeholder
  ("Select a date", `--el-text-muted`) when null. A trailing **Clear ×** shows
  ONLY when a date is set — hover tints `--el-tint-rose`/`--el-danger` (matches
  the link-row remove affordance from 2.4.9).
  - **Structure (important for 2.4.12):** the field is a **container**, not a
    single `<button>`. The calendar-open affordance (glyph + value) and the
    **Clear** button are **siblings** — the Clear `<button>` is NOT nested
    inside the trigger button (a `<button>` may not contain another `<button>`;
    the parser ejects the nested one and the × renders outside the field). So
    the field row = the `Popover.Trigger` surface (glyph + value → opens the
    calendar) + a separate Clear button at the row end.
- **Calendar popover** — floats in the `Popover` primitive (`--radius-card`,
  `--shadow-elevated`, `--el-border`), anchored to the trigger, `width ≈ 296px`.
  Contents:
  - **Caption row** — "June 2026" (`--el-text`, 14px/600) + prev/next-month
    `nav-btn`s (28px square, `--radius-control`, ghost → `--el-surface` hover,
    lucide `chevron-left`/`chevron-right`).
  - **Weekday header** — Su–Sa, `--el-text-faint`, 11px/600 uppercase.
  - **Day grid** — 6 rows × 7 cols, each cell a 36px square button at
    `--radius-control`. The grid always shows leading/trailing days from the
    adjacent months (the `is-outside` state) so every month renders 6 full rows
    (no layout jump on month change).
  - **Footer** — **Today** (jumps the view + focus to the current date) and
    **Clear** (sets null), separated by a `--el-border-soft` rule.

### Day-cell states (the authority for 2.4.12)

| State                           | Treatment                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Default                         | `--el-text`, transparent bg, transparent border                                               |
| Hover                           | `--el-sidebar-item-bg-hover` fill                                                             |
| **Today**                       | `--el-border-strong` ring + **bold** + a small `--el-accent` **dot** under the number         |
| **Selected**                    | `--el-accent` **filled** circle, `--el-accent-text` ink, bold (hover → `--el-accent-pressed`) |
| Focused (keyboard)              | 2px `--focus-ring-color` ring (roving tabindex)                                               |
| Outside month                   | `--el-text-faint`, still clickable/navigable                                                  |
| Disabled (out of min/max range) | `--el-text-faint` + strikethrough, not selectable                                             |

**Today and selection are NOT conveyed by colour alone** (WCAG 1.4.1 /
finding #35): selected differs in _shape_ (a filled circle), today carries a
_ring + dot_ — a colour-blind / greyscale reader still distinguishes them. All
colour flows through `--el-*` (finding #54); when the selected fill needs an
inverted dot (today + selected), it uses `--el-accent-text`. Light + dark parity
(toggle in the mock).

### Keyboard model (for 2.4.12 to implement)

The grid uses **roving tabindex** — exactly one day is tabbable; focus moves
within the grid, re-rendering (and shifting the view month) as needed:

- `←` / `→` — focus previous / next day (±1)
- `↑` / `↓` — focus same weekday previous / next week (±7)
- `PageUp` / `PageDown` — previous / next month (same day-of-month)
- `Home` / `End` — first / last day of the focused week
- `Enter` / `Space` — select the focused day (closes the popover)
- `Esc` — close without changing; focus returns to the trigger

Crossing a month boundary with an arrow re-renders the grid to the new month
with focus on the landed day. The popover opens with focus on the selected day
(or today when null).

### States in the mockup

Panels: **(0)** placement in the core-fields rail · **(1)** trigger states
(placeholder / filled+Clear / focused / disabled) · **(2)** the open calendar
(live: click, nav, arrow-key the demo) · **(3)** every day-cell state, labelled ·
**(4)** cleared → placeholder. Selected = Jun 4, 2026; today = Jun 5, 2026.

### Out of scope

Range selection (start↔end), time-of-day, and a month/year quick-jump picker are
not in 2.4.12 — single nullable date only. Min/max range wiring (the `disabled`
state) is drawn here but only enforced where a field constrains it (none in 2.4).

---

## Flat sortable List view + the `[Tree ▾]` view switcher (Story 2.5 · 2.5.7 → 2.5.8)

`tree.png` designs only the **Tree** view and ships a **disabled** `[Tree ▾]`
control as a forward-compatible seam (2.5.3's `IssueListToolbar`). It does NOT
specify the **flat List mode** that control will toggle to, nor the open
switcher menu. `list.mock.html` is the design asset for both — built from the
live `--el-*` tokens + the shipped primitives, so the code subtask (**2.5.8**)
composes the same primitives with no Pencil→code gap. Mirror product: Jira's
issue-navigator "List" view + its view/sort headers.

### What's new vs. the Tree (and what's reused verbatim)

The List is the **same table as the Tree, un-nested and sortable**. Only three
things are new; everything else is the shipped `IssueTreeTable` (2.5.3):

- **Flat rows** — no indent, no chevron, no `treegrid` nesting. The rows are the
  project's issues in the active sort order (the Tree's depth-first order is
  gone).
- **Sortable column headers** — each header is a sort button (see below).
- **The switcher menu** — the `[Tree ▾]` control becomes a real menu.

Reused **with zero new primitives** (satisfies the AC "no new visual primitive
invented; consistent with tree.png"): the **whole column set** the shipped
`IssueTreeTable` already renders, the cell vocabulary, the container chrome
(`rounded-(--radius-card)` bordered box, `--el-surface-soft` header), and the
whole-row link to `/issues/[identifier]`.

### Columns — the SAME set the shipped Tree renders

`IssueTreeTable` already renders seven columns (it went beyond `tree.png`'s
three drawn columns — that shipped code is enforced reality, rung 2). The List
**reuses that exact set and order**, so Tree↔List is column-identical and 2.5.8
reuses the same `cell` render-props:

| Column   | Width (px) | Cell                                                  | Sorts by                       |
| -------- | ---------- | ----------------------------------------------------- | ------------------------------ |
| Title    | `1fr`      | `IssueTypeIcon` (type hue) · mono identifier · title  | **issue key** (the default)    |
| Priority | 120        | `PRIORITY_META` chip (`Pill` tone + direction icon)   | priority rank (highest→lowest) |
| Assignee | 150        | initial-letter `Avatar` · name, or muted "Unassigned" | assignee name                  |
| Reporter | 150        | initial-letter `Avatar` · name                        | reporter name                  |
| Due      | 120        | formatted date, or muted `—`                          | due date                       |
| Est.     | 90 (end)   | formatted duration, or muted `—` (right-aligned)      | estimate minutes               |
| Status   | 130        | `Pill` by lifecycle category (the `STATUS_TONE` map)  | workflow status order          |

Grid template (identical to `IssueTreeTable` / `IssueTreeSkeleton`):
`minmax(0,1fr) 120px 150px 150px 120px 90px 130px`.

**Decision — no NEW "Updated" column (the card offered Priority/Updated as
optional extras).** Priority is already a Tree column, and the seven existing
columns already give rich, meaningful sort axes — so the List earns its keep
through _sorting the existing columns_, not by adding data. Adding `updated_at`
would be new plumbing into `IssueRowData` + a new cell for marginal gain over
the existing Due/Est/Priority sorts ("no complexity for nothing"). An **Updated**
column (and column show/hide) belongs with Epic 6 saved-views, where recency
sort earns its place; noted as the documented extension, not built here.

### Sortable headers — the affordance

- Each header is a **sort button** (`text-(--el-text-secondary)`, uppercase
  11px, the existing header type) carrying a **caret** that is hidden by default.
- **Hover** a header → the caret fades in faint (`--el-text-faint`, ~55%) and
  the label goes to `--el-text` — the "this is sortable" affordance.
- **Active column** → caret is solid (`--el-text-secondary`), `ChevronUp` for
  **asc** / `ChevronDown` for **desc**, and the header cell carries
  `aria-sort="ascending|descending"`. Inactive headers are `aria-sort="none"`.
- **Default sort = `key` asc** — the **Title** column (the issue key is the mono
  identifier leading that cell), matching 2.5.8's AC. The Title header shows the
  active ascending caret on first paint.
- **Interaction (built in 2.5.8):** clicking a header sorts by that column asc;
  clicking the active header toggles asc↔desc; clicking another column moves the
  active sort there (asc). **Single-column sort only** — multi-sort is Epic 6.
- The right-aligned **Est.** column keeps its header + caret right-aligned.

### View switcher menu

The `[Tree ▾]` toolbar control (disabled placeholder in 2.5.3) becomes a real
menu (a `Popover` / menu, `aria-haspopup="menu"`). The trigger shows the
**active view's** label + icon (`ListTree` for Tree, `List` for List) + a
`ChevronDown`. The open menu lists two `menuitemradio` rows:

- **Tree** — `ListTree` icon + "Tree".
- **List** — `List` icon + "List".

The **active** row gets `--el-surface` bg, semibold weight, and a trailing
`Check` in `--el-accent`. Menu container is `--radius-card` + `--shadow-elevated`;
rows are `--radius-control` + `--spacing-control-*` padding (the shipped
menu-row shape). View choice is **URL-driven** in 2.5.8 (`?view=tree|list`), so
the trigger label reflects `?view` on load.

### Empty + loading

- **Empty** — reused **verbatim** from the Tree: the shipped `EmptyState`
  ("No issues yet" / "Create your first issue to start tracking work." +
  `NewIssueButton`). The switcher doesn't change an empty project; **no delta**.
- **Loading** — the Tree's `IssueTreeSkeleton` with **one delta: the rows are
  FLAT** — no per-row `INDENT` offset and no leading chevron block. Same column
  grid, same header, same shimmer bars/chips/avatars, so there's no layout shift
  on settle.

### Tokens / a11y

- Colour flows only through `--el-*`; status via `Pill`'s `status` tones,
  priority via the shared `PRIORITY_META` chip (hue in the tint, `--el-text-strong`
  text — finding #35 AA-safe), type icons take their `--el-type-*` hue.
- Shape via the element-semantic tokens (`--radius-card` / `--radius-control` /
  `--radius-badge`, `--spacing-control-*`, `--height-control`,
  `--shadow-elevated`) so the List re-shapes under `data-display-style`.
- **Sortable headers carry `aria-sort`** (2.5.8 wires the live value) — required
  by the 2.5.6 strict shell-a11y sweep, which adds the List view to its scope.
  Sort direction is conveyed by the caret glyph + `aria-sort` text, never colour
  alone. Toggle dark mode in the mock to confirm token parity.

### Pagination — server-paged navigator (2.5.10 → 2.5.12, finding #57)

The List **must not load every row** — a real backlog is thousands of issues
(finding #57). It is **server-paged** (mirroring Jira's issue navigator): a
fixed **page size of 50**, a `LIMIT/OFFSET` read + a count, and a **footer bar**
inside the same bordered table box (`--el-surface-soft`, top border):

- **Left — the range/count:** `Showing 1–50 of 1,234`. The total is the count of
  the **currently filtered** set (so the count tracks the 2.5.4 filter), with the
  `1–50` range reflecting the active page.
- **Right — the pager** (`<nav aria-label="Pagination">`): a **Prev** chevron
  button, numbered page buttons with **ellipsis truncation** at both ends
  (`1 … 12 [13] 14 … 25`), and a **Next** chevron button. The current page is the
  **accent chip** + `aria-current="page"` (not colour alone — it's also the only
  non-bordered, filled button). **Prev is disabled on page 1, Next on the last
  page** (`aria-disabled`, faint).
- **URL-driven:** the bar drives a `?page=` param that **composes with
  `?view`/`?sort`/filter** and is part of the route's Suspense key, so changing
  page re-shows the skeleton while the next page streams (panel 4's loader).
- **Edge states (for 2.5.12):** an out-of-range `?page` **clamps to the last
  page**; a filter that yields **0 rows** shows the empty state (panel 3) with
  **no pager** (or "0 of 0"); a single page hides/disables both chevrons. Page
  size 50 is a constant (Epic 6 may make it configurable — not here).
- **The Tree does NOT use this** — a hierarchy can't be cut at "row N"; the Tree
  scales via lazy-load + virtualization (2.5.11 → 2.5.13/2.5.14), a separate
  design.

Reuses shipped shape tokens (`--radius-control`, `--height-control`-class
buttons) + `--el-*`; no new primitive — page buttons are the Button affordance,
chevrons are lucide.

### States in the mockup

Panels: **(0)** the List view in the `/issues` shell (toolbar + flat table,
default key asc) · **(1)** the switcher menu open (Tree / List, List checked) ·
**(2)** re-sorted by Priority desc (the active-sort indicator moved + the desc
caret) · **(3)** empty state · **(4)** the flat loading skeleton · **(5)** the
**pagination footer** — page 1 (Prev disabled, page-1 current) + a middle page
(13 of 25, both ends ellipsed).

### Out of scope (documented extension slots)

Saved / named views, multi-column sort, column show/hide config, and an
**Updated** column are **Epic 6** (saved views & advanced search) — not invented
here. Bulk actions from the list are also out of scope for 2.5.8. Configurable
page size + cursor (vs offset) paging are Epic-6 refinements; 2.5.12 ships
offset paging at a fixed 50.

---

## Tree view at scale — sortable headers · lazy-expand · virtualization (Story 2.5 · 2.5.11 → 2.5.13 / 2.5.14)

`tree.png` + the shipped `TreeTable` (2.5.2) / `getProjectTree` read (2.5.1)
load the **whole forest at once** with **no column sorting** — fine for a demo,
**prototype-thinking at real-product scale** (finding #57). Jira's hierarchy
grids (Structure / Advanced Roadmaps) don't paginate a tree; they **lazy-load a
node's children on expand** and **virtualize** rows, and they let you **sort
siblings within their parent**. `tree-scale.mock.html` is the design asset for
that scale shape — built from the live `--el-*` tokens + the shipped primitives
(the same `role="treegrid"` markup, 22px per-level indent, rotate-on-expand
chevron, stretched row link with the chevron raised `relative z-10` so no button
nests inside the `<a>`), so the code subtasks (**2.5.13** lazy reads · **2.5.14**
lazy/virtual/sortable `TreeTable`) compose the same vocabulary with no
Pencil→code gap. Mirror product: Jira Structure / Advanced Roadmaps.

### What's new vs. tree.png (and what's reused verbatim)

The tree is the **same treegrid**, made sortable + lazy + virtualized. Only
three things are new; everything else is the shipped `IssueTreeTable`:

- **Sortable tree-grid headers** — the **exact** asc/desc/unsorted caret
  affordance the List shipped (`list.mock.html`), applied to the
  `role="treegrid"` header row.
- **Lazy-expand** — a collapsed parent shows the chevron without loading its
  children; expanding fetches them (a spinner placeholder row on the expanding
  node); a **"Load more children"** affordance when a parent has more children
  than the per-node page.
- **Virtualization** — invisible (only viewport rows mount); documented, no
  distinct visual.

Reused **with zero new primitives** (satisfies the AC "no new visual primitive;
consistent with tree.png"): the seven-column set (Title · Priority · Assignee ·
Reporter · Due · Est. · Status — **column-identical to the List**, so Tree↔List
matches), the row vocabulary, the container chrome, the indent + chevron, the
whole-row link, and the empty / loading states (unchanged from `tree.png` —
not re-drawn here).

### Sortable headers — the affordance

Identical to the List's (see that section); on the treegrid:

- Each header is a **sort button** (uppercase 11px `--el-text-secondary`) with a
  **caret** hidden by default, faint on hover (`--el-text-faint`, ~55%), solid on
  the active column (`--el-text-secondary`): `ChevronUp` = **asc**,
  `ChevronDown` = **desc**. The active header cell carries
  `aria-sort="ascending|descending"`; the rest are `aria-sort="none"`.
- **Default sort = `key` asc** — the **Title** column (the mono identifier).
- **Single-column sort only** (multi-sort is Epic 6). Clicking a header sorts by
  it asc; clicking the active header toggles asc↔desc; clicking another moves the
  active sort there. The right-aligned **Est.** header keeps its caret
  right-aligned.
- **Sorting re-orders siblings WITHIN every parent — the hierarchy is
  preserved.** Each lazy children-fetch carries the same `ORDER BY <sort>`, so
  siblings sort under their own parent and **no row ever leaves its parent**.
  (Panel 1: by Priority desc, under PROD-12 the High story rises above the
  Medium ones; under it the Highest bug → High task → Medium task.) Sort is
  conveyed by the caret glyph **and** `aria-sort` text, **never colour alone**
  (WCAG 1.4.1 / finding #35).

### Lazy-expand — per-node paging

- **Per-node page size = 50 children.** A node's children are fetched on first
  expand, 50 at a time, ordered by the active sort. (2.5.13 shapes the read:
  `listRoots` + `listChildren(parentId, { sort, cursor, take: 50 })`.)
- **Collapsed parent** — shows the chevron (it has children) **without** loading
  them; `aria-expanded="false"`. The whole-forest count is NOT pre-fetched.
- **Expanding** — the node flips `aria-expanded="true"` + `aria-busy="true"` and
  renders **one spinner placeholder row** at the children's indent
  (`Loading children…`, the lucide `loader` ring) until the page arrives, then
  the real rows replace it.
- **"Load more children"** — when a parent has more children than the loaded
  page, a quiet `--el-link` row sits at the **end of that parent's loaded
  children**, at the children's indent: a `ChevronDown` glyph + **"Load more
  children"** + a faint `--el-text-faint` count (`Showing 50 of 128`). Clicking
  fetches the next page (same `ORDER BY`) and **appends** — the parent never
  collapses. This is per-node paging, distinct from the **List**'s flat
  whole-result pagination (2.5.10 / 2.5.12).

### Virtualization — invisible, but a11y-honest

Only the rows in (or near) the viewport mount; off-view rows are removed from the
DOM and a spacer preserves scroll height. **No distinct visual** — a virtualized
row is identical to a non-virtualized one (so the mock documents it rather than
drawing it). **A11y holds across the window:** each mounted row keeps its true
`aria-level` / `aria-posinset` / `aria-setsize` (the lazy read returns the
per-node total for `aria-setsize`, e.g. `posinset 19 / setsize 128`), so a
screen reader announces the real position even though only a window exists. The
shipped `TreeTable`'s **roving-tabindex** keyboard model is unchanged:
<kbd>↑</kbd>/<kbd>↓</kbd> move the active row (auto-scroll mounts the landed
row), <kbd>→</kbd> expands a collapsed parent (triggering its lazy fetch) or
steps into children, <kbd>←</kbd> collapses or steps to the parent,
<kbd>Enter</kbd> activates the row link.

### Tokens / a11y

- Colour flows only through `--el-*`; status via `Pill`'s tones, priority via the
  shared `PRIORITY_META` chip (hue in the tint, `--el-text-strong` text — finding
  #35 AA-safe), type icons take their `--el-type-*` hue.
- Shape via element-semantic tokens (`--radius-card` container, `--radius-badge`
  chips, `--radius-control` chevron, `--spacing-control-*`, `--shadow-*`) so the
  tree re-shapes under `data-display-style`.
- The treegrid keeps the shipped WAI-ARIA pattern: `role="treegrid"` › rowgroup ›
  row(`aria-level`/`posinset`/`setsize`/`expanded`) › gridcell, sortable headers
  carrying `aria-sort` (2.5.14 wires the live value), exactly one row tabbable
  (roving tabindex). The full sweep is the Story E2E + strict a11y (2.5.6, which
  already lists 2.5.14 in `depends_on`). Toggle dark mode in the mock to confirm
  token parity.

### States in the mockup

Panels: **(0)** the Tree in the `/issues` shell — sortable headers, nested rows,
default sort key asc, a **collapsed** parent (PROD-23) showing its chevron with
no children loaded · **(1)** sorted by **Priority desc** — siblings re-ordered
**within** every parent, hierarchy preserved, the active caret moved ·
**(2)** lazy-expand **in progress** — PROD-23 mid-expand with the spinner
placeholder child row · **(3)** **"Load more children"** — a paged parent
(showing 50 of 128) with the load-more affordance row · **(4)** virtualization +
keyboard / `aria-sort` note (no distinct visual).

### Out of scope (documented extension slots)

Multi-column sort, saved / named views, and column show/hide are **Epic 6**.
Cross-project / workspace-wide tree scale, and a count-all-descendants badge, are
not built here. The **List**'s flat pagination is its own design (2.5.10) + code
(2.5.12) — this section is the **tree** (per-node) shape only.

---

## Filter bar — kind · status · assignee · text (Story 2.5 · 2.5.9 → 2.5.4)

`tree.png` draws the `[Filter]` toolbar control only in its **disabled, closed**
state — a forward-compatible seam (2.5.3's `IssueListToolbar`, the same one
`list.mock.html` carries). It does NOT specify the **open filter surface** that
control opens. `filter.mock.html` is the design asset for it — built from the
live `--el-*` tokens + the shipped primitives, so the code subtask (**2.5.4**)
composes the same primitives with no Pencil→code gap. Mirror product: Jira's
issue-navigator basic filters / Linear's filter menu (a popover of faceted
multi-selects + a text quick-filter).

### Shape — a Popover of faceted multi-selects, NO new primitive

The `[Filter]` control becomes an **enabled** `ToolbarButton` (same `.tb-btn`
shape) that opens a **`Popover`** (`role="dialog"`, `aria-haspopup="dialog"`)
anchored under it (left-aligned). The popover surface reuses the **exact card
chrome the view-switcher menu uses**: `--radius-card` container, `--el-border`
hairline, `--shadow-elevated`. Inside, **four facets**, top to bottom:

| Facet        | Source (already in context)                                        | Row vocabulary (reused)                                                         |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Text**     | a free-text quick-filter over identifier + title                   | the bordered `Combobox` **search input** (`--radius-input`, leading `Search`)   |
| **Kind**     | `ISSUE_TYPE_META` (the five issue types)                           | `IssueTypeIcon` (type hue) · label · trailing `Check`                           |
| **Status**   | the project's **workflow statuses** (`StatusPicker` option source) | the `StatusPicker` **dot** (`status.color ?? category var`) · label · `Check`   |
| **Assignee** | workspace members + an explicit **"Unassigned"**                   | member-combobox `Avatar` (initial-letter) · name · `Check`; Unassigned is first |

Each facet is a **multi-select** `role="listbox"` (`aria-multiselectable="true"`)
of `role="option"` rows — the **same option-row vocabulary the `Combobox`
ships** (leading glyph · label · optional secondary · trailing `Check`), made
multi-select: `aria-selected="true"` adds the `--el-surface` row tint + the
`--el-accent` `Check`. **No new picker primitive** (satisfies the AC) — the kind
icons, the status dot, the member avatar, and the option row all already exist;
only the popover that composes them and the trigger's count badge are new, which
is exactly 2.5.4's scope. The Assignee facet carries the member-combobox's own
**"Search members…"** type-ahead since membership can be long; the top-level
**Text** facet is the issue quick-filter (distinct placeholder "Find by ID or
title…").

### The trigger — active state + the count badge

- **Inactive** (no filters): the `[Filter]` button reads exactly like the
  shipped seam (`Sliders` icon + "Filter"), now **enabled**.
- **Active** (≥1 filter applied): the button gains a faint accent ring
  (`--el-accent` border + `--el-tint-lavender` fill, the icon → `--el-accent`)
  and a trailing **count badge** — a small `--radius-badge` `--el-accent` chip
  with `--el-accent-text` ink showing the **number of active filter values**
  (each selected kind/status/assignee option counts 1; a non-empty text counts
  1). The badge is the **only net-new affordance** over the disabled seam. AA:
  the button label stays `--el-text` on the page bg (never hue-on-hue).

### Clear + apply

- **"Clear filters"** lives in the popover **header**, right-aligned (`X` glyph +
  label, `--el-link`). It is **disabled/greyed when nothing is selected** and
  active once any facet has a value; clicking it resets every facet to empty
  (→ the full unfiltered tree). The same reset is reachable from the trigger.
- **No Apply button.** Filters apply **live** and serialize to the **URL query**
  (`?kind=…&status=…&assignee=…&q=…`, `assignee=unassigned` for the Unassigned
  bucket) — the durable, shareable/reload-safe substrate Epic 6 saved filters
  persist. The Server Component reads the params and re-queries.

### Context-preserving result (reuses 2.5.1)

Filtering feeds `getProjectTree`'s **ancestor-retaining** filter (2.5.1): a
matching descendant keeps its **ancestor chain visible for context**. In the
mockup's applied panel, ancestor rows that don't themselves match read **muted**
(`--el-text-muted`); the actual matches read full-strength — so the tree stays
legible instead of collapsing to orphaned rows. This is the shipped Tree row
vocabulary (`IssueTypeIcon` · identifier · `Pill`), not a new surface.

### Tokens / a11y

- Colour flows only through `--el-*`: the count badge / selected-row tint /
  `Check` use `--el-accent`; status dots use the `StatusPicker` category vars
  via their `--el-*` equivalents (todo → `--el-text-faint`, in_progress →
  `--el-info`, done → `--el-success`; a custom-coloured status like "In Review"
  carries its own colour); kind icons take their `--el-type-*` hue; result pills
  are `Pill` tones (hue in the tint, `--el-text-strong` text — finding #35
  AA-safe).
- Shape via element-semantic tokens (`--radius-card` popover, `--radius-input`
  search field, `--radius-control` rows, `--radius-badge` count chip,
  `--spacing-control-*`, `--height-control`, `--shadow-elevated`) so the filter
  bar re-shapes under `data-display-style`.
- The popover is a labelled `role="dialog"`; each facet is a `role="group"` +
  multi-select `role="listbox"` of `role="option"` rows with `aria-selected`;
  the trigger carries `aria-haspopup="dialog"` + `aria-expanded`, and the count
  badge an `aria-label` ("N filters active"). Selection state is conveyed by the
  `Check` glyph + `aria-selected`, never colour alone. Toggle dark mode in the
  mock to confirm token parity. The end-to-end filter behaviour (incl. the URL
  round-trip + ancestor retention) is driven by the Story E2E (2.5.6).

### States in the mockup

Panels: **(0)** the `[Filter]` trigger — closed-inactive vs. closed-active
(accent ring + count badge) in the `/issues` toolbar · **(1)** the popover open,
**empty** (nothing selected, "Clear filters" disabled) · **(2)** the popover
open, **populated** (text "oauth" · Bug · In Progress + In Review · Dana Kim +
Unassigned → badge 5, "Clear filters" active) · **(3)** the applied filter on the
page — the active trigger over the context-preserving tree.

### Out of scope (documented extension slots)

**Saved / named filters**, the shareable-filter management UI, **advanced search
operators** (boolean/JQL-style), and filtering by custom fields are **Epic 6**
(saved views & advanced search) — the URL serialization 2.5.4 ships is the
forward-compatible substrate they build on, not a throwaway. Sorting the
filtered set is the **List view's** job (2.5.8), not the filter bar's.

---

## Create modal — Due date field (Story 2.3 · 2.3.11 → 2.3.12)

`create.mock.html` extends the create-issue modal (2.3.3) with a **Due date**
field — finding #56 ("yes, mirror Jira"). Jira's create dialog collects a Due
date; Prodect's modal did not, and `create.pen` designs the modal with
type/parent/title/description/priority (+ an **Assignee** field that was never
built — finding #51) but **no Due date**. This pins where it goes and how it
composes, so 2.3.12 isn't improvising (the design gate — `create.pen` omits it).

### What's new (and what's reused)

The field **reuses the shipped `DatePicker`** (2.4.11 design / 2.4.12 code) —
no new component. The only new design decision is its **placement and label**:

- **A "Due date" row placed right AFTER Priority** (and before "Linked issues"),
  matching the shipped **edit form**'s field order (Priority → Due date →
  Estimate, 2.3.6) and Jira's create dialog. It uses the modal's existing
  label-over-control row grammar (same as Type / Parent / Priority).
- The control is the **`DatePicker` trigger** — `Input`-styled field (calendar
  glyph + value or "Select a date" placeholder + a Clear ×), opening the
  `Popover` month grid. All states/tokens are exactly the `DatePicker`'s
  (see the DatePicker section); nothing about the calendar changes here.
- **Nullable** — Due date is optional at create; default is the placeholder, no
  value. (Jira likewise lets you create without a due date.)

### Behaviour (for 2.3.12)

- The chosen date is **collected in the modal's form state** (an ISO
  `YYYY-MM-DD` string, like the other create fields) and written when the issue
  is created — passed through `createIssueAction` → `createWorkItem`. The
  `work_item.dueDate` column already exists (the edit form writes it); this just
  wires the create path to it. No new calendar behaviour.
- UTC-safe conversion on submit (the same `${date}T00:00:00.000Z` the edit form
  - detail rail use) — no local-tz off-by-one.

### States in the mockup

Panels: **(1)** the modal with Due date **empty** (placeholder, after Priority) ·
**(2)** Due date **filled** (Jun 4, 2026) with the **calendar open** anchored
under the field (the same grid the shipped `DatePicker` draws; selected Jun 4,
today Jun 5). The other modal fields are drawn as representative controls (their
real pickers are already shipped) — only the Due-date field is specified here.

### Out of scope

The `create.pen` **Assignee** field (designed, never built — finding #51) is NOT
addressed here. Date ranges / relative presets / time-of-day stay out (the
`DatePicker` is single-date only).

---

## Work-item quick view (peek) modal (Story 2.5 · 2.5.18 → 2.5.19; readiness 2.5.20 → 2.5.21)

`quick-view.mock.html` is the design for the `/issues` **quick view** — a _peek_
overlay that previews a work item **without leaving the list**, with a prominent
path to the full detail page. Neither `tree.png` nor the 2.4 detail design (`detail.pen`)
draws this surface, so the planning-time design gate (`notes.html` mistake #31)
requires it before code Subtask **2.5.19**, the same way `list.mock.html` (2.5.7)
and `filter.mock.html` (2.5.9) closed the gate for the List view and the filter
popover. Built from the live `--el-*` tokens + the shipped primitives; **no new
visual primitive is invented** (AC).

**Composing primitives (all shipped):**

- **`components/ui/Modal`** — the dialog shell (the same one `CreateIssueModal`
  (2.3.3) and `create.mock.html` use): backdrop, centered panel, `--shadow-modal`,
  `--radius-modal`, the `×` close button, and the focus-trap / `Esc` / return-focus
  behaviour. The peek is **large** — it takes a big part of the screen: **≈940px
  wide, ~82vh tall** (`max-w-[58rem]` + a `max-h-[82vh]`, capped so it never
  exceeds the viewport). This is wider than Modal's stock `size="lg"`, so 2.5.19
  passes an explicit `size="xl"` / a `max-w-[58rem]` className (add the `xl` size
  token to `Modal` if not present — the per-component growth pattern). **Sizing
  rationale (per Yue, 2026-06-06, decision-authority rung-0 user directive):** the
  card framed the peek as a small "condensed subset"; Yue overrode that — the peek
  should be generous and show the **full** description, not a teaser. It remains a
  _peek_ (read-only, prominent "Open full page", no inline edit / no comments feed),
  just a big one — the Linear/Jira peek shape.
- **`IssueTypeIcon`** — the type glyph in its type hue (`--el-type-{epic|story|task|bug|subtask}`),
  in the header bar.
- **`Pill`** — the Status chip (lifecycle-category tone via the `STATUS_TONE` map)
  in the header + the rail, and the Priority chip (`PRIORITY_META`) in the rail —
  the exact chips the rows + detail page already render.
- **Avatar** — the initial-letter assignee + reporter avatars (same as the row `cell-person`).
- **`Button`** — `btn-primary` "Open full page →" (in the header bar) + `btn-ghost`
  "Close" (in the empty state); the `×` close `icon-btn` in the header.

### The row trigger — resolving the nested-interactive problem

The Tree (2.5.3) and List (2.5.8) rows are **already a whole-row link** to
`/issues/[key]`, shipped as a wrapping `<a class="lt-row" href>`. A quick-view
`<button>` **cannot nest inside that `<a>`** (no nested interactive elements; it
breaks AT semantics and HTML validity). Resolution:

- Render the row as a **relative `<div role="row">`** (was the `<a>`).
- The navigation link moves **into the Title cell** and is rendered as a
  **stretched link** — an `<a>` whose **`::after { position:absolute; inset:0 }`**
  overlay covers the whole row. Clicking anywhere on the row (except a layered
  control) navigates; the row title is the link's accessible name.
- Add a **trailing row-actions cell** (a new **40px** column appended to the
  shipped 7-column grid → `… 130px 40px`; **Tree and List share the same
  template**, so both gain it together). It holds the quick-view **icon
  `<button>`** (lucide **`eye`**, `aria-label="Quick view PROD-N: <title>"`),
  positioned **`z-index: 1` above** the stretched-link overlay. Button and link
  are **siblings, never nested**.
- The button is **hidden at rest** (`opacity: 0`), revealed on row `:hover` /
  `:focus-within` (and on its own `:focus-visible`), and **always visible on
  coarse pointers** (`@media (hover: none)`) so touch users get it. The 40px
  column is always reserved → no layout shift.

### Modal layout — a large, two-column peek

The peek is a generous overlay (NOT a small card): a **sticky header bar** over a
**two-column body** — a scrollable main column + a core-fields rail. It reads like
the detail page, scoped to a peek.

| Region                 | Content                                                                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header bar (sticky)    | `IssueTypeIcon` (type hue) · **`PROD-N`** (mono, a **link** to `/issues/[key]`) · Status `Pill` · spacer · **`btn-primary` "Open full page →"** · `×` close `icon-btn`                                                                                                                                          |
| Main (scrollable, 1fr) | the title (serif `--font-serif` 27px, matches the detail header), then the **full Markdown description** (`MarkdownView`) under a "Description" label, then a quiet `--el-text-muted` footer line naming what's full-page-only                                                                                  |
| Rail (300px)           | the detail page's **core-fields rail, condensed** — **Status** (`Pill`) · **Assignee** (Avatar + name) · **Reporter** (Avatar + name) · **Priority** (`PRIORITY_META` chip) · **Due date** · **Estimate** (clock glyph + duration) · **Parent** (breadcrumb link). `--el-surface-soft` bg, left hairline border |

**What the peek shows vs. what stays detail-only.** Shown: type, key, title, the
**readiness banner** (ready/blocked — 2.5.20, see below), the **full description**,
status, assignee, reporter, priority, due, estimate, parent.
**Detail-only** (reached via _Open full page →_ in the header bar / the header
identifier — both clearly go to the detail page): the **Explanation**, the
**child list**, the **full relationships/links panel** (2.4.5) — the Blocked-by /
Blocks / Relates-to / Duplicates / Clones groups and link add/remove — **attachments**,
**labels**, and the **activity / comments feed**. The peek is a big, read-only preview —
editing and the heavier sections live on the full page. **(Reconciliation, 2.5.20:** the
readiness **signal** moved OUT of detail-only and INTO the peek; only the full
relationships **panel** stays detail-only.)

### Readiness — ready / blocked (Subtask 2.5.20)

The peek surfaces the item's **readiness** so a viewer can tell, while scanning the
list, whether an item is **Ready to start** or **Blocked** (and on what) — without
opening the full page. It **reuses the shipped `ReadinessBadge` (2.4.5)** verbatim — the
SAME mint / peach banner the detail page's relationships panel renders — so **no new
visual primitive** is invented.

- **Placement** — a full-width banner at the **top of the main column, directly under
  the title and above the Description** (panel 2). Rationale: the title identifies the
  item; "can I start this?" is the next thing a scanner wants, so the banner is the first
  thing in the scrollable main area. NOT the rail — the rail holds scalar fields, while a
  full-width call-out reads stronger and matches how the badge sits atop its section on
  the detail page.
- **States** — **blocked** (peach, `circle-alert` in `--color-warning`, **Blocked** +
  `Waiting on N work item(s) — PROD-3, PROD-8` naming the open, non-terminal blockers);
  **ready** (mint, `circle-check-big` in `--color-success`, **Ready to start** / `All
blockers resolved`); and **no blockers → NO banner at all** — mirror the detail-page
  rule: an item with no `is_blocked_by` in-edge has no readiness signal to give. Panel 2
  draws **blocked** in context; **panel 3** draws **ready** + the **no-banner** case.
- **Only while the item is in the `todo` category** — once a peeked item is in-progress or
  done, the readiness banner is suppressed regardless of blockers: "can I start this?" is
  moot once work has started or finished (2.5.21). So the banner shows iff the item is
  todo-category AND has blockers.
- **Blocker links swap the peek** — a named blocker link pushes **`?peek=<blockerKey>`**
  (staying on `/issues`, swapping the peeked item) rather than navigating to
  `/issues/[key]`. Rationale: the peek exists to inspect _without losing your place_, so
  swapping keeps the user in-list and Back / `Esc` steps back through peeked items. This
  is a **justified deviation** from the detail-page badge (which links straight to
  `/issues/[key]` because there is no peek there): the only delta 2.5.21 passes to the
  shared component is each blocker's `href` (`?peek=…` instead of `/issues/[key]`) — the
  `ReadinessBadge` component itself is unchanged.
- **Data — no new query.** `readiness` is **already part of the core detail read** the
  peek issues: `getIssueDetail` returns `readiness: { ready, openBlockers }` — the same
  verdict the detail page feeds to `ReadinessBadge` — so 2.5.21 renders the badge from
  data already in hand (it maps `openBlockers` → `{ identifier, href }` exactly as the
  detail page does, only with the `?peek=` href). State is conveyed by **text + icon,
  never colour alone** (AA-safe, finding #35); colour flows only through `--el-*`.

### States (multi-panel)

1. **Populated** — panel 2 (drawn **blocked**, so the readiness banner is visible in
   context).
2. **Readiness states** (panel 3) — the **ready** banner + the **no-blockers** case
   (no banner), isolated side-by-side (2.5.20, see above).
3. **Loading** (panel 4) — the modal opens immediately (URL-driven, `?peek=PROD-N`);
   the item's fields fetch in the background. Skeleton bars (`--el-muted`, gentle
   pulse) hold the header / main / rail layout so the modal doesn't resize when data
   lands. The _Open full page_ button is live throughout.
4. **Not found / no access** (panel 5) — a stale `?peek=` key (deleted issue) or a
   forbidden one shows a centered empty state (the header bar keeps only the `×`):
   a `search-x` glyph in a muted circle, **"This issue isn't available"**, a line
   explaining it may have been moved/deleted or is in a workspace you can't access,
   and a `btn-ghost` **Close**. **Cross-workspace returns the same not-found**
   (finding #44's pure-workspace gate — never leak existence). A `lock` glyph
   variant covers an explicit no-access message if the product later distinguishes
   them. No _Open full page_ button (there is no page to open).
5. **Mobile / narrow** (panel 6) — the same Modal renders as a full-height bottom
   **sheet** (rounded top corners, grab handle, scrollable body, ~90% height)
   instead of a centered dialog. The 300px rail **collapses into a compact meta
   strip** (Assignee · Priority · Due) above the description; _Open full page_ is
   pinned full-width at the bottom as the primary action; close is backdrop /
   swipe-down / `Esc`.

### Opened from both views

The trigger lives in the **shared row-actions cell**, so the peek opens
identically from a Tree row or a List row. The modal is **URL-driven**
(`?peek=PROD-N` on `/issues`) so it survives a refresh, is shareable/deep-linkable,
and Back closes it — the standard "preview as a URL state" pattern (Linear's peek,
GitHub's issue hovercard→modal). 2.5.19's data load reuses `getWorkItemByIdentifier`
/ the detail aggregate read (the same source the full page uses) — the peek shows
the full description + core fields, so it needs the same core read, just without the
heavier child-list / relationships / activity sub-queries (those stay full-page).

### Colour + shape

Colour only through `--el-*`: type hue via `--el-type-*`, status/priority via the
`Pill` tones (hue in the tint background, `--el-text-strong` text — AA-safe,
finding #35), `--el-link` for the identifier + "Open full page", `--el-text-faint`
meta labels. Shape through the element-semantic tokens — `--radius-modal` (panel),
`--radius-badge` (pills), `--radius-control` (icon button + close), `--radius-btn`
(footer buttons), `--shadow-modal`, `--height-control` / `--spacing-icon-btn` (the
quick-view button). No Tier-0 utilities, no raw `rounded-*`.

### Out of scope

Inline editing inside the peek (status / assignee change without opening the full
page) is **not** in 2.5.19 — the peek is read-only with one write path (navigate to
the detail page to edit). Prev/next navigation _between_ peeked issues, comments,
and the hovercard-on-hover variant stay out; the modal-on-click peek is the
scope. Keyboard-shortcut opening (e.g. a row's `Space`/`O`) is a nice-to-have for
2.5.19, not required by this design.

## Comments + @mentions — the Activity section (Story 5.1 · 5.1.3 → 5.1.4 / 5.1.5)

`comments.mock.html` is the design for the issue detail page's **comments
surface** — the thread, the composer, the mention popup, and every comment
state. `detail.pen` draws ONLY the Activity placeholder ("Activity" /
"Comments coming in Epic 5"); everything inside it is a whole element no
design specified, so the design gate (`notes.html` mistake #31) requires this
asset before code Subtasks **5.1.4** (mention capability in `MarkdownEditor` /
`MarkdownView`) and **5.1.5** (the comments section UI). Mirror: the Jira
Cloud issue-view Activity section (threaded comments GA ~2025) — the
Jira-verified decisions (single-level threading, oldest-first default +
per-user toggle, "Edited" tag, hard delete, "Show more" collapse) are recorded
in the 5.1 story module and drawn here. A `comments.png` export accompanies
the HTML for the board view; the HTML is the source of truth.

### Placement

The comments stream replaces the placeholder INSIDE the existing Activity
`ContentSectionCard` — detail left column, after Relationships and Children,
exactly where `detail.pen` puts the placeholder card (panel 0). The section
header keeps the `ContentSectionCard` grammar (16px sans semibold title +
`--el-text-secondary` gloss) and carries:

- the **total count** in the gloss (`— 12 comments`);
- the **Comments / History filter seam** — a two-button segmented control;
  Comments active, **History drawn disabled** (`opacity: 0.6`,
  `cursor: not-allowed`, title "History — field-change activity lands with
  Story 5.5") — the 2.5.3 view-switcher seam treatment. Story 5.5's slot.
- the **sort toggle** — a small bordered control (`--height-control`,
  `--radius-btn`, `--spacing-control-x`) with `arrow-down-narrow-wide` /
  `arrow-up-narrow-wide` (14px, `--el-text-muted`) + the label
  **Oldest first / Newest first**. Per-user, oldest-first default (Jira's
  `asc` + "Reverse sort direction").

### Comment row anatomy (panel 1)

Row = 22px initial-letter **Avatar** (the shipped `issueCellPrimitives`
treatment, verbatim) · **author** (13px semibold `--el-text`) · **relative
time** (12px `--el-text-muted`; absolute timestamp on hover via `title`) ·
the **"· Edited" tag** (12px muted; only when `editedAt` is set — latest
version only, no history; its `title` carries the edit timestamp). The body
renders through **`MarkdownView`** prose (14px / 1.6) with inline mention
chips. Below, the **quiet action row**: 12px text buttons (`--el-text-muted`,
hover `--el-text` on `--el-surface`; Delete hovers `--el-danger` on
`--el-tint-rose` — the `RemoveLinkButton` trigger grammar), separated by faint
`·` dots.

- **Reply** appears on ROOT comments only (single-level threading). On a
  reply, Reply re-targets the same thread and pre-mentions that reply's
  author (the Jira auto-tag — panel 4).
- **Replies** indent once behind a soft thread rail (2px
  `--el-border-soft` left border, 14px padding). Long threads collapse their
  middle behind **"Show N more replies"** (quiet 12px text button).
- **Role-dependent actions** (panel 2) are drawn present/absent — never
  disabled-but-visible: author → Reply · Edit · Delete; another member →
  Reply only; project admin / workspace admin/owner → Reply · Edit · Delete
  on anyone's.

### Composer (panels 3–4)

The shipped **`MarkdownEditor`** (2.3.5) in a **compact comment mode**, led
by the viewer's own 22px avatar:

- **Rest** — a collapsed one-line "Add a comment…" invitation
  (`--height-control`, `--radius-input`, `--el-surface` bg, muted text);
  focusing expands it. Keeps long threads from being dominated by an empty
  editor (the Jira shape).
- **Expanded** — the editor chrome verbatim: `--radius-input` container on
  `--el-surface`, `--el-highlight` focus border, the icon toolbar (16px lucide
  glyphs in `--spacing-icon-btn` buttons), ~72px min-height area; a
  right-aligned primary **Comment** `Button` (size sm) below, disabled while
  empty. <kbd>Esc</kbd> with an empty body collapses back to rest.
- **Submitting** — editor dimmed + disabled, the Comment button busy with the
  `loader-circle` spinner.
- **Edit-in-place** — Edit swaps the row's rendered body for the editor
  pre-loaded with the Markdown source (mentions round-trip intact — 5.1.4),
  with ghost **Cancel** + primary **Save**.
- **Reply composer** — opens indented inside the thread rail with the
  replied-to author pre-mentioned as a chip; ghost **Cancel** + primary
  **Reply**. Both restore focus to the action that opened them.

### Mention popup + chip (panel 5)

Typing `@` anchors a member listbox **at the caret** — the shipped
**`Combobox`** menu + option-row vocabulary verbatim: `--radius-card`
container, `--el-border`, `--shadow-elevated`, 4px inner padding; rows =
22px Avatar · name (13px) · secondary email (11px muted, right-aligned),
`--radius-control` / `--spacing-control-x/y`, active row `--el-surface`;
filter-as-you-type, ↑/↓/Enter/Esc, `aria-activedescendant`. Candidates = the
members who can VIEW the issue (the 6.4 `assignableMembersService` scoping),
supplied via 5.1.4's `mentionCandidates` prop.

**The mention chip** (the one new treatment this design introduces — for
5.1.4 to build): inline in the rendered body, `--el-tint-lavender` background

- `--el-text-strong` text (hue in the tint bg, AA-safe — finding #35),
  `--radius-badge` shape with the small-chip `--spacing-kbd-x/y` padding (an
  existing swap-layer pair — **no new `--el-*` or shape token is needed**),
  0.92em / 500 weight. Serializes as `[@Display Name](mention:<userId>)`; a
  stale/unknown id degrades to plain text, never a broken link.

### Pagination + sort (panel 6)

The read is cursor-paged from the most recent (20/page — finding #57, never
load-all) with a total count. **"Show more comments (N older)"** — a
full-width quiet control (`--height-control`, dashed `--el-border-strong`
border, `--radius-control`, `--el-surface-soft`) — always sits at the OLDER
edge, so it flips top/bottom with the sort direction (top in oldest-first,
bottom in newest-first). Clicking extends the page backward and keeps scroll
position. Replies load whole with their thread (bounded by single-level
threading).

### States (panels 7–9)

- **Loading** — comment-row-shaped pulse skeletons (`--el-muted` bars +
  avatar circle, `aria-busy`) — the `BacklogSkeleton` grammar — so the
  section doesn't jump when data lands.
- **Empty** — centered `message-square` (22px muted) + **"No comments yet —
  start the conversation"**; the composer stays live below. Mirrors the
  placeholder's grammar but inviting, never blank.
- **Error** — the `ErrorState` grammar inside the card: danger
  `triangle-alert`, serif title **"Couldn't load comments"**, muted line,
  secondary **Retry**.
- **Delete confirm** — the `RemoveLinkButton` confirm-**Popover** pattern
  verbatim (300px, `--radius-card` + `--shadow-elevated`, ghost Cancel +
  danger **Delete**), anchored to the row's Delete action. A root with
  replies names its cascade: **"Delete this comment? Also deletes N replies —
  comments can't be restored."**; a single comment/reply: **"Delete this
  comment? Comments can't be restored."** (hard delete — the deliberate
  decision recorded in 5.1.2; the revision trail records that a comment was
  deleted and by whom, rendered by Story 5.5).
- **Viewer (read-only)** — thread visible, NO composer and no
  Reply/Edit/Delete; a quiet line where the composer would sit (`eye` 14px +
  **"Read-only access — you can view comments but can't add them."** on
  `--el-surface-soft`, `--radius-control`) — the 6.4 read-only grammar,
  phrasing mirroring the shipped `readOnlyBoardBanner`.

### Copy strings

"Add a comment…" · "Comment" · "Save" · "Cancel" · "Reply" · "Edit" ·
"Delete" · "· Edited" · "Show more comments (N older)" · "Show N more
replies" · "Oldest first" / "Newest first" · "No comments yet — start the
conversation" · "Couldn't load comments" / "Something went wrong fetching the
conversation." / "Retry" · "Delete this comment? Also deletes N replies —
comments can't be restored." / "Delete this comment? Comments can't be
restored." · "Read-only access — you can view comments but can't add them." ·
History seam title: "History — field-change activity lands with Story 5.5".

### Tokens / a11y

Colour only through `--el-*` (chips put hue in the tint background with
`--el-text-strong` text — finding #35; the danger affordances use
`--el-danger` / `--el-tint-rose`); shape through the element-semantic tokens
(`--radius-card/input/control/btn/badge`, `--spacing-card-padding`,
`--spacing-control-x/y`, `--spacing-icon-btn`, `--spacing-kbd-x/y`,
`--height-control`, `--height-btn-sm`, `--shadow-card/elevated`) — no Tier-0
utilities, no raw `rounded-*`. The composer is labelled; the toolbar is
`role="toolbar"`; the mention popup is a `role="listbox"` with
`aria-activedescendant` (the Combobox a11y bar); timestamps and the Edited
tag are conveyed as text (`title` for absolute time); the skeleton sets
`aria-busy`; the confirm is a dialog with an explicit accessible name; focus
returns to the opening action after post/edit/delete. Light + dark parity via
the same tokens.

### Out of scope (documented extension slots)

**Per-comment visibility restriction** (Jira's padlock) is a deliberate
non-feature: it needs the company-managed role/group substrate, and Jira's
team-managed projects — the small-team shape Prodect mirrors — do not support
it; documented as an Epic-6 admin extension slot. **Realtime** live-updating
comments: no realtime substrate exists in the codebase; comments refresh on
navigation/action — a product-wide decision, not story-local. The **History
filter** is Story 5.5's slot (the disabled seam). **In-app notifications**
are Story 5.7; **watchers** are Story 5.4. Comment **reactions/emoji** and
edit **history** are not planned features of 5.1.
