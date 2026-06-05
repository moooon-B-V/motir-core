# Work-items — design notes

Design reference for the `work-items` UI area. Each surface names the design
asset it lives in, the primitives it composes from, copy strings, and placement.

| Surface                                       | Asset                                       | Notes                                                                                                              |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Issue detail page                             | `detail.pen` (Pencil) + `detail.png`        | header eyebrow + Description / Explanation / Activity (left) · core-fields rail (right). Built across 2.4.1–2.4.4. |
| Create issue modal                            | `create.pen` + `create.png`                 | type/parent/title/description/priority + optional Explanation (panel 3).                                           |
| Tree view (issue list, nested)                | `tree.pen` + `tree.png`                     | issue tree rows + the `[Filter]`·`[Tree ▾]`·`[+ New issue]` toolbar.                                               |
| **Flat sortable List view + view switcher**   | **`list.mock.html`** (HTML mockup)          | The List mode `tree.png` leaves unspecified (it draws only Tree + a disabled switcher seam). Gates 2.5.8. See below. |
| **Relationships panel + ready/blocked badge** | **`relationships.mock.html`** (HTML mockup) | The element `detail.pen` does NOT specify. See below.                                                              |
| **Link management (add / remove links)**      | **`links.mock.html`** (HTML mockup)         | Extends the relationships panel with the add/remove UI (2.4.8 → 2.4.9). See below.                                 |

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

| Column   | Width (px) | Cell                                                    | Sorts by                          |
| -------- | ---------- | ------------------------------------------------------- | --------------------------------- |
| Title    | `1fr`      | `IssueTypeIcon` (type hue) · mono identifier · title    | **issue key** (the default)       |
| Priority | 120        | `PRIORITY_META` chip (`Pill` tone + direction icon)     | priority rank (highest→lowest)    |
| Assignee | 150        | initial-letter `Avatar` · name, or muted "Unassigned"   | assignee name                     |
| Reporter | 150        | initial-letter `Avatar` · name                          | reporter name                     |
| Due      | 120        | formatted date, or muted `—`                            | due date                          |
| Est.     | 90 (end)   | formatted duration, or muted `—` (right-aligned)        | estimate minutes                  |
| Status   | 130        | `Pill` by lifecycle category (the `STATUS_TONE` map)    | workflow status order             |

Grid template (identical to `IssueTreeTable` / `IssueTreeSkeleton`):
`minmax(0,1fr) 120px 150px 150px 120px 90px 130px`.

**Decision — no NEW "Updated" column (the card offered Priority/Updated as
optional extras).** Priority is already a Tree column, and the seven existing
columns already give rich, meaningful sort axes — so the List earns its keep
through *sorting the existing columns*, not by adding data. Adding `updated_at`
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

### States in the mockup

Panels: **(0)** the List view in the `/issues` shell (toolbar + flat table,
default key asc) · **(1)** the switcher menu open (Tree / List, List checked) ·
**(2)** re-sorted by Priority desc (the active-sort indicator moved + the desc
caret) · **(3)** empty state · **(4)** the flat loading skeleton.

### Out of scope (documented extension slots)

Saved / named views, multi-column sort, column show/hide config, and an
**Updated** column are **Epic 6** (saved views & advanced search) — not invented
here. Bulk actions from the list are also out of scope for 2.5.8.
