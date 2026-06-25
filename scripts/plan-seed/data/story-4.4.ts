import type { SeedStory } from '../types';

/**
 * Story 4.4 — Sprint lifecycle (start / complete).
 *
 * The ORCHESTRATION layer of Epic 4 (Agile planning): the flows that move a
 * sprint through its life — **start** (scope-lock + stamp the window + "board
 * opens") and **complete** (carry-over of unfinished work + the sprint report) —
 * plus the **one-active-sprint guard rail** at the flow level. Story 4.1 already
 * shipped the ENTITY and the RULES (the `Sprint` model + `SprintState` enum, the
 * pure `assertSprintTransition(planned→active→complete)` guard, the
 * `sprint_one_active_per_project` partial-unique index, and the
 * `assignToSprint`/`moveToBacklog` association writes); 4.4 COMPOSES those rules
 * into the two real flows. It owns no new entity-shape beyond a small scope-lock
 * baseline; it is the verb layer over 4.1's nouns.
 *
 * 📦 Backend + frontend. The lifecycle SERVICE (start/complete/report) is the
 * backend core (4.4.2–4.4.4); the two MODAL flows (4.4.5 start, 4.4.6 complete +
 * carry-over + report) are the UI. **NO external SaaS / secret** — a sprint
 * lifecycle is plain Postgres state transitions over the same tenant DB, so there
 * is NO `type: manual/human` provisioning subtask (mistake #30 checked and
 * clears: the only "provisioning" is the INTERNAL scrum-board create, which is
 * `boardsService.createBoard` — shipped code, Story 3.7.3 — not a dashboard/secret
 * step).
 *
 * ⚠️ Design gate (planning-time, no exceptions). The start/complete ENTRY POINTS
 * are already designed — the **Start-sprint** button in the backlog sprint
 * container (`design/backlog/` 4.2.1, notes: "the start FLOW is Story 4.4 — 4.2
 * mounts the entry point only") and the **Complete-sprint** button in the scrum
 * header (`design/boards/` 4.5.1, notes §"Complete-sprint is an ENTRY POINT only
 * (the flow is Story 4.4)"). But the FLOWS those buttons open — the **start-sprint
 * modal** (name / duration / window / goal confirm), the **complete-sprint modal**
 * (the completed/incomplete split + the carry-over destination chooser), and the
 * **sprint report** — are drawn NOWHERE: both prior assets explicitly state the
 * flow is unspecified here and deferred to 4.4. Unspecified == NO design, so
 * subtask **4.4.1 is a `type: design` subtask** that CREATES a new `design/sprints/`
 * area (mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1, the 4.2.1 backlog area, and the
 * 4.5.1 scrum extension), and EVERY UI-touching code subtask (4.4.5 / 4.4.6)
 * carries 4.4.1 in `dependsOn` (seeded `status: 'blocked'`) and names the asset in
 * Context-refs. A UI code subtask never reaches the ready set before its design
 * asset exists (Principle #13: design before code, within every Story).
 *
 * ── The clean seam: what 4.4 owns vs. what 4.1 / 4.2 / 4.5 own ───────────────────
 *   • Story **4.1** owns the ENTITY + RULES (consumed here): `assertSprintTransition`
 *     (the pure guard 4.4 composes for both flows), the `sprint_one_active_per_project`
 *     partial-unique index (the data-layer one-active backstop the start flow turns
 *     into a friendly typed error), `createSprint`/`updateSprint`/`deleteSprint`
 *     (4.1.3), and `assignToSprint`/`moveToBacklog` (4.1.4 — the carry-over MOVES).
 *   • Story **4.2** mounts the **Start-sprint** entry-point button in the backlog
 *     sprint container (4.2.3) as a SEAM; 4.4.5 wires the start modal to it (the
 *     3.2-Filter-seam pattern). 4.4.6 ALSO self-mounts the Complete-sprint action in
 *     the backlog's active-sprint container, so 4.4's flows are independently
 *     verifiable without Story 4.5.
 *   • Story **4.5** (Scrum board) mounts the **Complete-sprint** entry point in the
 *     sprint header and REUSES 4.4's flow (4.5.3 `dependsOn` includes 4.4). That is
 *     the BACKWARD direction (4.5 > 4.4): 4.5 imports 4.4's mountable trigger; 4.4
 *     does NOT depend on 4.5. Keeping the dependency one-way (4.5 → 4.4, never 4.4 →
 *     4.5) is what avoids the cycle the seam could otherwise create.
 *   • Story **4.3** (estimation) exposes the bounded `rollupForSprint(sprintId)`
 *     (committed / completed / remaining points; 4.3.3) — the sprint report's points
 *     source; 4.4.4 REUSES it rather than re-summing (DRY; the report is points-aware
 *     but degrades to counts when unestimated).
 *   • Story **4.6** (velocity + burndown) reads the completed-sprint history 4.4
 *     produces — a forward consumer, captured as 4.6's backward dep, not 4.4's
 *     concern.
 *
 * ── "One active sprint per BOARD" resolves to "per PROJECT" (inherited 4.1 decision)
 * The 4.4 stub and Story 4.5 prose say "one active sprint per board"; Story 4.1's
 * justified rung-1 deviation modelled the sprint as PROJECT-scoped (`sprint.projectId`),
 * so the guard is the `sprint_one_active_per_project` partial-unique index. 4.4
 * inherits that: the start flow's one-active check + the typed error are per project.
 * (A project has one logical sprint sequence regardless of how many scrum boards view
 * it — see 4.1's module header.)
 *
 * ── "Board opens" = ensure the project's SCRUM board exists (idempotent provisioning)
 * Story 4.5 + 4.1 both note that PROVISIONING the scrum board (so a started sprint has
 * a board to render on) is a 4.1/4.4 responsibility, and that Story 3.7.3 already
 * ships `boardsService.createBoard(projectId, { name, type })` (+ default-column seed).
 * v1 auto-seeds exactly one KANBAN board per project (3.1.2) and `board.projectId` is
 * deliberately non-unique (3.1.1) so a scrum board can be added. So 4.4's start flow
 * ENSURES a `type == scrum` board exists for the project (create-if-missing, in the
 * same transaction), then "board opens" = the start UI navigates to `/boards`. 4.4
 * adds NO board CRUD UI (Story 3.7) and NO scrum render (Story 4.5) — it just calls
 * the shipped `createBoard` so the board 4.5 renders is there. Until 4.5 lands the
 * scrum board renders as Kanban; that is graceful, not a blocker.
 *
 * ── Cross-epic dependency audit (mistake #32) ───────────────────────────────────
 * Every leaf below depends only on: shipped Epic-3 substrate (3.7.3 `createBoard`,
 * `workflowsService.getTerminalStatusKeys` for the done-category split — Epic 3 < 4,
 * backward), DONE Story-4.1 siblings (4.1.3 / 4.1.4), earlier Epic-4 stories
 * (4.2.1 / 4.2.3 design+backlog seam, 4.3.3 points roll-up — all stories < 4.4,
 * backward/sideways), and its own 4.4 siblings. **No `dependsOn` points forward of
 * Story 4.4** (in particular NOTHING here depends on Story 4.5, which would invert
 * the build order) → the audit passes. 4.5's dependency on 4.4 is the correct
 * one-way arrow.
 *
 * Expanded from its `stubs.ts` entry per `motir plan 4.4`. Matches the canonical
 * depth + string-literal style of Stories 4.1 / 4.5 / 3.7.
 */
