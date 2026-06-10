import type { PlanStory } from '../types';

/**
 * Story 4.6 — Velocity + burndown charts.
 *
 * The two iteration-measurement charts that finish Epic 4: an in-sprint
 * **burndown** (remaining points vs. days, with the ideal guideline + the
 * actual stepped line + scope-change markers) and a cross-sprint **velocity**
 * (committed vs. completed points per completed sprint, with an average). Both
 * are **READ-ONLY over data earlier stories already ship — NO new write model,
 * NO migration** (the stub: "Reads the sprint + points data; no new write
 * model"). The hard part is not the pixels; it is deriving the burndown's
 * historical "remaining per day" from the immutable **1.4.6 work_item_revision
 * trail** as a BOUNDED aggregate (finding #57), never a load-all-then-reduce.
 *
 * 📦 Lives in Epic 4 (Agile planning). Reads from its Epic-4 siblings and
 * Epic 1 — every dependency points backward (≤ epic 4), so the cross-epic audit
 * (`notes.html` mistake #32) is clean: no forward-pointing dep.
 *
 * What it reads (all DONE — so the backend subtasks are immediately ready):
 *   • Story **4.4.2** (`startSprint`) — stamps the immutable `committedPoints` /
 *     `committedIssueCount` baseline + `startDate`/`endDate`; the burndown's t=0
 *     value and the velocity "committed" bar both read this locked baseline.
 *   • Story **4.4.3** (`completeSprint`) — sets `completedAt` + flips `state` to
 *     `complete`; velocity enumerates the completed-sprint history this produces.
 *   • Story **4.3.3** (`rollupForSprint`) — the bounded `{ committed, completed,
 *     remaining }` aggregate; velocity's "completed" bar REUSES it (the same
 *     `category = 'done'` predicate the scrum header uses), never re-summing.
 *   • Story **1.4.6** (`workItemRevisionsService` + the revision repo) — the
 *     append-only audit trail. The burndown's actual line is derived from it:
 *     status transitions into/out of a `done`-category status (points burned)
 *     and sprint-association add/remove events after start (scope changes).
 *
 * The two seams it fills (both already documented + reserved by their stories):
 *   • The **scrum-header chart seam** — Story **4.5** shows numeric remaining
 *     only and leaves a documented chart slot (4.5.1 design + 4.5.3 header).
 *     The LIVE in-sprint burndown mounts here.
 *   • The **sprint-report chart seam** — Story **4.4.6** renders the
 *     completed/incomplete lists + numeric points and leaves an empty chart slot
 *     (the 4.4.1 design's "4.6 chart seam"). The COMPLETED-sprint burndown +
 *     the velocity chart mount here.
 *
 * ⚠️ Design gate (planning-time). The charts are entirely net-new UI and there
 * is **NO chart design asset** anywhere (`design/` has no reports/charts area;
 * the sprint + board designs only RESERVED a seam, they never drew a chart). Per
 * the gate that means NO design exists → subtask **4.6.1** is a `type: design`
 * subtask that creates `design/reports/` (the reusable chart visual language +
 * the burndown + the velocity, and where each fills the 4.5 / 4.4.6 seams), and
 * EVERY UI-touching code subtask (4.6.2 chart primitives, 4.6.5 burndown wiring,
 * 4.6.6 velocity wiring) carries 4.6.1 in `dependsOn`, is seeded `status:
 * 'blocked'`, and names the asset in Context-refs. A UI code subtask never
 * reaches the ready set before its design exists (Principle #13: design before
 * code).
 *
 * Charting foundation (decision baked in, per the no-shortcut rule). The repo
 * has **no charting library** and the design system routes ALL colour through
 * `--el-*` and ALL shape through element-semantic tokens (CLAUDE.md) — a
 * third-party chart lib (Recharts / Chart.js / nivo) brings its own canvas/DOM
 * styling that bypasses the swap layer and ships ~100 kB for two charts. So
 * 4.6.2 builds a **small, token-aware SVG chart primitive** in `components/ui/`
 * (line/area + grouped bar + shared axis/grid/legend), a11y-first (a visible
 * text legend + a data-table fallback so the chart is read as TEXT, not colour
 * alone — finding #35). This is the deliberate durable shape, and it is the
 * "viz from Epic 4" that **Story 6.3** (dashboards & reports) reuses — so it is
 * planned as a reusable primitive, not a one-off inside this story.
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 4.6`. Matches the
 * canonical depth + string-literal style of Stories 4.3 / 4.4 / 4.5.
 */
