import type { PlanStory } from '../types';

/**
 * Story 4.5 — Scrum board (sprint-scoped view).
 *
 * The board filtered to a board's active sprint, with a sprint header (goal,
 * dates, time + points remaining, per-column point totals). It is deliberately
 * **thin** (the stub: "mostly a scope filter + sprint header"): it reuses the
 * whole Story-3.2 Kanban surface and the Story-3.3 swimlanes/WIP layer wholesale
 * — same columns, same cards, same drag-as-transition contract, same bounded
 * projection — and adds only (a) the sprint SCOPE on the projection and (b) the
 * sprint header chrome. No new board interaction, no new card vocabulary.
 *
 * 📦 Lives in Epic 4 (Agile planning) — formerly Story 3.4 (Epic 3, Boards).
 * Moved here per `notes.html` mistake #32 (epic ordering follows the dependency
 * arrow): a Scrum board NEEDS sprints, and sprints are Epic 4. As Story 3.4 it
 * was a forward-pointing cross-epic dependency (Epic 3 → Epic 4) that would
 * silently break `prodect next`'s readiness logic. The (a)-vs-(b) decision
 * (see `PRODECT.md`) was (b)-move rather than (a)-swap, because only THIS
 * story crossed — Stories 3.1/3.2/3.3/3.6 (Kanban projection, drag-drop,
 * swimlanes/WIP, board config) are pure Kanban substrate that stands alone in
 * the mirror product (Jira and Linear both ship Kanban without sprints). So
 * Epic 3 stays Boards (Kanban-focused), and this single story relocates to
 * Epic 4 where its dependencies live. The dependency arrows below are now
 * backward-pointing (Story 4.5 → Stories 4.1 / 4.3 / 4.4), i.e. normal and
 * expected intra-epic deps; nothing about THIS story's content changed, only
 * its address in the plan.
 *
 * Epic-4 sibling deps (intra-epic, formerly cross-epic). A Scrum board needs
 * SPRINTS: the sprint entity (goal / dates / state planned·active·complete) +
 * the issue→sprint association live in Story **4.1**; story points (for
 * "points remaining") live in Story **4.3**; the sprint lifecycle that makes
 * a sprint *active*, provisions the project's Scrum board, and runs *complete
 * sprint* lives in Story **4.4**. Stories 4.1 / 4.3 / 4.4 are still unexpanded
 * `stubs.ts` stubs (no subtasks yet), so 4.5's code subtasks depend at the
 * STORY level on them. When 4.1 / 4.3 / 4.4 are expanded, a re-plan can
 * tighten these to subtask-level deps.
 *
 * ⚠️ Design gate (planning-time): the 3.2.1 `design/boards/board.mock.html`
 * mockup drew the Kanban board only — it has NO sprint header, NO points
 * summary, NO no-active-sprint empty state, NO complete-sprint affordance, i.e.
 * the Scrum surfaces are *unspecified*, which under the gate means NO design
 * exists. So subtask 4.5.1 is a `type: design` subtask that EXTENDS
 * `design/boards/` (the sprint header + scrum board states), and EVERY
 * UI-touching code subtask (4.5.3) carries 4.5.1 in `dependsOn` and names the
 * asset in Context-refs. A UI code subtask never reaches the ready set before
 * its design asset exists (Principle #13: design before code).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 4.5`. Matches the
 * canonical depth + string-literal style of Stories 3.1 / 3.2 / 3.3.
 */