export const story_4_4: SeedStory = {
  id: '4.4',
  title: 'Sprint lifecycle (start / complete)',
  status: 'done',
  descriptionMd:
    'The **sprint lifecycle flows** — the verbs that take a sprint from *planned* to *active* to ' +
    '*complete* — built on the entity + rules Story 4.1 shipped. Three things: **start a sprint** ' +
    '(scope-lock the committed work, stamp the window, ensure the scrum board exists so it "opens"), ' +
    '**complete a sprint** (move the unfinished issues somewhere via carry-over, close the sprint), and ' +
    'the **sprint report** (what got done vs. what did not, in issues and points). The one-active-sprint ' +
    "guard rail is enforced at the flow level (on top of 4.1's data-layer partial-unique backstop). 4.4 " +
    "owns no new entity beyond a small scope-lock baseline; it COMPOSES 4.1's `assertSprintTransition` " +
    'guard, one-active index, and `assignToSprint`/`moveToBacklog` association writes into real flows.\n\n' +
    '**What 4.4 owns vs. what Stories 4.1 / 4.2 / 4.3 / 4.5 own (the clean seam).** Story **4.1** owns ' +
    'the ENTITY + RULES — the `Sprint` model + `SprintState` enum, the pure `assertSprintTransition` ' +
    '(`planned→active→complete`, one-way), the `sprint_one_active_per_project` partial-unique index, the ' +
    'sprint CRUD (4.1.3), and the issue↔sprint association `assignToSprint`/`moveToBacklog` (4.1.4). 4.4 ' +
    'COMPOSES them: `startSprint` and `completeSprint` are orchestrations that call the guard, flip the ' +
    'state, and (for complete) drive the carry-over moves. Story **4.2** (backlog) MOUNTS the ' +
    'Start-sprint entry-point button as a seam; 4.4 wires the start modal to it. Story **4.5** (scrum ' +
    "board) MOUNTS the Complete-sprint entry point and REUSES 4.4's complete flow (4.5.3 `dependsOn` " +
    '4.4 — the one-way arrow). Story **4.3** exposes `rollupForSprint` (committed/completed/remaining ' +
    "points); 4.4's report REUSES it. 4.4 does NOT re-implement the state machine, the association, the " +
    'point roll-up, the backlog UI, or the scrum render — it consumes them.\n\n' +
    '**Start a sprint (scope-lock + window + "board opens").** From the backlog\'s Start-sprint entry ' +
    'point on a **planned** sprint that has at least one issue (the button is disabled on an empty ' +
    "sprint — 4.2.1's rule), open the **start-sprint modal**: confirm/edit the **name**, pick a " +
    '**duration** (1 / 2 / 3 / 4 weeks / custom — the Jira durations, mirror rung 1), which derives the ' +
    '**start date** (now) + **end date**, and the **sprint goal**. On confirm, `startSprint` (a) asserts ' +
    "the `planned→active` transition via 4.1's `assertSprintTransition`; (b) enforces **one active " +
    "sprint per project** — a friendly typed `SprintAlreadyActiveError` *before* hitting 4.1's " +
    'partial-unique backstop (the index is the data-layer guard; the service turns it into a 409 a UI can ' +
    'explain); (c) stamps `startDate`/`endDate` + flips `state` to `active`; (d) **scope-locks** the ' +
    "committed baseline (below); (e) **ensures the project's scrum board exists** (create-if-missing via " +
    'the shipped 3.7.3 `boardsService.createBoard(projectId, { type: scrum })`) so the started sprint has ' +
    'a board to render on; all in ONE transaction, recording a 1.4.6 revision. "Board opens" = the start ' +
    'UI then navigates to `/boards` (the scrum board renders the active sprint once Story 4.5 lands; ' +
    'until then it renders as Kanban — graceful).\n\n' +
    "**Scope-lock = an immutable committed baseline (the durable shape, not a shortcut).** Jira's sprint " +
    'report shows a fixed **Committed** line — the issues/points in the sprint *at start* — that does NOT ' +
    'move as scope changes afterward, so the report can flag work *added during the sprint*. The faithful ' +
    'durable shape is to STORE that baseline at start (an immutable snapshot), not to re-derive it later ' +
    '(re-derivation is fragile once points are edited retroactively). So 4.4 adds two small, ' +
    'set-once-at-start columns — `sprint.committedPoints` + `sprint.committedIssueCount` — stamped by ' +
    '`startSprint` and never mutated again. Combined with the 1.4.6 revision trail (which timestamps ' +
    'every sprint association), the report derives "added after start" = associations created after ' +
    '`startDate`. (`completedAt` already exists from 4.1.1; the start window columns `startDate`/`endDate` ' +
    'too — 4.4 only adds the two baseline columns.)\n\n' +
    '**Complete a sprint (carry-over + close).** From the Complete-sprint entry point (scrum header — ' +
    'Story 4.5 — AND the backlog active-sprint container — self-mounted here), open the **complete-sprint ' +
    "modal**: it shows the **completed** count (issues whose workflow status is in a `category = 'done'` " +
    'terminal status — reuse `workflowsService.getTerminalStatusKeys`, the Epic-3 done-category set) and ' +
    'the **incomplete** count, and asks where the incomplete issues go — the **carry-over destination**: ' +
    'the **Backlog** (default) or an **existing planned sprint** (a future sprint to roll them into). On ' +
    'confirm, `completeSprint(sprintId, { carryOverTo })` (a) asserts `active→complete`; (b) moves every ' +
    'unfinished issue — `moveToBacklog` (4.1.4) for the backlog, or `assignToSprint` into the chosen ' +
    'planned sprint (same-project guarded) — leaving the DONE issues on the completed sprint; (c) sets ' +
    '`completedAt` + flips `state` to `complete`; all in ONE transaction, recording 1.4.6 revisions. ' +
    'Carry-over into a NEW sprint = create it first (4.1.3 `createSprint`) then pick it — no inline ' +
    'sprint-create in the complete modal (no complexity for nothing; the backlog already creates ' +
    'sprints). Completing the sprint frees the one-active slot so the next sprint can start.\n\n' +
    '**The sprint report (what got done).** `getSprintReport(sprintId)` returns, for a *completed* (or ' +
    'active, for a live preview) sprint: the **completed** vs **not-completed** issue lists (the ' +
    'done-category split), the **points summary** — `committed` (the locked baseline) / `completed` ' +
    "(SUM over done-category issues) / `not completed` — REUSING Story 4.3's bounded `rollupForSprint` " +
    'rather than re-summing, and the **scope change** ("N issues added after start", derived from the ' +
    '1.4.6 revisions vs `startDate`). It degrades gracefully when issues are unestimated (points show ' +
    '"—", never `NaN`, exactly as the 4.5 sprint header does). The **burndown CHART is Story 4.6** (it ' +
    'reads this same completed-sprint history + the committed baseline); the report here is the textual / ' +
    "numeric summary + the issue lists, with a documented seam for 4.6's chart. The report is reachable " +
    "right after completion (rendered by the complete modal's success state) and later (a sprint's " +
    'report stays viewable — Jira keeps closed-sprint reports).\n\n' +
    '**Completeness / scale (finding #57 — bounded, not load-all).** The completed/incomplete COUNTS and ' +
    "the point figures are **grouped aggregates** scoped to the sprint (the same shape as 4.5.2's " +
    "`SprintSummaryDto` + 4.3's `rollupForSprint`), never a load-every-issue-then-sum. The report's " +
    'issue LISTS are **cursor-paginated** (a real sprint can hold hundreds of issues) — the report shows ' +
    'the counts + the first bounded page of each list, "view all" deep-links to the `/issues` navigator ' +
    '(Story 2.5) filtered to the sprint (the 4.2 "View all issues" mirror pattern), never a full ' +
    'in-report dump. The carry-over MOVE is bounded too: it is the same bounded-batch transaction shape ' +
    '4.2.2 uses for bulk assignment (move the unfinished set in one tx, not N client round-trips, with ' +
    'rollback on partial failure).\n\n' +
    "**The real-product states.** Start: an **empty sprint** can't be started (entry point disabled — " +
    '4.2.1); a **second active sprint** is refused with the friendly `SprintAlreadyActiveError` (the ' +
    'modal explains "Project X already has an active sprint"); an **invalid window** (`endDate < ' +
    "startDate`) is rejected (reuse 4.1.3's `SprintWindowInvalidError`). Complete: a sprint with **no " +
    'incomplete issues** skips the carry-over chooser (nothing to move); a sprint that is **all ' +
    'incomplete** still completes (everything carries over); the carry-over **target must be a planned ' +
    'sprint** in the SAME project (the 4.1.4 same-project guard backstops it). Loading / error on each ' +
    'modal reuse the shipped `Modal` + `ErrorState` idioms. Every state is drawn in 4.4.1, not ' +
    'improvised.\n\n' +
    '**4-layer + tenancy (CLAUDE.md).** The two baseline columns are modelled as plain scalars on the ' +
    'existing `Sprint` model (no new FK; the `add_sprint_lifecycle_fields` migration is additive and ' +
    'drift-free — a second `migrate dev` reports "No difference detected"). `startSprint` / ' +
    '`completeSprint` / `getSprintReport` are `sprintsService` methods (each write = one ' +
    '`prisma.$transaction`), composing the 4.1 repository single-ops (the scrum-board ensure goes through ' +
    'the shipped `boardsService.createBoard` — a service composing a service is fine; repos stay leaves); ' +
    'typed errors in `lib/sprints/errors.ts`; DTOs via `lib/mappers/sprintMappers.ts`; the finding-#26 ' +
    'application-layer `workspaceId` gate on every read/write; the `sprint` RLS policy (4.1.1) already ' +
    'covers the table. Routes are HTTP-only one-service-call handlers. Client UI uses `--el-*` colour + ' +
    'element-shape tokens only (no Tier-0 `--color-*` / raw `rounded-*`).\n\n' +
    '**Out of scope (Epic-4 siblings / Epic 6 / later):** the sprint entity / state-machine guard / ' +
    'one-active index / association + rank writes / bounded reads (Story **4.1** — consumed, not built); ' +
    'the backlog UI + the Start-sprint entry-point button + sprint CRUD UI (Story **4.2** — 4.4 wires the ' +
    'flow into the mounted button); story-point estimation + the `rollupForSprint` engine (Story **4.3** ' +
    '— consumed by the report); the Scrum BOARD render + the sprint header + the Complete-sprint entry ' +
    "point placement (Story **4.5** — which REUSES 4.4's flow); the **burndown + velocity CHARTS** (Story " +
    '**4.6** — the report shows numeric/list summary + a chart seam); board CRUD / multi-board nav (Story ' +
    '**3.7** — 4.4 only CALLS the shipped `createBoard` to provision the scrum board); the combined ' +
    'at-scale Scrum journey E2E (Story **4.7** — 4.4 ships its own focused lifecycle E2E); multiple ' +
    'parallel active sprints (the guard is one active per project — no multi-sprint selector, matching ' +
    'the planned guard, no complexity for nothing); a multi-value sprint *history* field on issues (Jira ' +
    'keeps one active `sprint_id` + the revision trail records moves — a later reporting concern).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (applies `add_sprint_lifecycle_fields` — the two scope-lock baseline columns), `pnpm db:seed`, `pnpm dev`. (Requires Story 4.1 merged for the sprint entity + guard + association; Story 4.3 merged for `rollupForSprint`; Story 4.2 merged for the backlog Start/Complete entry points the flows wire into.)\n' +
    '- **Migration is clean (no drift):** a second `pnpm prisma migrate dev` reports **"No difference detected"** — the baseline columns are plain additive scalars on `Sprint` (no FK, no raw-SQL-only constraint). `pnpm prisma migrate status` is up to date.\n' +
    '- **Design exists first:** `design/sprints/sprint-lifecycle.mock.html` + a PNG export + `design/sprints/design-notes.md` exist (subtask 4.4.1), built from `components/ui/*` + `--el-*`/element-shape tokens only, AA-safe, passing the render checklist — drawing the start-sprint modal, the complete-sprint modal (completed/incomplete split + carry-over chooser), and the sprint report (lists + points + scope change + the 4.6 chart seam).\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the lifecycle service stays ≥90% per-file branch/fn/line on the new/changed service/repository files (the CI coverage gate, `motir-core-coverage-gate`); empty-input guards on any new repo method have a direct test.\n' +
    '- **Start flow:** `startSprint` on a planned sprint with ≥1 issue flips it to `active`, stamps `startDate`/`endDate` (from the chosen duration) + the `committedPoints`/`committedIssueCount` baseline, ensures a `type == scrum` board exists for the project (created if missing, via `createBoard`), and records a 1.4.6 revision — all in one transaction. Starting a sprint while another is `active` in the same project throws `SprintAlreadyActiveError` (the friendly 409, before the partial-unique backstop); a different project may start its own concurrently. An `endDate < startDate` window is rejected.\n' +
    '- **One-active rail (defence in depth):** with the service guard bypassed, the `sprint_one_active_per_project` index (4.1.1) still refuses a second active sprint — the data layer is the backstop, the service error is the friendly path.\n' +
    "- **Complete flow + carry-over:** `completeSprint(sprintId, { carryOverTo: 'backlog' })` moves every NON-done-category issue back to the backlog (in `backlog_rank` order), leaves the done issues on the sprint, sets `completedAt`, flips `state` to `complete`, and frees the one-active slot — one transaction. `{ carryOverTo: { sprintId } }` instead assigns the unfinished issues into the chosen PLANNED sprint (same-project guarded; a cross-project or non-planned target is rejected). A sprint with no incomplete issues completes without a carry-over step.\n" +
    '- **Sprint report:** `getSprintReport` returns the completed vs not-completed issue lists (the done-category split), the points summary (`committed` = the locked baseline, `completed` = SUM over done issues via 4.3 `rollupForSprint`, `not completed` = the remainder), and the scope-change count ("added after start" from the 1.4.6 revisions vs `startDate`); an unestimated sprint shows "—" for points (no `NaN`). The lists are cursor-paginated (first bounded page + a "view all" deep-link to `/issues` filtered to the sprint), NOT a full dump (finding #57).\n' +
    '- **Start-sprint UI:** sign in as `zhuyue@motir.co`, open the `motir` project → `/backlog`; a planned sprint with issues shows an enabled **Start sprint** button → the start modal (name / duration / dates / goal) → confirm flips the sprint active and navigates to `/boards`. An empty sprint\'s Start button is disabled; starting a second sprint shows the "already active" message. Matches `design/sprints/sprint-lifecycle.mock.html`.\n' +
    '- **Complete-sprint UI:** on the active sprint (from the backlog active-sprint container — and, once Story 4.5 lands, the scrum header) the **Complete sprint** action opens the complete modal showing the completed/incomplete counts and the carry-over chooser (Backlog · a planned sprint) → confirm completes the sprint, moves the unfinished issues, and shows the **sprint report** (completed/incomplete lists + committed/completed points + "N added during sprint"). Matches the design.\n' +
    '- **Scale check (finding #57):** `pnpm db:seed:large` with a large active sprint → the report COUNTS + point figures come from grouped aggregates (not a load-all), the issue lists render one bounded page with a "view all" link, and the carry-over move is ONE bounded transaction (a forced mid-batch failure rolls back — none moved, not a partial set).\n' +
    '- **Tenancy:** a cross-workspace start/complete/report call is denied by the finding-#26 `workspaceId` gate; the `sprint` RLS policy rejects access outside the active workspace context.\n' +
    "- **a11y:** the modals are labelled dialogs with focus trap + escape; the report's completed/incomplete and points are read as text+number (not colour alone — finding #35); the carry-over chooser is keyboard-operable.",
  items: [
    {
      id: '4.4.1',
      title:
        'Design — sprint lifecycle flows: start-sprint modal, complete-sprint + carry-over modal, sprint report (creates design/sprints/)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: ['4.2.1'],
      descriptionMd:
        'The design asset every UI subtask of this story builds against. The start/complete ENTRY POINTS ' +
        'are already designed — the Start-sprint button in the backlog sprint container (4.2.1) and the ' +
        'Complete-sprint button in the scrum header (4.5.1) — but the FLOWS they open are drawn nowhere ' +
        '(both prior assets explicitly defer the flow to Story 4.4). Unspecified == NO design, so this ' +
        'subtask produces it FIRST (mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1, the 4.2.1 backlog area it ' +
        'inherits the sprint-container visual language from, and the 4.5.1 scrum extension). Output: ' +
        '`design/sprints/sprint-lifecycle.mock.html` (an HTML mockup built from the real design system — ' +
        '`components/ui/*` + the `--el-*` tokens, so a coding agent has no Pencil→code gap) + a PNG export ' +
        '+ `design/sprints/design-notes.md` naming the composing primitives, copy, and placement. `--el-*` ' +
        'only (no Tier-0 `--color-*`); shape via the element shape tokens; AA-safe; Jira start-sprint / ' +
        'complete-sprint / sprint-report dialogs as the mirror (rung 1).\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Start-sprint modal** — a `Modal` launched from the (already-designed) backlog Start-sprint ' +
        'button: the sprint **name** (editable), a **duration** control (1 / 2 / 3 / 4 weeks / Custom — the ' +
        'Jira deck; Custom reveals explicit start/end date pickers), the derived **start + end dates**, and ' +
        'a **goal** textarea. Primary "Start" + cancel. Reuse `Modal`, `FormField`, `Button`, the date ' +
        'input, the `Combobox`/segmented control for duration — do not invent a dialog shell.\n' +
        '- **Start error state** — the "already active" message when the project has an active sprint ' +
        '("Project X already has an active sprint — complete it first"), and the invalid-window inline ' +
        "error. Drawn as the modal's error treatment (text + `--el-danger`, not colour alone).\n" +
        '- **Complete-sprint modal** — a `Modal` launched from the Complete-sprint button: a **summary ' +
        'line** ("N completed · M incomplete"), and a **carry-over chooser** for the incomplete issues — a ' +
        "radio/`Combobox` group: **Backlog** (default) or **a planned sprint** (a select of the project's " +
        'planned sprints; empty when none). Primary "Complete sprint" + cancel. Note the no-incomplete case ' +
        '(the chooser collapses to "All issues complete").\n' +
        '- **Sprint report** — the post-completion success surface (and the standalone view): the ' +
        '**completed** vs **not-completed** issue lists (each a bounded list of issue rows reusing the ' +
        'work-items row vocabulary, with a "view all in Issues" link), the **points summary** (committed / ' +
        'completed / not-completed as labelled numbers — text+number, "—" when unestimated, finding #35), ' +
        'and the **scope-change** line ("N issues added during the sprint"). Leave a documented **chart ' +
        "SEAM** for Story 4.6's burndown (an empty slot, the same seam pattern 4.5 used). Specify where " +
        "the report renders: inline as the complete modal's success state AND as a reachable standalone " +
        'panel for a closed sprint.\n' +
        '- **States** — loading + error for each modal (reuse the shipped `Modal`/`ErrorState`); the ' +
        "disabled Start button (empty sprint) is the 4.2.1 entry-point's concern (reference, don't " +
        'redraw).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/sprints/sprint-lifecycle.mock.html` + a PNG export + `design/sprints/design-notes.md` exist; the mockup is built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape), passes the render checklist (icon viewBox, no nested buttons, prettier), and is AA-safe.\n' +
        '- The mockup draws: the start-sprint modal (name + duration deck + derived dates + custom-date reveal + goal), the start error states (already-active, invalid window), the complete-sprint modal (completed/incomplete summary + carry-over chooser: Backlog · planned sprint · no-incomplete collapse), and the sprint report (completed/not-completed lists with "view all" links + committed/completed/not-completed points + "—" unestimated + scope-change line + the 4.6 chart seam).\n' +
        '- `design-notes.md` names each composing primitive (`Modal`, `FormField`, `Button`, date input, `Combobox`/segmented duration, the issue-row vocabulary, `EmptyState`), documents that the Start/Complete ENTRY POINTS live in 4.2.1 / 4.5.1 (this asset is the FLOWS only), that the burndown CHART is Story 4.6 (the report shows numeric/list summary + a chart seam), and the dialog-a11y + not-colour-alone (finding #35) rules.\n' +
        '- The asset REFERENCES (does not redraw) the backlog sprint container (4.2.1) + the scrum header (4.5.1) entry points; it specifies only the modal flows + the report.\n\n' +
        '## Context refs\n\n' +
        '- `design/backlog/backlog.mock.html` + `design-notes.md` (4.2.1) — the Start-sprint entry point + sprint-container visual language this inherits (the modal launches from there)\n' +
        '- `design/boards/scrum.mock.html` + `design-notes.md` §"Complete-sprint is an ENTRY POINT only (the flow is Story 4.4)" (4.5.1) — the Complete-sprint entry point this flow opens from\n' +
        '- `components/ui/*` (`Modal`, `FormField`, `Button`, `Combobox`, date input, `EmptyState`, `Pill`) + the heading type scale — the primitives to compose\n' +
        '- `app/globals.css` `--el-*` + element-shape tokens; the `/tokens` specimen route\n' +
        '- Jira start-sprint / complete-sprint / sprint-report dialogs as the mirror; finding #35 (not colour-alone), #54 (use the palette); the design-mockup render checklist',
    },
    {
      id: '4.4.2',
      title:
        'Backend — schema (scope-lock baseline cols) + `startSprint` flow (transition + one-active guard + window + scope-lock + ensure-scrum-board)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['4.1.3', '4.1.4', '3.7.3'],
      descriptionMd:
        'The start half of the lifecycle service — the head of Story 4.4 (all its deps are done, so it is ' +
        "ready immediately). Composes Story 4.1's rules; adds the small scope-lock baseline.\n\n" +
        '**Migration `add_sprint_lifecycle_fields`** — two additive plain scalars on the existing `Sprint` ' +
        'model: `committedPoints Int? @map("committed_points")` + `committedIssueCount Int? ' +
        '@map("committed_issue_count")` — the immutable scope-lock baseline, set once by `startSprint` and ' +
        'never mutated (the Jira "Committed" line). NO new FK (so the migration is drift-free — a second ' +
        '`migrate dev` reports "No difference detected"; `startDate`/`endDate`/`completedAt` already exist ' +
        'from 4.1.1). No enum/index change.\n\n' +
        '**`sprintsService.startSprint(sprintId, { name?, startDate, endDate })`** (extends the 4.1.3 ' +
        'service; one method = one `prisma.$transaction`):\n' +
        "- Load the sprint (`findById`); assert it is `planned` and **compose 4.1's pure " +
        '`assertSprintTransition(planned, active)`** for the transition rule (do NOT re-derive it).\n' +
        '- **One-active guard (friendly path):** read `findActiveByProject(projectId)` (the `FOR UPDATE` ' +
        'variant, inside the tx); if one exists, throw a NEW typed `SprintAlreadyActiveError` (→ 409) ' +
        "BEFORE the write — so the UI gets an explainable error rather than a raw unique-violation. 4.1.1's " +
        '`sprint_one_active_per_project` partial-unique index remains the data-layer backstop (defence in ' +
        'depth).\n' +
        '- **Window:** validate `endDate ≥ startDate` (reuse 4.1.3 `SprintWindowInvalidError`); stamp ' +
        '`startDate` (default now) + `endDate`; optionally update `name`.\n' +
        '- **Scope-lock:** compute the committed baseline at start — `committedIssueCount` = the count of ' +
        "the sprint's issues; `committedPoints` = `SUM(storyPoints)` over them (REUSE 4.3.3 " +
        '`rollupForSprint`/the points aggregate if available; if 4.3 is not yet wired on these issues the ' +
        'sum is 0/null — graceful) — and write them (immutable thereafter).\n' +
        '- **"Board opens" — ensure the scrum board exists:** in the same transaction, ensure the project ' +
        "has a `type == scrum` board — read the project's boards; if none is `scrum`, call the shipped " +
        "`boardsService.createBoard(projectId, { name: 'Sprint board', type: 'scrum' })` (3.7.3, which " +
        'seeds default columns). Idempotent: a second start does not create a duplicate. (A service calling ' +
        'a service is allowed; repos stay leaves.)\n' +
        '- Flip `state` to `active`; record a 1.4.6 `work_item_revision`/sprint revision in the same tx; ' +
        'return the updated `SprintDto`. Enforce the finding-#26 `workspaceId` gate.\n\n' +
        '**Typed errors:** add `SprintAlreadyActiveError`, `SprintNotStartableError` (not in `planned`) to ' +
        '`lib/sprints/errors.ts`. **Route:** `POST /api/sprints/[id]/start` — HTTP-only, one service call + ' +
        'error→status mapping (409 already-active, 422 window/state).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The `add_sprint_lifecycle_fields` migration adds `committed_points` + `committed_issue_count` as nullable scalars on `sprint`; `pnpm prisma migrate dev` applies cleanly and a SECOND run reports "No difference detected" (no FK drift).\n' +
        '- `startSprint` composes `assertSprintTransition(planned→active)`, throws `SprintAlreadyActiveError` when the project already has an active sprint (before the partial-unique backstop), validates the window, stamps `startDate`/`endDate` + the immutable `committedPoints`/`committedIssueCount` baseline, ensures a `scrum` board exists via `createBoard` (idempotent), flips state to `active`, and records a revision — all in ONE transaction; returns a `SprintDto`.\n' +
        '- A different project can start its own sprint concurrently; an `endDate < startDate` window is rejected; starting a non-planned sprint throws `SprintNotStartableError`.\n' +
        '- New typed errors live in `lib/sprints/errors.ts`; `POST /api/sprints/[id]/start` is HTTP-only (one service call + error mapping); the finding-#26 `workspaceId` gate covers the reads/writes.\n' +
        '- `pnpm test:coverage` keeps the new/changed service file ≥90% branch/fn/line (the coverage gate); complete/report ORCHESTRATION is explicitly absent (subtasks 4.4.3 / 4.4.4).\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/sprintsService.ts` + `lib/sprints/errors.ts` + `lib/mappers/sprintMappers.ts` + `lib/dto/sprints.ts` (Story 4.1.3) — the service/errors/DTOs this extends; the pure `assertSprintTransition` to compose; `lib/repositories/sprintRepository.ts` `findActiveByProject` (the `FOR UPDATE` variant)\n' +
        '- `lib/services/boardsService.ts` `createBoard(projectId, { name, type })` (Story 3.7.3) — the shipped scrum-board provisioning primitive to call for "board opens"\n' +
        '- Story 4.3.3 `rollupForSprint` / the `SUM(storyPoints)` aggregate (for the committed baseline; graceful 0 when unestimated) — read here, defined there\n' +
        '- `prisma/schema.prisma` `model Sprint` (4.1.1) — where the two baseline columns land; `motir-core/CLAUDE.md` (4-layer: service owns the tx + DTO mapping; FK-as-`@relation`/no-drift rule); finding #26 (`workspaceId` gate); `motir-core-coverage-gate`',
    },
    {
      id: '4.4.3',
      title:
        'Backend — `completeSprint` flow + carry-over (transition + move unfinished to backlog / planned sprint, one tx)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['4.4.2', '4.1.4'],
      descriptionMd:
        'The complete half of the lifecycle service — closes an active sprint and carries its unfinished ' +
        "work somewhere, composing Story 4.1's transition guard + association writes + the Epic-3 " +
        'done-category set.\n\n' +
        '**`sprintsService.completeSprint(sprintId, { carryOverTo })`** where `carryOverTo` is ' +
        "`'backlog'` (default) or `{ sprintId: <planned sprint id> }` (one method = one " +
        '`prisma.$transaction`):\n' +
        '- Load the sprint; assert it is `active` and **compose `assertSprintTransition(active, ' +
        'complete)`**.\n' +
        "- **Determine the unfinished set:** the sprint's issues whose workflow status is NOT in a " +
        "`category = 'done'` terminal status — resolve the project's done-category status keys via the " +
        'shipped `workflowsService.getTerminalStatusKeys(projectId)` (Epic 3) and select the sprint issues ' +
        'whose status key is outside that set. The DONE issues STAY on the completed sprint (the historical ' +
        'record); only the unfinished ones move.\n' +
        "- **Carry-over move (bounded batch, one tx — the 4.2.2 bulk shape):** for `'backlog'`, " +
        '`moveToBacklog` each unfinished issue (4.1.4 — they re-appear in `backlog_rank` order); for ' +
        '`{ sprintId }`, validate the target is a **planned** sprint in the **same project** (throw ' +
        '`InvalidCarryOverTargetError` / reuse the 4.1.4 same-project guard otherwise) and `assignToSprint` ' +
        'each unfinished issue into it. The whole carry-over is ONE transaction (partial failure rolls back ' +
        '— never a half-moved set), recording a 1.4.6 revision per move.\n' +
        "- **Close:** set `completedAt = now`, flip `state` to `complete` (freeing the project's " +
        'one-active slot so the next sprint can start). Return the completed `SprintDto` + the report ' +
        'payload (or let the UI fetch `getSprintReport`, 4.4.4).\n' +
        '- A sprint with **no unfinished issues** completes with an empty carry-over (no-op move). Enforce ' +
        'the finding-#26 `workspaceId` gate.\n\n' +
        '**Typed errors:** add `SprintNotCompletableError` (not `active`), `InvalidCarryOverTargetError` ' +
        '(target not a same-project planned sprint) to `lib/sprints/errors.ts`. **Route:** `POST ' +
        '/api/sprints/[id]/complete` — HTTP-only, one service call + error mapping (422 state, 409/422 ' +
        'target).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `completeSprint` composes `assertSprintTransition(active→complete)`, computes the unfinished set via `getTerminalStatusKeys` (non-done-category issues), moves them in ONE transaction — to the backlog (`moveToBacklog`, rank order restored) or into a same-project PLANNED sprint (`assignToSprint`, same-project guarded) — leaves done issues on the sprint, sets `completedAt`, flips state to `complete`, and records a revision per move.\n' +
        '- A carry-over target that is cross-project or not planned throws `InvalidCarryOverTargetError`; completing a non-active sprint throws `SprintNotCompletableError`; a sprint with no incomplete issues completes with a no-op carry-over; the freed one-active slot lets a new sprint start.\n' +
        '- The carry-over is a bounded batch (one tx, rollback on partial failure — not N round-trips); new typed errors live in `lib/sprints/errors.ts`; `POST /api/sprints/[id]/complete` is HTTP-only; the finding-#26 `workspaceId` gate covers it.\n' +
        '- `pnpm test:coverage` keeps the changed service file ≥90% branch/fn/line (the coverage gate).\n\n' +
        '## Context refs\n\n' +
        '- Story 4.4.2 (`startSprint` + the extended `sprintsService`/errors) — the layer this completes; the pure `assertSprintTransition` to compose\n' +
        '- `lib/repositories/workItemRepository.ts` `setSprint` / `lib/services` `moveToBacklog` + `assignToSprint` (Story 4.1.4) — the association MOVES the carry-over drives; the same-project guard to reuse; the 4.2.2 bulk-tx shape to mirror for the bounded batch\n' +
        '- `lib/services/workflowsService.ts` `getTerminalStatusKeys` (Epic 3) — the `category = \'done\'` set that defines "unfinished"\n' +
        '- the 1.4.6 `workItemRevisionsService` — the audit-trail write to reuse per move; `motir-core/CLAUDE.md` (4-layer); finding #26 + #57 (bounded batch); `motir-core-coverage-gate`',
    },
    {
      id: '4.4.4',
      title:
        'Backend — `getSprintReport` (completed/incomplete lists + points via 4.3 roll-up + scope-change, bounded)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['4.4.3', '4.3.3'],
      descriptionMd:
        'The sprint report read — what got done vs. what did not — built to real-product SCALE (finding ' +
        "#57: bounded aggregates + paginated lists, never load-all). Powers the complete modal's success " +
        'state (4.4.6) and the standalone closed-sprint report view.\n\n' +
        '**`sprintsService.getSprintReport(sprintId, { completedCursor?, incompleteCursor?, limit })`** → ' +
        'a `SprintReportDto`:\n' +
        '- **Points summary** — `{ committed, completed, notCompleted }`: `committed` = the locked ' +
        "`committedPoints` baseline (4.4.2); `completed` = `SUM(storyPoints)` over the sprint's " +
        'done-category issues; `notCompleted` = the remainder — **REUSE Story 4.3.3 `rollupForSprint`** ' +
        '(the bounded grouped aggregate) rather than re-summing. Unestimated → the DTO returns the numbers ' +
        '(0/null), the UI renders "—" (the data layer stays total — the 4.5.2 pattern).\n' +
        '- **Counts** — `{ completedCount, incompleteCount }` from grouped aggregates scoped to the sprint ' +
        '(via `getTerminalStatusKeys`), NOT a loaded-page sum.\n' +
        '- **Issue lists** — `completed: WorkItemSummaryDto[]` + `incomplete: WorkItemSummaryDto[]`, each ' +
        '**cursor-paginated** (the first bounded page + a `nextCursor`); a real sprint can hold hundreds of ' +
        'issues, so the report shows the counts + a bounded page and a **"view all" deep-link** to the ' +
        '`/issues` navigator (Story 2.5) filtered to the sprint (the 4.2 "View all issues" mirror), never a ' +
        'full in-report dump.\n' +
        '- **Scope change** — `{ addedAfterStart }`: the count of issues associated with the sprint AFTER ' +
        '`startDate` (derived from the 1.4.6 revision trail — the immutable `committedIssueCount` baseline ' +
        'anchors it), the Jira "issues added during sprint" figure. Bounded (an aggregate over revisions, ' +
        'not a load-all).\n' +
        '- Works for a `complete` sprint (the report) AND an `active` sprint (a live preview the complete ' +
        'modal can show before confirming). Enforce the finding-#26 `workspaceId` gate.\n\n' +
        '**Route:** `GET /api/sprints/[id]/report` — HTTP-only, one service call. Mapper in ' +
        '`lib/mappers/sprintMappers.ts` → `SprintReportDto` in `lib/dto/sprints.ts`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `getSprintReport` returns a `SprintReportDto` with the points summary (committed = the locked baseline; completed/notCompleted via `rollupForSprint`), the completed/incomplete counts (grouped aggregates, not page sums), the cursor-paginated completed + incomplete issue lists (first bounded page + nextCursor + a "view all" deep-link target), and the `addedAfterStart` scope-change count (from the 1.4.6 revisions vs `startDate`).\n' +
        '- An unestimated sprint returns 0/null points (the DTO stays total; the UI owns the "—"); the report works for both a completed and an active sprint; the lists are NEVER an unbounded dump (finding #57).\n' +
        '- `GET /api/sprints/[id]/report` is HTTP-only (one service call); DTOs mapped in `lib/mappers/sprintMappers.ts`; the finding-#26 `workspaceId` gate covers the reads.\n' +
        '- `pnpm test:coverage` keeps the changed service/mapper files ≥90% branch/fn/line (the coverage gate).\n\n' +
        '## Context refs\n\n' +
        '- Story 4.4.3 (`completeSprint` — sets `completedAt` + the done/unfinished split) + 4.4.2 (the `committedPoints`/`committedIssueCount` baseline) — the data this reports on\n' +
        '- Story 4.3.3 `rollupForSprint(sprintId)` (committed/completed/remaining points, bounded aggregate) — the points source to REUSE, not re-sum\n' +
        '- `lib/services/workflowsService.ts` `getTerminalStatusKeys` — the done-category split; the 1.4.6 `workItemRevisionsService` — the sprint-association revisions the scope-change count reads\n' +
        '- Story 2.5 `/issues` navigator — the "view all" deep-link target (filtered to the sprint); finding #57 (bounded aggregates + paginated lists); `motir-core/CLAUDE.md` (service owns DTO mapping); `motir-core-coverage-gate`',
    },
    {
      id: '4.4.5',
      title:
        'UI — start-sprint flow: wire the start modal to the backlog Start-sprint entry point; "board opens" navigation',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['4.4.1', '4.4.2', '4.2.3'],
      descriptionMd:
        'The start-sprint UI — the modal `design/sprints/sprint-lifecycle.mock.html` specifies, WIRED to ' +
        'the Start-sprint entry-point button Story 4.2.3 already mounts in the backlog sprint container ' +
        '(the seam pattern: 4.2 mounts the button, 4.4 wires the flow). Reuses shipped primitives; no new ' +
        'dialog shell.\n\n' +
        "**The `StartSprintDialog`.** A `Modal` opened from the backlog sprint container's Start-sprint " +
        'button (enabled only on a planned sprint with ≥1 issue — the 4.2.1 rule): the sprint **name** ' +
        '(prefilled), a **duration** segmented control (1 / 2 / 3 / 4 weeks / Custom — Custom reveals ' +
        'explicit `startDate`/`endDate` pickers, the rest derive `endDate` from now), and the **goal** ' +
        'textarea. Primary **Start sprint** → `POST /api/sprints/[id]/start` (4.4.2). On success the sprint ' +
        'is `active`; **"board opens"** → navigate to `/boards` (the scrum board renders the active sprint ' +
        'once Story 4.5 lands; until then Kanban — graceful). Optimistic-friendly; the backlog ' +
        'sprint-container state refreshes (the started sprint shows its active chip).\n\n' +
        '**Error states (from the design).** The friendly `SprintAlreadyActiveError` (409) → an inline ' +
        'modal message ("Project X already has an active sprint — complete it first"); the ' +
        '`SprintWindowInvalidError` (422) → an inline field error on the date pickers. Text + ' +
        '`--el-danger`, never colour alone (finding #35).\n\n' +
        "**Wire, don't rebuild (the seam).** 4.2.3 ships the Start-sprint button as a seam (a button that " +
        'invokes an injected handler / opens this dialog — the 3.2 Filter-seam pattern). 4.4.5 supplies the ' +
        '`StartSprintDialog` + the handler. Do NOT re-draw the sprint container or the button; mount the ' +
        'dialog behind the existing entry point. The dialog is a self-contained component (a planned sprint ' +
        '+ its id) so it could also be mounted elsewhere if needed.\n\n' +
        '**Tokens + a11y.** Colour via `--el-*`, shape via element-shape tokens (no Tier-0 `--color-*` / ' +
        'raw `rounded-*`); the modal is a labelled dialog with focus trap + escape; the duration control + ' +
        'date pickers are keyboard-operable.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The backlog sprint container\'s Start-sprint button (4.2.3 seam) opens the `StartSprintDialog` (name + duration deck + derived/custom dates + goal); confirm calls `POST /api/sprints/[id]/start` and on success navigates to `/boards` ("board opens"); the started sprint shows its active state in the backlog.\n' +
        '- The empty-sprint Start button stays disabled (4.2.1 rule, unchanged); the already-active 409 renders the friendly inline modal message; an invalid window renders an inline date error — text + `--el-danger`, not colour alone.\n' +
        '- 4.4.5 WIRES the flow into the existing 4.2.3 entry point (does NOT redraw the sprint container/button); the dialog is a self-contained reusable component; matches `design/sprints/sprint-lifecycle.mock.html`.\n' +
        '- Colours via `--el-*`, shape via element tokens, AA-safe; the modal is a labelled focus-trapped dialog; component tests assert the dialog render (duration → dates), the start call, the navigation, and the already-active/invalid-window error states.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/backlog/_components/*` (Story 4.2.3 — the sprint container + the Start-sprint entry-point seam) — where the dialog mounts; the 3.2 Filter-seam pattern to mirror\n' +
        '- Story 4.4.2 (`POST /api/sprints/[id]/start` + the typed errors) — the backend this calls; Story 4.4.1 (`design/sprints/sprint-lifecycle.mock.html` + design-notes) — the modal spec\n' +
        '- `components/ui/*` (`Modal`, `FormField`, `Button`, `Combobox`/segmented control, date input) — the primitives to reuse\n' +
        '- finding #35 (not colour-alone), #54 (use the palette); `motir-core/CLAUDE.md` (`--el-*` + element-shape rules, client UI)',
    },
    {
      id: '4.4.6',
      title:
        'UI — complete-sprint flow: complete modal (carry-over chooser) + sprint report view; self-mount in backlog active-sprint container',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['4.4.1', '4.4.3', '4.4.4', '4.2.3'],
      descriptionMd:
        'The complete-sprint UI — the complete modal + carry-over chooser + the sprint report — per ' +
        '`design/sprints/sprint-lifecycle.mock.html`. Ships as a **self-contained mountable** flow that ' +
        'Story 4.5.3 ALSO mounts in the scrum header (4.5.3 `dependsOn` 4.4 — the one-way arrow), and that ' +
        "4.4.6 self-mounts in the backlog's active-sprint container so the flow is verifiable without " +
        'Story 4.5.\n\n' +
        '**The `CompleteSprintDialog`.** A `Modal` opened from a Complete-sprint action on the active ' +
        'sprint: a **summary** ("N completed · M incomplete", from the 4.4.4 live report preview) and the ' +
        '**carry-over chooser** for the incomplete issues — **Backlog** (default) or **a planned sprint** ' +
        "(a `Combobox`/select of the project's planned sprints; absent/disabled when none). When there are " +
        'no incomplete issues the chooser collapses to "All issues complete". Primary **Complete sprint** → ' +
        '`POST /api/sprints/[id]/complete` with the chosen `carryOverTo` (4.4.3).\n\n' +
        '**The sprint report (success state + standalone).** On completion, render the report from 4.4.4 ' +
        '`GET /api/sprints/[id]/report`: the **completed** vs **not-completed** issue lists (bounded page + ' +
        'a "view all in Issues" deep-link), the **points summary** (committed / completed / not-completed ' +
        'as labelled numbers; "—" when unestimated), and the **scope-change** line ("N added during the ' +
        'sprint"). Leave the documented **chart seam** for Story 4.6\'s burndown (an empty slot, no chart ' +
        'here). The report is also reachable standalone for a closed sprint (a route/panel) — Jira keeps ' +
        'closed-sprint reports.\n\n' +
        '**Self-mount + the 4.5 seam.** 4.4.6 mounts the Complete-sprint action in the backlog ' +
        'active-sprint container (its `⋯`/header — Jira lets you complete from the backlog too), giving the ' +
        'flow an owned mount point. Story **4.5.3** separately mounts the SAME exported flow ' +
        '(`CompleteSprintDialog` + the report) in the scrum header — that is 4.5 depending on 4.4 ' +
        '(backward), NOT 4.4 depending on 4.5. 4.4.6 exposes the flow as a self-contained component (active ' +
        'sprint + id) for that reuse; it does NOT touch the scrum board.\n\n' +
        '**Tokens + a11y.** `--el-*` colour + element-shape tokens (no Tier-0 / raw `rounded-*`); labelled ' +
        "focus-trapped dialog; the carry-over chooser is keyboard-operable; the report's counts + points " +
        'are text+number (not colour alone — finding #35); the issue lists reuse the work-items row ' +
        'vocabulary.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A Complete-sprint action on the active sprint (mounted in the backlog active-sprint container) opens the `CompleteSprintDialog` showing the completed/incomplete summary + the carry-over chooser (Backlog · a planned sprint · "All issues complete" when none incomplete); confirm calls `POST /api/sprints/[id]/complete` with the chosen `carryOverTo`.\n' +
        '- On completion the **sprint report** renders: completed vs not-completed lists (bounded page + "view all in Issues" link), committed/completed/not-completed points ("—" when unestimated), and the "N added during sprint" scope-change line, with a documented (empty) chart seam for Story 4.6; the report is also reachable standalone for a closed sprint.\n' +
        '- The flow ships as a self-contained exported component 4.5.3 can mount in the scrum header (4.5 → 4.4, one-way); 4.4.6 does NOT depend on or touch the scrum board; it self-mounts in the backlog so it is verifiable alone.\n' +
        '- Colours via `--el-*`, shape via element tokens, AA-safe; labelled focus-trapped dialog; counts/points are text+number not colour-alone (finding #35); matches `design/sprints/sprint-lifecycle.mock.html`.\n' +
        '- Component tests assert the complete dialog (summary + carry-over chooser + no-incomplete collapse), the complete call with each `carryOverTo`, and the report render (lists + points incl. "—" + scope-change + chart seam).\n\n' +
        '## Context refs\n\n' +
        '- Story 4.4.3 (`POST /api/sprints/[id]/complete` + carry-over) + 4.4.4 (`GET /api/sprints/[id]/report`) — the backends this binds; Story 4.4.1 (`design/sprints/sprint-lifecycle.mock.html` + design-notes) — the modal + report spec\n' +
        '- `app/(authed)/backlog/_components/*` (Story 4.2.3 — the active-sprint container) — where the Complete action self-mounts; Story 4.5.3 — the scrum-header consumer that re-mounts this exported flow\n' +
        '- Story 2.5 `/issues` navigator — the report\'s "view all" deep-link; the work-items row vocabulary the report lists reuse\n' +
        '- `components/ui/*` (`Modal`, `Combobox`, `Button`, `EmptyState`, `Pill`) — the primitives; finding #35 / #54; `motir-core/CLAUDE.md` (`--el-*` + element-shape, client UI)',
    },
    {
      id: '4.4.7',
      title:
        'Story tests — sprint lifecycle state machine (start/complete/carry-over/provisioning/report) + focused E2E (plan → start → move → complete → report)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['4.4.2', '4.4.3', '4.4.4', '4.4.5', '4.4.6'],
      descriptionMd:
        'The closing test subtask — Vitest over the real Postgres (the project convention: no mocks except ' +
        '`getSession`; `tests/helpers/db.ts` truncation) for the lifecycle service + a focused Playwright ' +
        'E2E over the whole flow. The at-scale combined Scrum journey (drag + WIP + swimlanes on a large ' +
        "active sprint) is **Story 4.7's**, not duplicated here (this story's scale proof is the bounded " +
        'aggregates/paginated report asserted in 4.4.3 / 4.4.4 against `db:seed:large`).\n\n' +
        '**Service / unit (vitest, real Postgres).** *Start:* `startSprint` flips planned→active, stamps ' +
        'the window + the immutable `committedPoints`/`committedIssueCount` baseline, ensures a scrum board ' +
        'exists (created once, idempotent on a second start), records a revision; `SprintAlreadyActiveError` ' +
        'on a second active sprint in the project (+ the partial-unique backstop still refuses with the ' +
        'service bypassed); a different project starts concurrently; invalid window + non-planned rejected. ' +
        '*Complete:* `completeSprint` flips active→complete, sets `completedAt`, moves only the ' +
        'non-done-category issues to the backlog (rank restored) OR into a same-project planned sprint, ' +
        'leaves done issues on the sprint, frees the one-active slot, records revisions, and is ONE ' +
        'transaction (forced mid-batch failure → none moved); `InvalidCarryOverTargetError` on a ' +
        'cross-project/non-planned target; no-incomplete completes cleanly. *Report:* `getSprintReport` ' +
        'returns the completed/incomplete lists (bounded/paginated), the committed (baseline) / completed / ' +
        'not-completed points (via `rollupForSprint`; unestimated → "—"/0s), and the `addedAfterStart` ' +
        'scope-change; the counts come from aggregates, not page sums. *Tenancy:* cross-workspace ' +
        'start/complete/report denied by the finding-#26 gate.\n\n' +
        '**E2E (Playwright) `tests/e2e/sprint-lifecycle.spec.ts`.** Against a seeded project with a planned ' +
        'sprint holding issues: open `/backlog` → **Start sprint** (modal: name/duration/goal) → the sprint ' +
        'goes active and the app navigates to `/boards`; move some issues to a done status; back on the ' +
        'backlog (or the scrum header once 4.5 lands) → **Complete sprint** → the modal shows the ' +
        'completed/incomplete split + the carry-over chooser → choose Backlog → confirm → the **sprint ' +
        'report** shows the completed/incomplete lists + committed/completed points + the scope-change, and ' +
        'the unfinished issues are back in the backlog. Assert the empty-sprint Start button is disabled ' +
        'and a second start shows the already-active message.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` (real Postgres) covers: start (transition + window + scope-lock baseline + idempotent scrum-board ensure + revision), the one-active service error + the index backstop + per-project concurrency, complete (transition + done/unfinished split + carry-over to backlog AND to a planned sprint + same-project guard + one-tx rollback + freed slot), and the report (paginated lists + committed/completed/not-completed points incl. unestimated "—" + scope-change + aggregate counts), plus the cross-workspace denial.\n' +
        '- `pnpm test:e2e --grep sprint-lifecycle` runs green over the real stack: plan → start (modal, navigate to board) → move issues to done → complete (carry-over chooser) → the sprint report; the disabled empty-sprint Start and the already-active message are asserted.\n' +
        '- `pnpm test:coverage` keeps the Story-4.4 service/mapper files ≥90% branch/fn/line (the CI coverage gate); the suite uses the real-Postgres harness + the single allowed `getSession` mock; it does NOT duplicate the at-scale combined Scrum journey (Story 4.7).\n\n' +
        '## Context refs\n\n' +
        '- `tests/helpers/db.ts` — real-Postgres truncation harness + the seed/fixture pattern (a planned sprint with issues; a project with a configured workflow so done-category statuses exist)\n' +
        '- Stories 4.4.2 / 4.4.3 / 4.4.4 (service flows) + 4.4.5 / 4.4.6 (the modals) — the units under test; Story 4.7 — the test story the at-scale combined Scrum journey defers to\n' +
        '- `tests/e2e/backlog.spec.ts` (4.2.6) + `tests/e2e/board-scrum.spec.ts` (4.5.4) — the sibling E2Es this composes the lifecycle flow on top of\n' +
        '- `motir-core-coverage-gate` (≥90% per-file; empty-input guards need a direct test) + `motir-core-local-postgres` (sandbox PG@5433 + Playwright chromium) + `motir-core/CLAUDE.md` (real Postgres, no mocks, single `getSession` mock)',
    },
    {
      id: '4.4.8',
      kind: 'bug',
      title:
        "Bug — start-sprint isn't atomic: the dialog PATCHes the goal then starts (two writes) because `startSprint` takes no `goal` (finding #68)",
      status: 'done',
      type: 'bug',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['4.4.2', '4.4.5'],
      descriptionMd:
        '**Type:** bug (tech-debt seam) · **Parent:** Story 4.4 (sprint lifecycle) · **Code surface ' +
        'owned by:** Story **4.4.2** (`sprintsService.startSprint` + `StartSprintInput`) crossed with ' +
        'Story **4.4.5** (the `StartSprintDialog` that has to compose around the gap) · **Status:** ' +
        'open · **Reported by:** the planner during the 4.4.5 build · **Source:** PRODECT_FINDINGS ' +
        '#68.\n\n' +
        'The start-sprint modal (4.4.5) draws an **editable Sprint goal** (design panel 1), and the ' +
        'mirror product (Jira) edits the goal as part of Start. But the shipped `StartSprintInput` ' +
        '(4.4.2) is `{ name?, startDate?, endDate? }` — **no `goal`** — and `POST /api/sprints/[id]/start` ' +
        'silently drops any extra body field. So 4.4.5 persists an edited goal with a **separate ' +
        '`PATCH /api/sprints/[id] { goal }` BEFORE the start POST** (allowed while the sprint is still ' +
        '`planned`). That is **two writes, not one** — and a small non-atomic window: if the start 409s ' +
        '(another sprint went active in between) after the goal PATCH already landed, the goal edit ' +
        'persists on the still-`planned` sprint (harmless + retryable, but untidy). `name` is editable ' +
        'on start; `goal` should be too.\n\n' +
        '**Fix.** Add `goal?: string | null` to `StartSprintInput` (`lib/dto/sprints.ts`) and have ' +
        '`sprintsService.startSprint` stamp it **inside its existing `$transaction`** (the start route ' +
        'already reads an arbitrary JSON body — extend its parse + forward `goal`, same shape as ' +
        '`name`). Then the `StartSprintDialog` (4.4.5) **drops the pre-start PATCH** and sends ' +
        '`{ name, goal, startDate, endDate }` to `/start` in ONE call. One service method = one ' +
        'transaction (CLAUDE.md); the whole start (window + scope-lock baseline + scrum-board ensure + ' +
        'name + goal) becomes a single atomic write. Keep the `updateSprint` PATCH for plain ' +
        'goal/name/window edits on an already-planned sprint (4.1.3) — unchanged.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `StartSprintInput` carries `goal?: string | null`; `startSprint` writes it inside the same ' +
        'transaction that flips the sprint active (no separate update), and `POST /api/sprints/[id]/start` ' +
        'parses + forwards `goal` (a non-string `goal` is a 400, mirroring the existing `name` guard).\n' +
        '- The `StartSprintDialog` (4.4.5) sends `goal` in the single `/start` call and **no longer** ' +
        'issues a pre-start `PATCH` — verified by the existing 4.4.5 component test (the "persists an ' +
        'edited goal" case is rewritten to assert ONE POST carrying the goal, zero PATCH).\n' +
        '- The committed `goal` is what the started sprint shows (the sprint detail / report reads it); ' +
        'an empty goal clears it (sends `null`).\n' +
        '- `pnpm test:coverage` keeps the changed `sprintsService` file ≥90% branch/fn/line (the ' +
        'coverage gate); a service test asserts `startSprint` stamps the goal in-transaction.\n\n' +
        '## Context refs\n\n' +
        '- `lib/dto/sprints.ts` `StartSprintInput` + `lib/services/sprintsService.ts` `startSprint` ' +
        '(Story 4.4.2) — where `goal` is added + stamped in-transaction\n' +
        '- `app/api/sprints/[id]/start/route.ts` (4.4.2) — the body parse to extend (forward `goal` like ' +
        '`name`)\n' +
        '- `app/(authed)/backlog/_components/StartSprintDialog.tsx` (4.4.5) — drops the pre-start PATCH; ' +
        'its component test asserts the single-call shape\n' +
        '- `lib/services/sprintsService.ts` `updateSprint` (4.1.3) — the plain-edit PATCH, left as-is; ' +
        'PRODECT_FINDINGS #68; `motir-core/CLAUDE.md` (one service method = one transaction)',
    },
    {
      id: '4.4.9',
      kind: 'bug',
      title:
        'Bug — start-sprint committed summary shows the issue count only, not "· N points" (no pre-start points source) (finding #69)',
      status: 'done',
      type: 'bug',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['4.4.5'],
      descriptionMd:
        '**Type:** bug (UI gap) · **Parent:** Story 4.4 (sprint lifecycle) · **Code surface owned by:** ' +
        'the committed-points SEAM (the `SprintContainer` slot, attributed to Story **4.3**) crossed ' +
        'with Story **4.4.5** (the `StartSprintDialog` committed summary) · **Status:** open · ' +
        '**Reported by:** the planner during the 4.4.5 build · **Source:** PRODECT_FINDINGS #69.\n\n' +
        'The design\'s committed summary reads "**8 issues · 21 points** committed at start" (panel 1). ' +
        '`SprintDto.issueCount` is available client-side, but `committedPoints` is `null` until ' +
        '`startSprint` stamps it, and there is **no route** exposing the live pre-start points roll-up — ' +
        '`estimationService.rollupForSprint` (4.3.3, done) is only consumed internally. The ' +
        '`SprintContainer` committed-points slot is itself still a labelled SEAM (Story 4.3). So 4.4.5 ' +
        'renders the committed summary with the **issue count only** ("{n} issues committed at start"), ' +
        "omitting the live points figure — under-delivering to the mockup's ceiling (mistake #26), but " +
        "deliberately, to avoid doing another story's work / a cross-surface collision. The " +
        'authoritative `committedPoints` baseline is still computed + stored server-side at start ' +
        '(4.4.2) and read back by the 4.4.6 report; only the pre-start PREVIEW figure is missing.\n\n' +
        '**Fix.** Expose a small bounded read — `GET /api/sprints/[id]/points` (HTTP-only, one service ' +
        'call) over the shipped `estimationService.rollupForSprint(sprintId)` → `SprintPointsDto` ' +
        '(`{ committed, completed, remaining }`, already bounded, finding-#57-safe, tenant-gated). Then ' +
        'wire `committed` into BOTH consumers: the `SprintContainer` committed-points SEAM (replace the ' +
        '`— pts` placeholder) AND the `StartSprintDialog` committed summary ("{n} issues · {p} points ' +
        'committed at start"; "—" when wholly unestimated — the 4.5.2 pattern, never `NaN`). This is the ' +
        'Story-4.3 / estimation-display follow-up the SEAM was reserved for; doing it once serves both ' +
        'surfaces.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `GET /api/sprints/[id]/points` returns the `SprintPointsDto` from `rollupForSprint` ' +
        '(HTTP-only, one service call; the finding-#26 `workspaceId` gate covers the read); a wholly ' +
        'unestimated sprint returns `{ 0, 0, 0 }` (the DTO stays total).\n' +
        '- The `StartSprintDialog` committed summary shows "{n} issues · {p} points committed at start", ' +
        'rendering "—" for points when the sprint is unestimated (no `NaN`); the figure refreshes if the ' +
        'duration/dates change but the issue set does not (points are issue-set-derived, not ' +
        'window-derived).\n' +
        '- The `SprintContainer` committed-points SEAM renders the live `committed` points (the `— pts` ' +
        'placeholder + the "reserved, not computed" comment are removed); the velocity SEAM (Story 4.6) ' +
        'is left untouched.\n' +
        '- Component tests assert the points render (incl. the unestimated "—"); `pnpm test:coverage` ' +
        'keeps any changed gated file ≥90% branch/fn/line.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/estimationService.ts` `rollupForSprint` + `lib/dto/estimation.ts` ' +
        '`SprintPointsDto` (Story 4.3.3) — the bounded aggregate to expose; no re-summing\n' +
        '- `app/(authed)/backlog/_components/SprintContainer.tsx` (the committed-points SEAM) + ' +
        '`app/(authed)/backlog/_components/StartSprintDialog.tsx` (4.4.5 committed summary) — the two ' +
        'display consumers\n' +
        '- the 4.5.2 sprint-header "—"-when-unestimated pattern (the UI owns the "—", the DTO stays ' +
        'total); finding #57 (bounded aggregate, not load-all); PRODECT_FINDINGS #69; ' +
        '`motir-core/CLAUDE.md` (4-layer: route is HTTP-only; `--el-*` + element-shape tokens)',
    },
  ],
};