export const story_4_6: PlanStory = {
  id: '4.6',
  title: 'Velocity + burndown charts',
  status: 'planned',
  descriptionMd:
    "The two charts that make iteration **measurable** — the analytics half of Jira's Scrum feature " +
    'set: an in-sprint **burndown** (how fast the committed work is being completed) and a ' +
    'cross-sprint **velocity** (how much a team reliably completes per sprint, the planning ' +
    'forecast). Both are **pure read surfaces over data Stories 4.1 / 4.3 / 4.4 already ship — this ' +
    'story adds NO new write model and NO migration** (the stub: "Reads the sprint + points data; no ' +
    'new write model"). It wires the in-sprint burndown into the **chart seam Story 4.5 left in the ' +
    'scrum header** and the completed-sprint burndown + velocity into the **chart seam Story 4.4.6 ' +
    'left in the sprint report**.\n\n' +
    '**Burndown (in-sprint).** Remaining work on the Y axis (the configured estimation statistic — ' +
    'story points by default, falling back to issue count when unestimated, exactly as 4.3 ' +
    'parameterises its roll-ups), sprint days on the X axis. Two series, the Jira-faithful pair ' +
    '(decision-ladder rung 1): the **guideline** — an ideal straight line from the committed ' +
    'baseline at sprint start down to 0 at sprint end — and the **actual remaining** — a step line ' +
    'that DROPS as issues reach a `done`-category status and RISES when scope is added mid-sprint. A ' +
    'live (active) sprint draws the actual line up to "today"; a completed sprint draws it to ' +
    '`completedAt`. **The load-bearing piece is the data, not the pixels:** the actual line is a ' +
    'function of time, and the only record of *when* each point burned down (or scope changed) is ' +
    'the **1.4.6 `work_item_revision` trail** — the status transitions into/out of a done-category ' +
    'status and the sprint-association add/remove events. 4.6 reads that trail, bucketed by day, to ' +
    'reconstruct "remaining at the end of each day".\n\n' +
    '**Velocity (cross-sprint).** A grouped bar chart over the **last N completed sprints** (N ' +
    'default 7, the Jira default): per sprint a **committed** bar (the locked `committedPoints` ' +
    'baseline from 4.4.2) and a **completed** bar (`rollupForSprint().completed` from 4.3.3 — the ' +
    'same done-category aggregate the scrum header uses), plus an **average completed** readout ' +
    '(the planning forecast: "your average velocity is 24"). It enumerates the completed-sprint ' +
    'history `completeSprint` (4.4.3) produces.\n\n' +
    '**Bounded, never load-all (finding #57 — the real-product scale axis).** Neither chart loads a ' +
    "row set whose size grows with the team's data. **Velocity** reads the last N completed sprints " +
    '(a `LIMIT N` over the sprint table) and, per sprint, ONE stored baseline figure + ONE bounded ' +
    "`rollupForSprint` aggregate — it never iterates every issue of every sprint. **Burndown's** day " +
    'series is bounded by sprint LENGTH (~10–14 days), and the underlying "what happened each day" ' +
    "is a **grouped aggregate over the revision rows** scoped to the sprint window and the sprint's " +
    'issues (a `$queryRaw` that GROUPs revision events by calendar day server-side), NOT a load of ' +
    'every revision row into Node followed by a client reduce. A burndown that fetched all revisions ' +
    'and summed them in JS would be prototype-thinking; the day buckets come from the database. This ' +
    'is the same discipline 4.3 / 4.4 / 4.5 applied to their roll-ups and projections.\n\n' +
    '**The reusable chart primitive (the "viz from Epic 4" Story 6.3 reuses).** The repo has no ' +
    'charting library and the design system routes every colour through `--el-*` and every shape ' +
    'through element-semantic tokens (CLAUDE.md). A third-party chart lib bypasses that swap layer ' +
    'and ships disproportionate weight for two charts, so — per the no-shortcut / justified-deviation ' +
    'rule — 4.6.2 builds a **small token-aware SVG chart primitive** in `components/ui/` (a ' +
    'line/area chart, a grouped bar chart, and the shared axis / gridline / legend scaffolding). It ' +
    'is **a11y-first**: a visible text legend, axis labels, and a `<table>` data fallback / ' +
    '`aria-describedby` summary so the chart is conveyed as TEXT and number, never colour or shape ' +
    'alone (finding #35). Epic 6.3 (dashboards & reports — "Charts reuse the viz from Epic 4") ' +
    'consumes this primitive, so it is planned as a reusable building block, not a one-off.\n\n' +
    '**Where each chart mounts (no new navigation surface invented).** The in-sprint burndown mounts ' +
    'in the **scrum header chart seam** (Story 4.5 reserved it — the header shows numeric remaining + ' +
    'an empty chart slot). The completed-sprint burndown + the velocity chart mount in the **sprint ' +
    'report chart seam** (Story 4.4.6 reserved it). 4.6 does NOT build a new "Reports" nav area, a ' +
    "dashboard, or a board-level reports tab — that is **Epic 6.3**, which reuses this story's " +
    'primitive. 4.6 fills the two seams its sibling stories already left, and the design (4.6.1) ' +
    'specifies the exact placement + sizing in each.\n\n' +
    '**Completeness — the real-product states (planned whole, not just the happy path).** ' +
    '**Unestimated** sprint/issues: by-points the chart degrades to the issue-count statistic (Jira ' +
    'does the same) or shows the "—/no point data" state, never `NaN` or a broken axis. **Too little ' +
    'history** for velocity (0–1 completed sprints): a "not enough history yet" state, not an ' +
    'axis-of-one. **Active vs. completed** sprint: the burndown draws the actual line to "now" vs. to ' +
    "`completedAt`. **Loading / error**: the chart slot reuses the surrounding surface's skeleton + " +
    '`ErrorState`. **Empty sprint** (no issues): a flat guideline at 0 / empty state. Each is drawn ' +
    'by 4.6.1 and asserted in 4.6.7.\n\n' +
    '**Out of scope (siblings / Epic 6 — kept deliberately narrow):** the numeric points summary + ' +
    'per-column totals (Stories 4.3 / 4.5 — the charts sit BESIDE them, do not replace them); the ' +
    'sprint-report lists / carry-over / scope-change line (Story 4.4.6 — 4.6 only fills its chart ' +
    'seam); a standalone **Reports / dashboards** navigation surface, configurable widgets, and the ' +
    "created-vs-resolved / status-distribution reports (**Story 6.3**, which reuses 4.6.2's " +
    'primitive); a **cumulative-flow diagram** and other Jira reports beyond velocity + burndown (no ' +
    'use case yet — no complexity for nothing); working-days / non-working-day shading on the ' +
    'guideline (the project has no working-days calendar config yet — the guideline uses calendar ' +
    'days, noted as a future refinement when a calendar lands); per-user or epic burndown variants; ' +
    'exporting a chart to image/CSV. The at-scale combined Scrum journey that also exercises these ' +
    'charts on a large sprint is **Story 4.7** (the Scrum analogue of 3.5), not duplicated here.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (no 4.6 migration — the charts ' +
    'are read-only over the Story 4.1 sprint schema + 4.3 story points + the 1.4.6 revision trail; ' +
    '`migrate dev` reports "No difference detected"), `pnpm db:seed`, `pnpm dev`. (Requires the ' +
    'sibling chart seams — Story 4.5.3 scrum header + Story 4.4.6 sprint report — merged so there is a ' +
    'slot to mount into, and at least one completed sprint with estimated, completed issues to chart.)\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres, no mocks except `getSession`) over the burndown ' +
    'series derivation + the velocity aggregate stays ≥90% per-file branch/fn/line on the new ' +
    '`reportsService` / revision-aggregate repo files (the CI coverage gate, `prodect-core-coverage-' +
    'gate`); any new repo method has a direct empty-input-guard test.\n' +
    '- **Burndown data check:** `getBurndownSeries(sprintId)` returns the guideline (committed → 0 ' +
    'across the sprint window) and the actual stepped remaining series reconstructed from the 1.4.6 ' +
    'revision trail — the actual line drops on the day an issue reached a `done`-category status and ' +
    'rises on the day scope was added; the figures match the 4.3.3 `rollupForSprint` remaining at ' +
    '"now"; an unestimated sprint degrades to issue count (or the "no point data" state), never ' +
    '`NaN`.\n' +
    '- **Velocity data check:** `getVelocity` returns the last N completed sprints with committed (the ' +
    'locked 4.4.2 baseline) vs completed (4.3.3 `rollupForSprint`) and the average; a project with 0–1 ' +
    'completed sprints returns the low-history state; the read is a bounded `LIMIT N`, not all ' +
    'sprints.\n' +
    '- **Chart render check:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open a project with an ' +
    'active scrum sprint → `/boards`: the **scrum header** shows the in-sprint **burndown** in the ' +
    'reserved chart slot (guideline + actual line) beside the numeric remaining; complete the sprint ' +
    "(or open a completed sprint's report) → the **sprint report** shows the completed-sprint " +
    'burndown AND the **velocity** bar chart (committed vs completed per sprint + average). The layout ' +
    'matches `design/reports/charts.mock.html`.\n' +
    '- **Bounded-scale check (finding #57):** `pnpm db:seed:large` (a long sprint with many issues + ' +
    'many completed sprints) → the burndown comes from a grouped day-aggregate over the revision rows ' +
    '(not an all-revisions load), the velocity is a `LIMIT N` read (not all sprints), and both render ' +
    'in bounded time with a bounded DOM.\n' +
    '- `pnpm test:e2e --grep charts` (or `--grep burndown`) — Playwright over the real stack: an ' +
    'active sprint shows the live burndown in the scrum header; completing a sprint shows the ' +
    'completed-sprint burndown + the velocity chart in the report; the low-history + unestimated ' +
    'states render without errors.\n' +
    '- **a11y check:** each chart exposes a visible text legend + axis labels and a data-table (or ' +
    '`aria-describedby`) fallback, so the series are read by assistive tech as text+number — never ' +
    'colour or shape alone (finding #35); colour via `--el-*`, shape via element shape tokens (no ' +
    'Tier-0 `--color-*` / raw `rounded-*`).',
  items: [
    {
      id: '4.6.1',
      title:
        'Design — chart visual language + burndown + velocity (creates design/reports/; specs the 4.5 scrum-header + 4.4.6 sprint-report seam placements)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: ['4.4.1', '4.5.1'],
      descriptionMd:
        'The design asset every UI subtask of this story builds against. There is **no chart design ' +
        'anywhere** today — `design/` has no reports/charts area, and the sprint (4.4.1) + scrum-board ' +
        '(4.5.1) designs only RESERVED an empty chart seam, they never drew a chart. Under the design ' +
        'gate an unspecified whole element == NO design, so this subtask produces it FIRST (mirrors ' +
        '1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 and the sibling design subtasks 4.3.1 / 4.4.1 / 4.5.1). ' +
        'Output: **`design/reports/charts.mock.html`** (an HTML mockup built from the real design ' +
        'system — `components/ui/*` + the `--el-*` colour tokens + the element-semantic shape tokens, ' +
        'so a coding agent has no Pencil→code gap) + a PNG export + **`design/reports/design-notes.md`** ' +
        'naming the composing primitives, copy, axis/legend treatment, and placement. `--el-*` only ' +
        "(no Tier-0 `--color-*`); shape via the element shape tokens; AA-safe; Jira's burndown + " +
        'velocity reports as the mirror.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **The reusable chart visual language** — the shared scaffolding 4.6.2 will build into a ' +
        'primitive: the plot frame, the X/Y axes + tick labels, the gridlines, and the **legend** ' +
        '(a visible text legend, since colour alone is never the signal — finding #35). Define the ' +
        'series colours from the palette via NEW `--el-*` tokens where needed (e.g. a guideline tone, ' +
        'an actual-line tone, a committed-bar vs completed-bar pair) — do NOT reach for raw ' +
        '`--color-*`; the notes record which `--el-*` tokens to add. This is the language Epic 6.3 ' +
        'reuses, so draw it as a generic chart, not a bespoke one.\n' +
        '- **Burndown chart** — Y axis = remaining (story points; note the issue-count fallback), X ' +
        'axis = sprint days. The **guideline** (ideal straight line, committed → 0) and the **actual ' +
        'remaining** (a STEP line that drops on completion and rises on scope-add). Draw a **scope-' +
        'change marker** treatment, the "today" indicator on a live sprint, and label the committed ' +
        'baseline at t=0. Specify the **compact** form for the scrum-header seam (small, beside the ' +
        'numeric remaining) AND the **full** form for the sprint-report seam.\n' +
        '- **Velocity chart** — a grouped **bar** chart: per completed sprint a committed bar + a ' +
        'completed bar (the pair clearly distinguished by text label, not colour alone), sprint names ' +
        'on the X axis, points on the Y axis, and the **average-completed** readout (a labelled line ' +
        'or a summary number — the planning forecast). Draw the "last 7 sprints" window.\n' +
        '- **States** — unestimated ("no point data" / the issue-count fallback, never `NaN`); ' +
        'too-little-history for velocity (0–1 completed sprints → a "not enough history yet" message, ' +
        'not an axis-of-one); the loading skeleton in the chart slot; the `ErrorState`; an empty ' +
        'sprint (flat guideline at 0).\n' +
        '- **Seam placement** — show the burndown inside the **4.5 scrum-header chart slot** (the slot ' +
        '4.5.1 reserved) and the burndown + velocity inside the **4.4.6 sprint-report chart slot** ' +
        '(the slot the 4.4.1 design reserved). Reference (do not redraw) the header / report chrome; ' +
        'specify only the chart that drops into each slot and its sizing.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/reports/charts.mock.html` + a PNG export + `design/reports/design-notes.md` exist; ' +
        'the mockup is built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 ' +
        '`--color-*`, no raw `rounded-*`/`p-*` for control shape), passes the render checklist (icon ' +
        'viewBox, no nested buttons, prettier --write, every panel), and is AA-safe.\n' +
        '- The mockup draws: the shared chart scaffolding (axes/gridlines/legend), the burndown ' +
        '(guideline + stepped actual + scope marker + "today" + committed baseline, in BOTH the ' +
        'compact header form and the full report form), the velocity grouped-bar chart (committed vs ' +
        'completed + average + the 7-sprint window), and the unestimated / low-history / loading / ' +
        'error / empty states.\n' +
        '- `design-notes.md` names each composing primitive + the heading scale, lists the NEW `--el-*` ' +
        'series tokens to add (guideline / actual / committed / completed), states that the in-sprint ' +
        'burndown fills the **Story 4.5 scrum-header chart seam** and the completed-sprint burndown + ' +
        'velocity fill the **Story 4.4.6 sprint-report chart seam**, states that the chart language is ' +
        'reused by **Story 6.3**, and documents the read-as-text legend + not-colour-alone (finding ' +
        '#35) rule.\n' +
        '- The asset REFERENCES (does not redraw) the scrum header (4.5.1) + sprint report (4.4.1) ' +
        'chrome; it specifies only the charts + their seam placement + sizing.\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/scrum.mock.html` + the "Scrum board (Story 4.5)" notes (4.5.1) — the ' +
        'scrum-header chart SEAM this burndown fills (placement + the reserved slot)\n' +
        '- `design/sprints/sprint-lifecycle.mock.html` + `design/sprints/design-notes.md` (4.4.1) — the ' +
        'sprint-report chart SEAM this burndown + velocity fill\n' +
        '- `components/ui/*` (`Card`, `Pill`, `EmptyState`, `ErrorState`, the heading scale) + the ' +
        '`/tokens` specimen route — the primitives the chart frame composes from\n' +
        '- `app/globals.css` `--el-*` (add the series tokens here) + the element-shape tokens\n' +
        "- Jira's **Burndown Chart** (guideline + remaining + scope change) and **Velocity Chart** " +
        '(commitment vs completed bars + average) as the mirror; findings #35 (read as text), #54 ' +
        '(use the palette, not grey+primary), and the design-mockup render checklist',
    },
    {
      id: '4.6.2',
      title:
        'Reusable token-aware SVG chart primitives in components/ui/ (line/area + grouped bar + axis/grid/legend; a11y data-table fallback) — the viz Story 6.3 reuses',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['4.6.1'],
      descriptionMd:
        'The foundational, **reusable** chart layer — built once here, consumed by the burndown ' +
        '(4.6.5), the velocity (4.6.6), AND **Story 6.3** dashboards ("Charts reuse the viz from Epic ' +
        '4"). It is design-gated UI, so it carries the 4.6.1 design in `dependsOn` and is seeded ' +
        '`blocked` until that lands (Principle #13).\n\n' +
        '**Decision (baked in per the no-shortcut rule): hand-rolled token-aware SVG, not a charting ' +
        'library.** The design system routes ALL colour through `--el-*` and ALL shape through ' +
        'element-semantic tokens (CLAUDE.md); a third-party lib (Recharts / Chart.js / nivo) ships ' +
        'its own styling that bypasses the swap layer, pulls ~80–120 kB for two charts, and fights the ' +
        'a11y model. Two small charts do not earn that. So this subtask builds lightweight SVG ' +
        'primitives that consume the design tokens directly — the durable shape, and the one Epic 6.3 ' +
        'extends.\n\n' +
        '**Build (in `components/ui/charts/` or `components/ui/`):**\n' +
        '- A shared **chart frame** — responsive SVG viewBox, the X/Y axes + tick labels, gridlines, ' +
        'and a margin/scale helper (a tiny linear-scale util; do NOT add d3). Colour via `--el-*` ' +
        '(the series tokens 4.6.1 specifies), shape via element shape tokens.\n' +
        '- A **`LineChart` / area** primitive — multiple series, including a STEP-interpolated series ' +
        '(for the burndown actual) and a straight guideline series, with optional point markers (the ' +
        'scope-change markers) and a "now" reference line.\n' +
        '- A **grouped `BarChart`** primitive — N categories × 2 bars (committed/completed) + an ' +
        'optional average reference line.\n' +
        '- A **`ChartLegend`** + the **a11y fallback**: every chart renders a visible text legend, ' +
        '`role="img"` + `aria-label`/`aria-describedby` summarising the series, and a visually-hidden ' +
        '(or toggle-revealed) `<table>` of the underlying data — so the chart is conveyed as ' +
        'text+number, never colour/shape alone (finding #35). Charts take data as plain typed props ' +
        '(series arrays + labels); they are PURE presentational components (no fetching, no service ' +
        'imports), unit-testable in isolation and previewable on a specimen/`/tokens`-style page.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `components/ui` exports a `LineChart` (multi-series, supports a step series + a straight ' +
        'guideline + a reference line + point markers) and a grouped `BarChart` (paired bars + average ' +
        'reference), plus a shared chart frame (axes/ticks/gridlines) and `ChartLegend`, matching ' +
        '`design/reports/charts.mock.html`.\n' +
        '- Colour comes ONLY from `--el-*` (the 4.6.1 series tokens, added to globals.css Tier 3 if ' +
        'missing); shape from element shape tokens; no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` ' +
        'for surface shape (`prodect-core/CLAUDE.md`).\n' +
        '- Each chart is **a11y-complete**: a visible text legend + axis labels, `role="img"` with an ' +
        '`aria-label`/`aria-describedby` summary, and a data-table fallback conveying every series as ' +
        'text+number (finding #35); colour/shape never the sole signal.\n' +
        '- The charts are PURE components (typed data props in, SVG out — no data fetching, no service ' +
        'imports); component tests render each with sample data + assert the a11y fallback table; no ' +
        'charting library is added to `package.json`.\n' +
        '- The primitive is generic enough for Story 6.3 to reuse (documented in `design-notes.md` / a ' +
        'short component doc) — not hard-coded to sprints.\n\n' +
        '## Context refs\n\n' +
        '- `design/reports/charts.mock.html` + `design/reports/design-notes.md` (4.6.1) — the chart ' +
        'visual language + the `--el-*` series tokens to consume\n' +
        '- `components/ui/*` (the existing primitive conventions — props/variants/exports) + the ' +
        '`/tokens` specimen route pattern (1.0.5) to add a chart specimen\n' +
        '- `app/globals.css` Tier-3 `--el-*` + the element-shape tokens; `prodect-core/CLAUDE.md` ' +
        '(colour via `--el-*`, shape via element tokens)\n' +
        '- Story **6.3** (dashboards & reports) — the downstream consumer to keep the API generic for; ' +
        'findings #35 (read as text), #54 (use the palette)',
    },
    {
      id: '4.6.3',
      title:
        'Backend — `reportsService.getBurndownSeries(sprintId)`: day-bucketed remaining (guideline + actual) from the committed baseline + the 1.4.6 revision trail, bounded',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['4.4.2', '4.3.3', '1.4.6'],
      descriptionMd:
        'The hard part of this story: reconstruct the burndown\'s historical "remaining per day" from ' +
        'data that already exists, as a BOUNDED aggregate. Pure backend, no new write model, no ' +
        'migration. Per the 4-layer rule (CLAUDE.md): a new **`reportsService`** (the home Epic 6.3 ' +
        'extends) owning the logic; a new bounded grouped-aggregate read on the revision repository; ' +
        'a HTTP-only route; a `BurndownSeriesDto`.\n\n' +
        '**`reportsService.getBurndownSeries(sprintId)`** → a `BurndownSeriesDto`:\n' +
        '- **Window** — the sprint `startDate`/`endDate` (stamped by `startSprint`, 4.4.2). The day ' +
        'axis is the calendar days from start to end (a completed sprint stops the actual line at ' +
        '`completedAt`; a live sprint stops it at "today", clamped within the window). (Working-days ' +
        'shading is out of scope — no calendar config yet; calendar days for now, noted as a future ' +
        'refinement.)\n' +
        '- **Guideline** — a straight line from the **committed baseline** (`committedPoints` from ' +
        '4.4.2, resolving the configured estimation statistic — points, else issue count) at the start ' +
        'day down to 0 at the end day. O(1) from the locked baseline; no per-issue scan.\n' +
        '- **Actual remaining (the derivation)** — start at the committed baseline and walk the **1.4.6 ' +
        "`work_item_revision` trail** for the sprint's issues: each transition INTO a `done`-category " +
        "status subtracts that issue's points on its day; a transition back OUT (reopened) adds them " +
        "back; each **sprint-association ADD after start** adds the issue's points (scope up) and each " +
        'REMOVE subtracts them (scope down / carry-out). Resolve "done" the SAME way as 4.3.3 / 4.5.2 ' +
        "(`workflow_status.category = 'done'` via `getTerminalStatusKeys`), so the end-of-series " +
        'remaining MATCHES `rollupForSprint(sprintId).remaining` (4.3.3). Emit the per-day stepped ' +
        'series + the scope-change events (day + delta) the chart marks.\n' +
        '- **Bounded (finding #57)** — the day buckets come from a **grouped `$queryRaw`** over the ' +
        "revision rows scoped to (the sprint's issues) ∧ (the sprint window) ∧ (status-transition or " +
        'sprint-association event types), GROUPed by calendar day server-side. It does NOT load every ' +
        'revision row into Node and reduce in JS, and the day count is bounded by sprint length. The ' +
        "point deltas join the issue's `storyPoints`; an issue unestimated at the time contributes 0 " +
        'to the points series (and the by-issue-count series counts it).\n' +
        '- **Degradation** — an unestimated sprint returns the issue-count series (or a `null`/empty ' +
        'points series the UI renders as "no point data"), never `NaN`; an empty sprint returns a flat ' +
        'guideline at 0; a not-yet-started (planned) sprint is rejected / returns an empty series (no ' +
        'window).\n\n' +
        '**Layering.** `reportsService.getBurndownSeries` composes a new bounded repo read (e.g. ' +
        '`workItemRevisionRepository.aggregateSprintEventsByDay(sprintId, window, doneStatusKeys)` — a ' +
        'single grouped `$queryRaw`), `estimationService.rollupForSprint` (to reconcile the endpoint ' +
        'remaining), and `sprintRepository` reads for the window/baseline. Repo methods are single ' +
        'ops; the service owns the DTO mapping + typed errors; the route is HTTP-only. Reads only — no ' +
        'transaction, no writes. The finding-#26 `workspaceId` gate covers the route. The new repo ' +
        'aggregate has a direct **empty-input-guard test** (a sprint with no qualifying revisions → a ' +
        'flat-at-committed series, not a crash) per the coverage gate.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `reportsService.getBurndownSeries(sprintId)` returns a `BurndownSeriesDto` with the day axis ' +
        '(sprint window), the guideline (committed → 0), the stepped actual remaining series, and the ' +
        'scope-change events — derived from the committed baseline (4.4.2) + the 1.4.6 revision trail, ' +
        'with the end-of-series remaining equal to `rollupForSprint(sprintId).remaining` (4.3.3, same ' +
        '`done`-category predicate).\n' +
        '- The actual line drops on the day an issue reached a done-category status and rises on the ' +
        'day scope was added (verified against seeded revisions at known dates); a reopened issue adds ' +
        'its points back.\n' +
        '- The day buckets come from ONE bounded grouped `$queryRaw` over revision rows scoped to the ' +
        'sprint issues + window + relevant event types (NOT an all-revisions load + JS reduce); the day ' +
        'count is bounded by sprint length; a forced large sprint (`db:seed:large`) stays bounded.\n' +
        '- Unestimated → the issue-count series / "no point data" (never `NaN`); empty sprint → flat ' +
        'guideline at 0; a planned (not-started) sprint returns an empty series / typed error; ' +
        'cross-workspace access is denied (finding #26).\n' +
        '- `GET /api/sprints/[id]/burndown` is HTTP-only (parse → one service call → map errors); the ' +
        'new repo aggregate is a single op with a direct empty-input-guard test; `pnpm test:coverage` ' +
        'keeps the new files ≥90% branch/fn/line (`prodect-core-coverage-gate`).\n\n' +
        '## Context refs\n\n' +
        '- Story **1.4.6** `workItemRevisionsService` + the revision repository / `work_item_revision` ' +
        'model — the audit trail the actual line is derived from (status-transition + sprint-' +
        'association event rows; their timestamps + types)\n' +
        '- Story **4.4.2** `startSprint` (`committedPoints`/`committedIssueCount` + `startDate`/' +
        '`endDate`) — the t=0 baseline + the window; Story **4.4.3** (`completedAt`) — the live-vs-' +
        'completed cutoff\n' +
        '- Story **4.3.3** `rollupForSprint(sprintId)` (`{ committed, completed, remaining }`, bounded) ' +
        '— reconcile the endpoint remaining + reuse the statistic resolution; `workflowsService.' +
        'getTerminalStatusKeys` — the `category = \'done\'` split (resolve "done" identically to ' +
        '4.5.2)\n' +
        '- `prodect-core/CLAUDE.md` (4-layer; repo single-ops, service owns DTOs/errors); findings #57 ' +
        '(bounded grouped aggregate, not load-all), #26 (`workspaceId` gate), `prodect-core-coverage-' +
        'gate` (≥90% + empty-input guard); `prodect-core-local-postgres` (sandbox PG@5433)',
    },
    {
      id: '4.6.4',
      title:
        'Backend — `reportsService.getVelocity({ projectId, lastN })`: last-N completed sprints committed (4.4.2 baseline) vs completed (4.3.3 roll-up) + average, bounded',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['4.4.2', '4.4.3', '4.3.3'],
      descriptionMd:
        'The velocity aggregate — simpler than the burndown, purely a bounded read over the ' +
        'completed-sprint history. Pure backend, no new write model. Lives in the same new ' +
        '**`reportsService`** as 4.6.3 (the Epic-6.3 home), with a HTTP-only route + a `VelocityDto`.\n\n' +
        '**`reportsService.getVelocity({ projectId, lastN = 7 })`** → a `VelocityDto`:\n' +
        "- Enumerate the project's **completed** sprints (`state = 'complete'`, ordered by " +
        '`completedAt` / `sequence` desc), **`LIMIT lastN`** (default 7, the Jira default) — a bounded ' +
        'read via `sprintRepository.listByProject` filtered to complete (extend it with a state filter ' +
        '+ limit if needed; do NOT load every sprint).\n' +
        '- Per sprint: **committed** = the locked `committedPoints` baseline (4.4.2, O(1) stored) and ' +
        '**completed** = `estimationService.rollupForSprint(sprintId).completed` (4.3.3 — the same ' +
        'done-category aggregate the scrum header + the sprint report use, so the bars match those ' +
        'surfaces). Resolve the configured statistic the same way 4.3.3 does.\n' +
        '- **Average completed** across the returned sprints (the planning forecast). Return the ' +
        'sprints oldest→newest for the X axis + the average + the statistic label.\n' +
        '- **Low-history** — 0 completed sprints → an empty `VelocityDto` the UI renders as "not enough ' +
        'history yet"; 1 sprint returns the single bar + that sprint as the average (the UI may note ' +
        '"need ≥2 for a trend"). Unestimated sprints contribute 0 (or count, per the statistic), never ' +
        '`NaN`.\n\n' +
        '**Layering + bound.** The service does `LIMIT N` sprints, then **N bounded `rollupForSprint` ' +
        'calls** (N ≤ 7) — a bounded fan-out, not an all-issues scan; it never iterates every issue of ' +
        'every sprint in Node. Repo reads are single ops; the service owns the DTO + the average; the ' +
        'route is HTTP-only; the finding-#26 `workspaceId`/project gate covers it. Any new repo method ' +
        '(e.g. a state-filtered + limited sprint list) gets a direct empty-input-guard test (coverage ' +
        'gate).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `reportsService.getVelocity({ projectId, lastN })` returns the last N completed sprints ' +
        '(ordered oldest→newest) with committed (the 4.4.2 locked baseline) + completed (4.3.3 ' +
        '`rollupForSprint`, same done-category predicate as the scrum header) per sprint, plus the ' +
        'average completed + the statistic label.\n' +
        '- The read is bounded: a `LIMIT N` sprint query + N (≤7) bounded roll-up aggregates — NOT a ' +
        'load of every sprint or every issue; `db:seed:large` (many completed sprints) stays bounded.\n' +
        '- 0 completed sprints → an empty/low-history DTO (no crash, no axis-of-one); 1 sprint → the ' +
        'single bar; unestimated sprints contribute 0 / the issue-count value, never `NaN`.\n' +
        '- `GET /api/projects/[id]/velocity` (or `/api/boards/[id]/velocity`) is HTTP-only; ' +
        'cross-workspace access denied (finding #26); any new repo method has a direct ' +
        'empty-input-guard test; `pnpm test:coverage` keeps the new files ≥90% branch/fn/line.\n\n' +
        '## Context refs\n\n' +
        '- Story **4.4.3** `completeSprint` (sets `state = complete` + `completedAt`) — the ' +
        'completed-sprint history this enumerates; Story **4.4.2** (`committedPoints` baseline) — the ' +
        'committed bar\n' +
        '- Story **4.3.3** `rollupForSprint(sprintId).completed` — the completed bar (REUSE, do not ' +
        're-sum); resolve the statistic identically so the bars match the scrum header + report\n' +
        '- Story **4.1.2** `sprintRepository.listByProject` / `countByProjectAndState` — the sprint ' +
        'list to filter to `complete` + limit (extend minimally if a state-filter+limit variant is ' +
        'needed)\n' +
        '- `reportsService` (introduced in 4.6.3) — the shared service home; `prodect-core/CLAUDE.md` ' +
        '(4-layer); findings #57 (bounded), #26 (`workspaceId` gate); `prodect-core-coverage-gate`',
    },
    {
      id: '4.6.5',
      title:
        'UI — mount the in-sprint burndown into the Story-4.5 scrum-header chart seam AND the completed-sprint burndown into the Story-4.4.6 sprint-report chart seam',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['4.6.1', '4.6.2', '4.6.3', '4.5.3', '4.4.6'],
      descriptionMd:
        'Wire the burndown into the **two seams its sibling stories already reserved** — no new nav ' +
        'surface. Binds the 4.6.2 `LineChart` primitive to the 4.6.3 `getBurndownSeries` data, in the ' +
        'placements 4.6.1 specifies. Design-gated UI → carries 4.6.1 in `dependsOn`, seeded `blocked`.\n\n' +
        '**Scrum-header seam (live, in-sprint).** Story 4.5 (4.5.1 design + 4.5.3 header) shows the ' +
        'numeric remaining and **reserved an empty chart slot** for this. Mount the **compact** ' +
        'burndown there for the active sprint — the guideline + the actual line up to "today" — beside ' +
        '(not replacing) the committed/completed/remaining numbers. Fetch `getBurndownSeries(activeSprintId)`; ' +
        "reuse the header's loading/error scaffold.\n\n" +
        '**Sprint-report seam (completed sprint).** Story 4.4.6 renders the report (lists + numeric ' +
        'points) and **reserved an empty chart seam** (the 4.4.1 design\'s "4.6 chart seam"). Mount the ' +
        '**full** burndown for the completed sprint there. (The velocity chart that also lives on the ' +
        'report is 4.6.6.)\n\n' +
        '**Faithful to the seam contract.** This is the 3.2-Filter-seam / 4.4-4.5-seam pattern: 4.6 ' +
        'fills slots 4.5.3 + 4.4.6 already drew, it does NOT restructure either surface, change the ' +
        'numeric summaries, or alter the move/lifecycle contracts. The chart degrades with the data ' +
        '(unestimated → the issue-count series / "no point data"; empty sprint → flat guideline; ' +
        'loading/error reuse the host surface). The mounted chart carries the 4.6.2 a11y fallback so ' +
        'the series read as text (finding #35).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The scrum header (4.5.3) renders the compact in-sprint burndown (guideline + actual to ' +
        '"today") in the reserved chart slot for the active sprint, beside the numeric remaining — ' +
        'matching `design/reports/charts.mock.html`; no change to the existing header numbers or ' +
        'layout contract.\n' +
        '- The sprint report (4.4.6) renders the full completed-sprint burndown in its reserved chart ' +
        'seam; the chart reflects `getBurndownSeries` (4.6.3) and its end-point remaining matches the ' +
        "report's numeric remaining.\n" +
        '- Both reuse the 4.6.2 chart primitive (no second chart implementation) + its a11y fallback; ' +
        'unestimated / empty / loading / error states render per the design (never `NaN`).\n' +
        '- Colour via `--el-*`, shape via element shape tokens (`prodect-core/CLAUDE.md`); the chart ' +
        'region is a labelled landmark read as text+number (finding #35).\n' +
        '- Component/E2E coverage: the burndown appears in the scrum header for an active sprint and ' +
        'in the report for a completed sprint (asserted in 4.6.7).\n\n' +
        '## Context refs\n\n' +
        '- Story **4.5.3** (the scrum header `SprintHeader` component + its reserved chart slot) — ' +
        'where the live burndown mounts; `design/boards/scrum.mock.html` (the slot)\n' +
        '- Story **4.4.6** (the sprint report view + its reserved chart seam) — where the completed ' +
        'burndown mounts; `design/sprints/sprint-lifecycle.mock.html` (the seam)\n' +
        '- Story **4.6.2** (`LineChart` primitive) + **4.6.3** (`getBurndownSeries` + `GET ' +
        '/api/sprints/[id]/burndown`) — the primitive + data this binds; `design/reports/charts.mock.html` ' +
        '(4.6.1) — the placement/sizing spec\n' +
        '- `prodect-core/CLAUDE.md` (colour/shape tokens, no improvised UI); findings #35, #54',
    },
    {
      id: '4.6.6',
      title:
        'UI — mount the velocity chart (committed vs completed per sprint + average) into the Story-4.4.6 sprint-report chart seam',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['4.6.1', '4.6.2', '4.6.4', '4.4.6'],
      descriptionMd:
        'Mount the **velocity** chart on the sprint report — the cross-sprint planning view that sits ' +
        'beside the completed-sprint burndown (4.6.5). Binds the 4.6.2 grouped `BarChart` primitive to ' +
        'the 4.6.4 `getVelocity` data, in the placement 4.6.1 specifies. Design-gated UI → carries ' +
        '4.6.1 in `dependsOn`, seeded `blocked`.\n\n' +
        '**Placement.** The 4.6.1 design specifies where velocity sits in the sprint-report chart seam ' +
        '(Story 4.4.6) — the same surface as the completed-sprint burndown, the two charts presented ' +
        "together as the report's analytics. Fetch `getVelocity({ projectId, lastN: 7 })`; render the " +
        'committed vs completed bars per completed sprint + the average-completed readout (the ' +
        "forecast). This is Jira's placement of velocity alongside the sprint report — no new nav " +
        'surface (a standalone Reports area is Epic 6.3, which reuses this chart).\n\n' +
        '**States.** Low history (0–1 completed sprints) → the "not enough history yet" message from ' +
        'the design, not an axis-of-one; unestimated sprints → 0 / the issue-count value, never `NaN`; ' +
        'loading/error reuse the report scaffold. The chart carries the 4.6.2 a11y fallback (committed ' +
        'vs completed read as text+number — finding #35).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The sprint report (4.4.6) renders the velocity grouped-bar chart in the placement 4.6.1 ' +
        'specifies: committed vs completed per completed sprint (last 7) + the average-completed ' +
        'readout, bound to `getVelocity` (4.6.4) — matching `design/reports/charts.mock.html`.\n' +
        '- Low-history (0–1 sprints) and unestimated states render per the design (no axis-of-one, no ' +
        '`NaN`); loading/error reuse the report scaffold.\n' +
        '- Reuses the 4.6.2 `BarChart` primitive + its a11y fallback (no second chart implementation); ' +
        'colour via `--el-*`, shape via element shape tokens; bars distinguished by text label, not ' +
        'colour alone (finding #35).\n' +
        '- The velocity bars match the scrum header / sprint-report numeric figures (same 4.3.3 ' +
        'done-category aggregate); no new navigation surface is introduced (that is Story 6.3).\n\n' +
        '## Context refs\n\n' +
        '- Story **4.4.6** (the sprint report view + its reserved chart seam) — where velocity mounts; ' +
        '`design/sprints/sprint-lifecycle.mock.html`\n' +
        '- Story **4.6.2** (grouped `BarChart` primitive) + **4.6.4** (`getVelocity` + `GET ' +
        '/api/projects/[id]/velocity`) — the primitive + data this binds; `design/reports/charts.mock.html` ' +
        '(4.6.1) — the placement spec\n' +
        '- Story **6.3** (dashboards & reports) — the future standalone-reports home this deliberately ' +
        'does NOT build; `prodect-core/CLAUDE.md`; findings #35, #54',
    },
    {
      id: '4.6.7',
      title:
        'Story tests — burndown series (revision-trail derivation, scope changes, bounded), velocity (last-N + average + low-history), chart primitive a11y + render; focused E2E',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['4.6.2', '4.6.3', '4.6.4', '4.6.5', '4.6.6'],
      descriptionMd:
        'The closing test subtask — Vitest over the real Postgres (the project convention: no mocks ' +
        'except `getSession`; `tests/helpers/db.ts` truncation) for the two report aggregates + the ' +
        'chart primitive, plus a focused Playwright E2E. The at-scale combined Scrum journey (drag + ' +
        "WIP + swimlanes + these charts on a large active sprint) is **Story 4.7's**, not duplicated " +
        "here; this story's scale proof is the bounded aggregates asserted in 4.6.3 / 4.6.4 against " +
        '`db:seed:large`.\n\n' +
        '**Service / unit (vitest, real Postgres).** *Burndown:* seed a sprint with a known window + ' +
        'committed baseline + issues whose 1.4.6 revisions move them to a done status on known days ' +
        '(and one added after start, one reopened) → `getBurndownSeries` returns the guideline ' +
        '(committed → 0), the stepped actual dropping on completion days + rising on the scope-add day ' +
        '+ the reopened add-back, the scope-change events, and an end-point remaining EQUAL to ' +
        '`rollupForSprint().remaining`; assert the day buckets come from the grouped aggregate (not a ' +
        'full-revision load) and that an unestimated sprint degrades to the issue-count series (no ' +
        '`NaN`) and an empty sprint is a flat guideline. *Velocity:* seed several completed sprints ' +
        '(varied committed/completed, one unestimated) → `getVelocity` returns the last N oldest→newest ' +
        'with committed (baseline) vs completed (`rollupForSprint`) + the average; assert the `LIMIT N` ' +
        'bound, the 0-sprint + 1-sprint low-history states, and the cross-workspace denial (finding ' +
        '#26).\n\n' +
        '**Component (vitest/jsdom).** The 4.6.2 primitives render given sample series (the step line, ' +
        'the guideline, the grouped bars, the average line) and expose the a11y fallback — assert the ' +
        'data-table / `aria` summary conveys every series as text+number (finding #35) and that no ' +
        'charting lib is imported.\n\n' +
        '**E2E (Playwright) `tests/e2e/charts.spec.ts`.** Against a seeded project with an active ' +
        'scrum sprint: open `/boards` → the scrum header shows the in-sprint burndown beside the ' +
        'numeric remaining; move issues to done → the actual line reflects the burn; complete the ' +
        'sprint → the sprint report shows the completed-sprint burndown + the velocity bars + the ' +
        'average; assert the low-history (a fresh project) + unestimated states render without errors.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` (real Postgres) covers: the burndown derivation (guideline; stepped actual from ' +
        'seeded done-transitions + scope add + reopen; scope-change events; end-point == ' +
        '`rollupForSprint().remaining`; unestimated → issue-count/no-NaN; empty → flat; planned-sprint ' +
        'guard; bounded grouped aggregate), the velocity aggregate (last-N oldest→newest; committed vs ' +
        'completed; average; `LIMIT N` bound; 0/1-sprint low-history; unestimated 0s), and the ' +
        'cross-workspace denial on both endpoints.\n' +
        '- Component tests assert the chart primitives render each series (step / guideline / grouped ' +
        'bars / average) and expose the a11y data-table/`aria` fallback (finding #35); `package.json` ' +
        'gains no charting dependency.\n' +
        '- `pnpm test:e2e --grep charts` runs green over the real stack: live burndown in the scrum ' +
        'header, completed-sprint burndown + velocity in the report, and the low-history + unestimated ' +
        'states.\n' +
        '- `pnpm test:coverage` keeps the Story-4.6 service/repo/component files ≥90% branch/fn/line ' +
        '(the CI coverage gate); the suite uses the real-Postgres harness + the single allowed ' +
        '`getSession` mock; it does NOT duplicate the at-scale combined Scrum journey (Story 4.7).\n\n' +
        '## Context refs\n\n' +
        '- `tests/helpers/db.ts` — real-Postgres truncation harness + the fixture pattern (a sprint ' +
        'with a window + committed baseline + issues with seeded 1.4.6 revisions at known dates; ' +
        'several completed sprints for velocity)\n' +
        '- Stories **4.6.3** / **4.6.4** (the aggregates under test) + **4.6.2** (the primitive) + ' +
        '**4.6.5** / **4.6.6** (the mounted UI) — the units under test; Story **4.7** — the test story ' +
        'the at-scale combined Scrum journey defers to\n' +
        '- `tests/e2e/board-scrum.spec.ts` (4.5.4) + `tests/e2e/sprint-lifecycle.spec.ts` (4.4.7) — the ' +
        'sibling E2Es this composes the chart assertions on top of\n' +
        '- `prodect-core-coverage-gate` (≥90% per-file; empty-input guards need a direct test) + ' +
        '`prodect-core-local-postgres` (sandbox PG@5433 + Playwright chromium) + `prodect-core/CLAUDE.md` ' +
        '(real Postgres, no mocks, single `getSession` mock)',
    },
  ],
};
