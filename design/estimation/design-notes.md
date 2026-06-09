# Estimation surfaces — design notes (Story 4.3 · Subtask 4.3.1)

The design reference for every UI subtask of Story 4.3 (Story-point estimation).
The estimation surfaces were **unspecified** — `design/` drew the backlog row
estimate slot + the sprint committed-points slot + the board `.pts` chip only as
**reserved dashed seams / a static chip** (never the click-to-edit picker), the
issue detail drew only the **time** Estimate (not story points), and there was no
epic roll-up badge and no project Estimation settings panel. Whole elements
unspecified == NO design under the design gate, so this subtask **creates** the
`design/estimation/` area first (mirrors `1.0.5` / `1.2.1` / `1.3.3` / `1.5.1` /
`4.2.1`).

Assets:

- **`estimation.mock.html`** — the estimate badge + click-to-edit picker, the
  issue-detail story-points field, the epic roll-up badge, the sprint
  committed-points roll-up, and the degradation / read-only states.
- **`estimation-settings.mock.html`** — the project Estimation settings panel
  (statistic + scale + custom-scale editor) and the settings-hub nav card.
- **`estimation.png` / `estimation-settings.png`** — review renders (2× DPR).

Both are built **from the real design system** — the token block is copied 1:1
from `app/globals.css` (Tier-0 `--color-*` + Tier-3 `--el-*` + element shape
tokens); colour flows through `--el-*` only (no Tier-0 `--color-*`); shape flows
through the element-semantic tokens (`--radius-{btn,card,input,control,badge}`,
`--spacing-{control,chip,card-padding}`, `--height-{btn,control}`,
`--shadow-*`); AA-safe (the only hued surfaces are tint **backgrounds** with
`--el-text-strong` text — never a tinted page surface). Toggle the theme button
to confirm token parity in dark mode.

**Mirror (decision-authority rung 1): the Jira story-point field + board
Estimation settings.** Story points are numeric with decimals allowed (`0.5`);
estimation is configured by a per-board (here per-**project**) statistic; the
sprint committed-points roll-up is Jira-native. The **epic roll-up** is a
documented rung-1 deviation (Jira needs automation for it) — kept because Story
4.3's card asks for it and the AI-native execution tree makes a parent subtree
total genuinely useful; see `story-4.3.ts` header.

---

## The estimate badge — ONE component across every surface

`EstimateBadge` is a single component reused everywhere an issue's estimate
renders. It is the board `.pts` vocabulary (`design/boards/design-notes.md` — mono
numerals, `--el-text-secondary`, hash glyph in `--el-text-faint`) generalised to
render the project's configured **statistic** (story points by default).

| Surface                | Placement                                                          | Reference asset                           |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| **Backlog row**        | the **fixed estimate slot** (before assignee) the 4.2 row reserved | `design/backlog/` (4.2.1) — match exactly |
| **Board / scrum card** | the `.pts` chip in the card footer                                 | `design/boards/board.mock.html` `.pts`    |
| **List / tree row**    | right-aligned **Points** column                                    | `design/work-items/list.mock.html`        |
| **Issue-detail rail**  | a **Story points** core-field row (see below)                      | `design/work-items/detail.pen` rail       |

- **Composing primitives:** the chip vocabulary (mono numerals like `.pts`), the
  lucide **hash** glyph (`#`, `--el-text-faint`) as the points marker.
- **Interactive variant** (`.est--btn`) is a real `<button>` (click-to-edit) with
  hover (`--el-surface` fill + `--el-border`) and a focus ring
  (`ring-(--focus-ring-color)`). It is NEVER nested inside another button — on the
  backlog/board row it sits in the flex container alongside the avatar / `⋯`
  menu, not inside them.
- **Unestimated** → a muted `—` (`--el-text-faint`), never `0`, `null`, or `NaN`.
- **Read-only** (no edit permission) → the static `.est` span (no `est--btn`
  button, no hover/focus affordance), so it degrades with no layout shift.

### Copy

