import type { PlanStory } from '../types';

/**
 * Story 3.8 — Board load model: filtered-set + virtualize + over-cap warning
 * (the Jira-faithful CORRECTION that replaces the board's per-column
 * "Load more").
 *
 * ⚠️ This story is a CORRECTION, not a rebuild. It does NOT modify the done
 * subtasks it supersedes (3.1.4 projection, 3.2.5 flat-board scale UI, 3.3.4
 * swimlane projection, 3.3.5 swimlane UI) — what is done is done; those cards
 * stand as the historical record. The NEW subtasks here ARE the fix. See
 * `notes.html` mistake #33 for the why.
 *
 * Why: the board's per-column cursor pagination + a "Load more" button (Stories
 * 3.1.4 / 3.2.5, carried into swimlanes by 3.3.4 / 3.3.5) was planned under
 * finding #57's "don't load every row" principle — a correct instinct applied
 * with a shape the mirror product does NOT use. VERIFIED against Jira (June 2026,
 * Atlassian docs): a Jira board renders the **whole saved-filter set up to a hard
 * cap** (5,000 issues Software / 3,000 Business), shows a **"maximum viewable
 * issues exceeded — refine your filter" warning** past the cap, **windows the
 * Done column to issues resolved in the last ~14 days**, and **virtualizes the
 * render** — it never paginates columns and has no "Load more." PER SURFACE
 * matters (mistake #33): Jira's issue *navigator* DOES paginate, so finding #57's
 * issue-list/tree pagination stays correct; only the *board* loads-the-set. This
 * story brings the board in line with that.
 *
 * ⚠️ Design gate (planning-time): the corrected surfaces — the over-cap "refine
 * filter" banner and a board with NO per-column "Load more" (the whole bounded
 * set, virtualized) — are NOT in `design/boards/board.mock.html` (whose scale
 * panel draws "Load more"). Unspecified == no design, so subtask 3.8.1 is a
 * `type: design` subtask that EXTENDS `design/boards/`, and every UI-touching
 * code subtask (3.8.3 / 3.8.4 / 3.8.5) carries 3.8.1 in `dependsOn` and names the
 * asset in Context-refs (Principle #13: design before code).
 */
