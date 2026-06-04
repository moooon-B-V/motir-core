# Work-items — design notes

Design reference for the `work-items` UI area. Each surface names the design
asset it lives in, the primitives it composes from, copy strings, and placement.

| Surface                                       | Asset                                       | Notes                                                                                                              |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Issue detail page                             | `detail.pen` (Pencil) + `detail.png`        | header eyebrow + Description / Explanation / Activity (left) · core-fields rail (right). Built across 2.4.1–2.4.4. |
| Create issue modal                            | `create.pen` + `create.png`                 | type/parent/title/description/priority + optional Explanation (panel 3).                                           |
| Tree / list                                   | `tree.pen` + `tree.png`                     | issue tree rows.                                                                                                   |
| **Relationships panel + ready/blocked badge** | **`relationships.mock.html`** (HTML mockup) | The element `detail.pen` does NOT specify. See below.                                                              |

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
