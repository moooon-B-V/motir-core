import type { PlanStory } from '../types';

/**
 * Story 3.5 — Tests: the cross-cutting AT-SCALE board journey.
 *
 * The one Epic-3 test story that no single board story can own: the COMBINED
 * drag + swimlane + WIP journey exercised against a few-thousand-issue board.
 * Every per-story test subtask in Epic 3 explicitly defers this here —
 * 3.1.7 ("does NOT duplicate the Epic-3 test story (3.5), which adds the
 * drag-drop UI journey + WIP + swimlane cases once 3.2/3.3 land"), 3.2.7 / 3.3.7
 * ("Defers to Story 3.5: the combined drag + WIP + swimlane journey at scale"),
 * 3.8.6 ("Defers the at-scale combined journey to Story 3.5"), and 4.5.4 (defers
 * its at-scale journey to "Story 3.5 (Epic 3) / 4.7 (Epic 4)"). 3.5 is where
 * those deferrals land.
 *
 * ⚠️ It MUST reflect the FINAL load model — Story 3.8, not the shape 3.1/3.2/3.3
 * originally shipped. Story 3.8 corrected the board to the mirror-faithful Jira
 * model: load the whole filtered set BOUNDED by `BOARD_ISSUE_CAP` (5,000),
 * virtualize the render (`useRowWindow`), window terminal columns to the
 * `DONE_AGE_WINDOW_DAYS` (14-day) recent set, and warn with the over-cap
 * "refine your filter" banner when the cap is exceeded — and RETIRED the
 * per-column cursor + "Load more" affordance entirely. So 3.5's at-scale specs
 * assert there is NO per-column "Load more" anywhere (flat or swimlane), the
 * over-cap banner appears past the cap, and the Done-age window trims the Done
 * column — the stub's mandate verbatim.
 *
 * Re-scope note (deepening, 2026-06-08). The stub framed 3.5 as "Vitest over the
 * projection + transition validation; Playwright over drag-drop happy path +
 * illegal-move snapback + WIP warning" — written when 3.5 was the ONLY board
 * test story. Since then EVERY board story grew its own closing test subtask
 * (3.1.7, 3.2.7, 3.3.7, 3.6.4, 3.7.6, 3.8.6), each owning the per-method Vitest
 * + a focused single-story E2E for its own surface. So 3.5 is scoped to its
 * NON-duplicative remainder: the cross-cutting journey AT SCALE that spans all
 * of them and that each one defers here. It does not re-test what an owning
 * story already covers in isolation.
 *
 * The fixture gap (why 3.5.1 exists). The at-scale journey needs a board-shaped
 * large dataset and a way to surface the over-cap + Done-age states cheaply.
 * Neither exists yet: `db:seed:large` (Subtask 2.5.16, finding #57) builds a
 * tree/list-shaped ~2,000-issue tenant — it does NOT spread issues across the
 * board's statuses (columns), assignees / priorities / epics (swimlanes), or a
 * Done-age spread; and `BOARD_ISSUE_CAP` / `DONE_AGE_WINDOW_DAYS` are hardcoded
 * `export const`s (`lib/services/boardsService.ts`), so the over-cap banner
 * would need 5,000+ materialized rows to trigger. 3.5.1 closes both: a
 * board-shaped large seed + a test-only env seam over the cap/window. It is
 * test infrastructure (a dev script + a few-line, production-inert seam), not a
 * UI change — so the design gate does NOT fire (every surface under test was
 * already designed: `design/boards/board.mock.html` 3.2.1, `swimlanes-wip`
 * 3.3.1, `board-scale` 3.8.1).
 *
 * Scope OUT — the Scrum board at scale. The sprint-scoped Scrum view (Story 4.5,
 * formerly 3.4) needs sprints (Epic 4) and 4.5.4 sends its at-scale journey to
 * "4.7 (Epic 4)", NOT here — putting a Scrum-at-scale spec in 3.5 would create a
 * forward-pointing cross-epic dependency on Epic 4 (mistake #32). 3.5 covers the
 * Kanban surface + swimlanes + WIP only; every `dependsOn` below points at an
 * Epic-3 (or earlier) subtask.
 */
