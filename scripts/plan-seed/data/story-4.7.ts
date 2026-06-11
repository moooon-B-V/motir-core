import type { PlanStory } from '../types';

/**
 * Story 4.7 — Tests: the cross-cutting AT-SCALE Scrum journey (the Scrum
 * analogue of Story 3.5 for Kanban).
 *
 * The one Epic-4 test story that no single sprint/board story can own: the
 * COMBINED sprint-scoped board journey — bounded sprint-scoped load →
 * virtualized render → drag-as-transition → swimlanes → WIP → complete-sprint
 * carry-over → report — exercised against a LARGE ACTIVE SPRINT. Every per-story
 * test subtask in Epic 4 explicitly defers this here: 4.5.4 ("the at-scale Scrum
 * integration may live in Epic 4's test story 4.7"; "Defers to Story 3.5 (Epic 3)
 * / 4.7 (Epic 4): the combined drag + WIP + swimlanes + scrum journey at scale"),
 * 4.4.7 ("The at-scale combined Scrum journey … is **Story 4.7's**, not duplicated
 * here"), 4.2.6 ("the at-scale Scrum journey is Stories 4.5.4 / 4.7, not here"),
 * and Story 3.5 itself scopes the Scrum-at-scale OUT ("the sprint-scoped Scrum
 * view … 4.5.4 sends its at-scale journey to 4.7 (Epic 4), NOT here — putting a
 * Scrum-at-scale spec in 3.5 would create a forward-pointing cross-epic dependency
 * on Epic 4, mistake #32"). 4.7 is where those deferrals land.
 *
 * Re-scope note (deepening, 2026-06-09). The stub framed 4.7 as "Vitest over the
 * sprint state machine + point roll-ups + carry-over; Playwright over plan → start
 * → move cards → complete; also owns the at-scale combined Scrum journey" — written
 * when 4.7 was the ONLY Epic-4 test story. Since then EVERY Epic-4 story grew its
 * own closing test subtask, each owning the per-method Vitest + a focused
 * single-surface E2E for its own surface: 4.1.5 (sprint entity + guard + bounded
 * reads), 4.2.6 (backlog groom/rank/assign + Start entry point), 4.3.7 (estimate
 * write + config + bounded sprint/epic roll-ups incl. the statistic switch + the
 * estimate-a-story E2E), 4.4.7 (the sprint lifecycle state machine + the focused
 * plan→start→move→complete→report E2E), 4.5.4 (sprint-scope projection + summary +
 * header + no-active-sprint). And Story 4.6 (velocity + burndown charts) will ship
 * its own closing test subtask when it expands. So — exactly as Story 3.5 was
 * re-scoped against its per-story siblings — 4.7 is scoped to the NON-duplicative
 * remainder: the cross-cutting journey AT SCALE that spans all of them and that
 * each one defers here. It does NOT re-test what an owning story already covers in
 * isolation (the sprint state machine is 4.4.7's; the roll-ups are 4.3.7's; the
 * chart math is 4.6's own future test subtask's; the focused single-sprint
 * lifecycle E2E is 4.4.7's).
 *
 * ⚠️ It MUST reflect the FINAL load model — Story 3.8, scoped to the active sprint
 * — not the per-column cursor shape the Scrum projection prose (4.5.2) still
 * describes. Story 3.8 corrected the board to the mirror-faithful Jira model: load
 * the whole filtered set BOUNDED by `BOARD_ISSUE_CAP` (5,000), virtualize the
 * render (`useRowWindow`), window terminal columns to `DONE_AGE_WINDOW_DAYS` (14
 * days), and warn with the over-cap "refine your filter" banner past the cap — and
 * RETIRED the per-column cursor + "Load more" affordance entirely. The Scrum board
 * (4.5) is the SAME `getBoard` projection scoped to its active sprint, so it
 * inherits that load model with the sprint filter composed in. So 4.7's at-scale
 * specs assert there is NO per-column "Load more" anywhere on the Scrum board (flat
 * or swimlane), the over-cap banner appears when the active sprint exceeds the cap,
 * and the Done-age window trims the Done column — the sprint-scoped analogue of
 * Story 3.5's mandate. (Finding: 4.5.2's prose still names the retired
 * `loadColumnCards` cursor; the Scrum board ships on the post-3.8 `getBoard`, so it
 * is cursor-free — 4.7 asserts the cursor-free shape and would catch a regression.)
 *
 * The fixture gap (why 4.7.1 exists). The at-scale Scrum journey needs a LARGE
 * ACTIVE SPRINT — a sprint-shaped large dataset — and neither the tree/list seed
 * (`db:seed:large`, 2.5.16) nor the board-shaped seed (`seedLargeBoard`, 3.5.1)
 * builds one. 3.5.1's board-shaped seed spreads issues across columns / assignees /
 * priorities / epics / Done-age, but its issues are NOT associated with a sprint,
 * so a Scrum board over it shows "no active sprint" (the 4.5.2 scope returns
 * `sprint: null` + empty columns). 4.7.1 closes the gap: it extends the
 * board-shaped seed with a SPRINT dimension — an `active` sprint holding a large
 * bounded set of the board-shaped issues, with a story-point spread (so the header
 * committed/completed/remaining + per-column point pills are at scale) and a
 * planned carry-over target sprint — reusing the 3.5.1 cap/Done-age env seam so the
 * over-cap and Done-age states stay reachable cheaply. It is test infrastructure (a
 * dev seed extension + e2e helpers), not a UI change — so the design gate does NOT
 * fire (every surface under test was already designed: `design/boards/board.mock.html`
 * 3.2.1, `swimlanes-wip.mock.html` 3.3.1, `board-scale.mock.html` 3.8.1,
 * `scrum.mock.html` 4.5.1, `sprints/sprint-lifecycle.mock.html` 4.4.1).
 *
 * Cross-epic dependency audit (mistake #32). Every leaf below points BACKWARD or
 * same-epic: 4.7.1 → 3.5.1 / 4.1 / 4.3.3; 4.7.2 → 4.7.1 / 4.5.2 / 4.5.3; 4.7.3 →
 * 4.7.1 / 4.5.2 / 4.5.3 / 4.4.3 / 4.4.4 / 4.4.6 / 3.2.4 / 3.3.5 / 3.3.6. All ids
 * are epic ≤ 4 — no forward-pointing cross-epic dependency.
 */
