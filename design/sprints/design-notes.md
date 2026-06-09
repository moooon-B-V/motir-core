# Sprints — design notes

Design reference for the `sprints` UI area — the **sprint lifecycle flows**
(Story 4.4): the start-sprint modal, the complete-sprint + carry-over modal, and
the sprint report. The asset is the source of truth for the UI subtasks **4.4.5**
(start) and **4.4.6** (complete + report), which each carry **4.4.1** in
`dependsOn`. Built FROM the real design system (`app/globals.css` `--el-*` /
shape tokens + the shipped `components/ui/*`, the work-items list-row vocabulary,
and the backlog/boards mockups), so the code subtasks compose the same primitives
— no Pencil→code gap.

| Surface              | Asset                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sprint lifecycle** | **`sprint-lifecycle.mock.html`** (HTML mockup) | The net-new FLOWS behind the (already-designed) Start-sprint (4.2.1) and Complete-sprint (4.5.1) entry points — both prior assets defer "the flow" to Story 4.4, so this is unspecified == NO design, and the 4.4.1 gate produces it. 7 panels: start (default · custom+invalid · already-active) · complete (carry-over chooser · all-complete) · report (full · unestimated). Gates 4.4.5 + 4.4.6. |

`design/sprints/` is a **NEW design area**. The flows are **almost pure frontend**
over Story 4.4's backend (4.4.2 `startSprint`, 4.4.3 `completeSprint` + carry-over,
4.4.4 `getSprintReport`); the UI BINDS to those. Mirror product: **Jira's
start-sprint dialog, complete-sprint dialog, and Sprint Report** (decision-ladder
rung 1 — verified against Atlassian's "Complete a sprint" docs, not asserted).

## The ENTRY POINTS live elsewhere — this asset is the FLOWS only

- **Start-sprint button** — the backlog sprint container (`design/backlog/` 4.2.1;
  notes: "the start FLOW is Story 4.4 — 4.2 mounts the entry point only"). 4.4.5
  WIRES the start modal below to that button (the 3.2 Filter-seam pattern). Enabled
  only on a **planned** sprint with ≥1 issue (the 4.2.1 rule) — the disabled state
  is 4.2.1's concern; this asset does not redraw the button.
- **Complete-sprint button** — the scrum header (`design/boards/` 4.5.1; notes
  §"Complete-sprint is an ENTRY POINT only (the flow is Story 4.4)"). 4.4.6 ships
  the complete flow as a self-contained mountable that Story **4.5.3** mounts there
  (4.5 → 4.4, one-way), and self-mounts in the backlog's active-sprint container so
  the flow is verifiable without Story 4.5.

## This surface REUSES existing vocabularies (reference, don't redraw)

- **`Modal`** (`components/ui/Modal.tsx`) — the dialog shell for all three flows:
  `--radius-modal`, `--shadow-modal`, `--spacing-card-padding`, serif title, the
  sibling close button (never a `<button>` inside a `<button>`), the
  border-topped footer with ghost + primary `Button`s. Same chrome as
  `design/work-items/create.mock.html`.
- **`FormField` + `Button` + date trigger** — the start modal's name/goal fields,
  the segmented **duration deck**, and the custom-date `start/end` triggers reuse
  the `create.mock.html` / `datepicker.mock.html` field grammar (`--height-input`,
  `--radius-input`, `--el-border-strong`).
- **Issue ROW** — the report's Completed / Not-completed lists reuse the
  work-items list-row (`design/work-items/list.mock.html` / `design/backlog`): the
  `IssueTypeIcon` in its `--el-type-*` hue · the mono key · the summary · the
  status `Pill`. The asset draws the net-new composition (the per-list card + the
  "→ destination" chip on a carried-over row + the trailing point figure), not the
  primitives.
- **`Pill`** (`components/ui/Pill.tsx`) — status tones: `--el-tint-mint`/`--el-success`
  dot (Done), `--el-tint-sky`/`--el-info` (In progress), `--el-tint-lavender`
  (To do) — hue in the BACKGROUND with `--el-text-strong` text (finding #35).
- **`EmptyState`/`ErrorState`/skeleton** — loading + error per modal reuse the
  shipped idioms (the 3.2.2 scaffold); not redrawn here.

## The asset is multi-panel (review EACH)

1. **Start-sprint modal — default.** Sprint **name** (editable) · a **duration**
   segmented deck (`1 / 2 / 3 / 4 weeks / Custom` — the Jira deck; the selected
   chip carries `--el-tint-lavender` + `--el-text-strong`) · a **derived** date
   line ("Jun 9 → Jun 22, 2026 · ends in 13 days") · the **goal** textarea
   (optional) · a **committed summary** line ("8 issues · 21 points committed at
   start", from the sprint, `--el-accent` target glyph) · footer **Start sprint**
   (flag glyph) + Cancel.
2. **Custom duration + invalid window.** `Custom` selected reveals explicit
   **Start date** + **End date** triggers; an `endDate < startDate` shows the
   end-date trigger in `--el-danger` + an inline `field-error` ("End date must be
   after the start date", alert glyph) and DISABLES the primary button. Text +
   `--el-danger`, never colour alone (finding #35).
3. **Start blocked — already active.** A `--el-tint-peach` `alert` ("**prodect**
   already has an active sprint (**Sprint 6**). Complete it first — a project can
   run one active sprint at a time." + a "View Sprint 6" link) maps to the backend
   `SprintAlreadyActiveError` (409); primary disabled. (One active sprint per
   PROJECT — the inherited 4.1 decision.)
4. **Complete-sprint modal — carry-over chooser.** A two-stat **split** summary
   (Completed — `--el-success` check-circle, "29 of 42 points"; Incomplete —
   neutral circle, "13 points carry over"); then **"Move the N incomplete issues
   to"** — a radio group: **Backlog** (default, selected → `--el-tint-lavender` +
   filled `--el-accent` dot, subcopy "return to the backlog in rank order") or **A
   future sprint** (with a trailing planned-sprint select). Footer **Complete
   sprint** (check-circle) + Cancel.
5. **Complete-sprint — no incomplete issues.** The split shows `0` incomplete and
   the chooser collapses to a `--el-tint-mint` **"All issues are complete — nothing
   to carry over."** affirmation.
6. **Sprint report — success state + standalone view.** A wide `Modal`: header
   (name · window · `completedAt` · goal) · a 3-up **points** rollup (Committed /
   **Completed** (`--el-success`) / Not completed — labelled numbers, text+number)
   · a **scope-change** line ("2 issues added after the sprint started", warning
   glyph) · **Completed** + **Not completed** sections (each a count chip + a
   bounded list of issue rows + a **"View all in Issues"** deep-link to the 2.5
   navigator filtered to the sprint — NEVER a full in-report dump, finding #57; a
   carried-over row shows its "→ Backlog" destination) · a **Burndown** section
   that is an explicit **dashed chart SEAM** labelled "SEAM · STORY 4.6" (the chart
   is Story 4.6 — the report shows numeric/list summary only).
7. **Report points — unestimated.** When the sprint has no story-point estimates
   the point figures render **"—"** (never `NaN`); the row point cell also shows
   "—". The data layer stays total (returns 0/null); the UI owns the "—"
   presentation (the 4.5.2 pattern).

## Tokens, shape, a11y

- **Colour via `--el-*` only** (no Tier-0 `--color-*` in component code): type
  hues `--el-type-{story,task,bug}`, status via `Pill` tones, `--el-success` /
  `--el-warning` / `--el-danger` for the completed / scope-change / error
  treatments, the pastel tints for chooser selection + alerts. AA holds: hues sit
  in the tint BACKGROUND with `--el-text-strong` text; no page-level surface tint
  (finding #35 / #54).
- **Shape via element-semantic tokens** (no raw `rounded-*`/`p-*`/`h-*` for a
  control's own box): `--radius-modal` (dialog), `--radius-card` (stat/alert/list/
  chart-seam boxes), `--radius-input` (fields/radios/triggers), `--radius-control`
  (duration chips / selects), `--radius-badge` (pills/count chips), `--height-input`
  / `--height-control`, `--spacing-card-padding` / `--spacing-chip-*`. `rounded-full`
  only for the radio/status dots.
- **a11y:** each modal is a labelled `role="dialog"` with focus trap + escape (the
  shipped `Modal`); the duration deck is a `radiogroup`; the carry-over chooser is
  a keyboard-operable `radiogroup` (`aria-labelledby`); completed/incomplete counts
  and points are read as text+number (not colour or shape alone, finding #35); the
  invalid-window field carries `aria-invalid` + the inline error; the burndown seam
  is an `aria-label`led placeholder.

## Out of scope (documented elsewhere)

- The **burndown / velocity CHART** — Story **4.6** (this report leaves the labelled
  seam; it reads the same completed-sprint history + the committed baseline).
- The Start/Complete **entry-point buttons** — Stories **4.2.1** (backlog) / **4.5.1**
  (scrum header); the disabled-empty-sprint Start rule is 4.2.1's.
- The **scrum board** render + the sprint header — Story **4.5**.
- The backend (start/complete/carry-over/report) — Story 4.4 subtasks **4.4.2 /
  4.4.3 / 4.4.4** (consumed by these UI subtasks, not built here).
