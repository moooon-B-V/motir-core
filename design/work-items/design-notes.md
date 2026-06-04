# Work-items — design notes

Design reference for the `work-items` UI area. Each surface names the design
asset it lives in, the primitives it composes from, copy strings, and placement.

| Surface                                       | Asset                                       | Notes                                                                                                              |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Issue detail page                             | `detail.pen` (Pencil) + `detail.png`        | header eyebrow + Description / Explanation / Activity (left) · core-fields rail (right). Built across 2.4.1–2.4.4. |
| Create issue modal                            | `create.pen` + `create.png`                 | type/parent/title/description/priority + optional Explanation (panel 3).                                           |
| Tree / list                                   | `tree.pen` + `tree.png`                     | issue tree rows.                                                                                                   |
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