- aria-label (filled): `Story points: {n} — edit` (or the statistic's label).
- aria-label (empty): `No estimate — add`.
- read-only hint: `Viewer — estimates are read-only`.

---

## The estimate picker — the click-to-edit Popover

Clicking the badge opens a **`Popover`** (`components/ui/Popover` — `--radius-card`,
`--shadow-elevated`) anchored to it. Drawn anchored on a backlog row AND in the
detail rail (panels 1 + 2). Contents, top to bottom:

1. **Header** — `STORY POINTS` section label + the active **deck name** (e.g.
   `Fibonacci`) right-aligned.
2. **Scale-deck quick chips** — the configured scale's values as
   `--radius-control` chips (Fibonacci default — `1,2,3,5,8,13,21`). The selected
   value is the **`--el-accent` fill with `--el-accent-text`** (AA-safe); the rest
   are `--el-surface` + `--el-border`. Each is a real `<button aria-pressed>`.
3. **Free numeric input** — an `--el-input` field accepting **any number,
   decimals included** (`0.5`). The deck **suggests**, it does NOT constrain —
   story points stay free numeric (Jira allows decimals) so they always roll up.
   Focus ring on `--el-accent`. A trailing `↵` kbd hint commits.
4. **Footer** — a **Clear** ghost button (`×`, nulls the estimate) on the left, an
   `Esc to cancel` kbd hint on the right.

- **Keyboard:** `↵` commits the focused/typed value; `Esc` cancels; the chips are
  arrow-navigable buttons. (Implementation owns full roving-tabindex; the mock
  shows the affordances.)
- **Statistic = Time / Issue count:** the picker degrades — Time opens the
  existing time-estimate editor (Story 2.3.6), Issue count is non-editable
  (derived). The scale deck is a **story-points-only** concept.

---

## Issue-detail story-points field — distinct from the TIME Estimate

The detail core-fields rail (`design/work-items/detail.pen`) already has a
**time** `Estimate` field (clock glyph, `estimateMinutes`, Story 2.3.6). Story
points are a **separate** rail row:

- a **`#` hash-glyph** `Story points` row, carrying the same `EstimateBadge` +
  inline picker, placed **after Assignee, beside the time Estimate** in the
  rail's fixed field order.
- Both fields coexist permanently; the project **statistic** decides which one
  the backlog / board / roll-ups SUM, but the rail always shows both (they are
  different measures, like Jira's Story-point estimate vs. Original estimate).

This is the explicit fix for the two-fields confusion: `estimateMinutes` (time,
clock) ≠ `storyPoints` (agile, hash).

---

## Epic roll-up badge — the subtree total

A `.rollup` badge showing the **SUM of story points across the parent's subtree**
(a recursive-CTE aggregate — finding #57's bounded shape, **never** a load-all +
client sum):

- **Epic detail header** — `Story Points · 34` (full label), right of the title.
- **List / tree parent row** — the compact `34 pts` form, right-aligned.
- **Tint:** `--el-tint-lavender` background + `--el-text-strong` text (AA-safe),
  to distinguish a **rolled-up total** from a leaf estimate at a glance. The
  number is mono.
- **No estimated descendants** → a muted `—` `.rollup.is-empty` (bordered, no
  tint), never `0`.
- It is **labelled** ("Story Points" / "pts") so it is never read as the parent's
  OWN estimate (an epic can have both its own estimate and a subtree roll-up).

---

## Sprint committed-points roll-up — fills the Story-4.2 slot

Fills the dashed **committed-points slot** the backlog reserved
(`design/backlog/design-notes.md` — "filled by Story 4.3"), in the **same slot
position** so it drops in with **no relayout**. In the sprint-container header:

- **`committed`** — the sum of the sprint's issues' points (mono, `--el-text-strong`).
- **`done`** — the `category = 'done'` subset, in `--el-success`.
- **`left`** — committed − done (remaining).
- A **planned** sprint shows `committed` only (no work done yet); an
  **unestimated** sprint shows `—`.
- All three are **bounded grouped aggregates** (`SUM(storyPoints) … GROUP BY` with
  a done-category predicate) — finding #57: never a client sum of the loaded rows.

**Seam relationship to the scrum header (Story 4.5).** This is the **compact
backlog-header** figure. The fuller scrum sprint-header summary
(`design/boards/scrum.mock.html`, drawn by 4.5.1 — committed / completed /
remaining + per-column point totals) reads the **same** reusable aggregate:
`rollupForSprint(sprintId, statistic)`. **Story 4.5.2 consumes it for
`SprintSummaryDto.points`** rather than re-deriving the SUM (4.5.2 adds only the
scrum-specific `columnPoints` breakdown). 4.5 > 4.3, so 4.5 reading 4.3 is a
normal backward dependency — no re-plan of 4.5 needed.

---

## Project Estimation settings (`estimation-settings.mock.html`)

The `settings/project/estimation` panel — a sibling of the Workflow + Board
settings panels, reusing the **shipped project-settings chrome** (the serif page
title + `crumb`, the `Card` with head / body / footer, `app/(authed)/settings/project`).

- **Estimation statistic** — a **`Segmented`** (`components/ui/Segmented`):
  **Story points** (default, `#` glyph) · **Time estimate** (clock glyph) ·
  **Issue count** (list glyph). Mirrors Jira's board Estimation **method**.
- **Point scale** — a `Segmented`: **Fibonacci** (default) · **Linear** ·
  **Custom**. A **deck preview** shows the chosen scale's values
  (Fibonacci → `1,2,3,5,8,13,21`; Linear → `1,2,3,4,5,…`).
- **Custom-scale editor** — shown **only when scale = Custom**: an editable list
  of numeric value chips, each with a `×` remove button (a real `<button>` beside
  the value, **not** nested), plus a dashed **Add** chip. Stored as
  `project.customScaleValues` (a numeric list), validated positive. Fibonacci /
  Linear hide this editor (fixed decks).
- **Helper copy** under each field; **Save changes** (primary `Button`) + Cancel
  (secondary) in the card footer.
- **Scale is story-points-only:** when the statistic is Time / Issue count the
  point-scale field is **hidden** (the scale governs the story-point picker deck
  only).

### Settings-hub nav card

The settings hub (`settings/project`) gains an **Estimation** nav card — the exact
`WorkflowSettingsCard.tsx` grammar (a single `<Link>`-wrapped `Card`, whole-row
target, trailing chevron), sibling of Board + Workflow. Leading glyph tile uses a
lavender tint (AA-safe). Copy: title `Estimation`, subtitle `Set the estimation
statistic and point scale for this project.`

### Admin gating

Only project admins edit (the Story-6.4 project-admin pattern): a non-admin sees
the panel **read-only** — the `Segmented` controls `disabled` + a lock banner
`Only project admins can change estimation settings.`

---

## Data shape this design implies (for 4.3.2, the schema subtask)

The design assumes the schema subtask provides:

- `work_item.storyPoints` — nullable numeric (decimals allowed).
- `project.estimationStatistic` — enum `story_points` (default) · `time` ·
  `issue_count`.
- `project.pointScale` — enum `fibonacci` (default) · `linear` · `custom`.
- `project.customScaleValues` — a numeric list (used when `pointScale = custom`).
- A reusable bounded aggregate `rollupForSprint(sprintId, statistic)` and an
  epic/subtree roll-up (recursive-CTE `SUM`), per finding #57.

These are the schema subtask's concern (4.3.2) — named here so the UI subtasks
(4.3.4 / 4.3.5 / 4.3.6) and the schema agree on the contract.

---

## Subtask map (who builds against this asset)

| Subtask   | Builds                                                             | Reads here                           |
| --------- | ------------------------------------------------------------------ | ------------------------------------ |
| **4.3.4** | the estimate badge + picker across backlog / board / list / detail | `estimation.mock.html` panels 0–2, 5 |
| **4.3.5** | the project Estimation settings panel + nav card                   | `estimation-settings.mock.html`      |
| **4.3.6** | the epic roll-up + sprint committed-points displays                | `estimation.mock.html` panels 3–4    |

Every one of those code subtasks carries **4.3.1** in `dependsOn` and is seeded
`status: 'blocked'` until this design lands (Principle #13: design before code).
