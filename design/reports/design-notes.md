# Reports — design notes

Design reference for the **`reports` UI area** — the **chart visual language**
(Story 4.6): a reusable token-aware SVG chart layer plus the two charts that
finish Epic 4, the in-sprint **burndown** and the cross-sprint **velocity**. The
asset is the source of truth for the Story-4.6 UI subtasks **4.6.2** (the chart
primitives), **4.6.5** (mount the burndown), and **4.6.6** (mount the velocity),
which each carry **4.6.1** in `dependsOn`. Built FROM the real design system
(`app/globals.css` `--el-*` / shape tokens + the shipped `components/ui/*`
`Card` / `EmptyState` / `ErrorState`, and the issue-list vocabulary the
sprint/report reuse), so the code subtasks compose the same primitives — no
Pencil→code gap.

| Surface            | Asset                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chart language** | **`charts.mock.html`** (HTML mockup) | The net-new CHART visual language. NO chart design existed — `design/` had no `reports/` area, and the sprint (4.4.1) + scrum-board (4.5.1) designs only RESERVED an empty chart SEAM (a dashed placeholder labelled "SEAM · STORY 4.6"), they never drew a chart. Unspecified whole element == NO design, so the 4.6.1 gate produces this. 7 panels: visual language + token table · burndown full · burndown compact · velocity · states · seam placement · a11y. Gates 4.6.2 / 4.6.5 / 4.6.6. |