export const story_4_5: PlanStory = {
  id: '4.5',
  title: 'Scrum board (sprint-scoped view)',
  status: 'planned',
  descriptionMd:
    'The **Scrum** variant of the board: the same Story-3.2/3.3 board surface, **scoped to a ' +
    "board's active sprint**, under a **sprint header** (name, goal, date range, time remaining, " +
    'points remaining, per-column point totals). Per the stub this story is *thin* — "mostly a ' +
    'scope filter + sprint header" — because Story 3.1 already shipped the `BoardType { kanban, ' +
    'scrum }` enum FOR this story (4.5 adds no enum) and the Kanban surface (3.2) + swimlanes/WIP ' +
    '(3.3) are reused wholesale. 4.5 is the **view layer**: a sprint scope on the projection plus ' +
    'the sprint header chrome. It changes NO part of the move contract (a drag is still a workflow ' +
    'transition) and adds NO new card or column vocabulary.\n\n' +
    '**Why this story lives in Epic 4, not Epic 3 (mistake #32).** Originally drafted as Story 3.4 ' +
    'under Epic 3 (Boards), this Story was the canonical example of mistake #32: a forward-pointing ' +
    'cross-epic dependency (Epic 3 → Epic 4) that would have shipped a story whose own file admitted ' +
    'its subtasks could not reach the ready set until the next epic landed. The fix per the (a)-vs-' +
    '(b) decision (PRODECT.md) was (b)-move-the-story, not (a)-swap-the-epics, because only this ' +
    'story crossed (Stories 3.1 / 3.2 / 3.3 / 3.6 — Kanban projection, drag-drop, swimlanes/WIP, ' +
    'board config — are pure Kanban substrate, a standalone capability in the mirror product). So ' +
    '4.5 ships from inside Epic 4 alongside the sprints, points, and lifecycle it depends on; its ' +
    'dependency arrows are now normal backward-pointing intra-epic deps.\n\n' +
    '**Sibling Epic-4 deps (intra-epic — story-level forward refs while siblings are unexpanded ' +
    'stubs).** A Scrum board is meaningless without sprints: the **sprint entity** (goal, start/end, ' +
    'state `planned·active·complete`) + the **issue→sprint association** are Story **4.1** (sprint ' +
    '+ backlog data model); **story points** (for "points remaining" + the per-column point totals) ' +
    'are Story **4.3** (estimation); the **sprint lifecycle** — *start* (which sets a sprint ' +
    "`active` and provisions the project's Scrum board), the **one-active-sprint-per-board guard " +
    'rail**, and *complete sprint* (carry-over) — is Story **4.4**. Stories 4.1 / 4.3 / 4.4 are ' +
    "unexpanded (`stubs.ts` stubs with no subtasks yet), so 4.5's code subtasks depend at the STORY " +
    'level on 4.1 / 4.3 / 4.4. **Consequence: 4.5 stays out of the ready set until 4.1 / 4.3 / 4.4 ' +
    'land** — that is correct and intended (a normal backward intra-epic dependency, not the ' +
    'mistake-#32 forward cross-epic kind). A re-plan after 4.1 / 4.3 / 4.4 expand can retarget these ' +
    'to specific subtasks.\n\n' +
    '**How a Scrum board comes to exist (Epic-4 provisioning, NOT 4.5).** v1 auto-seeds exactly one ' +
    '**Kanban** board per project (Story 3.1.2); `board.projectId` is deliberately non-unique (3.1.1) ' +
    'so a second, **scrum-type** board can be added per project. Provisioning that scrum board — ' +
    'auto-creating it when a team first uses sprints, and setting a sprint `active` — is a 4.1/4.4 ' +
    'responsibility, captured here as the dependency above. **4.5 does NOT add board CRUD** (out of ' +
    'scope, consistent with Story 3.3) and does NOT invent a provisioning path; it RENDERS the ' +
    "sprint-scoped view for a board whose `type` is `scrum`, resolving that board's active sprint. " +
    'If the resolved scrum board has no active sprint, 4.5 shows the no-active-sprint empty state ' +
    '(below) rather than failing.\n\n' +
    "**Sprint SCOPE on the projection (the one backend change).** Extend Story 3.1.4's " +
    "`boardsService.getBoard` so that for a **scrum-type** board it resolves the board's **active " +
    'sprint** (the single `state == active` sprint — the 4.4 one-active-per-board guard makes this ' +
    'unambiguous) and FILTERS the projection to issues associated with that sprint. The column / ' +
    'card / bounded-page / swimlane shape is otherwise byte-for-byte the 3.1.4/3.3.4 projection — ' +
    'sprint scope is an additional `WHERE issue.sprintId = :activeSprintId` on the same queries, not ' +
    'a new projection. A kanban-type board is unaffected (no sprint scope). When a scrum board has no ' +
    'active sprint, the projection returns a `sprint: null` marker (the UI renders the empty state); ' +
    'it never falls back to showing the unscoped backlog as if it were a sprint.\n\n' +
    '**Sprint SUMMARY in the projection (drives the header — bounded aggregates, finding #57).** ' +
    'Alongside the scoped columns, `getBoard` returns a `SprintSummaryDto` for the active sprint: ' +
    '`{ id, name, goal, startDate, endDate, state, daysRemaining, points: { committed, completed, ' +
    'remaining }, columnPoints: { columnId → pointSum } }`. The point figures are **aggregate ' +
    'SUM(storyPoints) queries** scoped to the sprint (committed = all sprint issues; completed = ' +
    'issues in terminal/done statuses; remaining = committed − completed; `columnPoints` = the Jira ' +
    'scrum-board per-column point total). They are computed from a grouped aggregate, **NOT by ' +
    'summing the loaded card page** — the board stays bounded exactly as 3.1/3.2/3.3 (a board that ' +
    'summed every loaded card to total points would be prototype-thinking; points come from an ' +
    'aggregate). `daysRemaining` is derived from `endDate` (calendar days to end, floored at 0; an ' +
    'overdue sprint reads "Ended" / a negative-clamped 0, not a negative number). The in-sprint ' +
    '**burndown chart is explicitly Story 4.6** (velocity + burndown, formerly 4.5 before 4.5 was ' +
    'reassigned to this Story), NOT here — 4.5 shows the numeric remaining only and leaves a ' +
    'documented seam for 4.6 to add the chart.\n\n' +
    "**The sprint header (the one UI surface, per 4.5.1's design).** Above the reused board: the " +
    'sprint **name** + **goal** (truncated with reveal), the **date range** + **time remaining** ' +
    '("5 days remaining" / "Ends Jun 14" / "Ended"), and a compact **points summary** (committed / ' +
    'completed / remaining) — each carried by text+number, never colour alone (finding #35). The ' +
    '**per-column point totals** render in the reused column headers (Jira\'s scrum "sprint health" ' +
    'pills) from `columnPoints`. The header also hosts the **Complete-sprint** entry point — but the ' +
    'complete-sprint FLOW (the confirm modal + carry-over handling + the sprint report) is **Story ' +
    "4.4's**; 4.5 REUSES 4.4's complete-sprint trigger/flow and does NOT rebuild carry-over (if 4.4 " +
    'exposes it as a mountable action, 4.5 mounts it in the header; otherwise 4.5 renders the button ' +
    'as a seam 4.4 wires — the same seam pattern 3.2 used for the Epic-6 Filter button).\n\n' +
    '**Completeness — the real-product states.** **No active sprint** (the common pre-start / post-' +
    'complete state): an `EmptyState` in place of the board — "No active sprint", a one-line ' +
    'explainer, and a CTA pointing at the **Backlog** (Story 4.2) to plan/start one (the Backlog is ' +
    'where a sprint is started — 4.2/4.4 — so 4.5 links there rather than starting a sprint itself). ' +
    '**No scrum board** for the project (sprints never enabled): fall through to the existing Kanban ' +
    'board (3.2) — 4.5 only *replaces* the view when a scrum board is resolved. **Loading / error** ' +
    'reuse the 3.2.2 board scaffold + `ErrorState`. The header degrades gracefully when points are ' +
    'unestimated (4.3 not yet used on these issues): a sprint with no estimated points shows "—" for ' +
    'point figures, never a broken `NaN`.\n\n' +
    '**Reuse, not rebuild (the load-bearing scope decision).** The columns, cards, drag-as-' +
    'transition, snap-back, keyboard DnD, per-column lazy load-more + virtualization (3.2), and the ' +
    'swimlanes + WIP layer (3.3) are the SAME components, rendered with a sprint-scoped projection. ' +
    'Swimlanes/WIP compose on the scrum board for free (Jira scrum boards have both) because it is ' +
    'the same board component — 4.5 wires none of it again. The ONLY net-new code is the projection ' +
    'sprint-scope + summary (4.5.2) and the sprint-header chrome + scrum page resolution (4.5.3).\n\n' +
    '**Out of scope (Epic-4 siblings / later):** the sprint entity / lifecycle / start-complete ' +
    'flow / one-active-sprint guard (Story 4.1 + 4.4); the backlog + assign-to-sprint + grooming ' +
    '(Story 4.2); story-point estimation itself (Story 4.3); the burndown + velocity CHARTS (Story ' +
    '4.6 — 4.5 shows numeric remaining + leaves the chart seam); board CRUD / scrum-board ' +
    'provisioning / multi-board navigation (**Story 3.7**); parallel multiple ' +
    'active sprints (the 4.4 guard is one active sprint per board — no multi-sprint selector or ' +
    'stacked-sprint board, matching the planned guard, no complexity for nothing); the cross-cutting ' +
    'Epic-3 board journey at scale (Story 3.5). The board surface, the move contract, swimlanes/WIP, ' +
    'and the bounded projection all come from Stories 3.1 + 3.2 + 3.3 (Epic 3) and are reused, not ' +
    'rebuilt.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (no 4.5 migration — the sprint schema is Story 4.1, the `BoardType` enum is 3.1.1), `pnpm db:seed`, `pnpm dev`. (Requires sibling Stories 4.1 / 4.3 / 4.4 merged so a scrum board + an active sprint with points exist to render.)\n' +
    '- `pnpm test` — vitest covers: the projection sprint-scope (a scrum board returns only its active sprint\'s issues; a kanban board is unscoped/unchanged; no-active-sprint → `sprint: null`), the `SprintSummaryDto` aggregates (committed/completed/remaining points + `columnPoints` from SUM aggregates, NOT from the loaded page; `daysRemaining` floored at 0; unestimated → null/"—"), and the bounded/paged shape preserved (no load-all).\n' +
    "- `pnpm test:e2e --grep board-scrum` — Playwright drives the real scrum board: header shows name/goal/dates/remaining + the points summary; the board renders only the active sprint's issues; per-column point totals show; the no-active-sprint empty state links to the Backlog.\n" +
    '- **Scrum render check:** sign in as `info@moooon.net`, open a project that has a scrum board with an active sprint → `/boards` renders the **sprint header** (name, goal, date range, "N days remaining", committed/completed/remaining points) above the board, the board shows ONLY the active sprint\'s issues in workflow columns, and each column header shows its point total. The layout matches `design/boards/scrum.mock.html`.\n' +
    '- **Scope check:** an issue NOT in the active sprint does not appear on the scrum board; moving a card still transitions its workflow status (the 3.2 contract is unchanged) and does not change its sprint.\n' +
    '- **Reuse check:** swimlanes (group-by Assignee/Epic/Priority) and per-column WIP limits work on the scrum board exactly as on the Kanban board (3.3) — same controls, same drag-reassign, same soft WIP warning — with no scrum-specific reimplementation.\n' +
    '- **No-active-sprint check:** on a scrum board whose sprint is completed (or before any sprint is started) the board area shows the "No active sprint" empty state with a CTA to the Backlog (4.2), not an empty six-column board and not the unscoped backlog masquerading as a sprint.\n' +
    '- **Points-degradation check:** a sprint whose issues have no story-point estimates shows "—" for the point figures (no `NaN`), and the board still renders.\n' +
    '- **Scale check (finding #57):** `pnpm db:seed:large` with a large active sprint → the board pages per column (3.2.5 load-more + virtualization intact) and the point totals come from the aggregate (no all-cards fetch); DOM row count stays bounded.\n' +
    '- **a11y check:** the sprint header is a labelled landmark; time/points remaining are read by assistive tech as text (not colour/shape alone, finding #35); the empty-state CTA is keyboard-operable.',
  items: [
    {
      id: '4.5.1',
      title:
        'Design — Scrum board view: sprint header (goal/dates/remaining + points), no-active-sprint state, per-column point totals (extends design/boards/)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: ['3.2.1'],
      descriptionMd:
        'The design asset every UI subtask of this story builds against. The 3.2.1 board mockup drew ' +
        'the **Kanban** surface only — it has NO sprint header, NO points summary, NO no-active-sprint ' +
        'empty state, and NO complete-sprint affordance, i.e. those Scrum surfaces are *unspecified*, ' +
        'which under the design gate means NO design exists. So this subtask produces it FIRST ' +
        '(mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1, the 3.2.1 board design it extends, and the 3.3.1 ' +
        'swimlanes/WIP extension). Output: `design/boards/scrum.mock.html` (an HTML mockup built from ' +
        'the real design system — `components/ui/*` + the `--el-*` tokens, so a coding agent has no ' +
        'Pencil→code gap) + a PNG export + an extension of `design/boards/design-notes.md` (a "Scrum ' +
        'board (Story 4.5)" section) naming the composing primitives, copy, and placement. `--el-*` ' +
        'only (no Tier-0 `--color-*`); shape via the element shape tokens; AA-safe; Jira/Linear scrum ' +
        'boards as the mirror.\n\n' +
        '**This is chrome over the EXISTING board — draw the header + states, REUSE the 3.2/3.3 board ' +
        'body.** Do NOT redraw columns, cards, drag states, swimlanes, or WIP — show them as the ' +
        "reused board beneath the new header (reference, don't re-spec). The net-new surfaces:\n\n" +
        '**Specify, panel by panel:**\n\n' +
        '- **Sprint header** — above the board: the sprint **name** (+ a state chip), the **goal** ' +
        '(one line, truncated with a reveal/tooltip for the full text), the **date range** + **time ' +
        'remaining** ("5 days remaining" / "Ends Jun 14" / an "Ended" overdue treatment), and the ' +
        '**points summary** — committed / completed / remaining as labelled numbers (text+number, ' +
        'never colour alone — finding #35). Reuse shipped primitives (`Pill` for the state chip, the ' +
        'card/heading type scale, `Tooltip` for the goal reveal); do not invent a header widget. Note ' +
        'the header is a labelled landmark.\n' +
        '- **Per-column point totals** — the Jira "sprint health" per-column point pill in the reused ' +
        'column header (e.g. a muted `8 pts`); specify where it sits relative to the 3.2.1 card-count ' +
        'badge + the 3.3 WIP slot so the three coexist without crowding.\n' +
        '- **Complete-sprint entry point** — the button position in the header. Make explicit in the ' +
        'notes that the complete-sprint FLOW (confirm + carry-over + report) is **Story 4.4**; this ' +
        "asset specifies only the entry point's placement/label, and 4.5 reuses 4.4's flow (or " +
        'renders the button as a seam 4.4 wires — the 3.2 Filter-seam pattern).\n' +
        '- **No-active-sprint empty state** — the board area replaced by an `EmptyState`: an icon, ' +
        '"No active sprint", a one-line explainer, and a CTA to the **Backlog** (Story 4.2). Draw it ' +
        'distinct from the 3.2.6 empty-board ("No issues") state — this is "no sprint", not "no ' +
        'issues".\n' +
        '- **Points-degradation + states** — the header when points are unestimated (figures show ' +
        '"—", not `NaN`); the loading header (skeleton) over the 3.2.2 board scaffold; the overdue / ' +
        '"Ended" sprint treatment.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/boards/scrum.mock.html` + a PNG export + a "Scrum board (Story 4.5)" section in `design/boards/design-notes.md` exist; the mockup is built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape), passes the render checklist (icon viewBox, no nested buttons, prettier), and is AA-safe.\n' +
        '- The mockup draws: the sprint header (name + state chip + goal-with-reveal + date range + time remaining + committed/completed/remaining points), the per-column point total pill coexisting with the 3.2.1 count badge + 3.3 WIP slot, the complete-sprint entry-point placement, the no-active-sprint `EmptyState` (CTA → Backlog, visually distinct from the 3.2.6 no-issues state), and the unestimated ("—") + overdue ("Ended") + loading states.\n' +
        '- `design-notes.md` names each composing primitive (`Pill`, `Tooltip`, `EmptyState`, the heading scale, the column-header slots), states that the complete-sprint FLOW is Story 4.4 (this asset is the entry point only), states that the burndown CHART is Story 4.6 (the header shows numeric remaining + a chart seam), and documents the header-landmark + not-colour-alone (finding #35) rules.\n' +
        '- The asset REUSES (references, does not redraw) the 3.2/3.3 board body; it specifies only the sprint chrome + scrum-specific states.\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/board.mock.html` + `design-notes.md` (3.2.1) — the base board this extends (column header slots, the reserved controls/WIP slots, the empty/loading/error states to reference)\n' +
        '- `design/boards/swimlanes-wip.mock.html` + the "Swimlanes + WIP (Story 3.3)" notes (3.3.1) — the column-header slot layout the point-total pill must coexist with\n' +
        '- `components/ui/*` (`Pill`, `Tooltip`, `EmptyState`, `Button`) + the heading type scale — the primitives to compose for the header\n' +
        '- `app/globals.css` `--el-*` + element-shape tokens; the `/tokens` specimen route\n' +
        '- Jira / Linear scrum-board active-sprint view as the mirror; finding #35 (not colour-alone), #54 (use the palette)',
    },
    {
      id: '4.5.2',
      title:
        'Projection — sprint scope + `SprintSummaryDto` (committed/completed/remaining points + per-column totals) in `getBoard` for scrum boards',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['3.1.4', '4.1', '4.3'],
      descriptionMd:
        'The one backend change: teach the Story-3.1.4 `boardsService.getBoard` projection to render a ' +
        '**scrum-type** board scoped to its active sprint, and to carry the sprint summary the header ' +
        'needs — **without regressing the bounded, never-load-all shape** (finding #57) and **without ' +
        'touching the kanban path**.\n\n' +
        '**Depends on Stories 4.1 + 4.3 (Epic-4 siblings, story-level forward refs while they are ' +
        'unexpanded stubs).** Story **4.1** provides the `sprint` entity (goal, startDate, endDate, ' +
        'state `planned·active·complete`) + the issue→sprint association (`workItem.sprintId` or a ' +
        'join — whatever 4.1 ships); Story **4.3** provides the story-point field on issues. Both are ' +
        'unexpanded stubs today, so these are story-level deps; this subtask reads those fields, it ' +
        'does not define them. (When 4.1/4.3 expand, a re-plan can retarget to the exact subtasks.)\n\n' +
        "**Sprint scope.** For a board whose `type == scrum`, resolve the board's **active sprint** " +
        '(the single `state == active` sprint for the board — the 4.4 one-active-per-board guard makes ' +
        'this unambiguous; resolve via a single repository read, `SELECT … WHERE boardId/projectId AND ' +
        'state = active`). FILTER every column query to issues associated with that sprint (an extra ' +
        '`WHERE issue.sprintId = :activeSprintId` on the SAME 3.1.4 column/page/count queries — not a ' +
        'new projection path). A `type == kanban` board is **unchanged** (no sprint scope — guard the ' +
        'new branch on board type). When a scrum board has **no active sprint**, return `sprint: null` ' +
        'and empty columns (the UI renders the empty state) — never silently fall back to the unscoped ' +
        'backlog as if it were a sprint.\n\n' +
        '**`SprintSummaryDto` (drives the header — bounded aggregates).** When an active sprint ' +
        'exists, `getBoard` returns `sprint: { id, name, goal, startDate, endDate, state, ' +
        'daysRemaining, points: { committed, completed, remaining }, columnPoints: Record<columnId, ' +
        'number> }`. The point figures are **aggregate `SUM(storyPoints)` queries** scoped to the ' +
        'sprint: `committed` = all sprint issues; `completed` = sprint issues in a terminal/done ' +
        'status; `remaining` = committed − completed; `columnPoints` = the per-column point sum (a ' +
        'grouped aggregate by the column\'s mapped statuses — the Jira "sprint health" number). These ' +
        'are computed by **aggregate queries, NOT by summing the loaded card page** (a sum over the ' +
        'bounded page would undercount — the board only loads a page per column). `daysRemaining` = ' +
        'calendar days from today to `endDate`, **floored at 0** (an overdue sprint → 0, surfaced as ' +
        '"Ended" by the UI, never negative). Issues with a NULL story-point estimate contribute 0 to ' +
        'sums; if the WHOLE sprint is unestimated the UI shows "—" (the DTO still returns 0/0/0 — the ' +
        'UI decides the "—" presentation, finding-#57-style the data layer stays total).\n\n' +
        '**Pagination + swimlanes stay intact (finding #57).** Cards still page per column via the ' +
        '3.1.4 first-page + `loadColumnCards` cursor; `loadColumnCards` ALSO takes the sprint scope so ' +
        '"load more" stays sprint-filtered. The 3.3.4 `swimlaneGroupBy` + `swimlanes[]` + per-card ' +
        '`swimlaneKey` continue to work (the sprint filter composes with the lane grouping — lanes are ' +
        'computed over the scoped issue set). The projection never loads every card to total points or ' +
        'discover lanes; both are aggregates.\n\n' +
        '**4-layer + tenant gate.** The active-sprint resolution + the point aggregates are repository ' +
        'single-op reads (the SUM/grouped aggregates via `$queryRaw` where needed); the service owns ' +
        'the orchestration + DTO mapping (mapper in `lib/mappers/boardMappers.ts`, DTO in ' +
        '`lib/dto/boards.ts`); the explicit application-layer `workspaceId` gate (finding #26) already ' +
        'on `getBoard` covers the new reads. No route change beyond the projection it already returns.\n\n' +
        '**Out of scope here:** any UI (4.5.3); the sprint entity / lifecycle / start-complete (Stories ' +
        '4.1/4.4); the burndown chart aggregate (Story 4.6 — only the numeric remaining is here).\n\n' +
        '## Acceptance criteria\n\n' +
        "- For a `scrum` board `getBoard` resolves the active sprint and returns columns filtered to that sprint's issues; a `kanban` board is byte-for-byte the 3.1.4 shape (no regression); a scrum board with no active sprint returns `sprint: null` + empty columns (no backlog fallback).\n" +
        '- `getBoard` returns a `SprintSummaryDto` (`id, name, goal, startDate, endDate, state, daysRemaining, points {committed, completed, remaining}, columnPoints`) when a sprint is active; `daysRemaining` is floored at 0; point figures come from SUM/grouped aggregates scoped to the sprint, NOT from the loaded card page.\n' +
        '- `loadColumnCards` (load-more) carries the sprint scope; per-column cursor pagination + the 3.3.4 swimlane grouping compose with the sprint filter; the projection never returns every card.\n' +
        '- NULL-estimate issues contribute 0 to point sums (no `NaN`); the DTO stays total (returns numbers, the UI owns the "—" presentation).\n' +
        '- Returns DTOs mapped in `lib/mappers/boardMappers.ts`; the new reads are repository single-ops; the finding-#26 `workspaceId` gate covers them.\n' +
        '- Vitest (real Postgres) covers: scrum scope (only active-sprint issues), the kanban no-op, no-active-sprint → `sprint: null`, the committed/completed/remaining + `columnPoints` aggregates (incl. an unestimated sprint → 0s), `daysRemaining` floor, and that pagination/bounding/swimlanes are preserved (no load-all).\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/boardsService.ts` `getBoard` + `loadColumnCards` + `lib/mappers/boardMappers.ts` + `lib/dto/boards.ts` (Story 3.1.4) — the projection + `BoardProjectionDto`/`BoardCardDto` this extends with `sprint` + the scope filter\n' +
        '- Story 3.3.4 — the `swimlaneGroupBy` + `swimlanes[]` + per-card `swimlaneKey` projection the sprint filter must compose with\n' +
        '- Story 4.1 (sprint entity + issue→sprint association) + Story 4.3 (story-point field) — the sibling Epic-4 model this reads (story-level dep; fields defined there, read here)\n' +
        '- `lib/repositories/boardRepository.ts` / `workItemRepository.ts` — where the active-sprint read + the SUM/grouped point aggregates land (single-op, `$queryRaw` for aggregates)\n' +
        '- finding #57 — bounded projection (aggregates, not load-all); finding #26 — the app-layer `workspaceId` gate; `prodect-core/CLAUDE.md` — 4-layer (service owns DTO mapping, repo single-op)',
    },
    {
      id: '4.5.3',
      title:
        'Scrum board page + sprint header UI — resolve scrum board, render sprint header + points + no-active-sprint state (reuses the 3.2/3.3 board)',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['4.5.1', '4.5.2', '3.2.6', '4.4'],
      descriptionMd:
        'Render the **Scrum variant** of the board page — the sprint header + per-column point totals ' +
        '+ the no-active-sprint empty state — drawn per `design/boards/scrum.mock.html`, **reusing the ' +
        'Story-3.2 board (columns, cards, drag-as-transition, load-more/virtualization) and the ' +
        'Story-3.3 swimlanes/WIP layer wholesale**. This is chrome + page resolution, NOT a second ' +
        'board.\n\n' +
        "**Scrum-board resolution.** The `/boards` page (3.2.2) currently renders the project's " +
        "default Kanban board. Extend it so that when the resolved board's `type == scrum` (a scrum " +
        'board provisioned by Story 4.1/4.4) it renders the Scrum variant; a `kanban` board renders ' +
        'exactly as today. Which board is resolved when a project has both is a board-nav concern ' +
        "(out of scope — see story Out-of-scope, Story 3.7); 4.5 keys purely off the resolved board's " +
        '`type`. No new navigation wiring (the "Boards" nav + ⌘K entry already point at `/boards`, ' +
        'Story 1.5).\n\n' +
        '**Sprint header.** Above the reused board, render the header from the 4.5.2 `SprintSummaryDto`: ' +
        'sprint **name** + state `Pill`, the **goal** (one line, `Tooltip`/reveal for the full text), ' +
        'the **date range** + **time remaining** ("5 days remaining" / "Ends Jun 14" / "Ended" when ' +
        '`daysRemaining == 0` and past `endDate`), and the **points summary** (committed / completed / ' +
        'remaining as labelled numbers; "—" when the sprint is unestimated). Text+number always, never ' +
        'colour alone (finding #35). The header is a labelled landmark. **Per-column point totals** ' +
        'render the `columnPoints` value as the "sprint health" pill in each reused column header (the ' +
        '3.2.1/3.3 header slots), without crowding the count badge + WIP slot.\n\n' +
        '**Complete-sprint entry point (reuse 4.4, do NOT rebuild).** Mount the complete-sprint button ' +
        'in the header. The complete-sprint FLOW (confirm modal + carry-over + sprint report) is Story ' +
        '**4.4**: if 4.4 exposes a mountable trigger/action, 4.5 mounts it; otherwise 4.5 renders the ' +
        'button as a seam 4.4 wires (the 3.2 Epic-6 Filter-seam pattern). 4.5 does NOT implement ' +
        'carry-over or the report.\n\n' +
        '**No-active-sprint empty state.** When the projection returns `sprint: null` for a scrum ' +
        'board, render an `EmptyState` in place of the board — "No active sprint", a one-line ' +
        'explainer, and a CTA linking to the **Backlog** (Story 4.2 route) to plan/start one (4.5 does ' +
        'NOT start a sprint — that\'s 4.2/4.4). This is visually distinct from the 3.2.6 "No issues" ' +
        'empty-board state. Loading reuses the 3.2.2 board scaffold (header skeleton + column ' +
        'skeletons); error reuses the 3.2.2 `ErrorState`.\n\n' +
        '**Reuse, not rebuild (load-bearing).** Render the SAME `BoardColumn`/`BoardCard`, the SAME ' +
        'dnd-kit `DndContext` + drop handler (drag is still a workflow transition — unchanged), the ' +
        'SAME 3.2.5 load-more/virtualization, and the SAME 3.3 group-by + swimlanes + WIP — fed the ' +
        '4.5.2 sprint-scoped projection. Swimlanes/WIP work on the scrum board for free because it is ' +
        'the same component. The only net-new components are `SprintHeader` + the scrum no-sprint state ' +
        '+ the page-level type resolution.\n\n' +
        '**Out of scope here:** the projection/aggregates (4.5.2); the sprint lifecycle + complete-' +
        'sprint flow (4.4); the burndown chart (4.6 — the header shows numeric remaining + leaves a ' +
        'seam); board CRUD / multi-board nav (**Story 3.7**).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `/boards` renders the Scrum variant when the resolved board `type == scrum` and the existing Kanban view when `type == kanban` (no regression); no new navigation wiring.\n' +
        '- The sprint header renders name + state pill + goal (with reveal) + date range + time remaining ("Ended" at `daysRemaining == 0` past `endDate`) + committed/completed/remaining points ("—" when unestimated), as a labelled landmark, text+number not colour-alone (finding #35); per-column point totals render in the reused column headers without crowding the count/WIP slots.\n' +
        '- The complete-sprint entry point is mounted in the header and REUSES the Story-4.4 flow (or is a 4.4-wired seam); 4.5 does NOT implement carry-over/report.\n' +
        '- A scrum board with no active sprint shows the "No active sprint" `EmptyState` (CTA → Backlog), distinct from the 3.2.6 no-issues state; loading/error reuse the 3.2.2 scaffold/`ErrorState`.\n' +
        '- The board body, drag-as-transition, load-more/virtualization, and swimlanes/WIP are the REUSED 3.2/3.3 components fed the sprint-scoped projection — not reimplemented; a card move still transitions status and does not change the sprint.\n' +
        '- Colours via `--el-*`, shape via element tokens, AA-safe; matches `design/boards/scrum.mock.html`.\n' +
        '- Component tests assert the type-resolution (scrum vs kanban), the header render (incl. "Ended" + "—" + points), the per-column point pill, and the no-active-sprint empty state.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/page.tsx` + `app/(authed)/boards/_components/*` (Stories 3.2.2–3.2.6) — the board page + container/`BoardColumn`/`BoardCard`/dnd-kit/load-more to extend (resolve by `type`, mount the header), NOT fork\n' +
        '- `app/(authed)/boards/_components/*` swimlane/WIP additions (Story 3.3.5/3.3.6) — the group-by + WIP layer that composes on the scrum board unchanged\n' +
        '- Story 4.5.2 — the `sprint` + `columnPoints` + sprint-scoped projection this binds to; Story 4.4 — the complete-sprint flow the header reuses; Story 4.2 — the Backlog route the empty-state CTA links to\n' +
        '- `components/ui/*` (`Pill`, `Tooltip`, `EmptyState`, `ErrorState`, `Button`) + `design/boards/scrum.mock.html` + design-notes (4.5.1) — the header/state spec\n' +
        '- finding #35 (not colour-alone), #54 (use the palette); `prodect-core/CLAUDE.md` — `--el-*` + element-shape rules (client UI)',
    },
    {
      id: '4.5.4',
      title:
        'Story tests — sprint-scope projection + sprint summary + header + no-active-sprint (component + focused E2E)',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['4.5.2', '4.5.3'],
      descriptionMd:
        'The closing test subtask for the scrum board — the same split Stories 3.1.7 / 3.2.7 / 3.3.7 ' +
        'used: this story ships its OWN component/unit tests + a focused scrum E2E, while the cross-' +
        'cutting Epic-3 journey (drag + WIP + swimlanes AT SCALE) lives in the Epic-3 test story 3.5 ' +
        "(the at-scale Scrum integration may live in Epic 4's test story 4.7 — the closing test " +
        'story shipped with 4.7 calls that). The 3.1 API + 3.2/3.3 board are already proven; this ' +
        'proves the sprint-scope + header layer on top.\n\n' +
        '**Component / unit (vitest, real Postgres where DB-touching).** The 4.5.2 projection: scrum ' +
        'scope (only active-sprint issues), the kanban no-op (unchanged), no-active-sprint → ' +
        '`sprint: null`, the `SprintSummaryDto` aggregates (committed/completed/remaining + ' +
        '`columnPoints` from SUM/grouped queries, an unestimated sprint → 0s, `daysRemaining` floored ' +
        'at 0), and that pagination/bounding/swimlane grouping are preserved with the sprint filter ' +
        '(no load-all) — may overlap 4.5.2, keep the integration assertions here. The 4.5.3 header: ' +
        'render of name/goal/dates/time-remaining ("Ended" + normal), the points summary incl. the ' +
        '"—" unestimated presentation, the per-column point pill, and the no-active-sprint empty-state ' +
        'render + Backlog CTA.\n\n' +
        '**E2E (Playwright) `tests/e2e/board-scrum.spec.ts`.** Against a freshly seeded project with a ' +
        'scrum board + an active sprint with points (seed/DB-set the active sprint state for the test ' +
        '— the lifecycle UI is 4.4):\n' +
        '- **Header** — the sprint header shows name/goal, the date range + time remaining, and the ' +
        'committed/completed/remaining points.\n' +
        "- **Scope** — only the active sprint's issues appear on the board; an issue not in the sprint " +
        'is absent; per-column point totals render.\n' +
        '- **Move contract** — moving a card still transitions its status (3.2 contract) and leaves ' +
        'its sprint unchanged.\n' +
        '- **No active sprint** — with the sprint completed/none, the board area shows "No active ' +
        'sprint" with the Backlog CTA, not an empty six-column board.\n\n' +
        'Defers to Story 3.5 (Epic 3) / 4.7 (Epic 4): the combined drag + WIP + swimlanes + scrum ' +
        "journey at scale and the large-active-sprint board/virtualization E2E (this story's scale " +
        'proof is the 4.5.2 acceptance checks against `db:seed:large`).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` covers the projection (scrum scope, kanban no-op, no-active-sprint, the point aggregates incl. unestimated → 0s, `daysRemaining` floor, bounded/paged/swimlane preserved) and the header/empty-state render (incl. "Ended", "—", per-column pill, Backlog CTA).\n' +
        '- `pnpm test:e2e --grep board-scrum` runs green over the real stack, asserting: the sprint header (name/goal/dates/remaining + points), sprint scope (only sprint issues + per-column totals), the unchanged move contract (status transitions, sprint unchanged), and the no-active-sprint empty state with the Backlog CTA.\n' +
        '- The E2E reuses the real-Postgres harness (`tests/helpers/db.ts` truncation) and the seeded project (active sprint state set in the fixture, since the lifecycle UI is Story 4.4); it does NOT duplicate the at-scale combined journey (Stories 3.5 / 4.7).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/board-ui.spec.ts` (3.2.7) + `tests/e2e/board-swimlanes.spec.ts` (3.3.7) — the board E2Es this builds the scrum layer on; `tests/e2e/board-projection.spec.ts` (3.1.7) — the projection E2E precedent\n' +
        '- `tests/helpers/db.ts` — real-Postgres truncation; the fixture pattern for setting an active sprint + points directly (the lifecycle UI is Story 4.4)\n' +
        '- Story 4.5.2 (projection) + 4.5.3 (header/page) — the units under test; Stories 3.5 / 4.7 — the test stories this defers the at-scale combined journey to\n' +
        '- `prodect-core/CLAUDE.md` — test conventions (real Postgres, no mocks, single `getSession` mock)',
    },
  ],
};