export const story_4_7: PlanStory = {
  id: '4.7',
  title:
    'Tests — the cross-cutting Scrum journey at scale (sprint-scoped load · drag · swimlanes · WIP · complete + carry-over)',
  status: 'done',
  descriptionMd:
    'The Epic-4 **integration** test story: the COMBINED Scrum journey — bounded sprint-scoped load ' +
    '→ virtualized render → drag-as-transition → swimlanes → WIP → complete-sprint carry-over → ' +
    'report — exercised end-to-end against a **large active sprint**, the cross-cutting case every ' +
    'per-story Epic-4 test explicitly defers here. It is the Scrum analogue of Story 3.5 (the ' +
    'at-scale Kanban journey).\n\n' +
    '**Why a separate story (not more per-story tests).** Each Epic-4 story already ships its own ' +
    'closing test subtask covering its surface in isolation: 4.1.5 (sprint entity + one-active guard ' +
    '+ bounded reads), 4.2.6 (backlog groom/rank/assign + the Start entry point), 4.3.7 (estimate ' +
    'write + config + bounded sprint/epic roll-ups + the statistic switch + estimate-a-story E2E), ' +
    '4.4.7 (the sprint lifecycle state machine — start/complete/carry-over/provisioning/report — + a ' +
    'focused plan→start→move→complete→report E2E), 4.5.4 (sprint-scope projection + summary + header ' +
    '+ no-active-sprint), and Story 4.6 will own its own chart tests when it expands. What NONE of ' +
    'them owns — and each one **defers to 4.7 by name** — is the *combined* journey **at real-team ' +
    'scale**, where virtualization, the over-cap bound, the Done-age window, the sprint scope, the ' +
    'interaction surfaces, and the complete-sprint carry-over all have to hold at once on a large ' +
    'active sprint. That is this story, and only that; it does not re-test what an owning story ' +
    'already proves with a handful of rows.\n\n' +
    '**It MUST reflect the Story-3.8 load model, scoped to the sprint (the headline mandate).** The ' +
    'Scrum board is the SAME `getBoard` projection (4.5.2) scoped to its active sprint, so it ' +
    'inherits the post-3.8 model: the board loads its sprint-scoped set **bounded by ' +
    '`BOARD_ISSUE_CAP`** (5,000), **virtualizes** the render via `useRowWindow`, **windows terminal ' +
    'columns** to `DONE_AGE_WINDOW_DAYS` (14 days), and shows the **over-cap "refine your filter" ' +
    'banner** (`OverCapBanner`, `truncated === true`) past the cap — with NO per-column "Load more" ' +
    'anywhere. 4.7\'s at-scale specs assert exactly this shape on the Scrum board (no "Load more" ' +
    'flat OR in swimlanes; the over-cap banner present past the cap and absent under it; the ' +
    'Done-age window trimming the Done column with the full count on the badge) — never a retired ' +
    "cursor. (4.5.2's prose still names the retired `loadColumnCards` cursor; the Scrum board ships " +
    'on the cursor-free post-3.8 `getBoard`, so 4.7 asserts the cursor-free shape and would catch a ' +
    'regression — finding-grade, surfaced in the header comment.)\n\n' +
    '**The fixture + seam this story builds first (4.7.1).** The at-scale Scrum journey needs a ' +
    '**large active sprint** and a cheap way to reach the over-cap / Done-age states. The ' +
    'board-shaped large seed (`seedLargeBoard`, 3.5.1) spreads issues across columns / assignees / ' +
    'priorities / epics / Done-age but does NOT associate them with a sprint, so a Scrum board over ' +
    'it shows "no active sprint". So 4.7.1 ships a **sprint-shaped large seed** (a new ' +
    '`SEED_SHAPE=scrum` mode that builds the board-shaped distribution AND associates a large ' +
    'bounded set of it with an `active` sprint, with a story-point spread + a planned carry-over ' +
    'target sprint) and reuses the **test-only, production-inert env seam** over the cap + Done-age ' +
    'window (3.5.1) so the banner and the Done-age trim are reachable with tens — not thousands — of ' +
    'rows. The journey specs (4.7.2 load model + scope + header, 4.7.3 interaction + complete) build ' +
    'on that harness.\n\n' +
    '**Out of scope.** The **Kanban** at-scale journey (Story 3.5 — done); the per-surface unit ' +
    'coverage owned by 4.1.5 / 4.2.6 / 4.3.7 / 4.4.7 / 4.5.4 (the sprint state machine, the roll-up ' +
    'math, the projection units — consumed here, not re-tested); the **velocity + burndown chart** ' +
    'math + render (Story 4.6 — its own future closing test subtask; 4.7 asserts only the numeric ' +
    'sprint-health figures the header already shows, never the chart series); the focused ' +
    'single-sprint lifecycle E2E (Story 4.4.7 — 4.7 runs the AT-SCALE version of that journey, with ' +
    'a large carry-over). 4.7 is the cross-cutting E2E layer over the real stack; per-method unit ' +
    'coverage stays in the owning stories.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma generate` (NO migration — pure tests + a ' +
    'dev seed extension + the reused test-only env seam over the Story-3.8/4.5 schema/services).\n' +
    '- `SEED_SHAPE=scrum pnpm db:seed:large` (the sprint-shaped variant from 4.7.1) seeds the `BIG` ' +
    "project so it has a large `active` sprint; sign in as the seed owner and open the project's " +
    'Scrum board to eyeball it (thousands of sprint cards across the columns, columns scroll ' +
    'smoothly, the sprint header shows committed/completed/remaining points, no "Load more" ' +
    'anywhere).\n' +
    '- `pnpm test` — the at-scale fixture/harness unit checks from 4.7.1 (the sprint-shaped seed ' +
    'produces the documented active-sprint / column / lane / Done-age / point distribution; the cap ' +
    '+ Done-age env seam flexes under the test env and falls back to the shipped 5,000 / 14 ' +
    'constants when unset).\n' +
    '- `pnpm test:e2e --grep board-scrum-at-scale` — Playwright over the real stack against the ' +
    'sprint-shaped large seed:\n' +
    "  - **Load model + scope + header (4.7.2):** the Scrum board renders ONLY the active sprint's " +
    'issues, the whole bounded set with NO per-column "Load more" (flat AND swimlane); scrolling a ' +
    'tall column keeps the rendered DOM bounded (virtualization); with the cap lowered below the ' +
    'seeded sprint total the **over-cap "refine your filter" banner** shows (and is absent when ' +
    'under the cap); the **Done column** shows only issues resolved inside the Done-age window while ' +
    'its count badge shows the full total; the **sprint header** shows committed/completed/remaining ' +
    'points + per-column point pills computed from aggregates (not page sums); a project with the ' +
    'sprint completed shows the **no-active-sprint** empty state + Backlog CTA, not an empty board.\n' +
    '  - **Interaction + complete at scale (4.7.3):** drag a card across columns deep in a ' +
    'virtualized sprint column → the transition applies (optimistic, reconciled) and the card stays ' +
    'in the sprint; an illegal cross-column move **snaps back** (409); switch **group-by** to ' +
    'Assignee/Epic/Priority → the sprint board re-lays into many lanes + catch-all (still bounded, ' +
    'still no "Load more"); a **cross-lane** drag reassigns the grouped field (sprint + status ' +
    'unchanged); a column **over its WIP limit** shows the soft `n/limit` warning yet **still ' +
    'accepts** the drop; then **Complete sprint** with a large set of unfinished issues moves them ' +
    'all to the backlog (or a planned sprint) in ONE bounded transaction and shows the sprint ' +
    'report (committed/completed points + scope-change from aggregates, lists paginated — not a ' +
    'dump).\n' +
    '- All of the above reuse the real-Postgres + Playwright harness (`tests/helpers/db.ts`, ' +
    '`tests/e2e/_helpers/{db-reset,board,workflow,shell-session}.ts` + the 3.5.1 at-scale helpers) ' +
    'and DO NOT duplicate the single-surface journeys owned by 4.4.7 / 4.5.4 or the Kanban-at-scale ' +
    'journey owned by 3.5.',
  items: [
    {
      id: '4.7.1',
      title: 'At-scale Scrum fixture — sprint-shaped large seed (active sprint + points) + helpers',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['3.5.1', '4.1', '4.3.3'],
      descriptionMd:
        'The harness the two journey specs build on — a **sprint-shaped large dataset** (a large ' +
        '`active` sprint holding board-shaped issues with a point spread) plus the **reused ' +
        'test-only env seam** over the load-model bounds, so the at-scale Scrum states are reachable ' +
        'deterministically and cheaply. Test infrastructure only (a dev seed extension + e2e ' +
        'helpers) — it changes NO UI, so the design gate does not fire.\n\n' +
        '**Sprint-shaped large seed.** `seedLargeBoard` (3.5.1, `scripts/seedLargeBoard.ts`, driven ' +
        'by `SEED_SHAPE=board`) spreads issues across every status (column), many assignees, every ' +
        'priority, several epics, and a Done-age spread — but its issues are NOT associated with a ' +
        'sprint, so the Scrum projection (4.5.2) returns `sprint: null` over it. Add a ' +
        '`SEED_SHAPE=scrum` mode (a sibling `seedLargeScrumSprint` the script calls, composing the ' +
        'existing board-shaped distribution — keep it idempotent + service-routed like the original, ' +
        'NO raw inserts that skip the kind-parent triggers) that, on top of the board-shaped spread, ' +
        '(a) creates an **`active` sprint** in the `BIG` project (via the shipped sprint service/repo ' +
        'from Story 4.1 — start it, or DB-set `state=active` + the window in the fixture the way ' +
        '4.5.4 sets active-sprint state directly, since the lifecycle UI is Story 4.4); (b) ' +
        '**associates a large bounded set** of the board-shaped issues with that sprint (`sprintId`) ' +
        'so the Scrum board is at scale — spanning every column (incl. the tall one), every group-by ' +
        'lane, and the Done-age spread; (c) leaves a slice of issues OUTSIDE the sprint (still in the ' +
        'backlog) so a scope test can assert they are absent from the Scrum board; (d) gives the ' +
        'sprint issues a **story-point spread** (`storyPoints` via the 4.3.3 field — some estimated, ' +
        'some NULL) so the header committed/completed/remaining + per-column point pills are at scale ' +
        'and the unestimated-→0 path is covered; and (e) creates a **planned** carry-over target ' +
        'sprint in the same project (the 4.7.3 complete-with-carry-over journey needs a non-backlog ' +
        'target). Tunable via the existing `SEED_*` envs (e.g. `SEED_SPRINT_ISSUE_COUNT`).\n\n' +
        '**Cap + Done-age test seam (reused).** The `BOARD_ISSUE_CAP` (5,000) / `DONE_AGE_WINDOW_DAYS` ' +
        '(14) env seam already exists from 3.5.1 (resolved at the `boardsService` boundary, falling ' +
        'back to the shipped constants when unset, wired only into the Playwright `webServer` / ' +
        'vitest env). The Scrum projection scopes the SAME `getBoard` to the sprint, so the seam ' +
        'governs the sprint-scoped board unchanged — this subtask REUSES it (no new seam), and a unit ' +
        'test confirms the unset-env default is still the shipped 5,000 / 14.\n\n' +
        '**E2E helper extensions.** Extend `tests/e2e/_helpers/board.ts` (the 3.5.1 at-scale helpers) ' +
        'with the Scrum-specific helpers the journey specs need (sign in as the sprint-seed owner, ' +
        "open the project's Scrum board, read the sprint header points + per-column point pill, " +
        "assert an issue is/ isn't in the active sprint scope) — additive, no change to the existing " +
        '3.5.1/4.5.4 helpers.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `SEED_SHAPE=scrum pnpm db:seed:large` seeds the `BIG` project with a large `active` ' +
        'sprint whose issues span every column (one tall enough to virtualize), every group-by lane ' +
        '+ catch-all, a Done-age spread in the terminal column, and a story-point spread (some NULL); ' +
        'a slice of issues stays OUTSIDE the sprint; a **planned** carry-over target sprint exists in ' +
        'the same project. Idempotent + routed through the shipped sprint/work-item services (no raw ' +
        'inserts), refusing to run under `NODE_ENV=production` like the original.\n' +
        '- The fixture REUSES the 3.5.1 cap + Done-age env seam (no new seam); a vitest test asserts ' +
        'the unset-env default still equals the shipped `BOARD_ISSUE_CAP` (5,000) / ' +
        '`DONE_AGE_WINDOW_DAYS` (14) (no production behaviour change).\n' +
        '- `tests/e2e/_helpers/board.ts` gains the Scrum at-scale helpers (sprint-seed sign-in, ' +
        'Scrum-board open, sprint-header points read, in-sprint-scope assertion) without altering the ' +
        'existing helpers; a focused vitest asserts the sprint-shaped seed yields the documented ' +
        'active-sprint / column / lane / Done-age / point distribution and that the Scrum projection ' +
        '(`getBoard`) over it returns the sprint summary + the scoped set.\n' +
        '- No migration, no UI change, no new product surface — dev seed extension + reused seam + ' +
        'test helpers only.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/seedLargeBoard.ts` (3.5.1) + `scripts/seed-large.ts` (`SEED_SHAPE` switch, ' +
        '2.5.16/3.5.1) — the board-shaped seed + its `SEED_*` knobs + idempotent service-routed ' +
        'pattern to extend with the sprint dimension\n' +
        '- `lib/services/sprintsService.ts` + `lib/repositories/sprintRepository.ts` (Story 4.1 — ' +
        'sprint entity + issue→sprint association) + the `workItem.sprintId` field; `storyPoints` ' +
        '(4.3.3) — the model the seed associates + estimates\n' +
        '- `lib/services/boardsService.ts` — `BOARD_ISSUE_CAP` / `DONE_AGE_WINDOW_DAYS` / the 3.5.1 ' +
        'env seam + the 4.5.2 scrum-scoped `getBoard` the seed feeds\n' +
        '- `tests/e2e/_helpers/board.ts` (3.5.1 at-scale helpers) + `tests/e2e/_helpers/{workflow,' +
        'shell-session,db-reset}.ts`; `tests/helpers/db.ts`; `motir-core/CLAUDE.md` (real Postgres, ' +
        'no mocks, service-routed seeds)',
    },
    {
      id: '4.7.2',
      title:
        'At-scale Scrum load-model + scope + header E2E — sprint-scoped bounded load, virtualization, over-cap banner, Done-age window, header points',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['4.7.1', '4.5.2', '4.5.3'],
      descriptionMd:
        'The Playwright spec (`tests/e2e/board-scrum-at-scale.spec.ts`) that proves the **Story-3.8 ' +
        'load model holds on the Scrum board at scale, scoped to the active sprint** — the ' +
        'sprint-scoped analogue of Story 3.5.2. Runs against the sprint-shaped large seed (4.7.1) ' +
        'over the real stack.\n\n' +
        "**Sprint scope at scale.** Open the `BIG` project's Scrum board: every rendered card " +
        'belongs to the active sprint; an issue left OUTSIDE the sprint (4.7.1 slice) is **absent** ' +
        'from the board — assert the scope filter (4.5.2) holds over a large set, never falling back ' +
        'to the unscoped backlog.\n\n' +
        '**Bounded whole-set load, no "Load more" (flat).** The sprint-scoped columns render their ' +
        'cards with NO per-column "Load more" button and NO scroll-sentinel footer anywhere (the ' +
        '3.8.3 retirement the Scrum board inherits) — assert the affordance is absent flat AND in ' +
        "swimlanes. Each column's count badge shows its full sprint-scoped `totalCount`.\n\n" +
        '**Virtualization keeps the DOM bounded.** A tall sprint column (seeded past the row window) ' +
        'renders far fewer card DOM nodes than its total; scrolling reveals later cards while the ' +
        'rendered node count stays bounded (`useRowWindow`) — assert rendered-count ≪ total, and that ' +
        'a card deep in the list becomes reachable by scrolling (not by paging).\n\n' +
        '**Over-cap "refine your filter" banner.** With the cap lowered below the seeded sprint total ' +
        '(the 4.7.1/3.5.1 env seam), the `OverCapBanner` shows above the Scrum board — text names the ' +
        'cap, paired with the alert-triangle (not colour-alone, finding #35), `role="status"` — for ' +
        'both flat AND swimlane layouts. Raise the cap above the total: the banner is absent ' +
        '(`truncated === false`).\n\n' +
        '**Done-age window.** The terminal (Done) column shows only issues resolved within the ' +
        'Done-age window (the seed places some inside, some outside); older resolved issues are ' +
        'absent from the rendered column while the count badge shows the full total. Shrinking the ' +
        'window via the seam trims more — proving the window is age-based (3.8.2), not count-based.\n\n' +
        '**Sprint header at scale (bounded aggregates, not page sums).** The `SprintHeader` (4.5.3) ' +
        'shows name/goal/dates/time-remaining and the **committed/completed/remaining** points + the ' +
        'per-column point pills (4.5.2 `SprintSummaryDto` / `columnPoints`). Assert these come from ' +
        "the aggregate queries and reflect the WHOLE sprint (they exceed any single loaded page's " +
        'sum), that NULL-estimate issues contribute 0 (no `NaN`), and that an overdue sprint shows ' +
        '"Ended" (`daysRemaining` floored at 0).\n\n' +
        '**No active sprint.** Against a project whose sprint is completed/none, the Scrum board area ' +
        'shows the **"No active sprint"** empty state + the Backlog CTA, not an empty six-column ' +
        'board (the 4.5.2 `sprint: null` path) — proven once here at the integration layer.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e --grep board-scrum-at-scale` (this spec) is green: against the ' +
        'sprint-shaped large seed, the Scrum board renders ONLY active-sprint issues (an ' +
        'out-of-sprint issue is absent), loads the whole bounded set with NO "Load more"/sentinel ' +
        '(flat + swimlane), and a tall column renders a bounded DOM node count that grows by ' +
        'scrolling (not paging).\n' +
        '- The over-cap "refine your filter" banner shows above the Scrum board (flat AND swimlane) ' +
        'when the seeded sprint total exceeds the (lowered) cap and is absent when under it; it pairs ' +
        'hue with the alert-triangle + copy (not colour-alone) and is announced (`role="status"`).\n' +
        '- The Done column shows only issues resolved inside the Done-age window while its count badge ' +
        'shows the full total; shrinking the window trims more (age-based, not count-based).\n' +
        '- The sprint header shows committed/completed/remaining points + per-column pills from ' +
        'bounded aggregates (exceeding a single page sum), NULL estimates contribute 0, and an ' +
        'overdue sprint shows "Ended"; the no-active-sprint empty state + Backlog CTA renders for a ' +
        'completed/none sprint.\n' +
        '- The spec asserts NO per-column cursor/"Load more" affordance or route call anywhere on the ' +
        'Scrum board; reuses the 4.7.1 helpers + the real-Postgres/Playwright harness; does NOT ' +
        "duplicate 4.5.4's small-scale scrum E2E or 3.5.2's Kanban load-model spec.\n\n" +
        '## Context refs\n\n' +
        '- Story 4.7.1 — the sprint-shaped large seed + reused cap/Done-age seam + Scrum at-scale ' +
        'helpers this consumes\n' +
        '- `app/(authed)/boards/_components/{BoardContainer,BoardColumn,SwimlaneBoard,LaneCell,OverCapBanner}.tsx` ' +
        '(3.8.3/3.8.4/3.8.5) + the `SprintHeader` (4.5.3) + `components/ui/useRowWindow.ts` — the ' +
        'surfaces under test\n' +
        '- `lib/services/boardsService.ts` (`getBoard` scrum scope + `cap`/`truncated`/Done-age + the ' +
        '`SprintSummaryDto`/`columnPoints` aggregates, 4.5.2) + `lib/dto/boards.ts` — the load-model + ' +
        'scope + summary contract being verified\n' +
        '- `tests/e2e/board-scrum.spec.ts` (4.5.4) — the small-scale scrum E2E this extends to scale ' +
        '(do not duplicate); `tests/e2e/board-at-scale.spec.ts` (3.5.2) — the Kanban analogue pattern; ' +
        '`design/boards/{scrum,board-scale}.mock.html` (4.5.1/3.8.1) — the design under test',
    },
    {
      id: '4.7.3',
      title:
        'At-scale Scrum interaction + complete journey E2E — drag-as-transition · snap-back · swimlanes · cross-lane reassign · WIP · complete-sprint carry-over + report',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['4.7.1', '4.5.2', '4.5.3', '4.4.3', '4.4.4', '4.4.6', '3.2.4', '3.3.5', '3.3.6'],
      descriptionMd:
        'The Playwright spec (`tests/e2e/board-scrum-at-scale.spec.ts`, the interaction + lifecycle ' +
        'half) that proves the **combined Scrum journey holds at scale** — the deferral 4.4.7 / 4.5.4 ' +
        'send here. Every interaction runs on a card inside a virtualized, bounded, sprint-scoped ' +
        'board (4.7.1 seed), so it doubles as proof that the 3.8 load model + the 4.5.2 sprint scope ' +
        'do not break the 3.2/3.3 interaction contracts, and the closing complete-sprint step proves ' +
        'the 4.4 carry-over holds over a LARGE set.\n\n' +
        '**Drag-as-transition deep in a virtualized sprint column.** Scroll a tall sprint column, ' +
        'pick a card not in the initial window, drag it to another column → the workflow transition ' +
        'applies (optimistic, then reconciled to the returned `BoardCardDto`); re-fetch / quick-view ' +
        'shows the new status and the card **stays in the sprint** (status changed, `sprintId` ' +
        'unchanged); counts + the header point figures on both columns update. Proves drag survives ' +
        'virtualization + the sprint scope (3.2.5/3.8.3 + 4.5.2).\n\n' +
        '**Illegal-move snap-back (409) at scale.** An illegal cross-column move under the ' +
        '`restricted` workflow → the card **snaps back** to its origin column and the status is ' +
        'unchanged on re-fetch (the 3.1.5 `IllegalBoardMoveError` 409 contract), even from deep in ' +
        'the list.\n\n' +
        '**Swimlanes re-lay at scale (sprint-scoped).** Switch **group-by** to Assignee → the Scrum ' +
        'board re-lays into one lane per assignee-with-cards + the "No assignee" catch-all, each lane ' +
        'still bounded + virtualized with NO "Load more" (3.8.5) and still **sprint-scoped**; switch ' +
        'to Epic (grouped by ancestor epic) and Priority and back to None. Collapse a lane → its ' +
        'cards hide, header + aggregate count remain, and the collapse persists on reload.\n\n' +
        '**Cross-lane reassign + diagonal.** Drag a card into another assignee lane → the assignee is ' +
        'reassigned (confirmed via re-fetch / quick-view), status + sprint unchanged; into "No ' +
        'assignee" → unassigned. A **diagonal** drag (different column AND different lane) applies ' +
        'BOTH the transition and the field reassign, each with independent reconcile (3.3.5) — one ' +
        'rejection does not revert the other; the card stays in the sprint throughout.\n\n' +
        "**WIP soft-warning is advisory, not blocking.** Set a column's WIP limit below its " +
        'sprint-scoped card count (the `[⋯]` menu, 3.3.6) → the header shows the `n/limit` over-limit ' +
        'warning (hue + icon/label, not colour-alone, finding #35); drag another card in → the drop ' +
        '**still succeeds** and the warning persists (soft = advisory; the 3.2.4 move contract is ' +
        'untouched). A column exactly at the limit (`n === limit`) is NOT warned (strictly greater).\n\n' +
        '**Complete-sprint with a LARGE carry-over + report (the lifecycle at scale).** With the ' +
        'large active sprint still holding many unfinished (non-done-category) issues, invoke ' +
        '**Complete sprint** (the 4.4.6 modal, from the backlog active-sprint container or the scrum ' +
        'header): the carry-over chooser offers **Backlog** and the seeded **planned** target sprint. ' +
        'Choose the planned sprint → confirm → the **whole large set** of unfinished issues moves into ' +
        'it in ONE bounded transaction (the 4.4.3 contract — assert none are left behind and the done ' +
        'issues stay on the completed sprint), and the **sprint report** (4.4.4) shows the ' +
        'completed/incomplete lists **paginated** (a bounded first page + a "view all" deep-link, ' +
        'NOT a dump of thousands — finding #57), the committed/completed/not-completed points + the ' +
        'scope-change count from **aggregates** (not page sums), and the freed one-active slot (a new ' +
        'sprint can now start). Re-run the Backlog branch on a fresh seed to assert carry-over to the ' +
        'backlog restores `backlog_rank` order over a large set.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e --grep board-scrum-at-scale` (this spec) is green: a drag-as-transition on ' +
        'a card scrolled into view deep in a virtualized sprint column applies + reconciles and keeps ' +
        'the card in the sprint; an illegal cross-column move snaps back (409) with status ' +
        'unchanged.\n' +
        '- Switching group-by (Assignee/Epic-ancestor/Priority/None) re-lays the Scrum board into ' +
        'bounded, virtualized, sprint-scoped lanes + catch-all with NO "Load more"; a collapsed lane ' +
        'stays collapsed on reload; a cross-lane drag reassigns the grouped field (status + sprint ' +
        'unchanged) and a diagonal drag applies both writes with independent reconcile.\n' +
        '- A column over its WIP limit shows the soft `n/limit` warning (not colour-alone) yet still ' +
        'ACCEPTS a dropped card (advisory, non-blocking); an at-limit column is not warned.\n' +
        '- Completing the large active sprint moves the WHOLE unfinished set into the chosen planned ' +
        'sprint (or the backlog, rank restored) in one bounded transaction (none left behind, done ' +
        'issues retained), frees the one-active slot, and renders the sprint report with PAGINATED ' +
        'lists + aggregate committed/completed/not-completed points + the scope-change count (no ' +
        'load-all, finding #57).\n' +
        '- Every interaction runs against the 4.7.1 sprint-shaped large seed (cards deep in ' +
        'virtualized, sprint-scoped lists), reuses the real-Postgres/Playwright harness + 4.7.1 ' +
        'helpers, and does NOT duplicate the single-surface journeys owned by 4.4.7 (focused ' +
        'lifecycle) / 4.5.4 (small-scale scrum) / 3.5.3 (Kanban interaction).\n\n' +
        '## Context refs\n\n' +
        '- Story 4.7.1 — the sprint-shaped large seed + at-scale helpers; Stories 4.4.7 / 4.5.4 / ' +
        '3.5.3 — the single-surface journeys this extends to the at-scale Scrum case (do not ' +
        'duplicate)\n' +
        '- `app/(authed)/boards/_components/{BoardContainer,BoardColumn,BoardCard,SwimlaneBoard,LaneCell}.tsx` ' +
        '(3.2.4 dnd-kit drag, 3.3.5 swimlanes, 3.3.6 WIP, 3.8.5 bounded swimlane render) + the ' +
        'complete-sprint modal + report view (4.4.6) — under test\n' +
        '- `lib/services/boardsService.ts` (`moveCard`, scrum scope, swimlane projection, WIP) + ' +
        '`lib/services/sprintsService.ts` (`completeSprint` carry-over 4.4.3, `getSprintReport` ' +
        '4.4.4) + `lib/boards/errors.ts` (`IllegalBoardMoveError` 409) + `lib/sprints/errors.ts` ' +
        '(`InvalidCarryOverTargetError`) — the move + reassign + complete contracts verified\n' +
        '- `tests/e2e/_helpers/board.ts` (+ 4.7.1 additions) + `tests/e2e/_helpers/workflow.ts`; ' +
        '`design/boards/{scrum,swimlanes-wip}.mock.html` (4.5.1/3.3.1) + ' +
        '`design/sprints/sprint-lifecycle.mock.html` (4.4.1) — the drag/lane/WIP/complete design ' +
        'under test',
    },
  ],
};
