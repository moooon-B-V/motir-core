import type { PlanStory } from '../types';

/**
 * Story 4.3 — Story-point estimation.
 *
 * The **estimation** layer of Epic 4 (Agile planning): a numeric **story-point**
 * field on every issue, an **inline-editable estimate badge** wherever issues
 * render (backlog rows, board/scrum cards, issue detail, list), a **project-scoped
 * estimation config** (which statistic is THE estimate + the configurable point
 * scale/deck), and **bounded roll-ups** to the **sprint** (committed / completed /
 * remaining points) and **epic** (sum over the subtree) level. It is the story
 * that FILLS the points seams the rest of Epic 4 reserved.
 *
 * 📦 Backend + frontend, NO external SaaS / secret — story points are a plain
 * `work_item` column and the estimation config is plain `project` columns, so
 * there is NO `type: manual/human` provisioning subtask (mistake #30 checked and
 * clears, like 4.1 / 4.2).
 *
 * ── This story FILLS seams two sibling stories reserved (the load-bearing wiring) ─
 * Epic 4's mistake-#32 resolution deliberately deferred every points concern to
 * THIS story so the forward audit on 4.2 / 4.5 would pass. 4.3 now redeems those
 * IOUs — all BACKWARD deps, because 4.3 is numbered after the surfaces it fills:
 *   • **Backlog (Story 4.2).** `design/backlog/design-notes.md` names two RESERVED
 *     seams "filled by Story 4.3": the **row estimate slot** (the inline-editable
 *     estimate badge, in a fixed slot order so 4.3 drops a value in with no
 *     relayout) and the **per-sprint committed-points slot** in each sprint
 *     container header. 4.3.4 fills the row slot; 4.3.5 fills the header slot.
 *     (Dep on 4.2.3, the backlog read render — 4.2 < 4.3, a normal backward dep.)
 *   • **Board / Scrum (Stories 3.2 / 4.5).** The board card draws a `.pts` chip
 *     (`design/boards/design-notes.md`) that the SHIPPED `BoardCard` currently
 *     renders from `estimateMinutes` (a TIME estimate); 4.3.4 generalises it to the
 *     project's configured estimation STATISTIC (story points by default). And
 *     Story **4.5.2** (`dependsOn: ['3.1.4','4.1','4.3']`) builds its
 *     `SprintSummaryDto.points` = `SUM(storyPoints)` aggregate — i.e. it reads the
 *     field 4.3 adds. 4.3 exposes a REUSABLE bounded `rollupForSprint(sprintId,
 *     statistic)` so 4.5.2 consumes it for `points` rather than re-deriving the
 *     SUM (4.5.2 adds only the scrum-specific `columnPoints` breakdown). 4.5 > 4.3,
 *     so 4.5 reading 4.3 is a normal backward dep — no re-plan of 4.5 needed; the
 *     seam direction is documented here and in 4.5.2's notes.
 *
 * ── `estimateMinutes` (time) vs `storyPoints` (this story) — two DIFFERENT fields ─
 * `work_item.estimateMinutes` already exists (Story 2.3.6 / the issue-detail
 * "Estimate" clock-glyph field, the `Est.` list column, the board card chip). That
 * is a TIME estimate. Story points are the AGILE estimate — a SEPARATE numeric
 * `work_item.storyPoints` column (4.3.2). The project **estimation statistic**
 * config (4.3.2 / 4.3.6) picks which of {Story Points · Time estimate · Issue
 * count} is THE planning estimate the backlog / board / scrum / roll-ups display +
 * sum — exactly Jira's board Estimation settings (rung 1). Default = **Story
 * Points** (this story's whole point). The roll-up engine parameterises over the
 * statistic (story points → `SUM(storyPoints)`; time → `SUM(estimateMinutes)`;
 * count → `COUNT(*)`), so adding the statistic switch is one parameter, not three
 * code paths — the durable shape, not a shortcut.
 *
 * ── Decision: estimation config is PROJECT-scoped (justified rung-1 deviation) ───
 * Jira configures estimation in BOARD settings (Board → Configure → Estimation).
 * In THIS product a board is a per-project READ projection (Story 3.1), sprints are
 * project-scoped (Story 4.1's justified deviation), and the planning estimate is a
 * property of the project's planning, not of a particular read view — so the
 * estimation config hangs off the **project** (`project.estimationStatistic` /
 * `pointScale` / `customScaleValues`), surfaced at `settings/project/estimation`
 * (sibling of the workflow + board settings panels). Same one-line justification
 * shape 4.1 used for `sprint.projectId`: modelling it per-board would force a board
 * to exist before you could estimate and split one project's estimation across
 * boards — added complexity, no real use case here. (Justified-deviation rule:
 * deviate from the mirror only with a concrete reason, written down — here, the
 * project-scoped-sprint architecture.)
 *
 * ── The point SCALE (the stub's "scale configurable per project") ───────────────
 * Story points stay a free NUMERIC value (Jira allows decimals, e.g. 0.5) so they
 * always roll up. The configurable "scale" is the **suggested-value deck** the
 * estimate picker offers (it does NOT hard-constrain entry): **Fibonacci** (the
 * planning-poker default — 1,2,3,5,8,13,21,…), **linear** (1,2,3,4,5,…), or
 * **custom** (a project-defined list in `customScaleValues`). The picker shows the
 * deck as quick chips + a free numeric input + clear. T-shirt sizes are out of
 * scope (non-numeric → won't roll up) — no complexity for nothing.
 *
 * ── Completeness / scale (finding #57) ──────────────────────────────────────────
 * Every roll-up is a **bounded grouped/recursive aggregate**, NEVER a load-all +
 * client sum: the sprint roll-up is a `SUM(storyPoints) … GROUP BY` over the
 * sprint's issues (with a `category='done'` predicate for `completed`), and the
 * epic roll-up is a recursive-CTE `SUM` over the parent's subtree. A points figure
 * computed by summing the loaded card/row page would be prototype-thinking — flag
 * and forbid (the exact tell finding #57 names). Per-issue estimate writes are
 * single-row.
 *
 * ── Cross-epic dependency audit (mistake #32) ───────────────────────────────────
 * Every leaf's `dependsOn` points only at a 4.3 sibling, at Story **4.2** (4.2 <
 * 4.3 — the backlog surface 4.3 fills), or at already-shipped earlier-epic
 * substrate (the issue detail 2.4, list 2.5, board 3.2, project settings shell).
 * NO `dependsOn` points forward of 4.3 → the audit passes. 4.3 sits cleanly
 * between 4.2 (whose seams it fills) and 4.5 (which reads its field).
 *
 * ⚠️ Design gate (planning-time, no exceptions). The estimation surfaces are
 * unspecified: `design/` has no estimate-PICKER (the backlog/board/scrum assets
 * draw only a RESERVED dashed slot or a static `.pts` chip, never the click-to-edit
 * popover + scale deck), no story-points issue-detail field (detail.pen draws only
 * the TIME Estimate), no epic roll-up badge, and no project Estimation settings
 * panel. Whole elements unspecified == NO design under the gate. So subtask
 * **4.3.1 is a `type: design` subtask** creating a NEW `design/estimation/` area
 * (mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 / 4.2.1), and EVERY UI-touching code
 * subtask (4.3.4 / 4.3.5 / 4.3.6) carries 4.3.1 in `dependsOn` and is seeded
 * `status: 'blocked'` until it lands (Principle #13: design before code).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 4.3`. Matches the canonical
 * depth + string-literal style of Stories 4.1 / 4.2 / 4.5.
 */