export const story_3_8: PlanStory = {
  id: '3.8',
  title:
    'Board load model — filtered-set + virtualize + over-cap warning (replaces per-column "Load more")',
  status: 'done',
  descriptionMd:
    'Replace the board’s per-column cursor pagination + "Load more" with the **mirror-faithful ' +
    'load model**: the board loads its issue set **bounded by a hard cap + a Done-age window**, ' +
    '**virtualizes** the render, and shows a **"this board is too large — refine the filter" ' +
    'warning** when the cap is exceeded — never a per-column "Load more." This is the correction ' +
    'to the scale shape Stories 3.1.4 / 3.2.5 / 3.3.4 / 3.3.5 shipped; **those subtasks are NOT ' +
    'edited** (what is done is done), and these new subtasks supersede them in code (`notes.html` ' +
    'mistake #33).\n\n' +
    '**The verified mirror behaviour (rung 1; checked, not asserted).** A Jira board renders the ' +
    'whole saved-filter set up to a **hard cap** (5,000 Software / 3,000 Business), warns **"maximum ' +
    'number of viewable issues exceeded — refine your filter"** past the cap, windows the **Done** ' +
    'column to issues resolved in the **last ~14 days**, and **virtualizes** long columns — it ' +
    'does NOT paginate columns and has no "Load more"; per-column limits are WIP alerts (3.3.6), not ' +
    'display paging. **Per surface (mistake #33):** Jira’s issue *navigator* paginates (so finding ' +
    '#57’s LIST/tree pagination is correct and is NOT touched here); only the *board* loads-the-set.\n\n' +
    '**What changes.** (a) The projection (`getBoard`) loads each column’s cards **up to a ' +
    'board-level cap** with the **Done-age window** for terminal columns, and returns a board-level ' +
    '**`truncated` / `cap`** signal + the existing per-column totals; the per-column **cursor + the ' +
    '`/columns/[id]/cards` load-more route become dead** and are retired. (b) The flat board drops the ' +
    '"Load more" button + scroll sentinel + footer and renders the whole bounded set, virtualized ' +
    '(reusing the 2.5.15 `useRowWindow`). (c) The swimlane board drops the per-column "Load more" ' +
    'footer and buckets the whole bounded set into lanes, virtualized per cell. (d) A board-level ' +
    '**over-cap banner** ("This board has more than {cap} work items — refine the board filter") ' +
    'renders when `truncated`, pointing at the Epic-6 board-filter seam (the disabled `[Filter]` ' +
    'button 3.2 already reserves).\n\n' +
    '**Scale + completeness.** This is STILL bounded — it does not "load every row" (finding #57 ' +
    'holds): the cap is the bound, the Done-age window trims terminal columns, and virtualization ' +
    'keeps the DOM bounded. The cap is generous (a real team’s active board fits under it); the ' +
    'rare board that exceeds it gets the warning, exactly as Jira does. The board-filter that would ' +
    'let a user shrink an over-cap board is **Epic 6** (board configuration / JQL-style filters); ' +
    'until it lands the banner explains the cap and the `[Filter]` seam stays disabled — a ' +
    'documented seam, not an invented control.\n\n' +
    '**Out of scope:** the board filter / saved-query UI itself (Epic 6); any change to the 3.2.4 ' +
    'move contract, the 3.3 swimlane/cross-lane-drag behaviour, or the 3.3.6 WIP treatment (all ' +
    'unchanged — this story only swaps the load/paging mechanism); the issue list/tree pagination ' +
    '(finding #57, a different surface that correctly paginates — untouched).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm dev`, open `/boards` on the seeded `moooon` → `motir` project.\n' +
    '- **No "Load more":** neither the flat board nor any swimlane shows a "Load more" button or footer; columns render their cards directly and scroll, virtualized (DOM row count stays bounded on a tall column).\n' +
    '- **Over-cap warning:** `pnpm db:seed:large` (a project seeded past the cap) → the board shows the "more than {cap} work items — refine the filter" banner; a normal-sized project shows NO banner.\n' +
    '- **Done-age window:** the Done/terminal column shows only recently-resolved items (the ~14-day window) with the full count still surfaced; older done items are not loaded.\n' +
    '- **Swimlanes unchanged otherwise:** group-by, collapse, cross-lane drag-reassign, and the WIP over-limit warning all still work (this story changed only loading, not those behaviours).\n' +
    '- `pnpm test` + `pnpm test:e2e --grep board-load` green over the real stack.',
  items: [
    {
      id: '3.8.1',
      title:
        'Design — extend design/boards/ with the corrected scale model (no "Load more"; over-cap "refine filter" banner; Done-age window)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: ['3.2.1', '3.3.1'],
      descriptionMd:
        'The design asset the corrected scale UI builds against. The 3.2.1 board mockup’s scale ' +
        'panel draws a per-column "Load more" + a count-based terminal window; the corrected model ' +
        '(whole bounded set, virtualized, no "Load more", plus an over-cap warning banner) is ' +
        'unspecified — unspecified == no design, so this produces it FIRST (mirrors 1.0.5 / 3.2.1 ' +
        '/ 3.3.1). Output: a `design/boards/board-scale.mock.html` (or an extension of ' +
        '`board.mock.html`) built from the real design system (`components/ui/*` + `--el-*`/element-' +
        'shape tokens) + a PNG export + a "Board load model (Story 3.8)" section in ' +
        '`design/boards/design-notes.md`.\n\n' +
        '**Specify, panel by panel:** (a) a column rendering the whole bounded set with NO "Load more" ' +
        'footer (the scroll + virtualization is invisible; a `.virt-note` documents it for review); ' +
        '(b) the **Done/terminal column** windowed to the ~14-day recent set with the full count still ' +
        'shown; (c) the **over-cap banner** above the board — reuse the yellow tray treatment the ' +
        '3.2.6 `UnmappedStatusesTray` already uses (`--el-tint-yellow` + an alert-triangle + the copy ' +
        '"This board has more than {cap} work items — refine the board filter" + a link to the ' +
        '(Epic-6) `[Filter]` seam), paired hue+icon+text (not colour-alone, finding #35); (d) the ' +
        'swimlane layout with the per-column "Load more" footer removed.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/boards/board-scale.mock.html` + a PNG + a "Board load model (Story 3.8)" section in `design-notes.md` exist; built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape), AA-safe, passes the render checklist (icon viewBox, no nested buttons, prettier).\n' +
        '- The mockup draws: a column with NO "Load more" (virtualized whole set), the Done-age windowed terminal column, the over-cap "refine filter" banner (hue + icon + text), and the swimlane layout sans load-more footer.\n' +
        '- `design-notes.md` names the composing primitives (the tray/banner reused from 3.2.6, `--el-tint-yellow`, the virt-note), states the cap is a generous bound (still finding-#57-bounded, not "load all"), and that the `[Filter]` link is the Epic-6 seam (disabled until then).\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/board.mock.html` (scale panel) + `swimlanes-wip.mock.html` + `design-notes.md` (3.2.1 / 3.3.1) — the base this extends; the existing "Load more"/terminal-window panels it replaces\n' +
        '- `app/(authed)/boards/_components/UnmappedStatusesTray.tsx` (3.2.6) — the yellow-tray banner treatment to reuse for the over-cap warning\n' +
        '- Jira "maximum number of viewable issues exceeded for this board" warning + the 5,000-issue cap + the 14-day Done window (the verified mirror, rung 1); finding #35 (not colour-alone); `notes.html` mistake #33',
    },
    {
      id: '3.8.2',
      title:
        'Projection load model — bounded whole-set load + Done-age window + `truncated`/`cap` signal (retire the per-column cursor)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['3.1.4', '3.3.4'],
      descriptionMd:
        'Change `boardsService.getBoard` from a per-column first-page + cursor to the **bounded ' +
        'whole-set** load the mirror uses, through the 4-layer architecture (Route → Service → ' +
        'Repository → Prisma), keeping the explicit `workspaceId` gate (finding #26).\n\n' +
        '**The change.** Introduce a `BOARD_ISSUE_CAP` constant (a generous bound, e.g. 5,000 — the ' +
        'Jira Software figure). The projection loads each mapped column’s cards **up to the ' +
        'board-level cap** across the board (ordered by `position`), applies the **Done-age window** to ' +
        'terminal columns (issues resolved within ~14 days; refines 3.2.5’s count-based window to ' +
        'the age-based Jira behaviour, full count still surfaced), and returns a board-level ' +
        '**`truncated: boolean`** + **`cap: number`** alongside the existing per-column `totalCount`. ' +
        'When the board’s total exceeds the cap, `truncated` is true (the UI shows the banner) and ' +
        'the load stops at the cap — bounded, never "load every row" (finding #57 holds). The ' +
        'swimlane projection (3.3.4 `swimlaneKey` + `swimlanes[]` aggregate) is unchanged in shape — ' +
        'it just buckets the now-fully-loaded (bounded) cards.\n\n' +
        '**Retire the cursor.** The per-column `cursor` (3.1.4) and the `GET /api/board/columns/[id]/' +
        'cards` load-more route (3.1.6) become dead with no "Load more" caller; remove them (and the ' +
        '`PagedColumnCardsDto` path) or mark them removed in this subtask — do NOT leave a ' +
        'half-paged contract. Keep `BoardColumnDto.totalCount` (the denominator the count badge + the ' +
        '3.3.6 WIP chip read).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `getBoard` loads each column’s cards up to `BOARD_ISSUE_CAP` (no per-column cursor paging) and applies the Done-age window to terminal columns; per-column `totalCount` is retained.\n' +
        '- The projection returns board-level `truncated` + `cap`; `truncated` is true exactly when the board total exceeds the cap, and the load is bounded by the cap (never unbounded).\n' +
        '- The dead per-column cursor + the `/columns/[id]/cards` load-more route are removed (no orphaned paging contract); DTOs updated in `lib/dto/boards.ts` + mapped in `lib/mappers/boardMappers.ts`.\n' +
        '- Vitest (real Postgres) covers: the bounded load (count == min(total, cap)), `truncated` true past the cap / false under it, the Done-age window (old done items excluded, count still full), and the swimlane buckets still resolve over the bounded set.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/boardsService.ts` `getBoard` + `lib/dto/boards.ts` + `lib/mappers/boardMappers.ts` (3.1.4 / 3.3.4) — the projection this changes (add `truncated`/`cap`, drop `cursor`)\n' +
        '- `app/api/board/columns/[columnId]/cards/route.ts` (3.1.6) — the load-more route to retire\n' +
        '- `lib/repositories/workItemRepository.ts` — the column read + count; the Done-age filter\n' +
        '- finding #57 (bounded, not load-all — the cap IS the bound); the verified Jira cap + 14-day Done window (rung 1); `notes.html` mistake #33; `motir-core/CLAUDE.md` (4-layer + DTO mapping)',
    },
    {
      id: '3.8.3',
      title: 'Flat board UI — drop "Load more"; render the whole bounded set, virtualized',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.8.1', '3.8.2', '3.2.5'],
      descriptionMd:
        'Remove the per-column **"Load more" button + scroll sentinel + `.col-foot` footer** from ' +
        '`BoardColumn` (3.2.5) and the `loadMore` plumbing from `BoardContainer`; render the whole ' +
        'bounded set the 3.8.2 projection returns, **virtualized** via the 2.5.15 `useRowWindow` (kept ' +
        '— virtualization stays; only the user-facing paging affordance goes). The column count ' +
        'badge keeps showing `totalCount`. Drawn per `design/boards/board-scale.mock.html` (3.8.1).\n\n' +
        '## Acceptance criteria\n\n' +
        '- No "Load more" button, footer, or scroll-sentinel auto-load remains on the flat board; `BoardColumn` renders the projection’s full (bounded) card list, virtualized; the count badge shows `totalCount`.\n' +
        '- The `loadMore` / `paging` / `appendColumnPage` plumbing tied to the retired cursor is removed from `BoardContainer` (no dead code, no calls to the removed route).\n' +
        '- Per-column virtualization (`useRowWindow`) still bounds the DOM on a tall column; colours via `--el-*`, shape via element tokens; matches the 3.8.1 mockup.\n' +
        '- Component tests assert no load-more affordance renders and a tall column stays DOM-bounded.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/_components/BoardColumn.tsx` + `BoardContainer.tsx` + `boardPaging.ts` (3.2.5) — the load-more + sentinel + footer to remove (do NOT touch the 3.2.4 drag handlers)\n' +
        '- `components/ui/useRowWindow.ts` (2.5.15) — the virtualization to keep\n' +
        '- `design/boards/board-scale.mock.html` + `design-notes.md` (3.8.1); `lib/dto/boards.ts` (3.8.2, the `cursor`-free column shape)',
    },
    {
      id: '3.8.4',
      title: 'Over-cap warning banner — "board too large, refine the filter" (flat + swimlane)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['3.8.1', '3.8.2'],
      descriptionMd:
        'Render a board-level **over-cap banner** above the board when the 3.8.2 projection signals ' +
        '`truncated` — the mirror of Jira’s "maximum number of viewable issues exceeded" ' +
        'warning. Reuse the 3.2.6 yellow-tray treatment (`UnmappedStatusesTray`’s pattern): an ' +
        'alert-triangle + the copy "This board has more than {cap} work items — refine the board ' +
        'filter" + a link to the (Epic-6) `[Filter]` seam. Shown for BOTH the flat and swimlane ' +
        'layouts (it sits in `BoardContainer`, above whichever board renders); absent when `truncated` ' +
        'is false. Not colour-alone (hue + icon + text, finding #35); announced via `role="status"`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A banner renders above the board exactly when `truncated` is true, with the cap in the copy and a (disabled-until-Epic-6) filter affordance; absent when `truncated` is false.\n' +
        '- Reuses the 3.2.6 tray treatment / `--el-tint-yellow`; hue paired with icon + text (finding #35); announced to assistive tech; shown for both flat and swimlane layouts.\n' +
        '- Colours via `--el-*`, shape via element tokens; matches the 3.8.1 mockup.\n' +
        '- Component test: banner present past the cap, absent under it, copy carries the cap.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/_components/UnmappedStatusesTray.tsx` (3.2.6) — the banner pattern to mirror; `BoardContainer.tsx` — where it mounts (above the board, like the unmapped tray)\n' +
        '- `lib/dto/boards.ts` (3.8.2, the `truncated`/`cap` signal); `design/boards/board-scale.mock.html` (3.8.1); finding #35',
    },
    {
      id: '3.8.5',
      title: 'Swimlane UI — drop the per-column "Load more" footer; bucket the whole bounded set',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['3.8.1', '3.8.2', '3.3.5'],
      descriptionMd:
        'Remove the per-column **"Load more" footer row** from `SwimlaneBoard` (3.3.5) — the ' +
        'awkward bottom row of per-column buttons whose page sprinkled cards into lanes above it — ' +
        'and bucket the whole bounded set (3.8.2) into `(lane, column)` cells, virtualized per cell via ' +
        '`useRowWindow` (kept). Everything else in 3.3.5 (group-by, collapsible lanes, catch-all, ' +
        'cross-lane drag-reassign, the 3.3.6 WIP chip in the lane header) is **unchanged**. Drawn per ' +
        'the 3.8.1 swimlane panel.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The per-column "Load more" footer is gone from `SwimlaneBoard`; lanes bucket the full bounded set; per-cell `useRowWindow` virtualization still bounds the DOM.\n' +
        '- Group-by, collapse + persistence, the catch-all lane, cross-lane drag-reassign, and the WIP over-limit chip all still work (this subtask changes only loading).\n' +
        '- Colours via `--el-*`, shape via element tokens; matches the 3.8.1 mockup.\n' +
        '- Component test asserts no load-more footer renders in swimlane mode and lanes still bucket correctly.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/_components/SwimlaneBoard.tsx` + `LaneCell.tsx` (3.3.5) — the load-more footer to remove; keep the lane/cell + WIP wiring\n' +
        '- `design/boards/board-scale.mock.html` + `design-notes.md` (3.8.1); `lib/dto/boards.ts` (3.8.2)',
    },
    {
      id: '3.8.6',
      title:
        'Tests — board load model (no "Load more", over-cap banner, Done-age window, virtualization)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.8.2', '3.8.3', '3.8.4', '3.8.5'],
      descriptionMd:
        'Prove the corrected load model end-to-end, the 3.1.7 / 3.2.7 split: component/unit (vitest, ' +
        'real Postgres where DB-touching) + a focused E2E. Confirms the mirror-faithful behaviour and ' +
        'that the old "Load more" affordance is fully gone.\n\n' +
        '**Component / unit.** The projection bounded load + `truncated`/`cap` + Done-age window (may ' +
        'overlap 3.8.2 — keep the integration assertions here); the over-cap banner predicate ' +
        '(present past cap / absent under it); no load-more affordance on flat OR swimlane; ' +
        'virtualization still bounds a tall column / cell.\n\n' +
        '**E2E (Playwright) `tests/e2e/board-load.spec.ts`.** Against a freshly seeded project: the ' +
        'board renders with NO "Load more"; a tall column scrolls (virtualized, DOM bounded); on a ' +
        '`db:seed:large` over-cap project the "refine filter" banner shows (and is absent on a normal ' +
        'project); the Done column shows only the recent window. Reuses the real-Postgres harness + the ' +
        'seeded project; does NOT duplicate the combined at-scale journey (Story 3.5).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` covers the bounded projection + `truncated`/`cap` + Done-age window, the banner predicate, the no-load-more assertions (flat + swimlane), and DOM-bounded virtualization.\n' +
        '- `pnpm test:e2e --grep board-load` runs green over the real stack: no "Load more", virtualized scroll, the over-cap banner present/absent correctly, the Done-age window.\n' +
        '- The suite reuses `tests/helpers/db.ts` truncation + the seeded project; the at-scale combined journey stays in Story 3.5.\n' +
        '- This subtask OWNS the board load-model coverage and SUPERSEDES the retired per-column "Load more"/cursor-paging assertions in 3.2.7 (if 3.2.7 landed first, update its specs); 3.2.7 / 3.3.7 keep their drag / reducer / grouping / reassign / WIP coverage unchanged — they are NOT cancelled.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/board-ui.spec.ts` (3.2.7) + `tests/e2e/board-projection.spec.ts` (3.1.7) — the board E2E this extends\n' +
        '- `tests/helpers/db.ts`; the 3.8.2 projection + 3.8.3/3.8.4/3.8.5 UI under test; `motir-core/CLAUDE.md` (real Postgres, no mocks)',
    },
  ],
};
