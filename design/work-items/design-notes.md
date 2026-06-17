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
date; Motir's modal did not, and `create.pen` designs the modal with
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
team-managed projects — the small-team shape Motir mirrors — do not support
it; documented as an Epic-6 admin extension slot. **Realtime** live-updating
comments: no realtime substrate exists in the codebase; comments refresh on
navigation/action — a product-wide decision, not story-local. The **History
filter** is Story 5.5's slot (the disabled seam). **In-app notifications**
are Story 5.7; **watchers** are Story 5.4. Comment **reactions/emoji** and
edit **history** are not planned features of 5.1.

## Attachments panel + preview lightbox (Story 5.2 · 5.2.4 → 5.2.5 / 5.2.6)

`attachments.mock.html` is the design for the issue detail page's
**attachments surface** — the panel (strip + list views, upload, download,
permission-gated delete) and the preview lightbox. `detail.pen` draws NO
attachments section (the detail page reserves the Epic-5 slot in a code
comment only), so every element here is a whole element no design specified —
the design gate (`notes.html` mistake #31) requires this asset before code
Subtasks **5.2.5** (the panel) and **5.2.6** (the lightbox). Mirror: the Jira
Cloud issue-view attachments panel — the Jira-verified decisions (strip + list
views with a count, embeds-are-attachments with the editor-sourced delete
block, the three permissions, image/PDF-only preview, hard delete) are
recorded in the 5.2 story module and drawn here. Deviation, recorded with its
justification: the read is **cursor-paged (50/page) + "Show more (N)"** —
never Jira's load-all-then-degrade (finding #57). An `attachments.png` export
accompanies the HTML for the board view; the HTML is the source of truth.

### Placement

A left-column **`ContentSectionCard`** — content-width and multi-row, so the
rail is wrong for it (the rail is for scalars; the same argument that placed
Relationships, 2.4.5). It mounts in the detail page's reserved Epic-5 slot:
after Children, before Activity (5.1). The section header keeps the
`ContentSectionCard` grammar (16px sans semibold + `--el-text-secondary`
gloss) and carries:

- the **total count** in the gloss (`— 44`);
- the **strip/list view toggle** — the shipped `Segmented` vocabulary (the
  2.5.3 view-switcher grammar): icon + label `Strip` / `List`; the chosen
  view persists per user (the 5.1.5 sort-preference pattern);
- the **Attach button** — secondary `Button` (size sm) with the `paperclip`
  glyph; opens a multi-select file picker. Always present for creating roles;
  OMITTED for the viewer.

### Strip view (panels 0–1)

Tiles on a `repeat(auto-fill, minmax(148px, 1fr))` grid: an 88px thumbnail
(the image itself, cover-fit, or the MIME-family glyph on
`--el-surface-soft`) over filename (truncating, full on `title`) + relative
date (absolute on `title`; size joins it on the anatomy panels). **The card's
open target is its own button; the per-card actions are sibling icon
buttons — never nested interactives.** Download + delete reveal on
hover/focus-within. Activating a previewable card (image / PDF) opens the
lightbox; any other type downloads (the DTO `isImage`/`isPdf` split).

**File-type glyph map (5.2.5 builds this from `lib/blob/allowlist.ts`):**
glyph on an `--el-surface-soft` tile, stroke taking the conventional family
hue through EXISTING semantic tokens — no new token:

| MIME family                                               | lucide glyph       | stroke                |
| --------------------------------------------------------- | ------------------ | --------------------- |
| `application/pdf`                                         | `file-text`        | `--el-danger`         |
| docs/text (`msword`, docx, `text/plain`, `text/markdown`) | `file-text`        | `--el-info`           |
| spreadsheets (`text/csv`, `ms-excel`, xlsx)               | `file-spreadsheet` | `--el-success`        |
| `application/zip`                                         | `file-archive`     | `--el-warning`        |
| image without a thumbnail                                 | `image`            | `--el-text-secondary` |

**Editor-sourced cards** (the embeds-ARE-attachments rule) carry the lavender
**source chip** (`--el-tint-lavender` bg + `--el-text-strong` text — the 5.1
mention-chip treatment, AA-safe per finding #35; `--radius-badge`,
`--spacing-kbd-x/y`) naming the source (`Description` / `Comment`), and their
delete control is **disabled with the points-at-source tooltip** ("Added in
the description — remove it there to delete it"). This is the Jira block that
prevents the broken-embed hole. By contrast, a card whose delete the caller
simply lacks (not the uploader, not an admin) **omits** the control entirely —
absent, never disabled (the role grammar 5.1 set).

### List view (panel 2)

The toggle flips the same data into rows: family glyph · name (the row's own
open button) · source chip when editor-sourced · size (right-aligned tabular)
· date · uploader · the hover actions. Row activation previews or downloads —
the same split as the cards.

### Upload (panel 3)

- The **Attach button** is the always-present, labelled affordance; the
  **whole-panel dropzone** is the drag enhancement over it (drag-only upload
  would be a keyboard hole).
- **Drag-over** draws an inset overlay: 2px dashed `--el-accent` border +
  `--el-tint-lavender` wash, `upload` glyph, "Drop files to attach" / "Up to
  10 MB each".
- **Uploading** queues per file: an `--el-surface-soft` row with the family
  glyph, name, percent (or "Uploading…" + an indeterminate bar when the
  request doesn't report progress), the `--el-accent` progress bar, and a
  cancel ×.
- **Errors isolate per file** as rose-tint AA banners (`--el-tint-rose` bg +
  `--el-text-strong` text + `--el-danger` glyph — the 2.4.9 error grammar),
  with the EXACT localized copy `lib/blob/uploadClient.ts` already maps
  (`errors.upload.FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE` / `RATE_LIMITED`)
  — reuse, don't fork. Dismiss ×. Successes become cards in place.

### Pagination + states (panel 4)

The read is cursor-paged (take 50, newest first) with a `totalCount`
(finding #57 — no unbounded read). **"Show more (N)"** — the full-width quiet
control (dashed `--el-border-strong`, `--radius-control`,
`--el-surface-soft`, `--height-control`; the comments pager grammar) — sits
at the strip/list end, extends in place keeping scroll position, and
disappears when everything is loaded. **Loading** = tile-shaped pulse
skeletons (`--el-muted`, `aria-busy`) so the card doesn't jump. **Empty** =
centered `paperclip` + "No attachments yet — attach a file or drop one here";
the Attach affordance stays live (never blank). **Error** = the `ErrorState`
grammar: danger `triangle-alert`, serif "Couldn't load attachments", muted
"Something went wrong fetching the files.", secondary **Retry**.

### Delete confirm (panel 5)

The `RemoveLinkButton` confirm-**Popover** pattern verbatim (300px,
`--radius-card` + `--shadow-elevated`, ghost Cancel + danger **Delete**),
anchored to the delete control: **"Delete &lt;filename&gt;? Attachments can't
be restored."** — the hard-delete truth (row + blob + a History
attachment-removed entry; no trash). Focus returns to the panel after.

### Preview lightbox (panel 6 — for 5.2.6)

A **full-screen `Modal`** over ONE focused attachment. Growth notes for
5.2.6 (the 2.5.19 size-token precedent): add the `full` size variant, and
deepen the overlay to `bg-black/80` for the lightbox (the default
`Dialog.Overlay` is `bg-black/40`). Header bar (white-on-scrim): filename +
size · a **Download** button · the close ×. **Images** render contain-fit,
centered on the scrim. **PDFs** render in an embedded `<object>`/`<iframe>`
frame over the blob URL, with the can't-inline fallback ("Preview isn't
available here — download the file instead." + Download). Non-previewable
types NEVER open it — the card downloads instead. **NO prev/next
navigation** — unverified in the mirror itself, documented out ("no
complexity for nothing"). Full Modal a11y contract: focus trap, Esc closes,
focus returns to the opening card, dialog labelled by the filename, the
image carries the filename as alt.

### Viewer / read-only (panel 7)

A project `viewer` sees the panel and can preview + download; every mutating
affordance is **omitted** — no Attach, no dropzone reaction, no delete
(absent, never disabled — the 5.1 viewer grammar). Count + view toggle
remain.

### Copy strings

"Attachments" · "Attach" · "Strip" / "List" · "Show more (N)" · "Drop files
to attach" / "Up to 10 MB each" · "Uploading…" · "Cancel" ·
upload errors (from `errors.upload.*`): "File is too large — please choose a
smaller file." / "That file type isn't supported." / "Too many uploads —
please wait a moment and try again." · source chip "Description" / "Comment"

- tooltip "Added in the description — remove it there to delete it" (/ "Added
  in a comment — remove it there to delete it") · "Delete &lt;filename&gt;?
  Attachments can't be restored." / "Delete" / "Cancel" · "No attachments yet —
  attach a file or drop one here" · "Couldn't load attachments" / "Something
  went wrong fetching the files." / "Retry" · lightbox "Download" / "Preview
  isn't available here — download the file instead."

### Tokens / a11y

Colour only through `--el-*` (chips put hue in the tint background with
`--el-text-strong` text — finding #35; the glyph map adds palette colour per
finding #54 via the existing `--el-danger/info/success/warning` — **no new
`--el-*` token**); shape through the element-semantic tokens
(`--radius-card/control/btn/badge`, `--spacing-card-padding`,
`--spacing-control-x/y`, `--spacing-icon-btn`, `--spacing-kbd-x/y`,
`--spacing-chip-x/y`, `--height-control`, `--height-btn-sm`,
`--shadow-card/elevated`) — no Tier-0 utilities, no raw `rounded-*`. The
open/preview target of every card/row is its own `<button>`; action icon
buttons are siblings (no nested interactives) and are individually labelled
("Download &lt;name&gt;" / "Delete &lt;name&gt;"); the disabled editor-sourced
delete uses `aria-disabled` + the tooltip; progress bars are
`role="progressbar"` (valuenow, or `aria-busy` when indeterminate); the error
group is `role="alert"`; the skeleton sets `aria-busy`; source and permission
state are conveyed as text (chip label, tooltip), not colour alone. Light +
dark parity via the same tokens.

### Out of scope (documented extension slots)

**Authed/private attachment serving** — the shipped storage layer is Vercel
Blob `access: 'public'` + `addRandomSuffix` (public-but-unguessable, the JSM
"unguessable links" shape); the authed download proxy / private storage is
the named Epic-8 hardening extension. **In-preview prev/next** — unverified
in the mirror, not planned. **"Download all" (ZIP)** — needs a server zipper;
no use case at team scale yet. **Jira's grid view** — strip + list is the
documented primary pair. **A dedicated attach field in the create modal** —
files already attach at create via the editor path + link-on-write (5.2.3).
**Per-project storage quotas / admin-configurable size limits** — Epic 6/8
admin. **Jump-to-exact-comment** from a comment-sourced card — additive;
the block only needs `source`. Custom-field file types are Story 5.3.
**Row-less blob sweep** — the 5.2.7 orphan-GC reaches only blobs that still
have an `attachment` row (it sweeps unlinked rows past the 7-day window,
blob-then-row); a blob whose row is gone entirely (e.g. a workspace-cascade
delete) is invisible to it. A prefix-listing sweep against the blob store
itself is the named Epic-8 hardening extension (also recorded in the
`attachmentGc` job header).

## Custom fields on the detail rail (Story 5.3 · 5.3.5 → 5.3.7)

`custom-fields.mock.html` is the design for **custom-field values on the
issue detail rail** — the per-type cards, the per-type inline editors, and
the "Show more fields" disclosure. `detail.pen` predates custom fields
entirely, so all three were whole undesigned elements (the design-gate
NONE-exists case, `notes.html` mistake #31); this asset gates code Subtask
**5.3.7**, which carries 5.3.5 in `dependsOn`. Mirror: the Jira issue-view
**Details** panel — fields with values show; empty ones hide behind **"Show
more fields"** (the verified hide-when-empty rule), without the work-type
layout-config admin (the documented 6.5 extension). A `custom-fields.png`
export accompanies the HTML for the board view; the HTML is the source of
truth.

### Placement (panel 0)

Custom-field cards are a contiguous block in definition `position` order,
immediately **after the Estimate card** (the last built-in `FieldCard`) and
**before the created/updated audit list**. The **"Show more fields (N)"**
disclosure sits after the valued custom cards, immediately before
created/updated. Built-ins never reorder. With **no definitions, nothing
renders** — no disclosure, no section gap; the rail is byte-identical to
today (5.3.7's null-case guarantee).

### Card + per-type rendering (panel 1)

Every custom card is **`CoreFieldsPanel`'s `FieldCard` verbatim** — Card
chrome (`--radius-card`, `--shadow-card`, `--el-border`) with px-3.5/py-2.5,
uppercase 11px `--el-text-secondary` field label, corner chevron `<button>`
(`aria-label="Edit/Close <label>"`, rotates 180° in edit mode), value line
mt-1.5 / 14px. **No new card chrome.** Value lines per type:

- **text** — plain, truncating (full value via `title`);
- **number** — the formatted decimal, plain;
- **date** — the Due-date card grammar verbatim: 16px muted `calendar`
  glyph + `formatDate` ("Jun 12, 2026");
- **select** — the option label, plain; an **archived** option keeps
  rendering as `label (archived)` — muted italic mark, never colour alone;
- **user** — the assignee grammar verbatim: 24px initial Avatar + name;
- **empty** — the rail's muted-italic **None** (the Parent card's exact
  convention).

The per-type TILE glyphs + tints (the 5.3.4-shared map: `type`/sky ·
`hash`/peach · `calendar`/mint · `square-chevron-down`/lavender ·
`circle-user`/rose, glyph in `--el-text-strong` on the tint — findings
#54/#35) belong to the **Fields ADMIN page**; the rail keeps value lines
clean — Jira renders custom values plain, and the rail's built-ins reserve
glyphs for values that benefit (calendar, Avatar).

### Per-type editors (panel 2)

The chevron toggles the value line into the editor — the FieldCard pattern;
each editor is a **shipped picker**, nothing hand-rolled:

- **text / number** — `Input` chrome (`--height-input`,
  `--radius-input`, `--el-border-strong`), autofocus; commit on blur or
  chevron collapse (the Estimate card's exact grammar). Clearing = emptying
  the input.
- **date** — the shipped `DatePicker` (`autoOpen`), trailing × Clear; the
  calendar popover's authority stays `datepicker.mock.html`.
- **select** — the shipped `Combobox` (`autoOpen`); first row **None**
  (muted italic — the clear path, the AssigneePicker NONE grammar); option
  rows with `Check` on the selected one; **archived options are excluded
  from the menu**, but a current archived value stays selected in the
  trigger with the `(archived)` mark. `searchable` switches on at **≥8
  options** (a 3-option set opens straight to the list; long sets get the
  filter — the ParentPicker precedent).
- **user** — the AssigneePicker-shaped member `Combobox`: searchable
  ("Search members…"), **None** first row (Unset), member rows = name +
  right-aligned email secondary (12px muted).
- **Inline 422** — the editor STAYS OPEN: error border (`--el-danger`) on
  the control + a rose-tint message box below (`--el-tint-rose` bg,
  `--el-text-strong` text, 12px, `--radius-control`,
  `--spacing-tooltip-x/y`, `role="alert"`) — the 2.4.9 inline-confirm
  family; hue in the background with strong text (finding #35). Drawn:
  number parse error, archived-option re-save, non-viewable user.
- **Pending** — the in-flight write disables the open editor (opacity 50% —
  the rail's `isPending` convention).

### "Show more fields" disclosure (panel 3)

A quiet full-width text `<button>` (13px `--el-text-secondary`,
`--spacing-control-x/y` padding, `--radius-control`, hover `--el-surface`):
**"Show more fields (N)"** with a leading chevron that rotates 180° when
open, label flipping to **"Show fewer fields"**, `aria-expanded`. Expanding
reveals the empty cards (muted-italic _None_, editable in place); a field
that gains a value moves **above** the line on refresh, a cleared one moves
back below. The row exists for **every role** — it is how all fields are
viewed; only the editors are role-gated.

### Viewer read-only + loading (panel 4)

A read-only actor sees values with **no chevron** (`FieldCard
editable={false}` — the rail's existing read-only grammar); the disclosure
row stays. The loading skeleton extends naturally: ghost label + ghost value
bars inside card chrome, one per custom field, same as the built-ins.

### Copy strings

"Show more fields (N)" / "Show fewer fields" · "None" (empty placeholder +
the select/user clear row) · "(archived)" · "Search members…" · "Select a
member…" · "Enter a number — e.g. 12.5." · "That option is archived — pick a
current one. Saving again with "<option>" is rejected (422)." · "That person
can't view this project, so they can't hold this field." · chevron
`aria-label`: "Edit <label>" / "Close <label>".

### Tokens / a11y

Colour only through `--el-*` (the 422 box puts hue in the tint background
with `--el-text-strong` text — finding #35; the archived mark is text, never
colour alone); shape through the element-semantic tokens
(`--radius-card/input/control/badge`, `--spacing-control-x/y`,
`--spacing-input-x`, `--spacing-tooltip-x/y`, `--height-input`,
`--height-control`, `--shadow-card/elevated`) — no Tier-0 utilities, no raw
`rounded-*`. **No new `--el-*` or shape token is needed.** The disclosure is
a real `aria-expanded` button; every editor is labelled by its field label;
errors are `role="alert"`; the DatePicker trigger is a CONTAINER with the
Clear × as a sibling button (never a button inside a button — the
datepicker.mock rule); Combobox menus keep the `role="listbox"` /
`aria-activedescendant` bar. Light + dark parity via the same tokens.

### Out of scope (documented extension slots)

Custom fields on the **create/edit forms** (work-type layouts, required
flags, form placement — the 6.5 layout-config extension; values are
editable the moment an issue exists, via this rail); custom-field columns
on **board/list/tree** (Epic-6 saved-views territory); the **filter UI**
over values (Story 6.1, consuming 5.3.1's predicate contract); the
remaining mirror types (paragraph / checkbox-multi / labels / multi-person
/ formula — additive on the same EAV substrate). Value-change **History**
rendering is Story 5.5 (the `customFields.<key>` revision diffs land with
5.3.3).

## Labels · Components · Watchers — the issue-view additions (Story 5.4 · 5.4.6 → 5.4.8 / 5.4.9)

`labels-components-watch.mock.html` is the design for every issue-view surface
Story 5.4 adds: the **Labels** and **Components** rail field cards (and the
generic multi-select chip picker they embed), and the **watch control + watchers
popover** in the detail header. `detail.pen` predates all three features (its
source contains no label / component / watcher element — verified), and the
codebase has no multi-select input primitive (`Combobox` is single-select; the
only multi-select vocabulary is the filter bar's `OptionRow` rows), so the
design gate (`notes.html` mistake #31) requires this asset before code Subtasks
**5.4.8** (MultiSelectPicker + rail cards) and **5.4.9** (watch control +
popover). Mirrors (verified in the 5.4 story module): the Jira issue-view
Labels / Components fields and the eye-icon watch control. A
`labels-components-watch.png` export accompanies the HTML for the board view;
the HTML is the source of truth.

### Placement (panel 0)

- **Watch control** — the detail header's `ml-auto` cluster
  (`issues/[key]/page.tsx`), placed BEFORE the Edit button (beside the roll-up
  badge). The eye + count is a peer of Edit, not a field: watching is
  social/header state, the Jira placement.
- **Labels and Components field cards** — the metadata rail, **between Parent
  and Due date**: they group with the relational fields ahead of the
  date/estimate block (the Jira details-panel grouping). Labels first, then
  Components (the 5.4 story's consistent ordering). Both reuse the
  `CoreFieldsPanel` **FieldCard grammar verbatim** — 11px uppercase
  `--el-text-secondary` label, corner chevron (`aria-expanded`, rotates open)
  toggling display ↔ edit, 14px value block at 6px top margin. Display mode
  renders chips only; empty shows the muted-italic placeholder (`No labels` /
  `No components`) per the FieldCard `muted()` convention.

### MultiSelectPicker — the ONE new primitive (panel 1; built by 5.4.8 as `components/ui/MultiSelectPicker`)

Designed ONCE, generically — labels, components, and future Epic-6 facet
editors all compose it. **Generic API surface:** options in, selection out —
NO fetching inside; `onCreate?` (adds the create-row, the folksonomy
affordance); `cap?` (per-value limit, disables input at the cap); `tint?`
per value (a chip + option-swatch colour — Labels passes the name-hash tint
below, Components passes none); pure + typed-generic, component-tested
standalone.

- **The box** — input-shaped: `--radius-input`, min-height `--height-input`,
  `--spacing-control-y/x` padding, `--el-border` on `--el-page-bg`,
  focus-WITHIN ring (`--focus-ring-color`, 2px, offset 1). Disabled (cap):
  `--el-surface-soft` fill, `not-allowed` cursor; chips stay removable.
- **Chips** — `--radius-badge`, `--spacing-chip-y/x` padding, 12px medium.
  Two treatments via the `tint?` prop: **neutral** (the default —
  `--el-surface` bg · `--el-border` border · `--el-text-secondary` text, the
  `Pill` neutral tone; what Components uses) and **tinted** (what Labels
  passes — the value's `--el-tint-*` background + `--el-text-strong` text,
  transparent border; hue-in-background AA per finding #35). Trailing
  **remove ×** (12px lucide `x`; neutral: `--el-text-muted` → `--el-text` +
  `--el-muted` bg on hover; tinted: `--el-text-strong` at 65% → 100% + a
  subtle ink overlay; accessible name `Remove <value>`).
- **The listbox** — the `Combobox` menu panel grammar: `--radius-card`,
  `--shadow-elevated`, `--el-border`, 4px padding, max-width 288px;
  `role="listbox"` + **`aria-multiselectable="true"`**; rows are the
  **`OptionRow` vocabulary reused 1:1** (`IssueFilterBar`): `role="option"` +
  `aria-selected`, `--radius-control` / `--spacing-control-y/x`, 22px glyph
  slot (14px icon, `--el-text-muted`), truncating label, **trailing 16px
  `Check` in `--el-accent`** (opacity 0 ↔ 1). Active row = `--el-surface`.
  Toggling does NOT close the menu (multi-select); Esc / outside click closes.
- **Keyboard (complete):** type filters · ↑↓ moves the active row · Enter
  toggles it · **Backspace on an empty input removes the last chip** · Esc
  closes and returns focus. `aria-activedescendant` tracking per the shipped
  `Combobox` a11y bar.

### Labels rail card (panel 2; 5.4.8)

The picker with `onCreate` wired to the 5.4.2 folksonomy:

- **Label colours — the recorded justified deviation (product owner,
  2026-06-10).** Unlike Jira's colourless labels, Motir label chips are
  COLOURED — deliberately less enterprise, more personality. The colour is
  **auto-assigned deterministically from the label name**: FNV-1a over
  `nameLower`, mod 6, into the existing pastel family
  `--el-tint-{peach,rose,mint,lavender,sky,yellow}` with `--el-text-strong`
  text (finding #35: hue in the tint background, AA-strong text on top —
  both themes hold via the dark tint variants). NO schema column, NO colour
  picker, NO admin surface — the folksonomy stays type-to-create, and the
  same label renders the same colour everywhere it appears (rail card,
  picker chips, option-row swatches, future board/filter chips). The mock's
  assignments (api=sky, perf-q3=peach, design-debt=lavender, infra=mint,
  flaky=yellow, onboarding=rose) are illustrative; the hash is the contract.
  **User-PICKED colours are the documented extension** (would add a `color`
  column + picker affordance later without breaking the auto default).
- **Create-row** — when the typed text matches no existing label the listbox
  shows `Create 'perf-q3'` with a plus glyph in `--el-accent`; the new label
  takes its hash tint immediately. Options otherwise come from the bounded
  `searchLabels` autocomplete (debounced, take 20) — each row's glyph slot
  carries the label's 10px tint **swatch dot** (the filter-bar swatch
  vocabulary) instead of an icon. Case-insensitive match surfaces
  the EXISTING label's original casing (no create-row offered).
- **No-spaces error** — the typed 422 renders the inline error grammar
  (12px `--el-danger` + 14px `triangle-alert`, `role="alert"`):
  `Labels can't contain spaces — use a hyphen: perf-q3`. The rejected text
  stays in the input for correction.
- **Cap (20)** — input disabled + the quiet hint
  `Label limit reached (20) — remove one to add another.`
- **Read-only (viewer)** — chips only, NO chevron: affordances absent, not
  disabled (the 6.4 grammar).

### Components rail card (panel 3; 5.4.8)

The SAME picker, `onCreate` absent — an admin-managed taxonomy never grows
from the issue field (mirror: company-managed Jira). Options =
`listComponents(projectId)`, name-ordered; rows and chips carry the lucide
`component` glyph (`--el-text-muted`; 22px row slot / 12px in-chip). Empty
project: `No components defined` in the listbox + the quiet `--el-link` line
`Manage components in Project settings →` — **project admins only** (members
see just the empty text). Read-only matches Labels.

### Watch control (panel 4; 5.4.9)

The small-header-control grammar (`--height-control` · `--radius-btn` ·
`--spacing-control-x` — the comments-mock sort-btn vocabulary):

- **Not watching** — outline lucide `eye` (16px, `--el-text-muted`) + count
  (`--el-text-secondary`, tabular-nums), `--el-border`, `aria-pressed="false"`,
  accessible name `Watch — N watching`.
- **Watching** — the eye **fills with `--el-accent`** (pupil knocked out in
  `--el-page-bg`), accent border, semibold accent count,
  `aria-pressed="true"`, name `Stop watching — N watching`. State is carried
  by the accessible name + fill, never colour alone.
- Hover `--el-surface`; focus-visible ring. Click or **`W`** toggles
  self-watch (ignored while typing in inputs/editors — the standard guard);
  the tooltip (ink surface, `--spacing-tooltip-y/x`) names the action + the
  `W` kbd chip. A `viewer` gets the control too — watching is not editing
  (the verified permission split).

### Watchers popover (panel 5; 5.4.9)

Anchored to the watch control; the menu panel container (`--radius-card` ·
`--shadow-elevated` · 4px padding · 288px), a labelled dialog (`Watchers`);
Esc closes, focus returns to the eye.

- **Header** — `Watchers · N` in the mono 11px uppercase faint label.
- **Rows** — 22px initial-letter avatar · truncating 14px name · your own row
  marked with the neutral `You` pill. Hover `--el-surface`.
- **Admin-only manage** (project admin + workspace admin/owner): the
  `Add a watcher…` search row on top (the member-picker vocabulary — typing
  filters workspace members into option rows) and a per-row **remove ×**
  (`--spacing-icon-btn`, name `Remove <name> from watchers`). Non-admins and
  viewers get the list only.
- **No-view-access error** — adding a user who can't view the issue surfaces
  the typed 422 INLINE under the candidate row (`role="alert"`,
  `--el-danger`): `<Name> can't view this issue, so they can't watch it.` —
  never a silent drop (the Jira trap, fixed).
- **Paging** — the quiet `Show more (N more)` row (13px
  `--el-text-secondary`).

### States (panel 6)

Skeleton chips ride the pulse grammar at chip size (`--radius-badge`,
`--el-muted`); the card chrome renders immediately. The watch toggle is
optimistic — state + count flip on click, reconciled on `router.refresh()`,
rolled back with the toast grammar on failure; tabular-nums keep the header
cluster from shifting.

### Tokens / a11y

- Colour only via Tier-3 `--el-*`; shape via the element-semantic tokens
  (`--radius-input/card/control/btn/badge/kbd`, `--spacing-control/chip/kbd/
tooltip/icon-btn-*`, `--height-input/control`, `--shadow-elevated/card`).
  **No new token needed** — the design composes existing roles only.
- **No new primitive beyond MultiSelectPicker** (the gate's ONE earn);
  everything else reuses FieldCard, OptionRow, the Combobox menu panel, the
  22px avatar, Pill neutral, the kbd chip, the inline-error grammar, the
  pulse skeleton.
- Label chips are **coloured** — the recorded justified deviation from Jira's
  colourless labels (less enterprise, more personality; product owner,
  2026-06-10). Tints auto-assigned by name hash from the EXISTING
  `--el-tint-*` family — still no new token; components chips stay neutral
  so the two facets read differently.
- AA holds in both themes: neutral chip text `--el-text-secondary` on
  `--el-surface`; tinted chip text `--el-text-strong` on the pastel tints
  (the finding-#35 grammar, dark tint variants included); `--el-danger`
  error text at 12px on `--el-page-bg`; accent count/border on page bg.
  Dark parity via the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- User-PICKED label colours (the auto name-hash tint ships now; a `color`
  column + picker is the additive extension); label rename/merge admin
  (Jira's own gap — Epic-6 admin territory).
- The Components ADMIN page (Project settings → Components) — its own design
  subtask **5.4.7** (`design/projects/components.mock.html`).
- Per-user autowatch preference + the in-app bell — Story 5.7's seam.
- Voting (Jira's sibling feature — no use case for a small-team tool).

## Activity History + the All stream (Story 5.5 · 5.5.3 → 5.5.4)

`activity-history.mock.html` is the design for the issue detail page's
**History feed** and the **All merged stream** — the completion of the
Activity section. `comments.mock.html` (5.1.3) designs the SECTION — the
`ContentSectionCard`, the segmented filter (History drawn as a disabled
seam), the comment grammar, the sort toggle; every history ROW form and the
All interleave are whole elements that asset does not depict, so the design
gate (`notes.html` mistake #31) requires this asset before code Subtask
**5.5.4** (History + All tabs UI). Mirror: the Jira Cloud issue-view
changelog, verified at plan time in the 5.5 story module — entry anatomy =
actor + "changed the <Field>" + old → new + timestamp, empty sides "None"
(the changelog null); comment DELETIONS in History (who/when, never the
content), comment ADDS under Comments/All only; ONE per-user sort toggle
spanning every tab (JRACLOUD-73076); append-only — read-only for every role,
no mutation affordance exists. An `activity-history.png` export accompanies
the HTML for the board view; the HTML is the source of truth.

### Placement + the tab row

Same card, same slot as 5.1.3 (detail left column). The 5.1.3 segmented
filter goes LIVE with three tabs — **All / Comments / History** (Jira's set
minus Work log: no worklog feature), **default Comments** (the Jira
default). Tab choice is URL-driven (`?activity=all|comments|history` — the
2.5.8 `?view=` house pattern). The header gloss counts the ACTIVE tab's
entries: "— 12 comments" / "— 34 changes" / "— 12 comments · 34 changes" on
All. The sort control is the 5.1.3 `sort-btn` unchanged, but it now governs
ALL tabs together (the verified cross-tab rule), persisted per user exactly
as 5.1.5 stores it.

### History row grammar (the new element)

Comment-row-aligned but visually QUIETER — the feed-vs-conversation
distinction:

- Same grid (22px first column — the two row kinds stay left-aligned in
  All) but an **18px** initial-letter `Avatar` (vs the comment row's 22px).
- The **sentence line**: 13px `--el-text-secondary` prose with the actor
  (13px semibold `--el-text`) and the field name (medium `--el-text`)
  lifted out; relative time 12px `--el-text-muted`, absolute on hover via
  `title` (the comment-row convention).
- The **value line** below: old value struck-through `--el-text-muted`
  (strike colour `--el-border-strong`), arrow `→` in `--el-text-faint`, new
  value medium-weight `--el-text`. An empty side renders italic faint
  **"None"** (the changelog null). State is carried by strike + weight, not
  colour alone (WCAG 1.4.1).
- **No action affordance on any row, for any role** — History is
  append-only (the verified rule); there is no read-only variant because
  the whole surface is read-only.

Per-change-type value forms (all drawn in panels 1–2):

- **Scalar** (title, kind, priority, estimate, story points, …): plain
  old → new.
- **Status**: the two workflow LABELS as `Pill`s (tint bg +
  `--el-text-strong`, finding #35 — todo lavender / in-progress sky / done
  mint / blocked peach) with the arrow between.
- **User fields** (assignee, reporter): 18px avatar + name pairs.
- **Dates**: the rail's `formatDate` form ("12 Jun 2026").
- **Description / Explanation**: the verb sentence ONLY ("updated the
  Description") — the body is never inlined.
- **Sprint**: "moved this issue to Sprint 4 / the Backlog" — names
  resolved, never ids; rendered with the old → new value line.
- **Links**: identifier mono in `--el-link` + the link kind italic
  ("linked `PROD-12` as _blocks_" / "removed the _relates to_ link to
  `PROD-48`") — the links.mock vocabulary.
- **Labels / components**: the 5.4 chip forms verbatim under an
  added/removed sentence (labels keep their name-hash tint; components
  neutral + glyph).
- **Attachments**: filename mono ("attached `drag-repro.mp4`" / "removed
  the attachment `old-screenshot.png`").
- **Custom fields**: the DEFINITION's label as field name, option LABELS as
  values; deleted options fall back to the stored label.
- **Comment deleted**: "deleted a comment" + the reply-count gloss ("and
  its 2 replies — content not retained") — NEVER the content (what 5.1.2
  records).
- **created**: the feed's oldest anchor ("created the issue");
  **archived**: its own quiet row (both muted-ink sentences, no value
  line).
- **The generic fallback** — a DESIGNED state, not an accident (mistake
  #29): an unregistered diff key renders mono on the `--el-muted` fill
  ("changed `riskScore`") with safely-stringified values.
- **Deleted referent**: the "Former member" form — muted "?" avatar
  (`--el-muted` bg, `--el-text-muted` glyph), italic muted name; deleted
  options/sprints/issues render their stored label fallback. Never a
  broken entry.

### The noise-suppression policy (what never renders)

Pure `position` / `backlogRank` reorders and the denormalised `key` /
`identifier` writes have **NO row form by design** — Jira shows no
board-reorder noise in History. The 5.5.1 registry marks them `suppressed`
(explicit disposition, not accidental omission); a diff mixing suppressed +
renderable keys renders only the renderable parts. The trail still holds
the rows — suppression is a render decision.

### The All stream

Comments (the full 5.1.3 grammar — 22px avatar, 14px body, quiet action
row; Reply etc. still live here) interleave with history rows (this
grammar) in true timestamp order — the bounded two-source composite-cursor
merge (5.5.2, finding #57). The shared 22px grid column + the size/ink
step-down (18px vs 22px avatar, 13px secondary vs 14px primary ink) is the
visual rhythm that keeps the two scannable: conversation loud, telemetry
quiet. A deleted comment appears ONCE, as history; live comments never
duplicate into history.

### Pagination + states

Each tab pages its own read (History: the 1.4.6 revisions cursor, 20/page;
All: the composite cursor) behind the 5.1.3 pager grammar at the OLDER edge
— "Show more changes (N older)" / "Show more activity (N older)" — flipping
top/bottom with the sort direction; clicking extends backward and keeps
scroll position. **Loading**: the `BacklogSkeleton` pulse grammar shaped
like history rows (18px circle + sentence/value bars, `aria-busy`).
**Empty History**: the 5.1.3 empty grammar with the `history` glyph — "No
history yet — changes to this issue will show up here" (practically
unreachable; designed anyway). **Error**: the `ErrorState` grammar —
"Couldn't load history" / "Something went wrong fetching the activity." +
secondary Retry ("Couldn't load activity" on All).

### Copy strings

"All" / "Comments" / "History" · "— N changes" / "— N comments · N changes"
· "changed the <Field>" · "updated the Description" · "None" · "moved this
issue to Sprint N" / "moved this issue to the Backlog" · "linked <KEY> as
<kind>" / "removed the <kind> link to <KEY>" · "added/removed the Label" ·
"added/removed the Component" · "attached <file>" / "removed the attachment
<file>" · "deleted a comment" + "and its N replies — content not retained"
/ "content not retained" · "created the issue" · "archived the issue" ·
"changed <key>" (fallback) · "Former member" · "Show more changes (N
older)" / "Show more activity (N older)" · "Oldest first" / "Newest first"
· "No history yet — changes to this issue will show up here" · "Couldn't
load history" / "Couldn't load activity" / "Something went wrong fetching
the activity." / "Retry".

### Tokens / a11y

NO new primitive and NO new token: everything composes the 5.1.3 section
vocabulary (seg / sort-btn / show-more / skeleton / empty / ErrorState),
the shipped `Pill` recipe, the 5.4 chip vocabulary, and the mono
identifier + `--el-link` treatment. Colour only through `--el-*`; shape
through the element-semantic tokens (`--radius-card/control/btn/badge`,
`--spacing-card-padding`, `--spacing-control-x/y`, `--spacing-chip-x/y`,
`--height-control`, `--height-btn-sm`, `--shadow-card`). The tab row is the
5.1.3 `role="tablist"` grammar with all three tabs enabled; each feed is a
labelled list (`role="list"` / `aria-label`) whose entries read as full
sentences (the values are inline text, so a screen reader hears "Bo Philips
changed the Status, To do → In progress, yesterday"); timestamps absolute
via `title`; the skeleton sets `aria-busy`; AA holds in both themes (muted
ink ≥4.5:1 on page bg, tinted Pills/chips use `--el-text-strong` — finding
#35). Light + dark parity via the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- A **Work log** tab — follows a time-tracking feature if one ever lands
  (no such feature is planned).
- History for comment EDITS beyond the "· Edited" tag (Jira keeps no
  comment version history either).
- Cross-issue / project-level activity streams — Epic-6 reporting
  territory.
- Retention / purge admin — the mirror has none; append-only is the
  contract.
- Rendering rank/position noise — suppressed by the explicit policy above.
- Realtime updates — the section refreshes like every other surface (the
  5.1 product-wide decision).

---

## Filter builder — the Advanced surface (Story 6.1 · 6.1.3 → 6.1.4 / 6.1.5)

`filter-builder.mock.html` is the design for the **advanced filter builder** —
the structured field / operator / value rows under a flat **Match all / Match
any** combinator that Story 6.1 ships as the no-parser advanced mode.
`filter.mock.html` (2.5.9) designs ONLY the basic facet popover, so the builder
was the design-gate NONE-exists case; this asset closes it for code Subtasks
**6.1.4** (built-in rows) and **6.1.5** (Epic-5 rows). Mirrors: Jira basic's
field/value vocabulary for the editors; the flat-rows structured builder shape
(Linear's filter editor) for exactly the operator set Jira's own docs say basic
cannot express (OR across fields, NOT, EMPTY, comparisons) — the recorded
richer-than-basic justification in the Story 6.1 module. A `filter-builder.png`
export accompanies the HTML for the board view; the HTML is the source of
truth.

### The UI contract is the SHIPPED 6.1.1 registry

The builder **renders `lib/filters/registry.ts`** — it never hard-codes a field
list. Field menu = `FILTER_FIELDS` in registry order, then the project's
dynamic entries (6.1.2/6.1.5). Choosing a field populates its operator menu
from `def.operators`; the operator resolves the value editor via
`filterValueEditorKind`. The editor-kind ↔ component mapping (the 6.1.1 UI
contract, pinned):

| `FilterValueEditorKind`            | Component (shipped)                                                    | Drawn in panel |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `kind-select`                      | `MultiSelectPicker` — kind options w/ `IssueTypeIcon` hue              | 1              |
| `status-select`                    | `MultiSelectPicker` — workflow statuses w/ the StatusPicker dot        | 1, 2           |
| `priority-select`                  | `MultiSelectPicker` — priorities w/ the `PRIORITY_META` direction icon | 1              |
| `member-select`                    | `MultiSelectPicker` — members w/ Avatar; **Unassigned sentinel first** | 1 (Reporter)   |
| `sprint-select`                    | `MultiSelectPicker` — sprints; **Backlog sentinel first**              | 1              |
| `text`                             | `Input`                                                                | 1              |
| `number`                           | `Input` (`inputmode="numeric"`, tabular-nums)                          | 1              |
| `date`                             | `DatePicker` trigger (2.4.11 calendar)                                 | 1              |
| `date-range`                       | two `DatePicker` triggers joined by "and"                              | 1              |
| `days`                             | `Input` numeric + the "days" unit suffix                               | 1              |
| `none` (`is empty / is not empty`) | the value slot COLLAPSES (field + operator only)                       | 1 (Assignee)   |

Operator menu labels (the registry ids, humanized — pinned copy):
`is any of` · `is none of` · `is empty` · `is not empty` · `contains` ·
`does not contain` · `=` `≠` `<` `≤` `>` `≥` · `on or before` · `on or after` ·
`is between` · `in the last … days` · `in the next … days`. The windowed
operators render the trigger label without the count ("in the next") and put
the count in the `days` editor. The single registry `text` field covers
title + description — its menu row carries the "title + description" secondary.

### Entry + coexistence (panel 0)

- **[Advanced]** is a `ToolbarButton` (the `.tb-btn` grammar) with the lucide
  `funnel-plus` glyph, placed **immediately after the shipped [Filter]** facet
  button in the `/issues` toolbar. Active state = the 2.5.4 grammar extended:
  accent ring + lavender fill + a count badge of **applied (complete) rows**.
- **Upgrade (one-way, lossless)** — the facet popover gains a footer row,
  `Edit in Advanced` (link-styled, `funnel-plus`), which opens the builder with
  every facet selection carried in as rows (the 6.1.1 facet→AST map). The 2.5.4
  facet bar REMAINS the quick path.
- **Superseded facet state** — when the AST exceeds facet expressiveness
  (OR / negation / empty / comparisons / non-facet fields), the [Filter] button
  mutes its label and gains a small lavender `funnel-plus` badge
  (`aria-label="Managed in Advanced"`) + tooltip: _"Managed in Advanced — this
  filter uses conditions the quick filter can't show. Open Advanced to edit
  it."_ Opening it shows the popover read-only with the same hand-off. **Never
  a silent down-conversion** (the verified mirror rule).

### The builder surface (panels 1–4)

- **Container** — a `Popover` (`role="dialog"`, labelled "Advanced filter")
  anchored under [Advanced]: 680px, `--radius-card`, `--el-border` hairline,
  `--shadow-elevated`. Header = mono 11px uppercase title + **Clear all**
  (the `fp-clear` link grammar). Footer = **+ Add condition** (link + plus) ·
  the live hint `N of 20 conditions · applied live`.
- **Combinator** — the `Segmented` control (3.3.5) read as a sentence:
  "Match **[all | any]** of the following conditions:". One level only — no
  nested groups (the documented builder→parser extension slot).
- **Condition row** — a labelled `role="group"`: field `Combobox` trigger
  (158px) · operator `Combobox` trigger (168px) · the operator's value editor
  (flex) · the remove × (`--spacing-icon-btn` square). Triggers are
  `--height-control`, editors `--height-input` — **the primitives' own heights,
  centre-aligned; no new size variants and no new primitive**. CF rows carry
  their 5.3.4 type glyph in the field trigger; Label/Component rows the
  `tag`/`component` glyph.
- **Live-apply + pending rows** — there is NO Apply button (the 2.5.4
  precedent): complete rows write `?filter=v1:…` (composing with
  `?view/?sort/?page`, Suspense-keyed) as they land. A row missing its value is
  **pending**: dashed boxes + the italic line _"Not applied yet — pick a value
  to activate this condition."_ — excluded from the badge count, the URL, and
  the result set; emptying an applied row returns it to pending without
  dropping it.
- **Row cap** — at `FILTER_ROW_CAP` (20) Add condition disables with
  _"Condition limit reached (20) — remove one to add another."_
- **Epic-5 rows (6.1.5)** — the field menu grows the project's dynamic entries
  under **Custom fields** (5.3.4 type glyphs) and **Other** (Label, Component).
  Select-CF chips include archived options with the 5.3.5 italic "(archived)"
  mark (historical matching); label chips take the 5.4 name-hash tint with
  `--el-text-strong` text; component chips stay neutral with the glyph; CF
  user/number/date/text reuse the built-in editors. Member/sprint/label/
  component listboxes are their owners' bounded reads + sub-search (the 5.4.6
  vocabulary).

### Applied state (panel 5)

The toolbar summary (active [Advanced] + row-count badge) plus a read-only
**condition-chip readout** under the toolbar — a `Match any` lavender chip
(only on OR) followed by one neutral chip per condition (`**Field** operator
values`); clicking any chip or the trigger opens the builder. The result
**count line** (`N issues match`, `role="status"`) tracks edits live.
Zero results = the EmptyState grammar: _"No issues match this filter"_ /
_"Try removing a condition, or clear the filter to see everything."_ +
**Clear all**.

### Durable-URL states (panel 6)

- **Stale referent** — a condition whose field/option/label/component/member
  id no longer resolves (a shared or saved URL outliving the data) renders the
  **Unknown value** chip (triangle-alert in `--el-warning` on the peach tint,
  `--el-text-strong` text) + the per-row `role="status"` notice _"This value no
  longer exists in the project — this condition matches nothing."_ The row
  stays visible and editable; the query matches nothing for it (the 6.2
  saved-filter durability rule). A field deleted under an open builder degrades
  its row to the same state.
- **Invalid `?filter=` param** — the typed recoverable decode failure renders a
  callout card (_"This filter link couldn't be read"_ + **Clear filter**) above
  the UNFILTERED list — never a crash, never a silent drop.

### Both views (panel 7)

One compiled predicate feeds both reads: the List (the navigator-faithful
result — sortable headers, 50/page + count, 2.5.8/2.5.12) and the Tree
(ancestor-retaining, muted non-matching ancestors — the shipped 2.5.1
behaviour, referenced not redrawn). Identical match sets.

### Copy strings

`Advanced` · `Edit in Advanced` · `Advanced filter` · `Match all/any of the
following conditions:` · `Add condition` · `Clear all` · `N of 20 conditions ·
applied live` · `Condition limit reached (20) — remove one to add another.` ·
`Not applied yet — pick a value to activate this condition.` · `Unknown value`
· `This value no longer exists in the project — this condition matches
nothing.` · `This filter link couldn't be read` · `The filter in this URL is
invalid or from a newer version of Motir, so no filter was applied. Clear it
to dismiss this message.` · `Clear filter` · `N issues match` · `No issues
match this filter` · `Try removing a condition, or clear the filter to see
everything.` · the superseded tooltip (above). All via next-intl in 6.1.4/6.1.5.

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: count badge / selected rows / Check / the
  active ring = `--el-accent`; the stale grammar = `--el-warning` glyph +
  `--el-tint-peach` + `--el-text-strong` (AA, finding #35 — and never colour
  alone: the glyph + notice text carry the state); label chips the name-hash
  `--el-tint-*`; **no new token needed**.
- Shape via element-semantic tokens only (`--radius-card/input/control/btn/
badge`, `--spacing-control/input/chip/icon-btn/tooltip-*`,
  `--height-control/input`, `--shadow-elevated/subtle`) — the builder reshapes
  under `data-display-style`.
- **No new primitive**: Popover + Combobox + MultiSelectPicker + Input +
  DatePicker + Segmented + Pill + the toolbar/empty/callout grammars cover
  every element.
- A11y: the builder is a labelled dialog; rows are labelled groups; every
  picker keyboard-complete per its own primitive's bar; the combinator is a
  labelled `role="group"` of `aria-pressed` buttons reading as a sentence; the
  count line `role="status"`; the stale notice `role="status"`, the invalid
  callout `role="alert"`; remove buttons carry value-specific names. Light +
  dark parity via the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- **Nested condition groups** — the builder→parser line (the Story 6.1
  recorded extension).
- **Saving / naming filters** — Story 6.2 persists the `?filter=v1:`
  serialization this surface writes.
- A JQL-style text query language (the stub's hard NO); cross-project search
  (the substrate is active-project-scoped — rung 2); stemmed full-text search
  (ILIKE + trgm ships).
- Filter chips editable in place (the readout is read-only; editing happens in
  the builder — one editing surface).

---

## Saved filters — save · apply · manage · subscribe (Story 6.2 · 6.2.2 → 6.2.3 / 6.2.4 / 6.2.5)

`saved-filters.mock.html` designs every Story 6.2 surface:
`filter-builder.mock.html` (6.1.3) designs ONLY the builder, so saving,
applying, managing, sharing, and subscribing were the design-gate NONE-exists
case. This asset closes it for code Subtasks **6.2.3** (save + apply UI on
/issues), **6.2.4** (the filters directory), and **6.2.5** (subscriptions) —
and pins the "Filter missing" widget state Story 6.3 inherits. Mirrors
(verified in the Story 6.2 seed module, 2026-06-10): Jira's Save / Save-as
ownership split, its Filters-directory columns (name / owner / visibility /
popularity / actions), its starred-first filter menu, its delete-in-use
warning, its preset-tier subscriptions, and its read-only system filters.
A `saved-filters.png` light render accompanies the HTML for the board view;
the HTML is the source of truth (toggle dark in it for token parity).

### The seven panels

| Panel | Surface                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | The /issues toolbar: the **[Saved]** ToolbarButton (bookmark glyph, right of [Advanced]) + the applied-filter **name chip**; clean vs dirty-owner vs dirty-non-owner |
| 1     | The **save dialog** (Modal `size="md"`): name / description / visibility; the duplicate-name error; the viewer private-only state                                    |
| 2     | The **[Saved] dropdown**: Starred → My filters → Project filters → Defaults, server search, per-row star, View-all footer; the empty-group states                    |
| 3     | The **filters directory** at `/filters`: searchable paginated table, role-gated row actions, built-ins read-only, empty + no-access states                           |
| 4     | The **visibility control** (Edit details) + the **delete-with-dependents** confirm                                                                                   |
| 5     | The **subscription editor** (preset schedule) + the subscribed state + its mounts                                                                                    |
| 6     | The **“Filter missing”** widget state (the 6.3 degraded card)                                                                                                        |

### Entry + the applied state (panel 0 → 6.2.3)

- **[Saved]** is a `ToolbarButton` (the `.tb-btn` grammar) with the lucide
  `bookmark` glyph + caret, placed **immediately right of [Advanced]**
  (6.1.3's builder trigger). Active state = the 2.5.4 grammar (accent ring +
  lavender fill) while a saved filter is applied.
- **The name chip** prepends the 6.1.3 summary-chip row: bookmark glyph
  (`--el-accent`) + the filter name on the lavender tint with
  `--el-text-strong` text (AA, finding #35), plus a visibility hint glyph
  (`users` = project-shared, `lock` = private). Clicking it opens the [Saved]
  dropdown. The 6.1.3 condition chips and count line stay unchanged.
- **Dirty state** — the chip's URL-AST is compared to the saved envelope
  (6.1.1 equality). When they diverge: the amber dot + the italic word
  **"Edited"** (`role="status"`, never colour-only), and the action set by
  ownership — **owner: [Save] [Save as] [Discard changes]** · **non-owner:
  [Save as] only**, with the ink tooltip explaining why ("Only the owner can
  overwrite this filter — Save as creates your own copy."). "Discard changes"
  reloads the saved envelope into builder + URL. Save (owner overwrite) shows
  NO dialog — it writes the current AST into the row in place.

### The save dialog (panel 1 → 6.2.3)

- `Modal` (`--radius-modal` / `--shadow-modal`), `FormField` grammar: **Name**
  (required), **Description (optional)** `Textarea`, and **"Who can see this
  filter?"** — two stacked radio cards in the 6.4.1 access-card grammar:
  **Private** (lock on `--el-tint-lavender`: "Only you and project admins can
  see it.") and **Project** (users on `--el-tint-sky`: "Everyone who can
  browse this project can see and apply it."). Selected card = `--el-accent`
  border + filled radio. **Default visibility: Private** (the Jira default
  share; the safe choice).
- **Duplicate name** — per-project case-insensitive (the 6.2.1 constraint):
  inline `role="alert"` error under the field ("A filter named “…” already
  exists in this project."), primary disabled until it clears.
- **Viewer** — the Project card renders **visible-but-disabled** (the 6.4.6
  affordance rule) under an `--el-tint-sky` info line: "Sharing needs the
  **Member** role — as a viewer, your filters stay private to you."
- "Save as" always opens this dialog (prefilled with the source filter's name
  when forking an applied filter).

### The dropdown (panel 2 → 6.2.3)

- The Combobox menu vocabulary (320px, `--radius-card`, `--shadow-elevated`):
  search field ("Find filters…", server-backed + debounced + bounded —
  finding #57), then the fixed group order **Starred → My filters → Project
  filters → Defaults**. A starred entry appears ONLY under Starred (no
  duplicates).
- Rows: a **star toggle** (a sibling focusable button inside the option row —
  never nested in another control; starred = filled `--el-warning` amber star
  - `aria-pressed`), the name, and the secondary hint — visibility glyph +
    owner name for others' shared filters, "Private" + lock for mine,
    "Built-in" for defaults. The APPLIED entry carries the `--el-accent` check
    (`aria-selected`).
- Footer: **"View all filters"** → the `/filters` directory. Per-group empty
  lines: "No starred filters yet — star a filter to pin it here." / "You
  haven't saved any filters yet." / "No filters shared with this project
  yet."
- Applying an entry resolves the stored envelope through the 6.2.1 read and
  writes `?filter=v1:` — the URL stays the single state channel
  (reload/share keep working; no new state surface).

### The directory (panel 3 → 6.2.4)

- **Route: `/filters`** — project-scoped, a sibling of `/issues` in the
  authed shell. Entries: the dropdown's "View all filters" footer + the
  command palette. **Deliberately NOT a primary sidebar item** — Jira's
  "Filters" nav entry belongs to its site-global model; in Motir's
  project-contained model the /issues toolbar is the home of filtering, and
  the sidebar stays lean (recorded deviation).
- The table (the list-table grammar): **Name** (bookmark/lock glyph + linked
  name — clicking applies the filter on /issues — + truncated description) ·
  **Owner** (Avatar + name; built-ins "—") · **Visibility** (`Pill`:
  Project = users glyph on `--el-tint-sky`; Private = lock, neutral tone;
  Built-in = neutral) · **Stars** (my-star toggle + the SQL-aggregated
  count) · **Actions** (the … menu). Server-searched + paginated (50/page,
  the 2.5.12 footer) — never an unbounded fetch.
- **Row actions by the 6.2.1 matrix**: owner → Edit details / Subscribe… /
  Delete; project admin (and workspace owner/admin) additionally → Change
  owner — on ANY project-shared filter (the mock shows an admin's menu on
  another member's filter); non-owners on shared rows → Subscribe… only.
  "Edit details" opens the panel-1 dialog prefilled; **"Change owner" reuses
  the 6.4.1 add-member Combobox grammar** (referenced, not redrawn).
- **Built-ins** (the eight expressible system filters: My open issues ·
  Reported by me · All / Open / Done issues · Created / Updated / Resolved
  recently) are listed read-only: no owner, no stars, no actions.
  **Decision (recorded): built-ins are NOT starrable and NOT subscribable** —
  they are non-persisted AST constants (6.2.1); there is no row to star or to
  FK a subscription to, and they are already always present in the dropdown's
  Defaults group. ("Viewed recently" omitted — no view-history substrate;
  extension.)
- States: the EmptyState ("No saved filters yet" + "Go to Issues" — creation
  lives in the /issues builder, the directory manages) and the 6.4.6
  ErrorState verbatim for a no-access deep link. Loading = the standard
  table skeleton (the 2.5.8 grammar, not redrawn).

### Visibility + deletion (panel 4 → 6.2.3 / 6.2.4)

- **Edit details** carries the same visibility radio cards; flipping
  Project → Private surfaces the info note naming the consequences ("hides it
  from everyone else — their subscriptions stop delivering, and dashboard
  widgets using it show “Filter missing”") — the quiet symmetric twin of the
  delete warning.
- **Delete** is a `role="alertdialog"` confirm that **names the dependents**
  (the 6.2.1 enumeration read): "**1 subscription** will be removed (…)" and
  the RESERVED 6.3 line "**N dashboard widgets** use this filter — they'll
  show a “Filter missing” state." `Button` danger; consequences in text,
  never colour-only. Deletion cascades subscriptions in one transaction;
  widgets degrade to panel 6.

### Subscriptions (panel 5 → 6.2.5)

- The dialog: **Frequency** as the `Segmented` control (Daily / Weekdays /
  Weekly), **Day** (Combobox, rendered only for Weekly) + **Time** (Combobox,
  clock glyph, hour presets), and the explainer copy: "Emails you the first
  50 results and the total count, on the workspace timezone. A report, not an
  alert — it sends even when nothing matches."
- The **subscribed state**: mint-tile bell card "Subscribed — daily at 09:00"
  - the delivery line + **Unsubscribe** (ghost). In the row menus the
    Subscribe item flips to "Subscribed…" with the schedule as its secondary.
- **Mounts**: the directory row's … menu + the dropdown row's context action
  — both open this dialog. Unsubscribe also lives in the email
  (token-authenticated link, the shipped unsubscribe pattern).

### The "Filter missing" widget state (panel 6 → 6.3)

The degraded BODY a dashboard widget renders when its filter FK dangles (the
verified Jira-gadget behaviour, designed here so 6.3 inherits it): the
`triangle-alert` glyph in `--el-warning`, the serif headline "Filter
missing", the one-line cause, and a single recovery action ("Choose a
filter"). The widget chrome itself is 6.3's to design; never a crash, never
a silent blank.

### Copy strings

`Saved` · `Find filters…` · `Starred` · `My filters` · `Project filters` ·
`Defaults` · `Built-in` · `View all filters` · the three group-empty lines
(above) · `Edited` · `Save` · `Save as` · `Discard changes` · `Save filter` ·
`Name` · `Description (optional)` · `What is this filter for?` · `Who can see
this filter?` · `Private` / `Only you and project admins can see it.` ·
`Project` / `Everyone who can browse this project can see and apply it.` ·
`A filter named “…” already exists in this project.` · `Sharing needs the
Member role — as a viewer, your filters stay private to you.` · `Only the
owner (…) can overwrite this filter — Save as creates your own copy.` ·
`Filters` · `Saved filters for … Save new ones from Issues.` · `Search
filters…` · `Name / Owner / Visibility / Stars` · `Edit details` · `Change
owner` · `Subscribe…` · `Delete` · `No saved filters yet` / `Build a filter
on Issues and save it to reuse and share it here.` / `Go to Issues` · `Edit
filter details` · `Save changes` · the go-private note (above) · `Delete
filter?` · `This permanently deletes “…” for everyone in this project.` ·
`N subscription(s) will be removed (…)` · `N dashboard widgets use this
filter — they'll show a “Filter missing” state.` · `Delete filter` ·
`Subscribe to “…”` · `Frequency` · `Daily` / `Weekdays` / `Weekly` · `Day` ·
`Time` · the subscription explainer (above) · `Subscribe` · `Subscribed —
daily at 09:00` · `Unsubscribe` · `Filter missing` · `The saved filter this
widget used was deleted, so it can't load results.` · `Choose a filter` ·
`12 filters · page N of M`. All via next-intl in 6.2.3/6.2.4/6.2.5.

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: the name chip + active triggers ride
  `--el-tint-lavender` + `--el-accent`; visibility tiles/pills the lavender /
  sky tints with `--el-text-strong` (AA, finding #35); the starred star is
  filled `--el-warning` amber (+ `aria-pressed` — state never colour-only);
  the dirty marker is the amber dot + the word "Edited"; the danger path
  `--el-danger` / `--el-danger-text`; **no new token needed**.
- Shape via element-semantic tokens only (`--radius-btn/card/input/modal/
control/badge`, `--spacing-control/input/chip/icon-btn/tooltip/btn-*`,
  `--height-control/input/btn-*`, `--shadow-subtle/elevated/modal`) — every
  surface reshapes under `data-display-style`.
- **No new primitive**: ToolbarButton + Modal + FormField + Input/Textarea +
  Combobox (menus, day/time selects) + Segmented + Pill + the 6.4.1
  access-card radio grammar + the list-table/pagination grammars +
  EmptyState/ErrorState + Avatar + Tooltip cover every element.
- A11y: the dropdown is a labelled `listbox` (options `aria-selected`; the
  star a sibling focusable button with `aria-pressed`, value-specific
  names); dialogs are focus-trapped `role="dialog"` / the delete confirm
  `role="alertdialog"`; the dirty marker and result counts `role="status"`;
  visibility radios a labelled `radiogroup` with full keyboard support; row
  menus `role="menu"` keyboard-complete; the disabled Project card
  `aria-disabled` with the reason visible in text. Light + dark parity via
  the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- Per-filter Viewers/Editors grant lists + group share scopes (no groups in
  Motir; the 6.4 roles draw the boundary — the Story 6.2 recorded
  deviation).
- Cross-project / workspace-global filters (follows the 6.1 scope deviation).
- Filter-sourced boards (the company-managed shape; Motir boards stay
  status-mapped — 3.1/3.6).
- Advanced cron subscriptions (the preset tier ships; cron is the power-user
  extension).
- "Viewed recently" (no view-history substrate).
- A "Filters" primary sidebar item (the site-global Jira shape; revisit if a
  use case lands).

---

## Work-item type + executor picker (Story 2.7 · 2.7.1 → 2.7.4)

Asset: `design/work-items/type-executor-picker.mock.html` (four panels; toggle
dark for token parity). The design for two NEW structural fields promoted from
plan PROSE to UI — `type` (a fixed ten-member `WorkItemType` enum, leaf-only)
and `executor` (`coding_agent | human`, seeded from a type→executor default
map). The picker is a NEW element on TWO existing surfaces — the issue **create
modal** (2.3.3) and the issue **detail rail** (2.4). The code subtask is 2.7.4
(blocked on this design gate + on the 2.7.3 schema).

### The mirror, and why this is a sibling control (not a replacement)

Verified in 2.7.2 (Atlassian): Jira's "issue type" IS the kind hierarchy
(epic/story/task/sub-task/bug) and routing-WHO is the **assignee** field (a
Rovo agent "shows up as an assignee"). Motir splits the axes — `type` (what
NATURE of work) + `executor` (who) — for the Epic-7 dispatch use case. So the
control is drawn as a **sibling of the kind/assignee affordances**, never a
replacement for kind: in the create modal it is its own `Type` field row
(after Kind/Title), and on the detail rail its own `Type` + `Executor` rows
alongside Status/Assignee.

### Placement

- **Create modal (panel 1).** A new `Type` field row, then an `Executor` row,
  inserted after the existing Kind + Title rows (before the rest of the
  optional fields). Both rows render **only when the chosen kind is a leaf**
  (task / subtask / bug) — absent for epic / story (panel 2d). The `Type`
  field is the shipped `Combobox`; because the modal is a `role="dialog"`, its
  menu renders **inline** (the Combobox in-dialog branch), not portaled.
- **Detail rail (panel 3).** Two new rail rows — `Type` (the hued chip) and
  `Executor` (the agent/person indicator) — in the metadata column beside
  Status / Assignee, each **inline-editable** (the 2.5.5 pattern: the static
  chip/indicator IS the click target, opening the same picker in place).

### The type picker — Combobox (panel 1; 2.7.4)

- The shipped `Combobox` (`components/ui/Combobox.tsx`), `searchable={false}`
  (a fixed, closed set of ten — no type-ahead), exactly like the existing
  kind `TypePicker`. Each option row = the type's **saturated `--el-type-*`
  glyph** (mirroring `IssueTypeIcon`) + its label; the selected row carries the
  trailing `Check`. The trigger shows the chosen glyph + label + the
  `ChevronsUpDown` affordance, or the `Set a type` placeholder when null.
- **The ten members, in menu order:** Code · Design · Test · Content ·
  Research · Review · Decision · Deploy · Manual · Chore (the 2.7.2 enum order;
  the "doing" types first, the meta/admin types last).

### The executor control — Segmented (panels 1–2; 2.7.4)

- The shipped `Segmented` (`components/ui/Segmented.tsx`), a two-option group:
  `Coding agent` (bot glyph) | `Human` (person glyph). The pressed option gets
  the raised `--el-page-bg` fill + `--shadow-subtle`; its leading glyph takes
  `--el-accent` (the Segmented contract).
- **Default-seeding (panel 2a/2b).** Choosing a type SEEDS the executor from
  the 2.7.3 `defaultExecutorForType` helper (the single source — the UI never
  re-states the map): `code` → `coding_agent`, `manual` → `human`, etc. The
  seed is **not a lock** — the user can flip it and the override sticks
  (panel 2b shows Manual seeding Human, then overridden to Coding agent).
- **Unset (panel 2c).** `type` is nullable; the trigger shows `Set a type` and
  the executor control is dormant until a type seeds it.

### The type chip + executor indicator — detail rail (panel 3; 2.7.4)

- **Type chip** — the `Pill` recipe: the type's hue in a **`color-mix` tint
  BACKGROUND** + `--el-text-strong` label (AA, finding #35 — never a
  page-level tint) + the saturated `--el-type-*` glyph. A single saturated
  `--el-type-*` token therefore yields BOTH the glyph hue and the chip tint
  (`color-mix(in srgb, var(--el-type-X) 14%, var(--el-page-bg))`; the two grey
  meta-types use 18% so the near-neutral tint still reads) — so no ten separate
  `--el-tint-*` pairs are needed.
- **Executor indicator** — a compact bot/person glyph (`--el-text-secondary`)
  - label, read-only until clicked.
- **Null leaf (panel 3c).** A quiet dashed `Set a type` affordance; no executor
  row appears until a type is set.

### The ten-type hue map (panel 4 — decided once here)

Proposed as ten new Tier-3 `--el-type-{code…chore}` tokens (2.7.4 adds them to
`globals.css`, the per-component token-growth pattern — the per-TYPE palette
parallel to the existing per-KIND `--el-type-{epic…subtask}`). **No new Tier-0
colour is needed:** the seven "produces an artifact" types take the seven
saturated hues; the three "meta / admin" types (decision, manual, chore) take
the three greys — desaturation is semantically apt.

| Type       | `--el-type-*` → Tier-0      | Glyph (lucide)  | Executor default       |
| ---------- | --------------------------- | --------------- | ---------------------- |
| `code`     | `--color-info` (blue)       | code            | coding_agent           |
| `design`   | `--color-accent` (pink)     | pencil          | either (default agent) |
| `test`     | `--color-success` (green)   | flask-conical   | coding_agent           |
| `content`  | `--color-accent-teal`       | file-text       | either (default agent) |
| `research` | `--color-primary` (purple)  | lightbulb       | either (default agent) |
| `review`   | `--color-accent-orange`     | clipboard-check | human                  |
| `deploy`   | `--color-destructive` (red) | rocket          | coding_agent           |
| `decision` | `--color-charcoal` (ink)    | scale           | human                  |
| `manual`   | `--color-stone` (grey)      | hand            | human                  |
| `chore`    | `--color-slate` (grey)      | wrench          | either (default agent) |

`deploy` → red is the one semantic stretch (production/ship = high-stakes); the
glyph (rocket) disambiguates it from the `bug` KIND, which also uses red but
appears in a different control. The default-executor column is the single map
2.7.2 fixes and 2.7.3's `defaultExecutorForType` encodes.

### Copy strings

- **Type labels (10):** `Code` · `Design` · `Test` · `Content` · `Research` ·
  `Review` · `Decision` · `Deploy` · `Manual` · `Chore`.
- **Executor labels (2):** `Coding agent` · `Human`.
- **Empty / field:** field labels `Type`, `Executor`; the unset placeholder +
  the dashed detail affordance both read `Set a type`.
- All copy goes in the issues i18n namespace (the same locale set the app
  ships — 2.7.4 AC); labels match the enum gloss in
  `docs/decisions/work-item-type-taxonomy.md` (2.7.2).

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: the ten per-type hues = the new
  `--el-type-{code…chore}` (glyph) + a `color-mix` tint of the same token (chip
  background) with `--el-text-strong` (AA, finding #35, and never colour alone
  — the glyph SHAPE + the label carry the type); the executor glyph =
  `--el-text-secondary`, the active segment glyph = `--el-accent`. No
  page-level tint.
- Shape via element-semantic tokens only (`--radius-input/card/control/btn/
badge`, `--spacing-control/chip-*`, `--height-control`,
  `--shadow-elevated/subtle/modal`) — every surface reshapes under
  `data-display-style`.
- **No new primitive** — Combobox + Segmented + Pill (chip) + the
  `IssueTypeIcon`-adjacent glyph + the modal/rail grammars cover every element.
- A11y: the type picker is the Combobox's labelled `role="combobox"` →
  `role="listbox"` of `role="option"` rows (keyboard-complete per its own bar);
  the executor control is Segmented's labelled `role="group"` of `aria-pressed`
  buttons; the inline-edit chips are keyboard-activatable triggers that open
  the same pickers; type/executor controls carry aria-labels. Light + dark
  parity via the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- **Per-type PROMPT generation** that keys off `type` — Story 7.6 (the
  total-function generator the fixed enum exists to support).
- **The AI dispatch surface** that routes by `executor` (agent-dispatch vs
  human-assign) — Story 7.6 / 7.7.
- **Adding an eleventh type** — an explicit enum addition + migration (+ a new
  `--el-type-*` token), never an ad-hoc free-text string (the closed set is the
  whole point).
- **Bulk type/executor edit** from the list/board (the single-item picker
  ships; multi-select bulk edit is a later list-surface extension).
- Any change to the **kind-parent grammar** — `type` is orthogonal to `kind`
  and never affects parenting.

### Primitives composed (no hand-rolling)

- **Type picker** → `Combobox` (`components/ui/Combobox.tsx`, in-dialog inline
  menu).
- **Executor control** → `Segmented` (`components/ui/Segmented.tsx`).
- **Type chip** → the `Pill` tint-background recipe + the `IssueTypeIcon`
  saturated glyph.
- **Type glyphs** → the `IssueTypeIcon` hue pattern extended to the ten
  `--el-type-*` TYPE tokens.
- **Modal / rail chrome** → the shipped `Modal` + the detail-rail metadata-row
  grammar.
- If a genuinely new primitive is ever needed, that is a NEW `design/` subtask
  — not a 2.7.4 code workaround.

---

## Delete a work item — confirm UX (Story 2.8 · 2.8.1 → 2.8.4)

Asset: `delete-confirm.mock.html` designs the **permanent delete** flow for
Story 2.8 (Jira-parity hard delete with a **subtree cascade**), shown next to
the already-shipped soft **archive** (`workItemsService.archiveWorkItem` —
`archivedAt`, single-node, reversible). 2.8.1 is the design gate; the UI code
(delete action + confirm dialog on detail / list / board, permission-gated) is
2.8.4, blocked on this.

**The two destructive actions are kept deliberately distinct** — this is the
whole point of the surface:

| Action      | Reversible       | Scope                      | Confirm                         | Gate        |
| ----------- | ---------------- | -------------------------- | ------------------------------- | ----------- |
| **Archive** | Yes (restorable) | Single node (kids stay)    | inline / lightweight            | `canEdit`   |
| **Delete**  | No (permanent)   | The whole subtree, cascade | `alertdialog` — count + warning | `canDelete` |

**Mirror check (rung 1 — Atlassian + Linear):** Jira's delete confirm warns the
action is permanent, **names the cascade** ("This issue has N sub-tasks that
will also be deleted"), and offers no type-to-confirm for a normal issue — a
single Cancel / Delete pair. We match that exactly and reuse the **5.3.6
delete-with-count** dialog grammar (`saved-filters.mock.html` panel 4): a real
`role="alertdialog"`, consequences **named in text** (never colour-only), a
dependents list, and a destructive button labelled with the action + magnitude.

### The six panels

| Panel | Surface                                                                      |
| ----- | ---------------------------------------------------------------------------- |
| 0     | Entry point — the **work-item detail** ⋯ actions menu, open (permitted)      |
| 1     | Entry points — **list row** + **board card** ⋯ menus, and the **gated** menu |
| 2     | Confirm dialog — **parent with descendants** (the cascade)                   |
| 3     | Confirm dialog — **leaf** item (no descendants)                              |
| 4     | States — **in-flight** (deleting) · **error** (failed, retryable)            |
| 5     | Legend — the archive-vs-delete table + copy index                            |

### Entry points (panels 0–1)

- The ⋯ menu is the shipped `Popover` actions menu (RowActionsMenu vocabulary),
  identical on detail / list / board. Order: `Edit details` · `Copy link` · _—
  separator —_ · `Archive` · `Delete…`. **Delete is the only danger-coloured
  row**; its trailing `…` signals a confirm step follows (it never deletes on
  click), and the separator + colour make Archive and Delete impossible to
  confuse.
- **Permission-gated, Jira-faithfully.** `Delete` needs the project
  `canDelete` permission (Jira's "Delete Issues" project permission,
  project-admin by default); `Archive` needs `canEdit`. A user without a
  permission **doesn't see that row at all** — the action is _hidden, never
  shown-disabled_ (the mirror's behaviour) — so the gated viewer's menu in
  panel 1 collapses to just `Copy link`.

### The confirm dialog (panels 2–3)

- A real `role="alertdialog"` (the shipped `Modal` chrome — `--radius-modal` /
  `--shadow-modal`) with `aria-labelledby`/`aria-describedby`. **Cancel takes
  default focus**, and `Esc` / the ✕ both cancel — the safe default for a
  destructive dialog.
- **Cascade case (panel 2):** the body warns it permanently deletes the named
  item "and everything beneath it. **This can't be undone.**" A `dep-list`
  (the 5.3.6 grammar) names the consequences: the **descendant count with a
  per-kind breakdown** ("7 descendants will also be deleted — 5 subtasks, 1
  task, 1 bug"), that comments/attachments/history on all N items go too, and
  that inbound links are removed. The destructive button states the
  magnitude — **"Delete 8 items"** = `1 + descendants` — so the count is on the
  button you press, not just in the prose.
- **Leaf case (panel 3):** the cascade row drops out, the copy reads "It has no
  child items.", and the button reads **"Delete work item"** (no magnitude). The
  irreversibility warning, the comments/history note, and the Archive
  alternative stay.
- **Archive as the reversible alternative** lives _inside_ the same dialog: a
  mint callout ("Just want it out of the way? **Archive** hides this item but
  keeps it and its history…") with an `Archive instead` link — the one-click
  safe exit, so a user who opened Delete by reflex can still down-shift to the
  recoverable action without dismissing and re-finding the menu.

### States (panel 4)

- **In-flight:** the dialog is `aria-busy`, both buttons disabled, the danger
  button shows a spinner + `Deleting…` — so a slow cascade can't be
  double-fired.
- **Error:** a `role="alert"` rose callout states the delete is **atomic** — it
  either fully cascades or changes nothing — so a failed attempt leaves the
  subtree intact ("Nothing was changed — the item and its descendants are
  intact."); the danger button becomes `Try again`.

### Copy strings

Menu: `Edit details` · `Copy link` · `Archive` · `Delete…` · |
Dialog title: `Delete this work item?` · |
Cascade body: `This permanently deletes [KEY] “[title]” and everything beneath it. This can't be undone.` · |
Leaf body: `This permanently deletes [KEY] “[title]”. It has no child items. This can't be undone.` · |
Cascade rows: `N descendants will also be deleted — [kind breakdown].` · `All comments, attachments, and activity history on these N items go with them.` · `Links from other items (blocks, relates to, duplicates) are removed.` · |
Leaf row: `Its comments, attachments, and activity history are deleted too.` · |
Archive callout: `Just want it out of the way? Archive hides this item but keeps it and its history — and leaves its descendants live. You can restore it later.` · `Archive instead` · |
Buttons: `Cancel` · `Delete N items` / `Delete work item` · `Deleting…` · `Try again` · |
Error: `Couldn't delete this item. Nothing was changed — the item and its descendants are intact. Check your connection and try again.`

All copy goes in the issues i18n namespace (the locale set the app ships).

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: the danger menu row + the destructive button
  use `--el-danger` (`--el-danger-text` on the fill); the cascade `dep-list`
  glyphs use `--el-warning`; the **archive callout** uses `--el-tint-mint` +
  `--el-success` (the safe/recoverable cue, a deliberate green contrast to the
  red delete). **Tier 0 has no red tint**, so the error callout uses
  `--el-tint-rose` background + a `--el-danger` border/icon with
  `--el-text-strong` body — the design system's honest danger surface, **no new
  Tier-0 colour**. No page-level tint.
- Shape via element-semantic tokens only (`--radius-modal/card/control/badge`,
  `--spacing-card-padding`/`-control-*`/`-chip-*`, `--height-btn-md`,
  `--shadow-modal/elevated/subtle`) — every surface reshapes under
  `data-display-style`.
- **No new primitive** — the menu is `Popover`, the dialog is `Modal`, the
  buttons are `Button` (`danger` / `secondary` variants), the dep-list + callout
  reuse the 5.3.6 grammars.
- A11y: `role="alertdialog"` + labelled/described; **every consequence is in
  words, never colour alone** (the count, the irreversibility, the atomicity);
  Cancel is default focus, `Esc`/✕ cancel; in-flight is `aria-busy` + disabled;
  the error is `role="alert"`. Light + dark parity via the token flip (toggle in
  the mock).

### Out of scope (documented extension slots)

- **The cascade COUNT backend** — the subtree count + per-kind breakdown the
  dialog reads before opening (2.8.x service), and the **atomic cascade
  delete** transaction itself (2.8.x); this asset only specifies the UX they
  feed.
- **Bulk delete** from a list/board multi-select — the single-item flow ships;
  multi-select bulk delete (with an aggregated count) is a later list-surface
  extension.
- **Restore / trash bin** — delete is permanent by design; an undo window or a
  recycle bin is NOT in 2.8 (archive is the recoverable path). If ever wanted,
  it is its own story.
- **Type-to-confirm** for very large cascades — deliberately omitted to match
  the mirror (Jira asks no typed confirmation for a normal issue); revisit only
  with a concrete use case (the justified-deviation rule).
- **Audit/event emission** on delete (who deleted what) — an activity/audit
  concern owned by the revisions/activity surface, not this dialog.

### Primitives composed (no hand-rolling)

- **Entry menus** → `Popover` actions menu (RowActionsMenu vocabulary).
- **Confirm dialog** → the shipped `Modal` (`role="alertdialog"`).
- **Buttons** → `Button` (`danger` for delete, `secondary` for cancel, the
  `loading` spinner state for in-flight).
- **Cascade dep-list + archive/error callouts** → the 5.3.6
  delete-with-count + note-line grammars (`saved-filters.mock.html`).
- If a genuinely new primitive is ever needed, that is a NEW `design/` subtask
  — not a 2.8.4 code workaround.

## Archived work items view + Restore UX (Story 2.9 · 2.9.1 → 2.9.3)

`archived.mock.html` is the design asset for the **archived work items view** —
the durable surface that replaces the transient **Undo** toast in
`WorkItemActionsMenu.tsx` (commented there as "the only restore path until an
archived-items view ships"). It is the design gate for the code subtask
**2.9.3**. Built from the live `--el-*` tokens + the shipped primitives the
active list already uses (`list.mock.html`), so 2.9.3 composes the same
vocabulary with no Pencil→code gap and **no new primitive**. Mirror product:
Jira's dedicated **Archived issues** view with per-item Restore.

### Placement — a dedicated `/issues/archived` route (rung-1 decision)

**Decision: a dedicated route `/issues/archived`, reachable from the work-items
navigator toolbar via a low-prominence `[Archived]` ghost link** (panel 5). The
three options the card named were a dedicated route, a navigator filter/segment,
or a project-settings page.

- **Rung 1 (Jira) says "dedicated view," and we keep that** — Jira surfaces
  archived work in its own view, not as a navigator sort/segment.
- **Justified deviation on _location_:** Jira's archived view is admin-gated
  under settings because Jira's archive is an **admin bulk operation**. Motir's
  archive is the opposite — an **editor-level, reversible, per-item action**
  surfaced right in the work-item `⋯` menu (`assertCanEdit`,
  `workItemsService.archiveWorkItem`, the single-node "Linear shape"). So the
  restore surface belongs **next to the work** (under the work navigator), not
  behind project admin. One concrete reason earns the deviation: the user who
  archived an item from its `⋯` menu is the one who restores it, and they live in
  the navigator, not in settings.
- **A navigator SEGMENT was rejected** ("no complexity for nothing"): every
  navigator read filters `archivedAt IS NULL` (`workItemRepository` forest CTE +
  every flat/count arm), and the navigator's sort, Tree view, inline-edit,
  advanced + saved filters are all built around **live** items. Bolting an
  "archived" mode onto `/issues` would fork all of those paths for a rarely-used
  read. A dedicated **flat** route keeps the archived surface simple and leaves
  the live navigator untouched.

**Entry point (panel 5):** a quiet `[Archived]` ghost link (lucide `archive`)
is added to the `/issues` toolbar **before** `[Filter]`, with a small count
badge so a user knows there's something there without opening it. It links to
`/issues/archived`; the archived page carries a `← Work items` back link
(`--el-link`) home. This is the one change 2.9.3 makes to the live navigator
toolbar (`IssueListToolbar`).

### Anatomy — a flat, paginated list (NOT a tree)

Motir's archive is single-node (children stay live — the deliberate Linear
shape, `workItemsService.ts:1469`), so archived items do **not** form a tree.
The view is therefore a **flat, server-paged list**, reusing the active List's
container chrome (`rounded-(--radius-card)` bordered box, `--el-surface-soft`
header) and `IssueListPager` footer verbatim. The columns are a focused subset
of the active list plus the two archive-specific facts:

| Column      | Width (px) | Cell                                                 | Source                                    |
| ----------- | ---------- | ---------------------------------------------------- | ----------------------------------------- |
| Title       | `1fr`      | `IssueTypeIcon` (type hue) · mono identifier · title | the item (reused row vocabulary)          |
| Status      | 130        | `Pill` by lifecycle category (`STATUS_TONE`)         | the item's last status (kept on archive)  |
| Archived by | 175        | initial-letter `Avatar` · name                       | the **`archived` revision** `changedById` |
| Archived    | 140        | formatted date                                       | the **`archived` revision** `createdAt`   |
| _(actions)_ | 120 (end)  | per-row `[Restore]` button — **canEdit only**        | —                                         |

Grid template: `minmax(0,1fr) 130px 175px 140px 120px`. **No** Priority /
Assignee / Reporter / Due / Est. columns — the archived view answers "what did
we archive, by whom, when, and can I get it back," so it keeps the row identity

- archive provenance and drops the planning columns ("no complexity for
  nothing"). The whole row (minus the action cell) links to `/issues/[identifier]`
  so the item is still reachable; the `[Restore]` button is a sibling control
  outside the link (it doesn't navigate).

**Default order = most-recently-archived first** (`archived.createdAt` desc) —
the freshest mistake to undo sits on top. (Headers are static here, not
sortable; sortable columns are an Epic-6 saved-views concern, like the active
list.)

**Reading "Archived by / at" — the data note for 2.9.3.** `archiveWorkItem`
records an `'archived'` revision (`workItemRevisionsService.recordRevision`,
diff `{ archivedAt: { from: null, to } }`) with `changedById`. The view reads
**that revision** for the actor + timestamp (the `workItem.archivedAt` column
gives the timestamp but not the actor). A re-archived item may have several
`'archived'` revisions — use the **latest** one.

### Restore — an inline action with a success toast

Restore is **reversible** (re-archive the item from its `⋯` menu), so it is an
**inline per-row action with a success toast** — NOT a confirm dialog, and
**without an Undo button** (unlike the archive toast, whose Undo IS the restore;
restoring needs no undo because re-archiving is the inverse).

- **Affordance:** a small **secondary `Button`** (`size="sm"`, lucide
  `rotate-ccw` + "Restore"), right-aligned in the actions cell. `aria-label`
  "Restore {key}".
- **In flight (panel 1):** clicking it POSTs `unarchiveWorkItem`; the row fades
  - locks optimistically (`opacity` + `pointer-events:none`, `aria-busy`), the
    button reads "Restoring…" disabled. The list is a **client island**, so on the
    200 the row is **removed locally** (the page-state-after-mutation contract —
    not a `router.refresh()`); the pager count decrements. The E2E waits on the
    unarchive **200** before asserting the row is gone (the authoritative-signal
    rule).
- **Confirmation:** the shipped success **`Toast`** — `{key} restored` (the
  existing `workItemActions.restoredToast` string, reused verbatim) with a
  `--el-success` `CircleCheck`. No action button on this toast.
- **Error:** reuse `workItemActions.archiveErrorTitle` / `archiveErrorBody`
  ("Couldn't archive" → here a generic restore failure) as an error `Toast`; the
  row un-fades and stays (nothing changed server-side).

### Access — view vs. restore

Two distinct gates, matching the shipped service:

- **View the page = `canBrowse`.** Anyone who can browse the project may open
  `/issues/archived` and audit what was archived (mirrors the `/issues`
  navigator's `canBrowse` gate, `projectAccessService.getSavedFilterCapabilities`).
  A non-browsable project renders the `NoAccessState` (same as `/issues`).
- **Restore = `canEdit`.** `unarchiveWorkItem` is `assertCanEdit`-gated (same as
  archive). A viewer who can browse but **not** edit sees the list with the
  **Restore column dropped entirely** (panel 4) — hidden, never shown-disabled,
  mirroring `WorkItemActionsMenu`'s hidden-not-disabled capability pattern. The
  grid drops to `minmax(0,1fr) 130px 175px 140px` (the `.view-only` modifier).

### Empty + loading

- **Empty (panel 2)** — the shipped `EmptyState` Card with an `Archive` glyph:
  **"Nothing archived"** / "Archived work items show up here. Archive one from
  its ⋯ menu to hide it from boards and lists while keeping its history." +
  a secondary **"Back to work items"** button (there is nothing to restore here,
  so the action routes home, not to "New").
- **Loading (panel 3)** — the flat shimmer skeleton (same columns), including a
  Restore-button placeholder in the actions cell. No layout shift on settle.

### Pagination — reuses IssueListPager (finding #57)

The archived list **must not load every row** (a long-lived project accretes
archived items): it is **server-paged** like the active List, **page size 50**,
reusing `IssueListPager` verbatim — `Showing 1–50 of N` (N = total archived
count) + Prev/numbered/Next with ellipsis truncation, the current page the accent
chip + `aria-current="page"`, URL-driven `?page=`. The repository read is a NEW
arm filtering **`archivedAt IS NOT NULL`** (every existing arm filters
`IS NULL`) — flagged for 2.9.3 as the one new data path.

### Tokens / a11y

- Colour only via `--el-*`: status via `Pill` tones, type icons via `--el-type-*`,
  the success toast via `--el-success`, the restore button + back link via
  `--el-link` / `--el-border`. No Tier-0 `--color-*`.
- Shape via element-semantic tokens (`--radius-card` / `--radius-control` /
  `--radius-btn` / `--radius-badge`, `--spacing-control-*`, `--height-control`,
  `--shadow-elevated` / `--shadow-card`) so the surface re-shapes under
  `data-display-style`.
- The list is `role="table"` with `columnheader`s; the Restore button is a real
  `<button>` with a per-item `aria-label`; the in-flight row carries `aria-busy`;
  the toast is `role="status"`. The page is in scope for the strict shell-a11y
  sweep. Toggle dark in the mock to confirm token parity.

### States in the mockup

Panels: **(0)** the archived view in the `/issues/archived` shell (back link +
header + flat table + pager) · **(1)** Restore in flight (the row faded/locked +
the "{key} restored" success toast) · **(2)** empty state · **(3)** flat loading
skeleton · **(4)** the view-only state (canBrowse, not canEdit — Restore column
dropped) · **(5)** the navigator entry point (the `[Archived]` toolbar link on
`/issues`).

### Out of scope (documented extension slots)

**Bulk Restore** (multi-select + a bulk action bar) — Jira has it, but Motir's
archive is per-item from the `⋯` menu today, so single-row Restore matches the
current archive shape; bulk select is an Epic-6 list-actions concern, noted not
built. **Sortable / configurable columns** and a **search/filter within
archived** are also out of scope for 2.9.3. **Permanent delete from the archived
view** was out of scope for 2.9.3 — it is now designed in **2.9.7** (the next
section) and built by **2.9.5**.

## Delete affordance in the archived view + archived-item delete-confirm (Story 2.9 · 2.9.7)

2.9.7 is the design gate for **2.9.5** (MOTIR-994 — deleting an archived work
item). It EXTENDS two existing assets rather than adding a new surface:
`archived.mock.html` gains the **Delete affordance** (panels 6–8), and
`delete-confirm.mock.html` gains the **archived-item confirm variant** with the
live-descendant warning (panels 6–7). **No new primitive, no new modal** — the
confirm is the shipped `DeleteWorkItemDialog` (2.8.4) with one added warning row.

### Where Delete sits — Restore inline, Delete in the row `⋯` (the decision)

The archived list row already has a primary inline **`[Restore]`** button
(canEdit, 2.9.3). 2.9.7 adds **permanent Delete** beside it as a single danger
**`Delete…`** row inside a per-row **`⋯` overflow menu** (the shipped Popover
`RowActionsMenu` vocabulary — the same menu the live list/board rows and the 2.8
delete mock use; there `Archive→Restore` is the only swap).

- **Why Restore stays the inline button and Delete goes in the `⋯`** (not both in
  one menu, not a bare trash icon): the archived view's whole job is _getting
  things back_, so Restore is the common, safe, reversible primary action and
  must stay one click away — demoting it behind a menu to make room for Delete
  would slow the dominant path. Delete is the opposite — rare, irreversible,
  higher-privilege — so it belongs one level deep, danger-toned, with a trailing
  `…` that signals a confirm follows. A bare red trash icon-button was rejected
  (misclick risk + breaks the established `⋯ → Delete…` vocabulary). This refines
  the card's "⋯ carrying Restore + Delete…" example: Restore is prominent inline,
  the `⋯` is purely the canManage/Delete affordance, so the menu maps 1:1 to a
  capability. (Mirror, rung 1: Jira's archived view keeps Restore prominent and
  puts destructive/admin actions in an overflow; Linear's archived view is the
  same shape.)

### The gate split (independent capabilities) — panel 7

Restore = **`canEdit`**, Delete = **`canManage`** — the SHIPPED capability
(`projectAccessService.getCapabilities → { canBrowse, canEdit, canManage }`;
`workItemsService.deleteWorkItem`/`getDeletePreview` both call `assertCanManage`,
`workItemsService.ts:1569`/`:1619`). The 2.8 delete mock's `canDelete` label is
this same gate. The two are **independent**, so the actions cell is total over
all four combinations (each affordance HIDDEN — never shown-disabled — when its
gate is unmet, mirroring `WorkItemActionsMenu`):

| `canEdit` | `canManage` | Actions cell                                          |
| --------- | ----------- | ----------------------------------------------------- |
| ✓         | ✓           | `[Restore]` + `⋯`(`Delete…`)                          |
| ✓         | ✗           | `[Restore]` only (no `⋯` — no Delete to host)         |
| ✗         | ✓           | `⋯`(`Delete…`) only (no inline Restore)               |
| ✗         | ✗           | column dropped entirely (the panel-4 view-only state) |

So "a row can show Restore but not Delete" (the editor case) and its inverse both
fall out cleanly. The grid column widened **120→150px** to seat `[Restore]` + `⋯`.

### On the DETAIL page — panel 8

Delete **does** appear on an archived item's detail page, in the standard detail
`⋯` actions menu (the same `RowActionsMenu` as the live detail page, with
`Archive→Restore` swapped): **`Restore`** (canEdit) + a danger **`Delete…`**
(canManage) below the separator. **The detail BANNER and its prominent Restore
button are a SEPARATE design — 2.9.8 (→ code 2.9.6) — and are NOT specified
here**; 2.9.7 only places the Delete affordance the card asks about. 2.9.8 should
keep the banner as the prominent Restore and leave Delete in the `⋯`.

### The archived-item confirm modal — the live-descendant warning (the one new thing)

The confirm is the **shipped `DeleteWorkItemDialog`** (2.8.4) reused verbatim —
same `role="alertdialog"` Modal, same 5.3.6 count grammar (`totalCount` /
descendant count / per-kind breakdown), same atomic-failure error state, same
`deletedToast` (`{key} deleted`). There is **no Archive escape hatch** in this
variant (the item is already archived), so that mint callout is omitted.

The ONE new element is the **live-descendant warning**. Motir's archive is
**single-node** (`workItemsService.ts:1469` — archiving a parent never archives
its children), so an archived parent can still own **non-archived, LIVE**
descendants on the active boards/lists. `deleteWorkItem` cascades the **whole
subtree** (`:1560`, `findSubtree`), so deleting the archived parent permanently
destroys those live items too — surprising, because the parent was "tucked away."

- **Panel 6 — archived parent WITH live descendants.** A distinct **peach/amber
  caution callout** (`--el-tint-peach` bg + `--el-warning` border/icon +
  `--el-text-strong`, lucide `triangle-alert`) sits directly under the body,
  ABOVE the normal cascade `dep-list`. Headline **"Some of what's beneath this
  isn't archived."** + body **"Deleting also permanently removes N active work
  items that aren't archived — [kind breakdown]. They're still live on your
  boards and lists. (Archiving an item never archives its children.)"** The peach
  tone is deliberately a THIRD callout colour, distinct from the mint
  archive/safe callout and the rose/danger error callout and the amber dep-list
  _rows_ — so the surprise is unmistakable and never colour-only (the count is in
  words). The `dep-list` then drops its redundant "N descendants" row (the warning
  already named them) and keeps the history + links rows; the button is unchanged
  (`Delete N items`, `1 + descendants`).
- **Panel 7 — archived parent, ALL descendants archived (the contrast).** When the
  **live count is 0**, the peach warning is **suppressed** — nothing active is at
  risk — and the dialog is the ordinary cascade confirm, with a calm
  archive-glyph row: **"N descendants will also be deleted — [breakdown]. All of
  them are already archived — nothing here is live on your boards."** This boundary
  is what makes panel 6's warning meaningful.
- An archived **leaf** (no descendants) reuses the leaf dialog (2.8 panel 3)
  unchanged — no warning, "It has no child items."

**Data note for 2.9.5 (the one new data path).** `getDeletePreview`
(`workItemsService.ts:1614`) returns `{ totalCount, descendantCount, byKind }`
today but does **not** split archived vs live descendants. 2.9.5 must extend the
preview with a **live-(non-archived)-descendant count + per-kind breakdown**
(count the subtree rows where `archivedAt IS NULL`, excluding the root) to drive
the panel-6 copy; the warning shows iff that count > 0. This is the analogue of
2.8.1's "cascade-count backend" extension slot — the design specifies the UX, the
code subtask adds the count.

### Copy strings (added by 2.9.7)

Live-descendant warning headline: `Some of what's beneath this isn't archived.` ·
body: `Deleting also permanently removes N active work items that aren't archived — [kind breakdown]. They're still live on your boards and lists. (Archiving an item never archives its children.)` · |
All-archived row: `N descendants will also be deleted — [kind breakdown]. All of them are already archived — nothing here is live on your boards.` · |
Archived-row `⋯` menu: `Delete…` (danger) · |
Detail `⋯` menu (archived): `Restore` · `Delete…` · |
(Restore button / `{key} restored` / `{key} deleted` toasts are existing 2.9.3 /
2.8.4 strings, reused.) All copy in the issues / `workItemActions` i18n namespace.

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: the `⋯` overflow + its `Delete…` row use the
  `RowActionsMenu` vocab (`--el-danger` on the danger row, `--el-tint-rose` hover);
  the new live-descendant warning uses `--el-tint-peach` + `--el-warning` (the
  warning tint, a third distinct callout tone). The gate-matrix capability chips
  put the state in the tint background with `--el-text-strong` (on) / a
  strikethrough `--el-text-faint` (off) — the state is in text + line-through,
  never colour alone. No Tier-0 `--color-*`.
- Shape via element-semantic tokens (`--radius-card`/`-control`/`-badge`,
  `--spacing-control-*`, `--height-control`, `--shadow-elevated`/`-modal`) so the
  surfaces reshape under `data-display-style`.
- A11y: the `⋯` is a real `<button>` with a per-row `aria-label` +
  `aria-haspopup="menu"`; the menu is `role="menu"` with `role="menuitem"` rows;
  the confirm stays `role="alertdialog"` (Cancel default focus, `Esc`/✕ cancel);
  the live-descendant warning is a `role="note"` whose consequence is stated in
  words. Light + dark parity via the token flip (toggle in both mocks).

### Out of scope (documented extension slots)

- **Bulk delete** from the archived view (multi-select + an aggregated count) —
  same Epic-6 list-actions concern as bulk Restore; single-row Delete ships now.
- **A per-descendant archived/live breakdown table** in the confirm — the warning
  names the live COUNT + kind breakdown, not a row-by-row list (matches the 2.8
  cascade grammar, which never itemised descendants either).

## Archived banner on the detail page (Story 2.9 · 2.9.8 → 2.9.6)

`detail-archived.mock.html` is the design asset for the **archived banner on the
work-item detail page** — the design gate for the code subtask **2.9.6
(MOTIR-995)**. The 2.9 list view (above) answers "what did we archive, by whom,
when, and can I get it back" from the dedicated `/issues/archived` route; this
banner answers the complementary question on the **item's own detail page**: a
viewer who opens an archived item directly (a bookmarked link, a link from
activity / a comment, a board peek) must immediately see that it is archived and
be able to restore it.

### Reachability — the precondition that makes this banner real (verified)

An archived item's detail page **renders** — it is NOT a 404. The detail read
`workItemsService.getIssueDetail` → `workItemRepository.findByIdentifier` is a
plain `findUnique` on `(projectId, identifier)` and does **NOT** filter
`archivedAt` (unlike the navigator forest CTE / list / children / sprint reads,
which all filter `archivedAt IS NULL`). So the item is fully reachable and
readable on its detail route; the banner is the page's archived-state signal, not
dead UI. (Verified against shipped code at plan/design time — rung 2.)

### Placement — top of the main column, above Description (a NEW slot)

The banner is the **FIRST element of the detail page's main column, directly
above the Description card** (`<main>` in `app/(authed)/issues/[key]/page.tsx`).
A whole-item state announcement belongs at the top of the page body, before the
content, where it's the first thing a reader sees — matching how Jira / Linear
surface an archived/closed banner.

> **⚠️ Placement reconciliation — flagged for 2.9.6 (rung 2 over the card's
> prose).** The subtask card asked to "reuse the SHIPPED readiness-banner
> PLACEMENT (`page.tsx` ~L317, full-width, top of main column)". Shipped reality
> differs: on the **detail page** the `ReadinessBadge` renders **inside
> `RelationshipsPanel`** (the 2.4.5 relationships section at ~L317, AFTER
> Description + Explanation), **not** as a standalone top-of-column banner.
> "Top of main column" is true of the **peek modal** (`quick-view`, 2.5.20),
> where the readiness banner IS panel-2's first main-column element — the card
> conflated the two surfaces. So this design **reuses the readiness banner's
> VISUAL MOLD** (`ReadinessBadge`: full-width, lead glyph + bold title +
> secondary line) but introduces a **new slot** at the very top of `<main>`. The
> code subtask (2.9.6) **adds a new top-of-`<main>` element**; it does NOT modify
> the in-panel `ReadinessBadge`. (The readiness badge and the archived banner can
> coexist — an archived item can still be blocked — but in practice the readiness
> badge is suppressed once an item isn't todo-category, so they rarely stack.)

A secondary, always-visible **"Archived" chip** also sits in the header eyebrow,
**following the breadcrumb**, so the archived state is legible even when the page
is scrolled past the banner — the same role the `(archived)` mark plays in the
field pickers.

> **⚠️ Eyebrow has NO status Pill — reconciled with 2.4.13 (MOTIR-996).** The
> shipped eyebrow used to render a `<Pill tone="neutral">{item.status}</Pill>`
> beside the breadcrumb, but **subtask 2.4.13 removes it** (it was a redundant,
> untinted duplicate of the rail's `StatusPicker` status —
> `app/(authed)/issues/[key]/page.tsx:246`). So the "Archived" chip is **NOT**
> placed beside a status Pill (there is none); it follows the breadcrumb directly
> and is the **only** eyebrow tag. This is deliberately consistent with 2.4.13's
> intent — the chip carries a **real, non-duplicated** state (archived is shown
> nowhere else in the eyebrow), unlike the redundant status tag 2.4.13 deletes,
> so it does not reintroduce the clutter that subtask removes. Canonical status
> stays rail-only (`CoreFieldsPanel`).

### Tone — neutral / muted, NOT a colored alert and NOT danger

Archived is a **calm, factual, reversible** state — not an error, not a warning,
not danger. So the banner does **NOT** reuse the readiness tints (mint
`--el-tint-mint` ready / peach `--el-tint-peach` blocked, which carry semantic
urgency) and **NEVER** `--el-danger`. Instead:

| Element        | Token                                                                       | Role                                              |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| Banner fill    | `--el-surface-soft`                                                         | a quiet, recessive callout — distinct from a tint |
| Banner border  | `--el-border` (1px hairline)                                                | defines the box on the page surface               |
| Banner radius  | `--radius-card`                                                             | same family as the readiness banner               |
| Lead glyph     | lucide **`archive`** in `--el-text-muted`                                   | the same glyph the `⋯` menu + 2.9 list view use   |
| Headline       | `--el-text-strong`                                                          | AA-safe emphasis                                  |
| Meta line      | `--el-text-secondary`; actor in `--el-text-strong`                          | archived-by / at + the explanatory tail           |
| Eyebrow chip   | `Pill` mold, `--el-surface` + `--el-border`, glyph `--el-text-muted`        | neutral, not a colored `Pill` tone                |
| Restore button | secondary `Button`, `--el-border` + `--radius-btn`; glyph `--el-text-muted` | the lightweight reversible action                 |

State is conveyed by **text + glyph, never colour alone** (the banner reads as
archived from its copy + the archive glyph, so it's AA-safe and colour-blind-safe
even though it carries no hue). Colour flows only through `--el-*`; shape only
through the element-semantic shape tokens — so the banner re-skins under
`data-palette` and re-shapes under `data-display-style`. The chip reuses the
**`BuildingInPublicBadge` mold** (a `Pill` with a lead glyph) but in the neutral
register rather than a build-tinted one.

### Copy

- **Headline:** **"This work item is archived"**.
- **Meta line (canEdit):** **"Archived by {name} · {date} · It's hidden from
  boards and lists but kept with its history. Restore it to bring it back."** The
  "Restore it to bring it back" tail is dropped in the view-only variant (that
  viewer can't restore).
- **Eyebrow chip:** **"Archived"** (with the `archive` glyph).
- **Restore button:** **"Restore"** (lucide `rotate-ccw`), `aria-label`
  **"Restore {key}"** — the same affordance + verb as the 2.9 list view's per-row
  Restore, so the two surfaces share one vocabulary.

### Archived-by / archived-at — the data note for 2.9.6

Same source as the 2.9.3 list view: the **latest `'archived'` revision**
(`workItemRevisionsService.recordRevision`, diff `{ archivedAt: { from: null, to } }`)
gives the **actor** (`changedById`) and the **timestamp** (`createdAt`). The
`workItem.archivedAt` column gives the timestamp but not the actor, so the actor
must come from the revision. A re-archived item has several `'archived'`
revisions — use the **most recent**. The current detail DTO (`getIssueDetail`)
returns `item.archivedAt` but **not** the archived-by actor; surfacing the actor

- formatted timestamp on the detail page is the one new data path 2.9.6 adds (read
  the latest `'archived'` revision for this item) — flagged here so the code subtask
  plans it, exactly as 2.9.3 flagged the `archivedAt IS NOT NULL` list arm.

### Restore — the action, and its gating

- **Affordance:** a secondary `Button` (`size="sm"`, lucide `rotate-ccw` +
  "Restore"), right-aligned in the banner. It POSTs `unarchiveWorkItem`
  (`DELETE /api/work-items/[id]/archive`), the same call the 2.9 list view's
  Restore uses.
- **Page-state after restore (the page-state-after-mutation contract):** the
  detail page is **server-rendered**, so on the unarchive 200 the page does a
  **`router.refresh()`** — the server re-reads the item (now `archivedAt: null`),
  the banner + eyebrow chip disappear, and the page returns to its active form. A
  success **`Toast`** confirms — reuse the existing `workItemActions.restoredToast`
  **"{key} restored"** string (verbatim, the same toast the list view shows), no
  action button. On error reuse the existing archive-error toast strings; the
  banner stays. (E2E: arm `waitForResponse` on the unarchive DELETE → 200 BEFORE
  asserting the banner is gone — the authoritative-signal rule.)
- **Gating — `canEdit`.** `unarchiveWorkItem` is `assertCanEdit`-gated (same as
  archive). A viewer who can browse but **not** edit sees the banner **without the
  Restore button** — hidden, never shown-disabled (the `WorkItemActionsMenu`
  hidden-not-disabled capability pattern, mirroring the 2.9 list view's dropped
  Restore column). The same `canEdit` the detail page already computes for inline
  edit / the `⋯` menu gates the button.
- **Restore is the banner's ONLY action — Delete lives in the detail `⋯` menu
  (per 2.9.7).** The sibling design **2.9.7** (the section above) places permanent
  **`Delete…`** (canManage) on an archived item's detail page in the standard
  `⋯` actions menu (`Restore` + `Delete…` below the separator), and explicitly
  scopes the banner to "the prominent Restore" only. This design honours that
  split: the banner carries the common, safe, reversible Restore one click away;
  the rare, irreversible, higher-privilege Delete stays one level deep in the
  `⋯`, danger-toned. The banner does **not** add a Delete affordance.

### Read-only posture — DECISION: stays fully editable, banner is the only signal

**Decision:** an archived item's detail page stays **fully functional and
editable** — inline field controls are **NOT** dimmed or disabled; the banner
(plus the eyebrow chip) is the **only** signal. There is no global read-lock.

**Rationale:**

- Motir's archive is a **reversible, single-node, editor-level** action (the
  deliberate "Linear shape" — `workItemsService.archiveWorkItem`,
  `workItemsService.ts:1469`), undoable in one click. A whole-page read-lock is a
  heavy lifecycle gesture that doesn't match a soft, restorable hide.
- A global disable would force **every inline editor on the page** (status,
  assignee, priority, due, estimate, title, description, relationships, custom
  fields, labels, comments…) to grow and maintain an "archived-disabled" state —
  real, spreading complexity for a state the user reverses instantly. "No
  complexity for nothing."
- Editing an archived item before restoring it is occasionally legitimate (fix a
  title or re-point a link, then restore).
- **Justified deviation from the mirror (Jira):** Jira makes archived issues
  read-until-restored — but Jira's archive is a **heavier admin bulk lifecycle**,
  whereas Motir's is the lightweight reversible per-item editor action, so the
  read-lock rationale doesn't transfer. The deviation is recorded with its reason
  (the rung-1 justified-deviation rule).
- **Documented future option:** if a real need emerges (e.g. archived items must
  freeze for audit/compliance, or to prevent edit-then-forget-to-restore churn), a
  read-until-restored posture can be added later — dim the inline controls + route
  edits through "Restore to edit". Not built now; noted so the decision is
  revisitable, not silently foreclosed.

### Active contrast

An **active** (non-archived) item shows **no banner and no "Archived" chip** —
the eyebrow is just type · key · breadcrumb · actions (no status Pill either,
post-2.4.13), and the main column opens with the Description card as it does
today. The banner + chip render **iff** `item.archivedAt != null`. (Mock panel 2
draws the active state for the side-by-side contrast.)

### a11y

- The banner is a `role="status"` region (a state announcement, not an alert —
  archived is not urgent), so a screen reader surfaces it without interrupting.
  The archive glyph is `aria-hidden` (the headline carries the meaning); the
  Restore button is a real `<button>` with `aria-label="Restore {key}"`.
- AA contrast holds: `--el-text-strong` headline + `--el-text-secondary` meta on
  the `--el-surface-soft` fill; no hue carries meaning, so it's colour-blind-safe.
  The page is in scope for the strict shell-a11y axe sweep; toggle dark in the
  mock to confirm token parity.

### States in the mockup

Panels: **(0)** PLACEMENT — the archived detail page (header + the banner atop the
main column, above Description + the 2-col body) · **(1)** the banner isolated +
annotated (tone, glyph, copy, archived-by/at, Restore) · **(2)** ACTIVE contrast —
the same detail header with no chip and no banner (Description is first) · **(3)**
VIEW-ONLY (`canBrowse`, not `canEdit`) — the banner WITHOUT the Restore button.

### Out of scope (documented extension slots)

The **read-until-restored** posture (above — deferred with its trigger). **Bulk**
archive/restore from the detail page (archive is per-item). A **re-archive** action
in the banner (re-archiving lives in the `⋯` menu, unchanged — the banner only
restores). These are noted, not built.

## Sprint on the work-item detail — rail field + "Add to active sprint" (Story 2.4 · 2.4.15 → 2.4.14)

`sprint-field.mock.html` (→ `sprint-field.png`) is the design for **sprint
membership on the work-item detail**: a **Sprint** inline-edit FieldCard on the
core-fields rail, and an **"Add to active sprint"** quick action in the shared
`⋯` actions menu. It gates code subtask **2.4.14 (MOTIR-1003)**, which carries
2.4.15 in `dependsOn` (`is_blocked_by`).

**Why this is a design subtask (the design gate, mistake #31).** Both additions
land on ALREADY-designed surfaces that do not include them, so each is an
undesigned element — not mere grammar reuse:

- `detail.pen`'s core-fields rail draws Status · Type · Work type · Executor ·
  Priority · Assignee · Reporter · Parent · (Labels · Components) · Due · Story
  points · Estimate — there is **no Sprint field**. This is exactly the case
  **custom fields** hit (5.3.5 → 5.3.7): they reused `FieldCard` + `Combobox`
  verbatim and STILL needed a design asset because placement / value rendering /
  the picker sentinel were unspecified. Sprint is the same shape.
- `delete-confirm.mock.html` fixes the `⋯` `WorkItemActionsMenu` item set
  (Edit details · Copy link · — · Archive · Delete…) with no sprint action, and
  pins a hard law: permission-gated rows are **hidden, "never shown-disabled."**
  The card asks for a row "greyed out + tooltip when there is no active sprint"
  — which contradicts that law and must be resolved by design.

**Mirror (rung 1) = Jira.** Jira's Details panel carries Sprint directly above
the Story-point estimate; Jira/Linear **disable-and-explain** context actions
that are not currently applicable and reserve **removal** for permission — the
basis for the state-gate decision below.

### The Sprint FieldCard (panels 0–1)

- **Placement** — inserts **between Due date and Story points** (cluster: Due ·
  **Sprint** · Story points · Estimate), pairing Sprint with the agile estimate
  (Jira's ordering). It is `CoreFieldsPanel.tsx`'s `FieldCard` verbatim — Card
  (`--radius-card`, `--shadow-card`, `--el-border`, px-3.5/py-2.5) · uppercase
  11px `--el-text-secondary` label · corner chevron `<button>` (rotates 180° in
  edit mode) · value line mt-1.5/14px. **No new chrome.** Built-ins never
  reorder; Sprint is new, so existing relative order is preserved.
- **Visibility** — shown for sprintable kinds. For **epics** (which span sprints
  in Jira and are never assigned to one) the recommendation is to **hide** the
  card; 2.4.14 confirms against the data model (whether `epic.sprintId` is
  permitted). Drawn here for a story.
- **Value line** — in a sprint: 16px `--el-text-secondary` **Goal** glyph (lucide
  `goal`, the Due/Estimate glyph grammar) + the sprint **name** plain
  ("Sprint 7"). No sprint (`sprintId` null) is **status-dependent** (the backlog
  excludes `category === 'done'` items — `backlogService.backlogExcludedStatusKeys`):
  an **active** item (category `todo`/`in_progress`) shows muted-italic
  **"Backlog"** in `--el-text-secondary` (backlog is its real home — NOT the
  generic "None"); a **done/cancelled** item shows muted-italic **"None"** (the
  Parent card's empty convention) — it is excluded from the backlog, so calling it
  "Backlog" would contradict where it actually sits. A current value whose
  sprint is **completed** stays shown with a muted `(completed)` mark in
  `--el-text-muted` (the archived-option precedent) — never colour alone.
- **Editor** — the AssigneePicker-shaped **`Combobox`** (`components/ui/Combobox`,
  `autoOpen`): trigger (`--height-control`, `--radius-input`, up/down glyph),
  menu (`--shadow-elevated`, `--radius-card`). Rows:
  - **First row = the null sentinel** (muted italic) — the clear / move-home
    path, matching the filter's `sprint-select` **Backlog-first** precedent (a
    meaningful sentinel). Its label is **status-aware and mirrors the read-mode
    value**: "Backlog" for an ACTIVE item, "None" for a DONE/cancelled one (which
    is excluded from the backlog) — the picker value never disagrees with the
    displayed value.
  - the **Active** sprint (secondary "Active"), then **Planned**/future sprints
    (secondary "Planned"); the selected row carries the `Check` in `--el-accent`.
  - **Completed** sprints are **excluded** from the menu (you do not schedule into
    a closed sprint); a current completed value still renders in the trigger with
    the `(completed)` mark.
  - **Searchable at ≥8 sprints** (the Combobox `searchable` rule) — the search row
    (`--el-border`, `--radius-input`, `search` glyph) appears; smaller sets open
    straight to the list.
- **Page-state (for 2.4.14)** — changing the sprint is an inline edit: keep the
  optimistic value, **no `router.refresh()`** of the cell (the
  inline-edit-no-tree-refresh rule). The assign goes through
  `backlogService.assignToSprint` (the 4.2 / `move_to_sprint` path), which also
  ranks the item at the sprint tail; the field waits on that response.

### "Add to active sprint" in the `⋯` menu (panels 2–3)

- **Access path** — the shared `⋯` `WorkItemActionsMenu` on the detail header
  (drawn open over a header slice: type glyph · `PROD-N` mono · serif title ·
  the active `icon-btn`). The new row (Goal glyph) joins the **top
  non-destructive group, after "Edit details"**: **Edit details · Add to active
  sprint · Copy link** · — · Archive · Delete…. `canEdit` gates it. One click
  assigns to the project's **currently-active** sprint and confirms with the
  shipped success **Toast** ("Added PROD-N to <sprint>").
- **Disabled-vs-hidden (the conflict resolution)** — the menu's "hidden, never
  shown-disabled" law governs **capability**: `!canEdit` still **removes** the
  row entirely (panel 3, viewer). But **"no active sprint"** and **"already in
  the active sprint"** are transient **state** gates — the user HAS the
  capability, the precondition just is not met now. Hiding would flicker the row
  in/out as sprints start/complete and hide that the feature exists. So in those
  states the row is **shown disabled (opacity-50) + a `Tooltip`** naming the
  reason ("No active sprint" / "Already in the active sprint"). This is a
  **justified deviation** from the hide-law, scoped to state gates only; the
  Tooltip-on-a-disabled-row is the one new menu sub-pattern (the menu's other
  rows carry none). Tooltip = the ink bubble (`--el-text` bg, `--el-text-inverted`
  text, `--radius-control`, `--spacing-tooltip-*`).
- **Shared reach** — the row lives in the shared menu, so it appears wherever the
  menu mounts (detail header, **list rows, board cards**), like Archive/Delete —
  a surface-agnostic per-item action; quick triage into the running sprint from a
  row/card is the use case.

### Tokens + primitives

Colour via `--el-*` only (no Tier-0): `--el-text` / `--el-text-secondary` /
`--el-text-muted` ink, `--el-accent` for the selected `Check`, `--el-success` on
the confirmation Toast, `--el-danger` on the unchanged Delete row,
`--el-border`/`--el-border-soft` hairlines. Shape via element-semantic tokens
(`--radius-card`/`-input`/`-control`, `--shadow-card`/`-elevated`/`-subtle`,
`--height-control`, `--spacing-control-*`/`-tooltip-*`). Primitives reused
verbatim: `FieldCard`, `Combobox`, `WorkItemActionsMenu` (Popover), `Tooltip`,
`Toast`. No new chrome beyond the disabled-row Tooltip treatment.

### States in the mockup

Panels: **(0)** PLACEMENT + value — the Due · Sprint · Story-points cluster with
Sprint populated, the Backlog state, and the completed-current mark · **(1)** EDIT
— the Combobox open (Backlog sentinel · Active+Check · Planned) and the ≥8
searchable variant · **(2)** `⋯` MENU enabled — the detail header with the menu
open, the new row live, + the success Toast · **(3)** `⋯` MENU disabled — "No
active sprint" and "Already in the active sprint" (each disabled + Tooltip), and
the viewer case (row absent).

### Out of scope (documented extension slots)

**Removing** an item from a sprint other than via the Backlog sentinel (there is
no separate "remove from sprint" affordance — picking Backlog IS the remove).
**Multi-select / bulk** "add to active sprint" from the list/board (this design
is the per-item menu row; bulk lives with the backlog/board bulk tools, 4.2).
A sprint-state **badge** on the value line beyond the `(completed)` mark (kept
clean — Jira renders the sprint name plain). These are noted, not built.