export const story_4_3: PlanStory = {
  id: '4.3',
  title: 'Story-point estimation',
  status: 'planned',
  descriptionMd:
    'The **estimation** layer of Epic 4 — Jira-faithful story-point estimation that fills the points ' +
    'seams the rest of the epic reserved. Four things ship: (1) a numeric **`work_item.storyPoints`** ' +
    'field (SEPARATE from the existing `estimateMinutes` TIME estimate); (2) a **project-scoped ' +
    'estimation config** — which statistic is THE estimate (Story Points default · Time · Issue count) ' +
    'plus the configurable point **scale/deck** (Fibonacci · linear · custom); (3) an ' +
    '**inline-editable estimate badge** wherever issues render (backlog row, board/scrum card, issue ' +
    'detail rail, list); and (4) **bounded roll-ups** to the **sprint** (committed / completed / ' +
    'remaining points) and **epic** (sum over the subtree) level. It owns the estimate ENTITY + the ' +
    'roll-up engine; the surfaces it decorates were built by earlier stories.\n\n' +
    '**What 4.3 fills (the seam wiring — all backward deps).** Epic 4 deliberately deferred every ' +
    'points concern to this story (the mistake-#32 resolution that kept 4.2 / 4.5 forward-audit-clean). ' +
    '4.3 redeems them: it fills the **backlog row estimate slot** + the **per-sprint committed-points ' +
    'slot** that `design/backlog/design-notes.md` names "filled by Story 4.3" (Story 4.2 drew them as ' +
    'reserved dashed seams); it generalises the board **`.pts` card chip** (currently rendering ' +
    '`estimateMinutes`) to the configured statistic; and it provides the **`storyPoints` field + the ' +
    'reusable `rollupForSprint` aggregate** that Story **4.5.2** reads for its `SprintSummaryDto.points`. ' +
    '4.3 > 4.2 and 4.5 > 4.3, so every one of these is a normal backward dep — no forward-pointing ' +
    'dependency, no re-plan of 4.2 / 4.5.\n\n' +
    '**`estimateMinutes` vs `storyPoints` (two fields, one statistic switch).** `estimateMinutes` ' +
    '(time, Story 2.3.6) already exists and already has its own editing (issue detail). `storyPoints` ' +
    'is the NEW agile estimate. The project **estimation statistic** picks which of {Story Points · ' +
    'Time · Issue count} the planning surfaces DISPLAY and the roll-ups SUM — exactly Jira board ' +
    'Estimation settings (decision-ladder rung 1). Default **Story Points**. The roll-up engine takes ' +
    'the statistic as a parameter (`SUM(storyPoints)` | `SUM(estimateMinutes)` | `COUNT(*)`), so the ' +
    'switch is one parameter, not three code paths.\n\n' +
    '**Estimation config is PROJECT-scoped (justified rung-1 deviation — see the module header).** ' +
    'Jira configures estimation per-board; this product makes boards per-project read projections and ' +
    'sprints project-scoped (Story 4.1), so the planning estimate is a project property: ' +
    '`project.estimationStatistic` + `pointScale` + `customScaleValues`, edited at ' +
    '`settings/project/estimation` (sibling of the workflow + board settings panels). Modelling it ' +
    'per-board would force a board to exist before estimating and split estimation across boards — ' +
    'added complexity, no real use case here.\n\n' +
    '**The point SCALE.** Story points stay a free numeric value (decimals allowed, Jira-faithful) so ' +
    'they always roll up. The configurable scale is the **suggested deck** the picker offers (it does ' +
    'not hard-constrain entry): **Fibonacci** (default — 1,2,3,5,8,13,21,…), **linear** (1,2,3,4,5,…), ' +
    'or **custom** (`customScaleValues`). The estimate picker shows the deck as quick-pick chips + a ' +
    'free numeric input + a clear action. T-shirt sizes are out of scope (non-numeric, would not roll ' +
    'up).\n\n' +
    '**Roll-ups are BOUNDED aggregates (finding #57).** The **sprint** roll-up is a grouped ' +
    "`SUM(storyPoints)` over the sprint's issues — `committed` = total, `completed` = sum scoped to " +
    "issues whose status maps to a `category = 'done'` workflow status (the finding-#21 terminal-set " +
    'predicate), `remaining` = committed − completed. The **epic** roll-up is a recursive-CTE `SUM` ' +
    "over the parent's subtree (points roll up through intermediate stories into the epic, Jira-style). " +
    'Both are single bounded queries — NEVER a load-all + client sum (the prototype tell finding #57 ' +
    'forbids). Per-issue estimate writes are single-row. NULL-estimate issues contribute 0; a wholly ' +
    'unestimated sprint/epic returns 0 (the DTO stays total; the UI owns the "—" presentation, matching ' +
    "4.5's documented degradation).\n\n" +
    '**4-layer + tenancy (CLAUDE.md).** The `storyPoints` write + the config read/update are repository ' +
    'single-ops (writes require `tx`); the roll-up aggregates are repository `$queryRaw` reads; the ' +
    'service owns the transactions + DTO mapping + typed errors + the finding-#26 `workspaceId` gate on ' +
    'every read/write. Each estimate change records a `work_item_revision` row (reuse the Story 1.4.6 ' +
    'audit service) in the SAME transaction, so the activity feed (Story 5.5) and reporting (Epic 6) ' +
    "see estimate changes for free. `storyPoints` stays camelCase (no `@map`) to match `work_item`'s " +
    'existing camelCase columns (decision-ladder rung 2 — within-table consistency, the same call the ' +
    "schema's 4.1 `sprintId`/`backlogRank` comment records); no new FK, so the FK-drift rule is n/a but " +
    'a re-run of `migrate dev` must still report "No difference detected".\n\n' +
    '**Design gate.** The estimate PICKER, the story-points detail field, the epic roll-up badge, and ' +
    'the project Estimation settings panel are unspecified (== no design), so subtask **4.3.1** creates ' +
    'a NEW `design/estimation/` area FIRST and every UI code subtask depends on it (seeded ' +
    '`blocked`).\n\n' +
    '**Out of scope (Epic-4 siblings / Epic 6 / later):** the sprint START / COMPLETE flows + sprint ' +
    'report (Story **4.4**); the Scrum BOARD view + the `SprintSummaryDto.columnPoints` per-column ' +
    "breakdown (Story **4.5** — it READS 4.3's field + reuses `rollupForSprint`, but the scrum render " +
    'is 4.5); the velocity + burndown **charts** (Story **4.6** — 4.3 ships numeric roll-ups, leaves ' +
    'the chart seam); the backlog rank / association / bounded reads themselves (Story **4.1**); the ' +
    'backlog grooming UI (Story **4.2** — consumed, its seams filled); time-estimate editing ' +
    '(`estimateMinutes`, Story 2.3.6 — already shipped); a separate planning-poker / voting session ' +
    '(not a Jira-core feature — out of scope); t-shirt (non-numeric) scales; estimation REPORTS beyond ' +
    'the inline roll-ups (Epic 6 dashboards).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (applies the `add_story_points_and_estimation_config` migration), `pnpm db:seed`, `pnpm dev`. (Requires Story 4.2 merged so the backlog surface whose seams 4.3 fills exists.)\n' +
    '- **Migration is clean (no drift):** a second `pnpm prisma migrate dev` reports **"No difference detected"** (`work_item.storyPoints` + the `project` estimation columns + the two enums add no spurious change). `pnpm prisma migrate status` is up to date.\n' +
    '- **Design exists first:** `design/estimation/estimation.mock.html` + `estimation-settings.mock.html` + PNG export(s) + `design/estimation/design-notes.md` exist (subtask 4.3.1), built from `components/ui/*` + `--el-*`/element-shape tokens only, AA-safe, passing the render checklist; they draw the editable estimate badge (display + click-to-edit picker with the scale deck + free numeric + clear), the epic roll-up badge, the sprint committed-points roll-up filling the backlog header slot, and the project Estimation settings panel.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the estimate write + the estimation config + the bounded sprint/epic roll-ups stays ≥90% per-file branch/fn/line on the new service/repository files (the CI coverage gate, `prodect-core-coverage-gate`); empty-input guards on any new repo method have a direct test.\n' +
    '- **Estimate write:** setting a story-point estimate on an issue writes a single `work_item.storyPoints` row, records a 1.4.6 revision in the same transaction, and is denied by the finding-#26 `workspaceId` gate cross-workspace; clearing it nulls the field.\n' +
    '- **Config:** the project Estimation settings panel (`settings/project/estimation`) reads/writes `estimationStatistic` (default Story Points) + `pointScale` (default Fibonacci) + `customScaleValues`; switching the statistic to Time / Issue count changes which value the planning surfaces show + the roll-ups sum; admin-only.\n' +
    '- **Inline badge:** the estimate badge renders the configured statistic on the backlog row (filling the Story-4.2 estimate seam with no relayout), the board/scrum card (`.pts` chip, now the configured statistic, not raw `estimateMinutes`), the issue detail rail (a story-points field distinct from the time Estimate), and the list; click-to-edit shows the scale deck as quick chips + a free numeric input + clear; the write is optimistic with snap-back on error.\n' +
    '- **Sprint roll-up (fills the 4.2 committed-points seam):** a sprint container header shows committed / (and the seam for) completed / remaining points from the BOUNDED `rollupForSprint` aggregate; `completed` counts only issues in a `category = \'done\'` status; a wholly unestimated sprint shows "—" (no `NaN`); the figure is NOT a sum over the loaded row page.\n' +
    "- **Epic roll-up:** an epic (or any parent) shows a rolled-up point total = the recursive `SUM` over its subtree (a story's points roll into its epic through intermediate levels), on the issue detail + list/tree; the read is one bounded recursive-CTE aggregate.\n" +
    '- **Scale check (finding #57):** `pnpm db:seed:large` (a project with a large sprint + deep epic subtree) → the sprint + epic roll-ups return from one bounded aggregate each (no load-all), and the inline estimate writes stay O(1); the backlog/board DOM row count stays bounded.\n' +
    "- **`pnpm test:e2e --grep estimation`** — Playwright: estimate a backlog story via the inline picker (the badge updates), see the sprint container committed-points figure increase, open the issue detail and see the story-points field, and see the parent epic's rolled-up total reflect the change.\n" +
    "- **4.5 seam check:** `rollupForSprint(sprintId, statistic)` is exported as a reusable bounded aggregate that Story 4.5.2's `SprintSummaryDto.points` consumes (documented in `design/estimation/design-notes.md` + 4.5.2's notes) — 4.3 does not duplicate the scrum `columnPoints` breakdown.\n" +
    '- **a11y / tokens:** the estimate badge + roll-up figures read as TEXT (number + label, not colour/shape alone — finding #35); colour via `--el-*`, shape via element shape tokens (no Tier-0 `--color-*` / raw `rounded-*` — `prodect-core/CLAUDE.md`); the picker is keyboard-operable.',
  items: [
    {
      id: '4.3.1',
      title:
        'Design — estimation surfaces: inline-editable estimate badge + scale picker, epic roll-up badge, sprint committed-points roll-up (backlog header), project Estimation settings panel (NEW design/estimation/)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 46,
      dependsOn: [],
      descriptionMd:
        'The design asset EVERY UI subtask of this story builds against. The estimation surfaces are ' +
        'unspecified — `design/` has the backlog row estimate slot + the sprint committed-points slot + ' +
        'the board `.pts` chip drawn only as RESERVED dashed seams / a static chip (never the ' +
        'click-to-edit picker), the issue detail draws only the TIME Estimate (not story points), and ' +
        'there is no epic roll-up badge and no project Estimation settings panel. Whole elements ' +
        'unspecified == NO design under the gate, so this subtask CREATES it FIRST (mirrors 1.0.5 / ' +
        '1.2.1 / 1.3.3 / 1.5.1 / 4.2.1). Output: a NEW area `design/estimation/` with ' +
        '`estimation.mock.html` (the badge + picker + roll-up displays across surfaces) + ' +
        '`estimation-settings.mock.html` (the project Estimation settings panel) + PNG exports + ' +
        '`design/estimation/design-notes.md` naming every composing primitive, copy string, and ' +
        'placement. Built from the real design system (`components/ui/*` + the `--el-*` tokens + element ' +
        'shape tokens — no Pencil→code gap); `--el-*` only (no Tier-0 `--color-*`); shape via the ' +
        'element shape tokens; AA-safe; the Jira story-point field + board Estimation settings as the ' +
        'mirror.\n\n' +
        "**This surface REUSES existing vocabularies — reference, don't redraw.** The estimate badge " +
        'reuses the chip/`Pill` vocabulary + the backlog row (4.2.1) + the board card `.pts` chip ' +
        '(`design/boards/`) + the issue-detail core-fields rail (`design/work-items/detail.pen`); the ' +
        'settings panel reuses the project-settings page chrome + `FormField` / `Segmented` / the ' +
        'settings-card pattern (`settings/project/board` + `workflow`). Draw the NET-NEW: the ' +
        'click-to-edit picker, the roll-up badges, and the Estimation settings form.\n\n' +
        '**Specify, panel by panel (estimation.mock.html):**\n\n' +
        '- **Estimate badge — display states** — the chip showing the configured statistic (a ' +
        'story-point value, e.g. `5`; the muted `—` / empty-slot when unestimated), in the FIXED slot ' +
        'the 4.2 backlog row reserved (so 4.3 drops it in with no relayout), and on the board card ' +
        '(the `.pts` chip, mono) + the list row + the issue-detail rail. Show it is the SAME component ' +
        'across surfaces.\n' +
        '- **Estimate picker — edit state** — the click-to-edit popover: the configured **scale deck** ' +
        'as quick-pick chips (Fibonacci default — 1,2,3,5,8,13,21,…), a **free numeric input** (decimals ' +
        'allowed), a **Clear** action, and the keyboard affordance. Draw the popover anchored to the ' +
        'badge on a backlog row AND in the detail rail.\n' +
        '- **Issue-detail story-points field** — the rail field, DISTINCT from the existing TIME ' +
        '**Estimate** (clock glyph) field — a hash/points glyph + the value + the inline picker. Specify ' +
        'where it sits in the core-fields rail (`design/work-items/detail.pen`).\n' +
        '- **Epic roll-up badge** — the rolled-up subtree total on an epic (and any parent), e.g. ' +
        '`Story Points · 34` or a `34 pts` summary, on the issue detail header/rail AND the list/tree ' +
        "parent row. Distinct from the parent's OWN estimate (a roll-up of descendants).\n" +
        '- **Sprint committed-points roll-up** — the figure that FILLS the Story-4.2 sprint-container ' +
        '**committed-points slot** (the dashed seam `design/backlog/design-notes.md` reserved): the ' +
        'committed (and the seam for completed / remaining) points in the sprint header. Match the ' +
        '4.2.1 slot placement so it drops in with no relayout. Note its relationship to the scrum ' +
        "header's fuller points summary (Story 4.5 draws the scrum variant).\n" +
        '- **Degradation + states** — unestimated issue (muted `—`, never `NaN`); unestimated ' +
        'sprint/epic (`—` roll-up); the badge in a read-only (no-permission) state.\n\n' +
        '**Specify (estimation-settings.mock.html):**\n\n' +
        '- **Project Estimation settings panel** (`settings/project/estimation`) — the settings page ' +
        'chrome + a card with: the **estimation statistic** selector (Story Points default · Time ' +
        'estimate · Issue count — a `Segmented` or radio group), the **point scale** selector ' +
        '(Fibonacci · linear · custom), the **custom-scale editor** (an editable list of numeric values, ' +
        'shown only when scale = custom), helper copy explaining each, and the Save affordance. Plus the ' +
        'settings-hub **nav card** entry (sibling of Board + Workflow). Admin-only state. Mirror Jira ' +
        'board Estimation settings.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A NEW `design/estimation/` area exists with `estimation.mock.html` + `estimation-settings.mock.html` + PNG export(s) + `design/estimation/design-notes.md`; built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape), passing the render checklist (icon viewBox, no nested buttons, prettier), AA-safe.\n' +
        '- `estimation.mock.html` draws: the estimate badge display states (with the unestimated `—`), the click-to-edit picker (scale-deck quick chips + free numeric + clear), the issue-detail story-points field (distinct from the time Estimate), the epic roll-up badge (subtree total), the sprint committed-points roll-up filling the 4.2 sprint-header slot, and the degradation/read-only states.\n' +
        '- `estimation-settings.mock.html` draws the project Estimation settings panel (statistic selector + scale selector + custom-scale editor + helper copy + Save) and the settings-hub nav-card entry; admin-only.\n' +
        '- `design-notes.md` names each composing primitive (`Pill`/chip, the picker popover primitive, `FormField`, `Segmented`, the settings card, the backlog row, the detail rail) AND documents: the badge fills the Story-4.2 **estimate slot** + **committed-points slot** (with no relayout), the statistic switch (Story Points default), the project-scoped-config justified deviation, and that `rollupForSprint` is the reusable aggregate **Story 4.5.2** consumes for its scrum `SprintSummaryDto.points`.\n' +
        '- The asset REUSES (references, does not redraw) the backlog row, the board `.pts` chip, the detail rail, and the settings-page chrome; it specifies only the net-new picker + roll-up badges + settings form.\n\n' +
        '## Context refs\n\n' +
        '- `design/backlog/backlog.mock.html` + `design-notes.md` (the row estimate slot + the sprint committed-points slot this fills — named "filled by Story 4.3") — match the reserved slot placement\n' +
        '- `design/boards/design-notes.md` (the card `.pts` chip) + `design/boards/scrum.mock.html` (the scrum sprint-header points summary 4.5 draws) — the chip + points vocabulary to align with\n' +
        '- `design/work-items/detail.pen` + `design/work-items/design-notes.md` (the core-fields rail with the TIME Estimate field) — where the story-points field + epic roll-up sit\n' +
        '- `app/(authed)/settings/project/board` + `workflow` + `design/projects/` — the settings-page chrome + settings-card + nav-card pattern the Estimation panel mirrors\n' +
        '- `components/ui/*` (`Pill`, `FormField`, `Segmented`, the menu/popover primitive, `Button`) + `app/globals.css` `--el-*` + element-shape tokens; the `/tokens` specimen route\n' +
        '- The Jira story-point field + board Estimation settings (statistic + scale) as the mirror; findings #57 (bounded roll-ups), #35 (read as text), #54 (use the palette)',
    },
    {
      id: '4.3.2',
      title:
        'Schema + migration — `work_item.storyPoints` + `project` estimation config (`estimationStatistic` / `pointScale` / `customScaleValues`) + the two enums, drift-free',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: [],
      descriptionMd:
        'Add the persistence for story points + the project estimation config as ONE Prisma migration, ' +
        'modelled so `prisma migrate dev` is drift-free (a second run reports "No difference ' +
        'detected").\n\n' +
        '**`WorkItem` addition:** `storyPoints Decimal? @db.Decimal(6, 2)` — the agile estimate, ' +
        "nullable (null = unestimated), camelCase (NO `@map`, matching `work_item`'s existing camelCase " +
        'columns — the same within-table-consistency call the schema records for `sprintId` / ' +
        '`backlogRank`; decision-ladder rung 2). **`Decimal`, not `Float`** — story points allow 0.5 ' +
        'increments (Jira-faithful) AND roll up via `SUM`; `Decimal` avoids floating-point drift in the ' +
        'roll-up sums (a real-product correctness concern), at the small fixed precision `(6, 2)`. ' +
        'SEPARATE from the existing `estimateMinutes` (TIME) — both columns coexist; the project ' +
        'statistic config picks which one is THE planning estimate. Index: add `storyPoints` to a ' +
        'covering index ONLY if the roll-up aggregates need it (the sprint roll-up filters on the ' +
        'existing `(projectId, sprintId, backlogRank)` composite; the epic roll-up walks `parentId` — ' +
        'measure, do not add a speculative index).\n\n' +
        '**`Project` additions (the estimation config — PROJECT-scoped per the module header):**\n' +
        '- `estimationStatistic EstimationStatistic @default(story_points)` — which value is THE ' +
        'planning estimate the surfaces display + the roll-ups sum.\n' +
        '- `pointScale PointScale @default(fibonacci)` — the suggested-deck the estimate picker offers.\n' +
        '- `customScaleValues Float[] @default([])` — the project-defined deck values, used ONLY when ' +
        '`pointScale = custom` (these are UI SUGGESTIONS — summation uses the `Decimal` `storyPoints`, ' +
        'so `Float[]` for the suggestion list is fine and avoids a Decimal-array column). All camelCase, ' +
        "no `@map`, matching `project`'s existing `workflowPolicyMode` / `accessLevel` columns. They " +
        'backfill to the defaults on migration (every existing project becomes Story Points + Fibonacci ' +
        '— the agile default, no lock-out).\n\n' +
        '**Enums:**\n' +
        '- `EstimationStatistic` (`@@map("estimation_statistic")`): `story_points`, `time_estimate`, ' +
        '`issue_count` — the three Jira estimation statistics. All values exist now so later stories add ' +
        'no enum ALTER.\n' +
        '- `PointScale` (`@@map("point_scale")`): `fibonacci`, `linear`, `custom`.\n\n' +
        '**No new FK** (the columns are scalars / a scalar list on existing tables), so the ' +
        'FK-as-`@relation` rule is n/a here — but the migration must STILL be drift-free (no spurious ' +
        'change on a second `migrate dev`), and no other model changes.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `schema.prisma` gains `work_item.storyPoints Decimal? @db.Decimal(6, 2)` (camelCase, nullable, separate from `estimateMinutes`) and the `project` columns `estimationStatistic` / `pointScale` / `customScaleValues` with the defaults above, plus the `EstimationStatistic` + `PointScale` enums (`@@map`-ed).\n' +
        '- One migration `add_story_points_and_estimation_config` creates the column, the project columns, and the two enums; existing projects backfill to `story_points` + `fibonacci` + `[]`. `pnpm prisma migrate dev` applies cleanly and a SECOND run reports **"No difference detected"** (no drift).\n' +
        '- `pnpm prisma generate` + `pnpm typecheck` + `pnpm build` pass; no other model changes; no speculative index (add one only if a roll-up query measurably needs it).\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` `model WorkItem` (the `estimateMinutes` / `sprintId` / `backlogRank` columns + the camelCase-no-`@map` convention comment) and `model Project` (`workflowPolicyMode` / `accessLevel` — the project-config-column pattern to mirror)\n' +
        '- `prodect-core/CLAUDE.md` (the migration drift rule — even without an FK, a second `migrate dev` must report "No difference detected") + the `bug-attachment-fk-migration-drift` precedent\n' +
        '- Jira estimation statistics (Story Points / Original Time Estimate / Issue Count) + planning-poker decks (Fibonacci / linear) as the mirror for the enums',
    },
    {
      id: '4.3.3',
      title:
        '`estimationService` — story-point write + project estimation config CRUD + bounded sprint/epic roll-up reads (reusable `rollupForSprint`/`rollupForParent`); repo single-ops + DTOs/errors',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['4.3.2'],
      descriptionMd:
        'The business-logic + data-access layer for estimation: the per-issue estimate write, the ' +
        'project estimation config CRUD, and the BOUNDED roll-up aggregates the UI binds to — including ' +
        'the reusable `rollupForSprint` Story 4.5.2 consumes. Per the 4-layer rule (CLAUDE.md): repo ' +
        'methods are single Prisma ops (writes require `tx`; aggregates use `$queryRaw`); the service ' +
        'owns transactions + DTO mapping + typed errors + the finding-#26 `workspaceId` gate.\n\n' +
        '**Repository methods:**\n' +
        '- `workItemRepository.setStoryPoints(itemId, points | null, tx)` — the single-row estimate ' +
        'write (the entity owns it; no new repo).\n' +
        '- `projectRepository.findEstimationConfig(projectId)` + `updateEstimationConfig(projectId, ' +
        '{ estimationStatistic?, pointScale?, customScaleValues? }, tx)` — the config read/write.\n' +
        '- **Roll-up aggregates** (`$queryRaw`, BOUNDED — finding #57): `sumPointsForSprint(sprintId, ' +
        "statistic)` → a grouped aggregate returning committed (all the sprint's issues) + completed " +
        "(scoped to issues whose status maps to a `category = 'done'` workflow status — the finding-#21 " +
        'terminal predicate, resolved the SAME way 4.5.2 resolves "done") in one query; and ' +
        "`sumPointsForParent(parentId, statistic)` → a recursive-CTE `SUM` over the parent's SUBTREE " +
        '(descendants at any depth) in one query. Both parameterise over the statistic ' +
        '(`SUM(storyPoints)` | `SUM(estimateMinutes)` | `COUNT(*)`). NEVER a load-all + sum.\n\n' +
        '**`estimationService`** (`lib/services/estimationService.ts`) — one method = one transaction, ' +
        'DTO mapping (`lib/mappers/estimationMappers.ts` → `lib/dto/estimation.ts`), typed errors ' +
        '(`lib/estimation/errors.ts`):\n' +
        '- `setEstimate(itemId, points | null)` — validates the value (non-negative; within `Decimal(6,2)` ' +
        'range; null clears), writes `storyPoints`, records a 1.4.6 `work_item_revision` in the SAME ' +
        'transaction, enforces the `workspaceId` gate. (Editing the TIME estimate stays on its existing ' +
        '2.3.6 path — this method owns story points.)\n' +
        '- `getEstimationConfig(projectId)` / `updateEstimationConfig(projectId, patch)` — read/admin-update ' +
        'the project config; validate `customScaleValues` (non-empty + numeric when `pointScale = ' +
        'custom`); admin-only (the same project-admin gate the workflow/board settings use).\n' +
        '- **`rollupForSprint(sprintId)`** → `{ committed, completed, remaining }` (resolving the ' +
        "project's statistic, calling `sumPointsForSprint`; `remaining = committed − completed`, never " +
        'negative; an unestimated sprint returns `{0,0,0}` — the DTO stays total, the UI owns "—"). ' +
        '**Exported as the reusable bounded aggregate Story 4.5.2 consumes for its ' +
        '`SprintSummaryDto.points`** (4.5.2 adds only the scrum-specific `columnPoints` breakdown) — ' +
        'this is the seam that keeps the sprint-points SUM in ONE place.\n' +
        '- **`rollupForParent(parentId)`** → the subtree point total (resolving the statistic, calling ' +
        '`sumPointsForParent`) for the epic/parent roll-up badge.\n' +
        '- Mappers return `EstimationConfigDto` + `SprintPointsDto` + a `points` field on the work-item ' +
        'summary DTO — never raw Prisma models.\n\n' +
        '**Typed errors** (`lib/estimation/errors.ts`): `InvalidEstimateError`, ' +
        '`InvalidScaleConfigError`, `EstimationConfigForbiddenError` (non-admin) — distinct codes the ' +
        'route layer maps to 422/403.\n\n' +
        '**Routes** (HTTP-only, one service call + error→status mapping each): `PATCH ' +
        '/api/work-items/[id]/estimate` (set/clear story points), `GET`/`PATCH ' +
        '/api/projects/[id]/estimation-config`. The roll-up reads ride the existing board/backlog/detail ' +
        'read endpoints (the UI subtasks 4.3.4/4.3.5 wire them in) rather than new dedicated routes ' +
        'where an existing read already returns the issue/sprint.\n\n' +
        '**Empty-input guards** (`prodect-core-coverage-gate`): a roll-up over a sprint/parent with no ' +
        'issues, and an empty `customScaleValues`, short-circuit with a direct unit test so the ' +
        'branch-coverage gate stays green.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `setEstimate` writes/clears `work_item.storyPoints` in one transaction (value validated), records a 1.4.6 revision, and enforces the `workspaceId` gate; `getEstimationConfig`/`updateEstimationConfig` read/admin-update the project config (custom-scale validation; admin-only via the project-admin gate).\n' +
        "- `rollupForSprint(sprintId)` returns `{ committed, completed, remaining }` from a BOUNDED grouped aggregate (`completed` scoped to `category = 'done'` statuses, the same predicate 4.5.2 uses; remaining floored at 0; unestimated → `{0,0,0}`); it is EXPORTED + reused by Story 4.5.2 (documented). `rollupForParent(parentId)` returns the recursive-subtree total from one bounded CTE aggregate. Neither loads all rows.\n" +
        '- Both roll-ups parameterise over the configured statistic (`SUM(storyPoints)` | `SUM(estimateMinutes)` | `COUNT(*)`); repo methods are single Prisma ops (writes require `tx`; aggregates `$queryRaw`); the service owns transactions/DTOs/typed errors; routes are HTTP-only.\n' +
        '- Empty-sprint/empty-subtree/empty-custom-scale guards are directly unit-tested; `pnpm test:coverage` keeps the new files ≥90% branch/fn/line.\n\n' +
        '## Context refs\n\n' +
        '- Story 4.3.2 (the `storyPoints` column + `project` estimation config + enums) — the schema this reads/writes\n' +
        '- Story 4.5.2 (`SprintSummaryDto.points` = `SUM(storyPoints)`) — the consumer of `rollupForSprint`; resolve "done" the SAME way (workflow `category = \'done\'`), so the figure matches the scrum header\n' +
        "- `lib/repositories/workItemRepository.ts` / `projectRepository.ts` / `boardRepository.ts` — the single-op + required-`tx` + `$queryRaw`-aggregate patterns; `lib/workflows/*` (the `category = 'done'` terminal-status resolution, finding #21)\n" +
        '- `lib/services/workItemsService.ts` + the 1.4.6 `workItemRevisionsService` — the audit-trail write to reuse in the same tx; `lib/mappers/*`, `lib/dto/*`, `lib/<domain>/errors.ts` layout\n' +
        '- `prodect-core/CLAUDE.md` (4-layer; entity-name-wins) + `prodect-core-coverage-gate` (empty-input guards) + finding #57 (bounded aggregates) + finding #26 (`workspaceId` gate)',
    },
    {
      id: '4.3.4',
      title:
        'Inline-editable estimate badge (display + scale-deck picker) wired across backlog row, board/scrum card, issue detail rail + list — fills the Story-4.2 estimate seam',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['4.3.1', '4.3.3', '4.2.3'],
      descriptionMd:
        'The reusable **estimate badge** — a display chip + a click-to-edit picker — wired into every ' +
        'surface that shows an issue, filling the Story-4.2 backlog **estimate seam** and generalising ' +
        'the board `.pts` chip. Drawn per `design/estimation/estimation.mock.html`; binds to 4.3.3 ' +
        '`setEstimate` + `getEstimationConfig`. ONE component, reused — not four copies.\n\n' +
        "**The `EstimateBadge` component.** Renders the configured statistic (the issue's `storyPoints` " +
        'when statistic = Story Points; the formatted `estimateMinutes` when Time; nothing per-issue ' +
        'when Issue count). Unestimated → the muted `—` / empty slot the design draws. Click (or ' +
        "keyboard-activate) opens the **picker popover**: the project's **scale deck** as quick-pick " +
        'chips (Fibonacci default / linear / the `customScaleValues`, read from `getEstimationConfig`), ' +
        'a **free numeric input** (decimals allowed), and a **Clear** action. Selecting/entering a value ' +
        'calls 4.3.3 `setEstimate` **optimistically with snap-back on error** (the same write contract ' +
        'the board/backlog use). Reuse the shipped menu/popover primitive (no nested buttons, no ' +
        'hand-rolled popover).\n\n' +
        '**Wire it into the surfaces (reuse, do not redraw the rows):**\n' +
        '- **Backlog row (Story 4.2.3)** — drop the badge into the RESERVED estimate slot the 4.2.1 ' +
        'design left (fixed slot order → no relayout). This is the headline seam-fill.\n' +
        '- **Board / Scrum card (`BoardCard`)** — generalise the existing `.pts` chip: it currently ' +
        'renders `card.estimateMinutes` (TIME); make it render the configured statistic (story points by ' +
        'default), editable via the same picker. The card stays drag-friendly (the picker is a click, ' +
        'distinguished from a drag, per the existing `BoardCard` pointer handling).\n' +
        '- **Issue detail rail (Story 2.4)** — add the story-points field DISTINCT from the existing ' +
        'TIME **Estimate** field, with the inline picker.\n' +
        '- **List view (Story 2.5)** — show the configured statistic in the estimate column (reuse the ' +
        'existing `Est.` column slot / add a points column per the design), editable inline where the ' +
        'list already supports inline edit.\n\n' +
        '**Tokens + a11y.** The badge value + label read as TEXT (finding #35 — not colour/shape alone); ' +
        'colour via `--el-*`, shape via element shape tokens (no Tier-0 `--color-*`, no raw ' +
        '`rounded-*`/`p-*` for control shape — CLAUDE.md); the picker is keyboard-operable; new copy ' +
        '(picker labels, clear, the empty `—`) gets `estimation.*` i18n keys in every shipped locale ' +
        '(the existing next-intl threading pattern).\n\n' +
        '**Out of scope here:** the sprint committed-points + epic roll-up DISPLAYS (4.3.5); the project ' +
        'Estimation settings panel (4.3.6); the statistic-switch ADMIN UI (4.3.6 — this subtask READS ' +
        'the config to decide what to show/sum).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A single reusable `EstimateBadge` renders the configured statistic (story points by default; the muted `—` when unestimated) and a click/keyboard-activated picker showing the scale deck as quick chips + a free numeric input + clear; it reads `getEstimationConfig` for the statistic + deck.\n' +
        '- The badge is wired into the backlog row (filling the Story-4.2 estimate seam in the reserved slot, no relayout), the board/scrum `BoardCard` `.pts` chip (now the configured statistic, not raw `estimateMinutes`), the issue-detail rail (a story-points field distinct from the time Estimate), and the list — the SAME component in all four, not copies.\n' +
        '- Setting/clearing an estimate calls 4.3.3 `setEstimate` optimistically and SNAPS BACK with a surfaced error on failure; on the board the picker is distinguished from a drag.\n' +
        '- Colour via `--el-*`, shape via element tokens, AA-safe; the value reads as text (finding #35); the picker is keyboard-operable; new copy has `estimation.*` i18n keys in every shipped locale.\n' +
        '- Component tests assert the badge display (estimated / unestimated), the picker (deck chips + free numeric + clear), the optimistic write + snap-back, and that the board chip now reflects the configured statistic.\n\n' +
        '## Context refs\n\n' +
        '- `design/estimation/estimation.mock.html` + `design-notes.md` (4.3.1) — the badge + picker spec + the reserved-slot placement\n' +
        '- `app/(authed)/boards/_components/BoardCard.tsx` (the `.pts` chip rendering `estimateMinutes` today — generalise it) + the backlog row (4.2.3) + the issue-detail rail (Story 2.4) + the list (Story 2.5 `Est.` column) — the surfaces to wire into\n' +
        '- Story 4.3.3 (`setEstimate` / `getEstimationConfig`) — the write + config read this binds to; `components/ui/*` menu/popover primitive (no nested buttons) + `Pill`/chip\n' +
        '- The `prodect-i18n-threading-pattern` (the `estimation.*` keys across locales); finding #35 (read as text), #54 (palette); `prodect-core/CLAUDE.md` (`--el-*` + element-shape, primitive reuse)',
    },
    {
      id: '4.3.5',
      title:
        'Roll-up displays — sprint committed-points (fills the Story-4.2 sprint-header seam) + epic/parent subtree roll-up badge (issue detail + list/tree)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['4.3.1', '4.3.3', '4.2.3'],
      descriptionMd:
        'Render the two BOUNDED roll-ups 4.3.3 computes: the **per-sprint committed-points** figure that ' +
        'fills the Story-4.2 sprint-container header seam, and the **epic/parent subtree roll-up** badge ' +
        'on the issue detail + list/tree. Drawn per `design/estimation/estimation.mock.html`; binds to ' +
        '4.3.3 `rollupForSprint` / `rollupForParent`. Display-only — the aggregation is 4.3.3.\n\n' +
        '**Sprint committed-points (fills the 4.2 seam).** The Story-4.2 backlog sprint container ' +
        'reserved a **committed-points slot** (`design/backlog/design-notes.md`, "filled by Story ' +
        '4.3"). Bind it to `rollupForSprint(sprintId)`: render the committed points (and the labelled ' +
        'seam for completed / remaining per the design) in the sprint header, in the reserved slot (no ' +
        'relayout). An unestimated sprint shows `—`, never `NaN` (the DTO returns 0s; the UI owns the ' +
        '"—"). The figure comes from the bounded aggregate, NOT a sum over the loaded backlog page ' +
        '(finding #57). NOTE: the SCRUM board header (Story 4.5) draws its own fuller points summary ' +
        "from the same `rollupForSprint` via 4.5.2 — this subtask fills the BACKLOG sprint container's " +
        'slot; it does not touch the scrum board.\n\n' +
        '**Epic / parent roll-up badge.** On an epic (and any parent with children), show the ' +
        'rolled-up **subtree** point total from `rollupForParent(parentId)` — e.g. `Story Points · 34` ' +
        'on the issue-detail header/rail and a roll-up figure on the list/tree parent row, DISTINCT ' +
        "from the parent's OWN estimate (a roll-up of descendants, the way Jira rolls child points into " +
        'an epic). Unestimated subtree → `—`. The read is the one bounded recursive-CTE aggregate ' +
        '(4.3.3), never a load-the-whole-subtree-and-sum.\n\n' +
        '**Tokens + a11y.** Figures read as TEXT (number + label — finding #35); colour via `--el-*`, ' +
        'shape via element shape tokens (CLAUDE.md); the roll-up regions carry `aria-label`s naming the ' +
        'committed/completed/remaining or the rolled-up total; new copy gets `estimation.*` i18n keys in ' +
        'every shipped locale.\n\n' +
        '**Out of scope here:** the per-issue estimate badge/picker (4.3.4); the scrum board sprint ' +
        'header + `columnPoints` (Story 4.5); the velocity / burndown charts (Story 4.6 — this ships ' +
        'numeric remaining only, leaving the chart seam); the Estimation settings panel (4.3.6).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The backlog sprint container header renders the committed-points figure (and the labelled completed/remaining seam per the design) from 4.3.3 `rollupForSprint`, in the Story-4.2 reserved slot with no relayout; an unestimated sprint shows `—` (no `NaN`); the figure is the bounded aggregate, not a sum over the loaded page.\n' +
        '- An epic (and any parent) shows a rolled-up subtree point total from 4.3.3 `rollupForParent` on the issue detail + list/tree parent row, distinct from its own estimate; an unestimated subtree shows `—`; the read is one bounded recursive aggregate.\n' +
        '- Both displays reuse the configured statistic; colour via `--el-*`, shape via element tokens, AA-safe; figures read as text with `aria-label`s (finding #35); new copy has `estimation.*` i18n keys in every shipped locale.\n' +
        '- Component tests assert the sprint committed-points render (estimated + unestimated `—`) and the epic subtree roll-up render; they assert the figures come from the roll-up DTO, not a client sum of loaded rows.\n\n' +
        '## Context refs\n\n' +
        '- `design/estimation/estimation.mock.html` + `design-notes.md` (4.3.1) — the roll-up display spec; `design/backlog/design-notes.md` (the committed-points slot this fills)\n' +
        '- Story 4.3.3 (`rollupForSprint` / `rollupForParent`) — the bounded aggregates this renders; Story 4.5.2 (the scrum header reading the same `rollupForSprint`) — keep the backlog + scrum figures consistent\n' +
        '- The backlog sprint container (Story 4.2.3) + the issue-detail header/rail (Story 2.4) + the list/tree (Story 2.5) — the surfaces this decorates\n' +
        '- finding #57 (bounded, not load-all-and-sum), #35 (read as text); the `prodect-i18n-threading-pattern`; `prodect-core/CLAUDE.md`',
    },
    {
      id: '4.3.6',
      title:
        'Project Estimation settings panel (`settings/project/estimation`) — statistic + scale + custom-scale editor + settings nav card (admin-only)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['4.3.1', '4.3.3'],
      descriptionMd:
        'The project **Estimation** settings panel — the admin surface that configures the estimation ' +
        'statistic + the point scale, sibling of the Workflow + Board settings panels. Drawn per ' +
        '`design/estimation/estimation-settings.mock.html`; binds to 4.3.3 `getEstimationConfig` / ' +
        '`updateEstimationConfig`. Mirror: Jira board Estimation settings (rung 1), at project scope ' +
        '(the module-header deviation).\n\n' +
        '**Route + nav.** A new `settings/project/estimation` page under the existing project-settings ' +
        'shell (alongside `settings/project/board` + `workflow`), and an **Estimation** settings-hub ' +
        'nav CARD on the project-settings index (mirror `BoardSettingsCard` / `WorkflowSettingsCard`). ' +
        'Admin-only — the same project-admin gate the workflow/board settings pages use (a non-admin is ' +
        'denied / sees a read-only or forbidden state).\n\n' +
        '**The form.** Reuse the settings-card + `FormField` + `Segmented` chrome:\n' +
        '- **Estimation statistic** — Story Points (default) · Time estimate · Issue count (a ' +
        '`Segmented` / radio group), with helper copy on what each means + that it drives what the ' +
        'backlog/board/scrum show and the roll-ups sum.\n' +
        '- **Point scale** — Fibonacci (default) · linear · custom (shown only when statistic = Story ' +
        'Points — the scale is a story-point concept).\n' +
        '- **Custom-scale editor** — an editable list of numeric values, shown only when scale = ' +
        'custom; validates non-empty + numeric (the 4.3.3 `InvalidScaleConfigError` surfaced inline).\n' +
        '- **Save** — calls `updateEstimationConfig` (optimistic-with-reconcile, the settings-page ' +
        'contract); a success/error affordance.\n\n' +
        '**Tokens + a11y + i18n.** Colour via `--el-*`, shape via element shape tokens (CLAUDE.md); the ' +
        'form is keyboard-operable + properly labelled; the panel copy + the nav card get `settings.*` / ' +
        '`estimation.*` i18n keys in every shipped locale.\n\n' +
        '**Out of scope here:** the per-issue badge/picker (4.3.4 — which READS this config); the ' +
        'roll-up displays (4.3.5); any board-level estimation override (this product configures ' +
        'estimation per PROJECT, not per board — the justified deviation).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A new `settings/project/estimation` page (under the project-settings shell) + an Estimation settings-hub nav card (mirroring the Board/Workflow cards) read/write the project estimation config via 4.3.3; admin-only (the project-admin gate; non-admin denied/read-only).\n' +
        '- The form offers the statistic selector (Story Points default / Time / Issue count), the point-scale selector (Fibonacci default / linear / custom, shown for Story Points), and the custom-scale editor (numeric list, validated, shown only for custom); Save calls `updateEstimationConfig` optimistically with a success/error affordance.\n' +
        '- Switching the statistic changes which value the planning surfaces show + the roll-ups sum (verified via 4.3.4/4.3.5 reading the config); changing the scale changes the picker deck.\n' +
        '- Colour via `--el-*`, shape via element tokens, AA-safe, keyboard-operable + labelled; copy has i18n keys in every shipped locale; matches `design/estimation/estimation-settings.mock.html`.\n' +
        '- Component tests assert the form render + the statistic/scale selection + the custom-scale validation + the admin gate (non-admin forbidden) + the optimistic save.\n\n' +
        '## Context refs\n\n' +
        '- `design/estimation/estimation-settings.mock.html` + `design-notes.md` (4.3.1) — the panel spec\n' +
        '- `app/(authed)/settings/project/board` + `workflow` + their `_components/*SettingsCard.tsx` (`BoardSettingsCard` / `WorkflowSettingsCard`) + `settings/project/page.tsx` — the settings-page shell + nav-card + admin-gate pattern to mirror\n' +
        '- Story 4.3.3 (`getEstimationConfig` / `updateEstimationConfig` + `InvalidScaleConfigError` / `EstimationConfigForbiddenError`) — the read/write this binds to\n' +
        '- `components/ui/*` (`FormField`, `Segmented`, the settings card, `Button`); the `prodect-i18n-threading-pattern`; the Jira board Estimation settings as the mirror; `prodect-core/CLAUDE.md`',
    },
    {
      id: '4.3.7',
      title:
        'Story tests — estimate write + config + bounded sprint/epic roll-ups (incl. statistic switch + at-scale) + badge/settings components + estimate-a-story E2E',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['4.3.3', '4.3.4', '4.3.5', '4.3.6'],
      descriptionMd:
        'The closing test subtask — the same split Stories 4.1.5 / 4.2.6 used: service/component tests + ' +
        'a focused E2E, against the real Postgres (the project convention: no mocks except `getSession`; ' +
        '`tests/helpers/db.ts` truncation).\n\n' +
        '**Service (vitest, real Postgres).** 4.3.3: `setEstimate` writes/clears `storyPoints` in one ' +
        'transaction (value validation: non-negative, in-range, null clears), records a 1.4.6 revision, ' +
        'and is denied cross-workspace by the finding-#26 gate; `getEstimationConfig`/`updateEstimationConfig` ' +
        'round-trips the statistic + scale + custom values, validates custom scale (`InvalidScaleConfigError`), ' +
        'and rejects a non-admin (`EstimationConfigForbiddenError`). **Roll-ups:** `rollupForSprint` ' +
        "returns committed/completed/remaining where `completed` counts only `category = 'done'` issues, " +
        '`remaining = committed − completed` floored at 0, an unestimated sprint → `{0,0,0}`, and the ' +
        'aggregate is bounded (NOT a sum over a loaded page); `rollupForParent` sums the recursive ' +
        "SUBTREE (a grandchild's points roll into the epic); the **statistic switch** changes which " +
        'field both roll-ups sum (`SUM(storyPoints)` vs `SUM(estimateMinutes)` vs `COUNT(*)`); ' +
        'empty-sprint / empty-subtree / empty-custom-scale guards.\n\n' +
        '**Component.** The `EstimateBadge` display (estimated / unestimated `—`) + picker (deck chips + ' +
        'free numeric + clear) + optimistic write + snap-back, on the board card (configured statistic, ' +
        'not raw minutes) + a backlog row; the sprint committed-points + epic roll-up displays (incl. ' +
        'unestimated `—`); the Estimation settings panel (statistic/scale selection, custom-scale ' +
        'validation, admin gate).\n\n' +
        '**E2E (Playwright) `tests/e2e/estimation.spec.ts`.** A real estimation session against a ' +
        'seeded project with a sprint + an epic/story tree:\n' +
        "- **Estimate a story** — open the backlog, click a story's estimate badge, pick a Fibonacci " +
        'value; the badge updates and survives reload.\n' +
        "- **Sprint roll-up** — the story's sprint container committed-points figure increases by the " +
        'estimate.\n' +
        "- **Epic roll-up** — the parent epic's rolled-up subtree total reflects the new estimate (on " +
        'the detail + list/tree).\n' +
        '- **Detail field** — the issue detail shows the story-points field (distinct from the time ' +
        'Estimate) with the same value.\n' +
        '- **Config** — an admin switches the scale to custom in `settings/project/estimation`; the ' +
        'picker deck reflects the custom values.\n' +
        '- **Scale (finding #57)** — against `pnpm db:seed:large` (a large sprint + deep epic subtree), ' +
        'the roll-ups come back from one bounded aggregate each and the DOM stays bounded.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` (real Postgres) covers 4.3.3 (estimate write + validation + revision + workspace gate; config round-trip + custom-scale validation + admin gate; `rollupForSprint` committed/completed/remaining with the `done`-category predicate + unestimated 0s + bounded; `rollupForParent` recursive subtree sum; the statistic switch; empty-input guards) and the components (badge display/picker/optimistic-snap-back, the roll-up displays, the settings panel).\n' +
        '- `pnpm test:e2e --grep estimation` runs green over the real stack: estimate a backlog story (survives reload), the sprint committed-points + epic subtree roll-ups update, the detail story-points field shows the value, an admin switches the scale, and the at-scale roll-ups stay bounded (DOM bounded) on `db:seed:large`.\n' +
        '- `pnpm test:coverage` keeps the Story-4.3 service/route + component files ≥90% branch/fn/line (the CI coverage gate); the suite uses the real-Postgres harness + the single allowed `getSession` mock.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/backlog.spec.ts` (4.2.6) + `tests/e2e/board-scrum.spec.ts` (4.5.4) — the backlog/board E2E patterns to build the estimation E2E on; `tests/helpers/db.ts` (real-Postgres truncation + large-seed fixture)\n' +
        '- Story 4.3.3 (service + roll-ups) + 4.3.4/4.3.5/4.3.6 (the UI under test); Story 4.1.5 / 4.2.6 — the sibling test-subtask split this mirrors (no duplication of their association/rank/grooming tests)\n' +
        '- `prodect-core-coverage-gate` (≥90% per-file; empty-input guards need a direct test) + `prodect-core-local-postgres` (sandbox PG@5433 + Playwright) + `prodect-core/CLAUDE.md` (real-Postgres, no mocks, single `getSession` mock) + the `prodect-e2e-selector-gotchas` / `prodect-e2e-run-harness-oom` lessons',
    },
  ],
};