export const story_3_5: PlanStory = {
  id: '3.5',
  title: 'Tests — the cross-cutting board journey at scale (load model · drag · swimlanes · WIP)',
  status: 'planned',
  descriptionMd:
    'The Epic-3 **integration** test story: the COMBINED board journey — bounded load → ' +
    'virtualized render → drag-as-transition → swimlanes → WIP — exercised end-to-end against a ' +
    '**few-thousand-issue board**, the cross-cutting case every per-story board test explicitly ' +
    'defers here.\n\n' +
    '**Why a separate story (not more per-story tests).** Each board story already ships its own ' +
    'closing test subtask covering its surface in isolation: 3.1.7 (projection + move-as-transition ' +
    'over the API), 3.2.7 (board UI render + drag/snap-back + keyboard-DnD), 3.3.7 (swimlane ' +
    'grouping + cross-lane reassign + WIP soft-warning), 3.6.4 (column-config + unmapped→mapped), ' +
    '3.7.6 (board CRUD + switcher), 3.8.6 (the load-model unit + no-"Load more" assertions). What ' +
    'NONE of them owns — and each one **defers to 3.5 by name** — is the *combined* journey **at ' +
    'real-team scale**, where virtualization, the over-cap bound, the Done-age window, and the ' +
    'interaction surfaces all have to hold at once. That is this story, and only that; it does not ' +
    're-test what an owning story already proves with a handful of rows.\n\n' +
    '**It MUST reflect the Story-3.8 load model (the headline mandate).** Story 3.8 replaced the ' +
    'per-column "Load more" / cursor paging (3.1.4 / 3.2.5 / 3.3.4) with the mirror-faithful Jira ' +
    'model: the board loads its whole filtered set **bounded by `BOARD_ISSUE_CAP`** (5,000), ' +
    '**virtualizes** the render via `useRowWindow` so the DOM stays bounded, **windows terminal ' +
    'columns** to `DONE_AGE_WINDOW_DAYS` (14 days) of recently-resolved issues, and shows the ' +
    '**over-cap "refine your filter" banner** (`OverCapBanner`, `truncated === true`) past the cap ' +
    '— with NO per-column "Load more" anywhere. 3.5\'s at-scale specs assert exactly this shape ' +
    '(no "Load more" affordance flat OR in swimlanes; the over-cap banner present past the cap and ' +
    'absent under it; the Done-age window trimming the Done column with the full count still on the ' +
    'badge) — never the retired cursor paging.\n\n' +
    '**The fixture + seam this story builds first (3.5.1).** The at-scale journey needs a ' +
    'board-shaped large dataset and a cheap way to reach the over-cap / Done-age states. ' +
    '`db:seed:large` (2.5.16) only builds a tree/list-shaped tenant (it does not spread issues ' +
    "across the board's statuses, assignees, priorities, or epics), and `BOARD_ISSUE_CAP` / " +
    '`DONE_AGE_WINDOW_DAYS` are hardcoded constants. So 3.5.1 ships a **board-shaped large seed** ' +
    '(issues spread across columns + many swimlane lanes + a Done-age spread) and a **test-only, ' +
    'production-inert env seam** over the cap + window, so the banner and the Done-age trim are ' +
    'reachable with tens — not thousands — of rows. The journey specs (3.5.2 load model, 3.5.3 ' +
    'interaction) build on that harness.\n\n' +
    '**Out of scope.** The **Scrum board at scale** (sprint-scoped view, Story 4.5) is deferred to ' +
    'Epic 4 (4.7) by 4.5.4 — it needs sprints, and testing it here would point Epic 3 forward into ' +
    'Epic 4 (mistake #32). 3.5 covers the Kanban surface + swimlanes + WIP only. Per-method unit ' +
    'coverage stays in the owning stories; 3.5 is the cross-cutting E2E layer over the real stack.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma generate` (NO migration — pure tests + a ' +
    'dev seed script + a test-only env seam over the Story-3.8 schema/services).\n' +
    '- `pnpm db:seed:large` (board-shaped variant from 3.5.1) seeds the `BIG` project so the board ' +
    'is visibly at scale; sign in as the seed owner and open `/boards` to eyeball it (thousands of ' +
    'cards, columns scroll smoothly, no "Load more" anywhere).\n' +
    '- `pnpm test` — the at-scale fixture/harness unit checks from 3.5.1 (the board-shaped seed ' +
    'produces the documented column / lane / Done-age distribution; the cap + Done-age env seam ' +
    'flexes under the test env and falls back to the shipped 5,000 / 14 constants when unset).\n' +
    '- `pnpm test:e2e --grep board-at-scale` — Playwright over the real stack against the ' +
    'board-shaped large seed:\n' +
    '  - **Load model (3.5.2):** the board loads the whole bounded set with NO per-column "Load ' +
    'more" (flat AND swimlane); scrolling a tall column keeps the rendered DOM bounded ' +
    '(virtualization); with the cap lowered below the seeded total the **over-cap "refine your ' +
    'filter" banner** shows (and is absent when the total is under the cap); the **Done column** ' +
    'shows only issues resolved inside the Done-age window while its count badge shows the full ' +
    'total.\n' +
    '  - **Interaction at scale (3.5.3):** drag a card across columns deep in a virtualized list → ' +
    'the transition applies (optimistic, reconciled); an illegal cross-column move **snaps back** ' +
    '(409) with status unchanged; switch **group-by** to Assignee/Epic/Priority → the board re-lays ' +
    'into many lanes + the catch-all (still bounded, still no "Load more"); a **cross-lane** drag ' +
    'reassigns the grouped field (and a diagonal drag does both); a column **over its WIP limit** ' +
    'shows the soft `n/limit` warning yet **still accepts** the drop (advisory, not blocking).\n' +
    '- All of the above reuse the real-Postgres + Playwright harness (`tests/helpers/db.ts`, ' +
    '`tests/e2e/_helpers/{db-reset,board,workflow,shell-session}.ts`) and DO NOT duplicate the ' +
    'single-surface journeys owned by 3.1.7 / 3.2.7 / 3.3.7 / 3.6.4 / 3.7.6 / 3.8.6.',
  items: [
    {
      id: '3.5.1',
      title: 'At-scale board fixture + cap/Done-age test seam',
      status: 'in_progress',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['2.5.16', '3.3.4', '3.8.2'],
      descriptionMd:
        'The harness the two journey specs build on — a **board-shaped large dataset** plus a ' +
        '**test-only env seam** over the load-model bounds, so the at-scale board states are ' +
        'reachable deterministically and cheaply. Test infrastructure only (a dev seed script + a ' +
        'few-line, production-inert service seam) — it changes NO UI, so the design gate does not ' +
        'fire.\n\n' +
        '**Board-shaped large seed.** `db:seed:large` (Subtask 2.5.16, `scripts/seed-large.ts`) ' +
        'today builds a tree/list-shaped tenant to make finding-#57 List/Tree pagination visible — ' +
        "its issues are NOT spread across the board's statuses, assignees, priorities, or epics, so " +
        'a board over it would pile every card into one column with no lanes. Extend it (a new ' +
        '`SEED_SHAPE=board` mode, or a sibling `seedLargeBoard` the script calls — keep it ' +
        'idempotent + service-routed like the original, NO raw inserts that skip the kind-parent ' +
        "triggers) so the `BIG` project's issues spread across: every workflow **status** (so each " +
        'board **column** is populated, including a tall one for virtualization), many distinct ' +
        '**assignees** + every **priority** + several **epics** (so group-by Assignee/Epic/Priority ' +
        'each produce many lanes + a catch-all), and a **Done-age spread** in the terminal status ' +
        '(some `resolvedAt` inside the 14-day window, some well outside) so the Done-age trim is ' +
        'observable. Tunable via the existing `SEED_*` envs.\n\n' +
        '**Cap + Done-age test seam.** `BOARD_ISSUE_CAP` (5,000) and `DONE_AGE_WINDOW_DAYS` (14) are ' +
        'hardcoded `export const`s in `lib/services/boardsService.ts`; triggering the over-cap ' +
        'banner would otherwise need 5,000+ materialized rows. Add a minimal seam: resolve the cap ' +
        '(and, if useful, the Done-age window) from an env override (e.g. `BOARD_ISSUE_CAP_OVERRIDE` ' +
        '/ `DONE_AGE_WINDOW_DAYS_OVERRIDE`) **when set, falling back to the shipped constant ' +
        'otherwise** — read once at the service boundary, kept as the single source the projection ' +
        'and the `cap`/`truncated` DTO fields already use (3.8.2). The override is wired ONLY into ' +
        'the Playwright `webServer` env (`playwright.config.ts`) / the vitest setup; with the env ' +
        'unset, production behaviour is byte-for-byte the shipped 5,000 / 14 — VERIFIED by a unit ' +
        'test, so this is a test seam, not a behaviour change.\n\n' +
        '**E2E helper extensions.** Extend `tests/e2e/_helpers/board.ts` with the at-scale helpers ' +
        "the journey specs need (resolve a column's rendered card count vs. its total badge, assert " +
        'no "Load more" affordance exists, read the over-cap banner, sign in as the board-seed ' +
        'owner) — additive, no change to the existing 3.1.7/3.6.4 helpers.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm db:seed:large` (board mode) seeds the `BIG` project so its default board has every ' +
        'column populated (one tall enough to virtualize), many assignee/epic/priority lanes + a ' +
        'catch-all under each group-by, and a Done-age spread in the terminal column; idempotent ' +
        'and routed through the shipped services (no raw inserts), refusing to run under ' +
        '`NODE_ENV=production` like the original.\n' +
        '- The cap + Done-age seam reads an env override when set and **falls back to the shipped ' +
        '`BOARD_ISSUE_CAP` (5,000) / `DONE_AGE_WINDOW_DAYS` (14) when unset**, with the override ' +
        'wired only into the test `webServer` / vitest env; a vitest test asserts the unset-env ' +
        'default equals the shipped constants (no production behaviour change).\n' +
        '- `tests/e2e/_helpers/board.ts` gains the at-scale helpers (rendered-vs-total count, ' +
        '"no Load more", over-cap banner read, board-seed sign-in) without altering the existing ' +
        'helpers; a focused vitest asserts the board-shaped seed yields the documented ' +
        'column/lane/Done-age distribution.\n' +
        '- No migration, no UI change, no new product surface — dev script + service seam + test ' +
        'helpers only.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/seed-large.ts` (2.5.16, finding #57) — the existing large seed + its `SEED_*` ' +
        'env knobs + idempotent service-routed pattern to extend\n' +
        '- `lib/services/boardsService.ts` — `BOARD_ISSUE_CAP` / `DONE_AGE_WINDOW_DAYS` / ' +
        '`doneSince()` + `getBoard` (the `cap`/`truncated` projection, 3.8.2) the seam feeds\n' +
        '- `tests/e2e/_helpers/board.ts` (`getBoard` / `moveCard` / `columnByStatus` / `cardIdsIn`) ' +
        '+ `tests/e2e/_helpers/{workflow,shell-session,db-reset}.ts`; `tests/helpers/db.ts`\n' +
        '- `lib/repositories/workItemRepository.ts` (the bounded board read, 3.8.2) — the ' +
        'distribution the seed must populate; `prodect-core/CLAUDE.md` (real Postgres, no mocks)',
    },
    {
      id: '3.5.2',
      title:
        'At-scale load-model E2E — bounded load, virtualization, over-cap banner, Done-age window',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.5.1', '3.8.3', '3.8.4', '3.8.5'],
      descriptionMd:
        'The Playwright spec (`tests/e2e/board-at-scale.spec.ts`) that proves the **Story-3.8 load ' +
        "model holds at scale** — the stub's explicit mandate: \"NO per-column 'Load more'; the " +
        "board loads the filtered set + virtualizes + shows the over-cap 'refine filter' warning " +
        '+ the Done-age window (not the retired cursor paging)". Runs against the board-shaped large ' +
        'seed (3.5.1) over the real stack.\n\n' +
        '**Bounded whole-set load, no "Load more" (flat).** Open `/boards` on the `BIG` project: ' +
        'columns render their cards with NO per-column "Load more" button and NO scroll-sentinel ' +
        "footer anywhere (the 3.8.3 retirement) — assert the affordance is absent. Each column's " +
        'count badge shows its full `totalCount`.\n\n' +
        '**Virtualization keeps the DOM bounded.** A tall column (seeded past the row window) ' +
        'renders far fewer card DOM nodes than its total; scrolling it reveals later cards while the ' +
        'rendered node count stays bounded (`useRowWindow`) — assert rendered-count ≪ total, and ' +
        'that a card deep in the list becomes reachable by scrolling (not by paging).\n\n' +
        '**Over-cap "refine your filter" banner.** With the cap lowered below the seeded board total ' +
        '(the 3.5.1 env seam), the `OverCapBanner` shows above the board — text names the cap, ' +
        'paired with the alert-triangle (not colour-alone, finding #35), `role="status"` — for both ' +
        'the flat AND the swimlane layout (3.8.4). Raise the cap above the total (or seed under it): ' +
        'the banner is absent (`truncated === false`).\n\n' +
        '**Done-age window.** The terminal (Done) column shows only issues resolved within the ' +
        'Done-age window (the 3.5.1 seed places some `resolvedAt` inside and some outside); the ' +
        "older resolved issues are absent from the rendered column while the column's count badge " +
        'still reflects the full total. Shrinking the window via the 3.5.1 seam trims more — proving ' +
        'the window is age-based (3.8.2), not the retired count-based cap.\n\n' +
        '**No retired contract.** Assert the dead per-column load-more route ' +
        '(`GET /api/board/columns/[id]/cards`) is not called by the board at scale (no cursor ' +
        'paging) — the bound is the cap, the render is virtualized.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e --grep board-at-scale` (this spec) is green: against the board-shaped ' +
        'large seed, the flat board loads the whole bounded set with NO "Load more"/sentinel footer, ' +
        'and a tall column renders a bounded DOM node count that grows by scrolling (not paging).\n' +
        '- The over-cap "refine your filter" banner shows above the board (flat AND swimlane) when ' +
        'the seeded total exceeds the (lowered) cap and is absent when under it; it pairs hue with ' +
        'the alert-triangle + copy (not colour-alone) and is announced (`role="status"`).\n' +
        '- The Done column shows only issues resolved inside the Done-age window while its count ' +
        'badge shows the full total; shrinking the window (3.5.1 seam) trims more (age-based, not ' +
        'count-based).\n' +
        '- The spec asserts NO per-column cursor/"Load more" affordance or route call anywhere ' +
        '(flat or swimlane); reuses the 3.5.1 helpers + the real-Postgres/Playwright harness; does ' +
        "NOT duplicate 3.8.6's unit-level load-model assertions.\n\n" +
        '## Context refs\n\n' +
        '- Story 3.5.1 — the board-shaped large seed + cap/Done-age seam + at-scale helpers this ' +
        'consumes\n' +
        '- `app/(authed)/boards/_components/{BoardContainer,BoardColumn,SwimlaneBoard,LaneCell,OverCapBanner}.tsx` ' +
        '(3.8.3/3.8.4/3.8.5) + `components/ui/useRowWindow.ts` — the surfaces under test\n' +
        '- `lib/services/boardsService.ts` (`getBoard` `cap`/`truncated`/Done-age) + `lib/dto/boards.ts` ' +
        '(`cap` / `truncated`) — the load-model contract being verified\n' +
        '- `tests/e2e/board-projection.spec.ts` (3.1.7) — the board E2E pattern; `tests/e2e/_helpers/board.ts`; ' +
        '`design/boards/board-scale.mock.html` (3.8.1) — the over-cap/Done-age design under test',
    },
    {
      id: '3.5.3',
      title:
        'At-scale interaction E2E — drag-as-transition · snap-back · swimlanes · cross-lane reassign · WIP',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['3.5.1', '3.2.4', '3.3.5', '3.3.6', '3.8.5'],
      descriptionMd:
        'The Playwright spec (`tests/e2e/board-at-scale.spec.ts`, the interaction half) that proves ' +
        'the **combined drag + swimlane + WIP journey holds at scale** — the deferral 3.2.7 / 3.3.7 ' +
        '/ 4.5.4 send here. Every interaction runs on a card inside a virtualized, bounded board ' +
        '(3.5.1 seed), so it doubles as proof that the 3.8 load model does not break the 3.2/3.3 ' +
        'interaction contracts.\n\n' +
        '**Drag-as-transition deep in a virtualized list.** Scroll a tall column, pick a card not ' +
        'in the initial window, drag it to another column → the workflow transition applies ' +
        '(optimistic, then reconciled to the returned `BoardCardDto`); re-fetch / quick-view shows ' +
        'the new status; counts on both columns update. Proves drag survives virtualization ' +
        '(the dragged card + neighbours stay mounted, 3.2.5/3.8.3).\n\n' +
        '**Illegal-move snap-back (409) at scale.** An illegal cross-column move under the ' +
        '`restricted` workflow → the card **snaps back** to its origin column and the status is ' +
        'unchanged on re-fetch (the 3.1.5 `IllegalBoardMoveError` 409 contract), even from deep in ' +
        'the list.\n\n' +
        '**Swimlanes re-lay at scale.** Switch **group-by** to Assignee → the board re-lays into ' +
        'one lane per assignee-with-cards + the "No assignee" catch-all (last), each lane still ' +
        'bounded + virtualized with NO "Load more" (3.8.5); switch to Epic (grouped by **ancestor** ' +
        'epic) and Priority and back to None. Collapse a lane → its cards hide, header + aggregate ' +
        'count remain, and the collapse persists on reload.\n\n' +
        '**Cross-lane reassign + diagonal.** Drag a card into another assignee lane → the assignee ' +
        'is reassigned (confirmed via re-fetch / quick-view), status unchanged; into "No assignee" ' +
        '→ unassigned. A **diagonal** drag (different column AND different lane) applies BOTH the ' +
        'transition and the field reassign, each with independent reconcile (3.3.5) — one rejection ' +
        'does not revert the other.\n\n' +
        "**WIP soft-warning is advisory, not blocking.** Set a column's WIP limit below its card " +
        'count (the `[⋯]` menu, 3.3.6) → the header shows the `n/limit` over-limit warning (hue + ' +
        'icon/label, not colour-alone, finding #35); drag another card in → the drop **still ' +
        'succeeds** and the warning persists (soft = advisory; the 3.2.4 move contract is ' +
        'untouched). A column exactly at the limit (`n === limit`) is NOT warned (strictly greater).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e --grep board-at-scale` (this spec) is green: a drag-as-transition on a ' +
        'card scrolled into view deep in a virtualized column applies + reconciles; an illegal ' +
        'cross-column move snaps back (409) with status unchanged.\n' +
        '- Switching group-by (Assignee/Epic-ancestor/Priority/None) re-lays the board into bounded, ' +
        'virtualized lanes + catch-all with NO "Load more"; a collapsed lane stays collapsed on ' +
        'reload; a cross-lane drag reassigns the grouped field (status unchanged) and a diagonal ' +
        'drag applies both writes with independent reconcile.\n' +
        '- A column over its WIP limit shows the soft `n/limit` warning (not colour-alone) yet ' +
        'still ACCEPTS a dropped card (advisory, non-blocking); an at-limit column is not warned.\n' +
        '- Every interaction runs against the 3.5.1 board-shaped large seed (cards deep in ' +
        'virtualized lists), reuses the real-Postgres/Playwright harness + 3.5.1 helpers, and does ' +
        'NOT duplicate the single-surface drag/swimlane/WIP journeys owned by 3.2.7 / 3.3.7.\n\n' +
        '## Context refs\n\n' +
        '- Story 3.5.1 — the board-shaped large seed + at-scale helpers; Stories 3.2.7 / 3.3.7 — ' +
        'the single-surface journeys this extends to scale (do not duplicate)\n' +
        '- `app/(authed)/boards/_components/{BoardContainer,BoardColumn,BoardCard,SwimlaneBoard,LaneCell}.tsx` ' +
        '(3.2.4 dnd-kit drag, 3.3.5 swimlanes, 3.3.6 WIP, 3.8.5 bounded swimlane render) — under test\n' +
        '- `lib/services/boardsService.ts` (`moveCard`, swimlane projection, WIP) + ' +
        '`lib/boards/errors.ts` (`IllegalBoardMoveError` 409, `UnmappedColumnTargetError` 422) — the ' +
        'move + reassign contracts verified\n' +
        '- `tests/e2e/_helpers/board.ts` (+ 3.5.1 additions) + `tests/e2e/_helpers/workflow.ts`; ' +
        '`design/boards/{board,swimlanes-wip}.mock.html` (3.2.1/3.3.1) — the drag/lane/WIP design under test',
    },
  ],
};