`design/reports/` is a **NEW design area**. The charts are **pure read surfaces**
over data Stories 4.1 / 4.3 / 4.4 already ship (no new write model, no migration —
the burndown reads the committed baseline + the **1.4.6 `work_item_revision`
trail**; the velocity reads the completed-sprint history). Mirror product: **Jira's
Burndown Chart + Velocity Chart** (decision-ladder rung 1 — verified against
Atlassian's report docs, not asserted).

## The core decision — hand-rolled token-aware SVG, NOT a charting library

The design system routes **all colour through `--el-*`** and **all shape through
element-semantic tokens** (`prodect-core/CLAUDE.md`). A third-party chart lib
(Recharts / Chart.js / nivo) ships its own canvas/DOM styling that **bypasses the
swap layer**, pulls ~80–120 kB for two charts, and fights the a11y model — so per
the no-shortcut / justified-deviation rule, **4.6.2 builds small SVG primitives
that consume the design tokens directly**. `package.json` gains no charting
dependency. The primitive is the **"viz from Epic 4" Story 6.3 reuses** for
dashboards, so it is drawn GENERIC (a line/area chart + a grouped bar chart + a
shared frame), not bespoke to sprints.

## NEW `--el-chart-*` series tokens (4.6.2 adds these to globals.css Tier 3)

Every chart colour routes through a NEW Tier-3 `--el-chart-*` token — NEVER a raw
`--color-*` in chart code (the per-component token-growth pattern, CLAUDE.md /
mistake #20). Add to `app/globals.css` Tier 3 (and they inherit the
`[data-theme="dark"]` flip + a future `data-palette` via their `--color-*`
mapping; the mockup's Toggle-dark confirms parity):

| Token                  | Maps to                | Role                          |
| ---------------------- | ---------------------- | ----------------------------- |
| `--el-chart-guideline` | `--color-stone`        | burndown ideal line (dashed)  |
| `--el-chart-actual`    | `--color-primary`      | burndown actual remaining     |
| `--el-chart-scope`     | `--color-warning`      | scope-change marker           |
| `--el-chart-committed` | `--color-info`         | velocity committed bar        |
| `--el-chart-completed` | `--color-success`      | velocity completed bar        |
| `--el-chart-average`   | `--color-charcoal`     | velocity average (dashed ref) |
| `--el-chart-plot`      | `--color-surface-soft` | plot background fill          |
| `--el-chart-grid`      | `--color-border`       | gridlines                     |
| `--el-chart-axis`      | `--color-steel`        | axis line + tick labels       |

## This surface REUSES existing vocabularies (reference, don't redraw)

- **`Card`** (`components/ui/Card.tsx`) — the chart container: `--radius-card`,
  `--shadow-subtle`, `--spacing-card-padding`. Each chart (header form, report
  form) sits in a Card with a serif title + a muted sub-line.
- **`EmptyState` / `ErrorState` / skeleton** — the unestimated / low-history /
  loading / error states reuse the shipped idioms (the 3.2.2 scaffold), NOT a
  chart-bespoke state. The chart slot reuses the **surrounding surface's**
  skeleton + `ErrorState` (the scrum header's, the sprint report's).
- **The scrum header (4.5.1 / 4.5.3) + the sprint report (4.4.1 / 4.4.6)** — the
  two host surfaces are **REFERENCED (greyed), never redrawn** (panel 5). 4.6
  fills the chart SEAMS they reserved; it does not restructure either surface or
  touch the numeric summaries (the 3.2-Filter-seam / 4.4–4.5-seam pattern).

## The asset is multi-panel (review EACH)

0. **Chart visual language.** The reusable scaffold 4.6.2 builds into the shared
   frame — the plot frame, the X/Y axes + tick labels, the gridlines, and a
   **visible text legend** (colour is never the sole signal — finding #35). Plus
   the `--el-chart-*` token table above. Responsive SVG `viewBox` +
   `preserveAspectRatio`; a tiny linear-scale helper, **no d3**.
1. **Burndown — full form (sprint-report seam).** Y = points remaining (note the
   issue-count fallback), X = sprint days. The **guideline** (ideal straight line,
   committed → 0) + the **actual remaining** (a STEP line that DROPS on a
   done-category transition and RISES on a mid-sprint scope add). A **scope-change
   marker** (a `--el-chart-scope` diamond + "+N scope"), the **committed baseline**
   labelled at t=0, and the completed end-point labelled. The end-point equals
   `rollupForSprint().remaining` (4.3.3). A completed sprint draws the actual line
   to `completedAt`.
2. **Burndown — compact form (scrum-header seam).** The SAME `LineChart` with a
   smaller frame, Y topping at the committed baseline, the actual line drawn only
   to **"today"** (a dashed vertical marker) for the LIVE sprint, and scope markers
   omitted for density. Mounts BESIDE the numeric remaining, never replacing it.
3. **Velocity.** A grouped **bar** chart over the **last N completed sprints**
   (N = 7, the Jira default): per sprint a **committed** bar (`--el-chart-committed`,
   the locked 4.4.2 `committedPoints`) + a **completed** bar (`--el-chart-completed`,
   `rollupForSprint().completed` from 4.3.3 — the same done-category aggregate the
   scrum header uses, so bars match those surfaces), with value labels, sprint
   names on X, points on Y, and a dashed **average-completed** reference line +
   readout (the planning forecast). Sprints ordered oldest → newest.
4. **States.** **Unestimated** → "no point data" / the issue-count fallback,
   shows "—", never `NaN` (the 4.5.2 "—" rule — the data layer stays total,
   returns 0/null; the UI owns the "—"). **Empty sprint** → a flat guideline at 0.
   **Low-history velocity** (0–1 completed sprints) → "not enough history yet", not
   an axis-of-one. **Loading** → the host surface's skeleton. **Error** → the host
   surface's `ErrorState` with a Retry.
5. **Seam placement.** The compact burndown DROPS INTO the **Story-4.5
   scrum-header chart slot** (beside the committed/completed/remaining stats); the
   full burndown + the velocity chart DROP INTO the **Story-4.4.6 sprint-report
   chart seam** (the 4.4.1 design's labelled "SEAM · STORY 4.6" slot), the two
   presented together as the report's analytics. The header/report chrome is
   REFERENCED (greyed), not redrawn. **No new "Reports" nav surface** — that is
   **Story 6.3**, which reuses this primitive.
6. **A11y.** Every chart is conveyed as **text + number**, never colour/shape
   alone (finding #35): `role="img"` + an `aria-label` / `aria-describedby` →
   `<desc>` summary of every series + endpoint; a **visible text legend**; **value
   labels** on the velocity bars + the burndown baseline/end-point; and a
   **data-table fallback** (the `<details>` "View data table" disclosure → a real
   `<table>` with row/col headers) so the chart is re-expressed as numbers. The
   committed/completed pair is distinguished by **text label**, not the blue/green
   alone — it survives greyscale + colour-blindness.

## Tokens, shape, a11y

- **Colour via `--el-*` only** (no Tier-0 `--color-*` in chart code): the new
  `--el-chart-*` series tokens above, plus `--el-text*` for labels, `--el-surface*`
  / `--el-border` for the Card/plot, `--el-danger` for the error state, the pastel
  tints for the alert flags. AA holds: chart-series hues are vivid line/bar fills,
  and any chip puts the hue in the tint BACKGROUND with `--el-text-strong` text
  (finding #35 / #54); no page-level surface tint.
- **Shape via element-semantic tokens** (no raw `rounded-*`/`p-*`/`h-*` for a
  control's own box): `--radius-card` (chart Card / state boxes), `--radius-control`
  (skeleton bars / small affordances), `--radius-badge` (pills / flags),
  `--radius-btn` (the Retry button), `--spacing-card-padding`, `--shadow-subtle`.
  `rounded-full` only for the status dot. SVG geometry (bar `rx`, point `r`,
  stroke widths) is intrinsic chart shape, not a swappable surface.
- **a11y:** each chart is a `role="img"` figure with a describedby summary + a
  visible legend + value labels + a `<table>` fallback (above). The data tables
  carry `<caption>` + `scope`-ed headers. The series read as text+number; colour
  and shape are never the sole signal.

## Out of scope (documented elsewhere)

- A standalone **Reports / dashboards** navigation surface, configurable widgets,
  and the created-vs-resolved / status-distribution reports — **Story 6.3**, which
  REUSES the 4.6.2 chart primitive (kept generic for exactly this).
- A **cumulative-flow diagram** and other Jira reports beyond burndown + velocity
  (no use case yet — no complexity for nothing).
- **Working-days / non-working-day shading** on the guideline — the project has no
  working-days calendar config yet; the guideline uses calendar days (a future
  refinement when a calendar lands).
- Per-user / per-epic burndown variants; **exporting** a chart to image/CSV.
- The chart **data derivation** — the bounded `getBurndownSeries` (4.6.3) +
  `getVelocity` (4.6.4) services, and the host surfaces themselves (the scrum
  header 4.5, the sprint report 4.4.6) — consumed by these UI subtasks, not built
  here.
- The at-scale combined Scrum journey that also exercises these charts — **Story
  4.7** (the Scrum analogue of 3.5).
