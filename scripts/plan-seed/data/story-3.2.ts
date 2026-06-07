import type { PlanStory } from '../types';

/**
 * Story 3.2 — Kanban board UI + drag-drop transitions.
 *
 * The Kanban board SURFACE — the first UI story of Epic 3. Story 3.1 shipped the
 * whole board BACKEND (the `board` / `board_column` / `board_column_status`
 * model, the bounded column-of-cards projection, the move-as-transition
 * mutation, and the `GET …/board` · `GET …/board/columns/[id]/cards` ·
 * `POST …/board/move` API). This story builds the frontend that consumes it:
 * columns of cards, accessible drag-drop that resolves a cross-column drop to a
 * workflow transition (illegal drops snap back on the 3.1 typed errors), the
 * per-column lazy "load more" + virtualization that finding #57 demands, and the
 * board completeness states (unmapped-statuses tray, empty / loading / error,
 * responsive). NO new backend — every read/write goes through the 3.1.6 API.
 *
 * ⚠️ Design gate (planning-time): the board is the most design-heavy surface in
 * the product and NO `design/boards/` asset existed at plan time. Per the
 * design gate there is no "improvise it" branch — so subtask 3.2.1 is a
 * `type: design` subtask that produces `design/boards/board.mock.html` + PNG +
 * `design-notes.md` (mirroring 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1), and EVERY
 * UI-touching code subtask (3.2.2–3.2.6) carries 3.2.1 in `dependsOn` and names
 * the asset in Context-refs. A board code subtask never reaches the ready set
 * before its design asset exists (Principle #13: design before code).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 3.2`. Matches the
 * canonical depth + string-literal style of Story 3.1 and the Epic-2 modules.
 */
export const story_3_2: PlanStory = {
  id: '3.2',
  title: 'Kanban board UI + drag-drop transitions',
  status: 'planned',
  descriptionMd:
    'The board surface: a horizontally-scrolling row of **columns**, each a vertical stack of ' +
    '**cards**, with accessible drag-drop that moves a card between columns (a workflow ' +
    'transition) or reorders it within a column (a rank change). This is a **pure frontend ' +
    'story** — it builds NO new backend; every read and write goes through the Story-3.1 board ' +
    'API (`GET /api/projects/[key]/board` → `BoardProjectionDto`, `GET …/board/columns/[id]/cards` ' +
    '→ the lazy page, `POST …/board/move` → the moved card). The load-bearing contract carried ' +
    'from 3.1: **moving a card is a workflow transition, never a board-local write** — a ' +
    'cross-column drop calls `POST …/move`, which resolves to `issuesService.updateStatus` under ' +
    "the project's policy mode; an in-column drop is a pure `work_item.position` rank change. The " +
    'UI applies the move **optimistically** and reconciles against the server response, **snapping ' +
    'the card back** when the server rejects an illegal transition (`IllegalBoardMoveError` → HTTP ' +
    '409) or an unmapped target (`UnmappedColumnTargetError` → 422).\n\n' +
    '**Where it lives.** The `/boards` route already exists as a stub placeholder ' +
    '(`app/(authed)/boards/page.tsx` renders `ProjectStubPage … comingIn="Epic 3"`); the sidebar ' +
    '"Boards" nav link + the Cmd-K "Go to Boards" entry are already wired (Story 1.5). This story ' +
    '**replaces the stub** with the real surface — no new navigation wiring. The board renders the ' +
    "active project's single default Kanban board (3.1 auto-seeds one per project); multi-board " +
    'routing is a later, non-breaking addition (the API already takes a `boardId`).\n\n' +
    '**Reuse, do not reinvent (the card visual language).** A board card is the same issue, shown ' +
    'compactly — so it REUSES the issue-list card primitives, not a parallel set: the ' +
    '`IssueTypeIcon` (kind hue via `--el-type-*`), the `Pill` tones for status/priority, the ' +
    '`ReadinessBadge` blocked/ready signal, the assignee avatar, and the `key`/`identifier` chip — ' +
    'all already shipped under `app/(authed)/issues/_components/issueCellPrimitives.tsx` + ' +
    '`components/ui/*`. Clicking a card opens the **existing `IssueQuickView` panel** (Story 2.5), ' +
    'not a new detail surface. The board is a new *arrangement* of shipped primitives.\n\n' +
    '**Accessibility is in scope, not deferred.** The stub mandates "accessible keyboard DnD," and ' +
    'Jira/Linear both ship it — so drag-drop uses **dnd-kit** (`@dnd-kit/core` + `@dnd-kit/' +
    'sortable`), the de-facto accessible React DnD library (pointer + keyboard sensors, a ' +
    '`DragOverlay`, and `aria-live` move announcements out of the box). This is a new dependency ' +
    '(no DnD lib exists yet); it is the mirror-product-standard choice (decision-ladder rung 1), ' +
    'not a deviation. A drag must be fully operable by keyboard (pick up / move / drop / cancel) ' +
    'with screen-reader announcements; drop targets are not signalled by colour alone (finding ' +
    '#35).\n\n' +
    '**Scale shape — the board is bounded, never "render every card" (finding #57).** 3.1 already ' +
    'returns a *bounded first page per column* with a per-column total count and a cursor; this ' +
    'story consumes that — each column shows its count, lazy-loads further cards on demand via ' +
    '`GET …/board/columns/[id]/cards?cursor=`, and **virtualizes** a tall column so the DOM row ' +
    'count stays bounded (reusing the windowing primitive Story 2.5.15 establishes for the issue ' +
    'tree — do NOT introduce a second virtualization library). A board that fetched and rendered ' +
    'every card would be prototype-thinking; the projection is paged by design and the UI must ' +
    'honour it.\n\n' +
    '**Completeness — the real-product states, not just the happy path.** A real board has: a ' +
    '**loading** skeleton (columns + card placeholders) while the projection streams; an **empty** ' +
    'state (project has no issues yet → a create-issue affordance); a **no-board / error / ' +
    "forbidden** state; and an **unmapped-statuses** affordance — 3.1's projection deliberately " +
    'returns `unmappedStatuses` (project statuses mapped to no column, the Jira behaviour), which ' +
    'the board surfaces as a tray/banner (with a path to the board/workflow admin) rather than ' +
    'silently dropping them. The board is **responsive** (horizontal scroll on desktop, a usable ' +
    'mobile layout). These are planned as their own subtask, not bolted on.\n\n' +
    '**Out of scope (Epic-3 siblings):** swimlanes + WIP-limit enforcement / over-limit warnings ' +
    '(Story 3.3 — this story renders the `wipLimit` the projection returns as a count display only, ' +
    'and leaves a slot for 3.3); the sprint-scoped Scrum board (Story 3.4); the cross-cutting ' +
    'drag-drop + WIP + swimlane Playwright journey (Story 3.5 — this story ships its OWN UI ' +
    'component tests + the core drag/snapback E2E, the same split 3.1.7 used). Board CRUD / ' +
    'column-remap admin is not v1.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install` (picks up the new `@dnd-kit/*` deps), `pnpm prisma migrate dev`, `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test` — vitest covers the optimistic-move / snapback reducer (move applied → confirmed on 200; reverted on 409/422), the `BoardCard` / `BoardColumn` render (type hue, readiness, count), and the column lazy-load page-append logic.\n' +
    '- `pnpm test:e2e --grep board-ui` — Playwright drives the real board: drag a card across columns (status persists), an illegal move snaps back (409), in-column reorder changes only rank, and the keyboard-DnD path moves a card end-to-end.\n' +
    '- **Visual / design check:** open `/boards` on the seeded `moooon` → `prodect` project. The board matches `design/boards/board.mock.html` — columns in workflow order with a card count each, cards showing type icon + key + title + assignee + priority + a blocked indicator where applicable, colour via `--el-*` (not grey-only, finding #54).\n' +
    '- **Move = transition check:** drag a card from To Do → In Progress → the card lands, the count updates, and re-opening the issue (or the quick view) shows the new status. Attempt an illegal move under a `restricted` workflow (e.g. To Do → Done with no such transition) → the card **animates back** to its origin column and a toast explains the rejection; the issue status is unchanged.\n' +
    '- **In-column reorder check:** drag a card up/down within a column → it stays in the column, no status change, the order persists on reload (rank only).\n' +
    '- **Keyboard-DnD check:** focus a card, press the pick-up key (Space/Enter), arrow to another column, drop → the move happens with an `aria-live` announcement; Escape mid-drag cancels with the card returning home. Verify with the keyboard alone (no mouse).\n' +
    '- **Scale check (finding #57):** `pnpm db:seed:large`, open a column with hundreds of cards → it shows the bounded first page + the total count + a "Load more" affordance; scrolling/loading fetches the next page via `GET …/columns/[id]/cards?cursor=`; the rendered DOM row count stays bounded (virtualized) even when the column is fully expanded.\n' +
    '- **Unmapped-status check (mirror-product):** add a custom status via the workflow editor (Story 2.2.5) → the board shows it in the **unmapped-statuses tray** (NOT a new column, NOT silently dropped), with a link to map it; existing columns are unaffected.\n' +
    '- **States check:** a brand-new project with no issues shows the empty state (with a create affordance); throttling the network shows the loading skeleton; a forced API error shows the error state with a retry.',
  items: [
    {
      id: '3.2.1',
      title: 'Design — Kanban board surface: columns, card anatomy, drag states, scale + states',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 50,
      dependsOn: ['1.5.1'],
      descriptionMd:
        'The design asset the whole story builds against — the board is the most design-heavy ' +
        'surface in the product and **no `design/boards/` asset exists**, so this subtask produces ' +
        'it FIRST (the planning-time design gate; mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1). Output: ' +
        '`design/boards/board.mock.html` (an HTML mockup built from the real design system — ' +
        '`components/ui/*` + the `--el-*` tokens, so a coding agent has no Pencil→code gap) + a PNG ' +
        'export + `design/boards/design-notes.md` naming the composing primitives, copy, and ' +
        'placement. `--el-*` only (no Tier-0 `--color-*`); shape via the `--radius-*`/`--spacing-*` ' +
        'element tokens; AA-safe; mirrors Jira/Linear as the reference board.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Board layout** — the board inside the shell (1.5.1): a horizontally-scrolling row of ' +
        'columns, sticky column headers, the overall page header (board name + a place for the ' +
        '3.3 controls and the issue filter to live later). Desktop scroll behaviour + a usable ' +
        '**mobile** layout (single-column scroll or a column pager).\n' +
        '- **Column** — header with the column name, the **card count**, and a reserved slot for ' +
        "the 3.3 WIP-limit indicator (drawn as a placeholder, NOT enforced here); the column's " +
        'scroll area; the empty-column state.\n' +
        '- **Card anatomy** — the compact issue card REUSING the shipped issue primitives: the ' +
        '`IssueTypeIcon` (kind hue via `--el-type-*`), the issue `key`/identifier chip, the title ' +
        '(clamped), the assignee avatar, the priority pill, the story-point/estimate chip, and the ' +
        'blocked/ready indicator (`ReadinessBadge`). Show the colour from the palette, not grey + ' +
        'one accent (finding #54). Note that clicking a card opens the existing `IssueQuickView`.\n' +
        '- **Drag states** — the card lift (elevation/shadow via `--shadow-*`), the `DragOverlay` ' +
        'clone, the **insertion indicator** between cards, the target-column highlight, and the ' +
        'snap-back (illegal move) treatment. Drop targets must NOT be signalled by colour alone ' +
        '(finding #35) — pair colour with an insertion line / border / icon.\n' +
        '- **Keyboard-DnD affordances** — the focus ring on a card, the "picked up / press arrows ' +
        'to move / Space to drop / Esc to cancel" model, and where the `aria-live` move ' +
        'announcement copy reads from (document the strings).\n' +
        '- **Scale (finding #57)** — the per-column **count**, the **"Load more"** affordance at ' +
        'the bottom of a column (or scroll-to-load), and a note that tall columns virtualize ' +
        '(invisible to the eye; document it, no distinct visual). Reuse the affordance language the ' +
        'issue tree/list scale design (2.5.10 / 2.5.11) established.\n' +
        '- **States** — board **loading** skeleton (columns + card placeholders), **empty** ' +
        '(project has no issues → create affordance), **no-board / error / forbidden**, and the ' +
        '**unmapped-statuses tray** (statuses with no column — a banner/tray listing them with a ' +
        'link to the board/workflow admin; the Jira behaviour).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/boards/board.mock.html` + a PNG export + `design/boards/design-notes.md` exist; the mockup is built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape), passes the render checklist (icon viewBox, no nested buttons, prettier), and is AA-safe.\n' +
        '- The mockup draws: the multi-column board (with horizontal scroll + sticky headers + mobile layout), a column header with count + a WIP placeholder slot, the card anatomy reusing the issue primitives, the drag states (overlay, insertion indicator, target highlight, snap-back), and the load-more / virtualization affordance.\n' +
        '- It draws every state: loading skeleton, empty, no-board/error/forbidden, and the unmapped-statuses tray.\n' +
        '- `design-notes.md` names each composing primitive (`IssueTypeIcon`, `Pill`, `ReadinessBadge`, `IssueQuickView`, `EmptyState`, `ErrorState`, `Spinner`), documents the keyboard-DnD model + the `aria-live` announcement copy, states that a board card opens `IssueQuickView`, and names Jira/Linear as the mirror.\n' +
        '- Drop/drag affordances do not rely on colour alone (finding #35); card hues come from `--el-type-*` (finding #54).\n\n' +
        '## Context refs\n\n' +
        '- `design/shell/desktop.png` / `mobile-drawer.png` (1.5.1) — the shell chrome the board renders inside\n' +
        '- `design/work-items/list.mock.html` + `tree-scale.mock.html` + `design-notes.md` (2.5) — the card/cell visual language + the scale (load-more/virtualization) affordance to mirror\n' +
        '- `design/work-items/quick-view.mock.html` — the `IssueQuickView` a card click opens\n' +
        '- `components/ui/*` (Card, Pill, ReadinessBadge, EmptyState, ErrorState, Spinner, Tooltip) + `app/(authed)/issues/_components/issueCellPrimitives.tsx` + `IssueTypeIcon` — the primitives to compose\n' +
        '- `app/globals.css` `--el-*` + element-shape tokens; the `/tokens` specimen route\n' +
        '- Jira / Linear board as the mirror product; finding #35 (not colour-alone), #54 (use the palette), #57 (bounded board)',
    },
    {
      id: '3.2.2',
      title: 'Board page + data layer — replace the `/boards` stub; fetch projection; board states',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.2.1', '3.1.6'],
      descriptionMd:
        'Stand up the real board route + its client data layer, the foundation the column/card/DnD ' +
        'subtasks build on. Replace the placeholder `app/(authed)/boards/page.tsx` ' +
        '(`ProjectStubPage … comingIn="Epic 3"`) with the real surface; the sidebar + Cmd-K entries ' +
        'already point at `/boards` (Story 1.5), so NO navigation wiring changes.\n\n' +
        '**Route + container.** The page resolves the active project (the same active-project ' +
        'context the `/issues` route uses) and renders a client board container. The container ' +
        'fetches the projection from the **Story-3.1.6 API** (`GET /api/projects/[key]/board` → ' +
        '`BoardProjectionDto`: ordered columns, each with its first page of card DTOs + per-column ' +
        "`total` + `cursor`, plus top-level `unmappedStatuses`). Use the codebase's native " +
        'client-fetch idiom (`useState`/`useEffect`/`useTransition` + `fetch`, as `WorkflowEditor` ' +
        'and the issue components do) — there is no query library and this story does not add one. ' +
        'Hold the projection in component state shaped so the later subtasks can mutate one ' +
        "column's card list in place (optimistic moves, appended pages) without refetching the " +
        'whole board.\n\n' +
        '**Quick-view wiring (card click → IssueQuickView modal).** A board card is a peek into an ' +
        'issue: **clicking a card opens the existing `IssueQuickView` modal** (Story 2.5), the SAME ' +
        'peek surface the issue list uses — NOT a new detail surface and NOT a full-page navigation. ' +
        'This subtask mounts the shared quick-view panel at the board-page level (reusing the ' +
        'issues-list wiring — `IssueQuickViewPanel` + the `QuickViewTrigger`/`QuickView` ' +
        'open-handler/context) and threads an `onOpenQuickView(workItemId)` handler down to the ' +
        '`BoardCard` (3.2.3), which invokes it on click. The card stays keyboard-activatable (Enter ' +
        'opens the quick view; the drag pick-up key is Space, per 3.2.4) and a "↗ open full page" ' +
        'path from the peek still navigates to the issue detail. Reuse, do not rebuild, the 2.5 ' +
        'quick-view panel.\n\n' +
        '**Board-level states (completeness).** Render, per the 3.2.1 design: a **loading** ' +
        'skeleton (columns + card placeholders) via `Spinner`/skeleton while the projection ' +
        'streams; an **error** state (`ErrorState` with retry) on a failed fetch; and the ' +
        '**no-board** case (defensive — 3.1 auto-seeds one, but handle null). The project-has-no- ' +
        'issues **empty** state and the **unmapped-statuses tray** are the 3.2.6 subtask; this ' +
        'subtask renders the column scaffold + the load/error shells and leaves typed seams for ' +
        'them.\n\n' +
        '**Out of scope here:** the column/card components (3.2.3), drag-drop (3.2.4), lazy ' +
        'load-more/virtualization (3.2.5), and the empty/unmapped tray (3.2.6) — this subtask ' +
        'ships the route, the data fetch, the board state container, and the loading/error shells.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `/boards` renders the real board (the `ProjectStubPage` placeholder is gone) for the active project; the sidebar/Cmd-K links resolve to it unchanged.\n' +
        '- The container fetches `GET …/board` once on load via the native fetch idiom (no query lib added) and holds the projection in mutable-per-column state; `unmappedStatuses` is carried in state for 3.2.6.\n' +
        '- A loading skeleton shows while the projection streams; a failed fetch shows `ErrorState` with a working retry; a null/absent board is handled without a crash.\n' +
        '- The board page mounts the shared `IssueQuickView` panel and provides the `onOpenQuickView(workItemId)` handler the `BoardCard` (3.2.3) calls; **clicking a card opens the IssueQuickView modal** (the same 2.5 peek surface — reused, not rebuilt), with the "open full page" path intact.\n' +
        '- No data access in the page beyond calling the 3.1.6 API (no new route, no Prisma — this is a pure consumer); colours via `--el-*`, shape via element tokens, matching `design/boards/`.\n' +
        '- Component/render tests assert the loading, error, and populated-scaffold branches, plus that a card click opens the quick view.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/page.tsx` — the stub to replace; `app/(authed)/_components/ProjectStubPage.tsx` — what it renders today\n' +
        '- `app/(authed)/issues/_components/IssueQuickView*.tsx` + `QuickViewTrigger.tsx` — the quick-view panel + open-handler wiring to reuse (a card click opens it)\n' +
        '- `app/(authed)/issues/page.tsx` + `_components/*` — the active-project resolution + client-fetch + Suspense/skeleton precedent to mirror\n' +
        '- Story 3.1.6 — the `GET /api/projects/[key]/board` route + `BoardProjectionDto`/`lib/dto/boards.ts` shape this consumes\n' +
        '- `components/ui/Spinner` / `ErrorState` / `EmptyState`; `design/boards/board.mock.html` + `design-notes.md` (3.2.1)\n' +
        '- `prodect-core/CLAUDE.md` — `--el-*` colour rule, element-shape rule (this is client UI, no service/repo work)',
    },
    {
      id: '3.2.3',
      title: 'Column + card components — `BoardColumn` / `BoardCard` reusing issue primitives',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.2.1', '3.2.2'],
      descriptionMd:
        'The presentational layer the board container renders — the columns and cards, drawn per ' +
        '`design/boards/board.mock.html`, REUSING the shipped issue primitives rather than a ' +
        'parallel set.\n\n' +
        '**`BoardColumn`** — a column header (name, the per-column **card count**, and a reserved ' +
        'slot/prop for the Story-3.3 WIP indicator drawn as a count display only — NOT enforced ' +
        'here) over a scrollable card stack, with an **empty-column** state. Takes the column meta + ' +
        'its current card page from the board state; emits the drop-target hooks 3.2.4 wires and the ' +
        '"load more" seam 3.2.5 fills.\n\n' +
        '**`BoardCard`** — the compact card for a `BoardCardDto`, composed from the existing ' +
        'primitives: `IssueTypeIcon` (kind hue via `--el-type-*`), the `key`/identifier chip, the ' +
        'clamped title, the assignee avatar, the priority `Pill`, the estimate/points chip, and the ' +
        '`ReadinessBadge` blocked/ready signal (the 3.1.4 `BoardCardDto` carries the finding-#21 ' +
        'readiness signal). Clicking a card opens the **existing `IssueQuickView`** panel (Story ' +
        '2.5) — do not build a new detail surface. The card is keyboard-focusable (it becomes a ' +
        'drag handle in 3.2.4).\n\n' +
        '**Reuse rule.** Pull the type icon, pills, readiness badge, and avatar from ' +
        '`app/(authed)/issues/_components/issueCellPrimitives.tsx` + `components/ui/*`; if a piece ' +
        'needs extracting to share between the list and the board, extract it (do not fork). ' +
        'Colour via `--el-*` (the palette, not grey-only — finding #54); shape (radius/padding/ ' +
        'shadow) via the element-shape tokens; AA-safe.\n\n' +
        '**Out of scope here:** drag-drop behaviour (3.2.4); the load-more/virtualization that ' +
        'feeds the stack (3.2.5); the board-level empty + unmapped tray (3.2.6). This subtask is ' +
        'static rendering + the quick-view click + the seams for DnD and paging.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `BoardColumn` renders the header (name + count + a WIP-placeholder slot, not enforced), the card stack, and the empty-column state, matching `design/boards/`.\n' +
        '- `BoardCard` renders type icon (hue via `--el-type-*`), key, title, assignee, priority, points, and the readiness/blocked badge from the `BoardCardDto`, reusing the issue-list primitives (no forked card markup).\n' +
        '- Clicking a card opens the existing `IssueQuickView`; the card is keyboard-focusable.\n' +
        '- Colours via `--el-*` (not grey + one accent — finding #54), shape via element tokens; render checklist clean (icon viewBox, no nested buttons, prettier); AA-safe.\n' +
        '- Component tests assert card field rendering (incl. the blocked indicator) and the empty-column state.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/issues/_components/issueCellPrimitives.tsx` + `issueColumns.tsx` + `IssueTypeIcon` — the card primitives to reuse/extract\n' +
        '- `components/ui/Pill` / `ReadinessBadge` / `Tooltip`; `app/(authed)/issues/_components/IssueQuickView*.tsx` — the quick view a card opens\n' +
        '- Story 3.1.4 — `BoardCardDto` (`lib/dto/boards.ts`) the card binds to (incl. the finding-#21 readiness signal)\n' +
        '- `design/boards/board.mock.html` + `design-notes.md` (3.2.1) — the column/card spec; `prodect-core/CLAUDE.md` — `--el-*` + element-shape rules',
    },
    {
      id: '3.2.4',
      title: 'Drag-drop transitions — dnd-kit, optimistic move, snap-back on illegal/unmapped',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['3.2.3', '3.1.6'],
      descriptionMd:
        'The heart of the story: make cards draggable, move them via the Story-3.1 transition ' +
        'contract, and reconcile optimistically. Introduce **dnd-kit** (`@dnd-kit/core` + ' +
        '`@dnd-kit/sortable`) — the accessible React DnD standard (the stub mandates accessible ' +
        'keyboard DnD; Jira/Linear ship it). `pnpm add` the deps (a plain library add — no ' +
        'dashboard/SaaS provisioning, so no manual subtask). Wire it per `design/boards/`.\n\n' +
        '**DnD wiring.** A `DndContext` over the board with **pointer AND keyboard sensors**; each ' +
        '`BoardColumn` is a droppable, each `BoardCard` a sortable draggable; a `DragOverlay` ' +
        'renders the lifted card; an insertion indicator marks the drop position (the 3.2.1 ' +
        'treatment, not colour-alone — finding #35).\n\n' +
        '**Move semantics → the 3.1 contract.** On drop, compute `{ workItemId, toColumnId, ' +
        'beforeId?, afterId? }` from the source/target and call `POST /api/projects/[key]/' +
        'board/move` (Story 3.1.6). A **cross-column** drop is a workflow transition (the server ' +
        'resolves the target status + validates via `canTransition`); an **in-column** drop is a ' +
        'rank change (`work_item.position`). The UI does NOT decide legality — the server does.\n\n' +
        '**Optimistic update + reconcile.** Apply the move to the board state immediately (card ' +
        'jumps to the target column/position) for snappy feedback, then:\n' +
        '- **200** → reconcile to the returned `BoardCardDto` (confirmed status/position; update ' +
        'the source + target column counts).\n' +
        '- **409 `IllegalBoardMoveError`** → **snap the card back** to its origin column/position ' +
        '(the 3.2.1 snap-back treatment) and show a `Toast` explaining the rejected transition.\n' +
        '- **422 `UnmappedColumnTargetError`** → snap back + a toast (drop onto an unmapped ' +
        'target).\n' +
        '- **other / network error** → snap back + a generic retry toast; never leave the card in a ' +
        'lying optimistic position.\n\n' +
        '**Accessibility.** Keyboard DnD must fully work: focus a card, pick up (Space/Enter), ' +
        'arrow between columns/positions, drop, and Escape-to-cancel — with `aria-live` ' +
        'announcements (dnd-kit `announcements`, copy from the 3.2.1 design-notes). Operable with ' +
        'the keyboard alone.\n\n' +
        '**Out of scope here:** the lazy load-more/virtualization the dragged stack lives in ' +
        '(3.2.5 — ensure the DnD wiring tolerates a virtualized list); WIP-limit rejection on ' +
        'over-limit drops (Story 3.3 — the server does not reject on WIP yet, and this story does ' +
        'not pre-empt it).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `@dnd-kit/core` + `@dnd-kit/sortable` added; a `DndContext` with pointer + keyboard sensors makes cards draggable between and within columns, with a `DragOverlay` + an insertion indicator (not colour-alone, finding #35).\n' +
        '- A drop calls `POST …/board/move` with the right `{ workItemId, toColumnId, beforeId?, afterId? }`; cross-column = transition, in-column = rank — the UI defers legality to the server.\n' +
        '- The move applies optimistically; on 200 it reconciles to the returned card + updates column counts; on **409** it snaps the card back + toasts; on **422** and other errors it snaps back + toasts. The card never stays in a rejected position.\n' +
        '- Keyboard DnD works end-to-end (pick up / move / drop / Esc-cancel) with `aria-live` announcements; the flow is operable with no mouse.\n' +
        '- Vitest covers the optimistic-move/reconcile reducer (confirm on 200, revert on 409/422) in isolation; colours/shape via tokens.\n\n' +
        '## Context refs\n\n' +
        '- Story 3.1.5 / 3.1.6 — `boardsService.moveCard` semantics + `POST …/board/move` + the `IllegalBoardMoveError` (409) / `UnmappedColumnTargetError` (422) typed errors this branches on\n' +
        '- `components/ui/Toast` — the rejection feedback; `app/(authed)/issues/_components/IssueInlineEdit.tsx` — an existing optimistic-update precedent to mirror\n' +
        '- dnd-kit docs (`DndContext`, `useSortable`, `DragOverlay`, keyboard sensor, `announcements`); `design/boards/design-notes.md` (3.2.1) — drag states + announcement copy\n' +
        '- finding #35 (not colour-alone); `prodect-core/CLAUDE.md` — `--el-*` + element-shape rules',
    },
    {
      id: '3.2.5',
      title: 'Per-column lazy load-more + virtualization (finding #57) — consume cursor/count',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['3.2.3', '3.2.2', '3.1.6'],
      descriptionMd:
        'Make each column bounded at the UI, honouring the 3.1 paged projection (finding #57): the ' +
        'board never renders every card. 3.1 already returns, per column, a bounded first page + a ' +
        '`total` count + a `cursor`; this subtask consumes that.\n\n' +
        '**Load-more.** A column showing fewer than its `total` renders the **"Load more"** ' +
        'affordance from `design/boards/` (button and/or scroll-to-load via an ' +
        '`IntersectionObserver` sentinel); triggering it calls `GET /api/projects/[key]/' +
        'board/columns/[columnId]/cards?cursor=&limit=` (Story 3.1.6) and **appends** the returned ' +
        "page to that column's card list in the board state (the per-column-mutable shape from " +
        '3.2.2), advancing the cursor. Done/terminal columns are already windowed server-side — the ' +
        'UI just shows their count + load-more like any column.\n\n' +
        '**Virtualization.** A tall column **virtualizes** its card stack so the DOM row count ' +
        'stays bounded regardless of how many cards are loaded — **reusing the windowing primitive ' +
        'Story 2.5.15 establishes for the issue tree** (do NOT add a second virtualization ' +
        'library). The virtualized list must coexist with the 3.2.4 dnd-kit sortable (keep the ' +
        'dragged item + its neighbours mounted; this is a known dnd-kit + virtualization ' +
        'integration — follow the documented pattern).\n\n' +
        '**Out of scope here:** the move behaviour itself (3.2.4); swimlanes (3.3). This subtask is ' +
        'the count display, the load-more paging, and the windowing.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Each column shows its `total` count and, when more cards exist, a "Load more" affordance (button and/or scroll-sentinel) that fetches `GET …/columns/[id]/cards?cursor=` and appends the page, advancing the cursor — never a full-board refetch, never a load-all.\n' +
        '- A tall column virtualizes (the rendered DOM row count stays bounded as more pages load), reusing the 2.5.15 windowing primitive (no second virtualization dep).\n' +
        '- Virtualization coexists with drag-drop (a card can be dragged within/out of a virtualized column without detaching mid-drag).\n' +
        '- Against `pnpm db:seed:large`, a hundreds-of-cards column loads bounded pages and the DOM stays bounded (the finding-#57 proof).\n' +
        '- Vitest covers the page-append logic (cursor advance, no duplicate cards, count vs loaded reconciliation).\n\n' +
        '## Context refs\n\n' +
        '- Story 3.1.4 / 3.1.6 — the per-column `cursor`/`total` + `loadColumnCards` / `GET …/columns/[id]/cards` this consumes\n' +
        '- Story 2.5.15 — the virtualization/windowing primitive to reuse; `design/work-items/tree-scale.mock.html` — the load-more affordance language\n' +
        '- `design/boards/board.mock.html` + `design-notes.md` (3.2.1) — the column count + load-more design; finding #57 — bounded, no load-all\n' +
        '- dnd-kit + virtualization integration notes; `prodect-core/CLAUDE.md` — token rules',
    },
    {
      id: '3.2.6',
      title: 'Board completeness — empty state, unmapped-statuses tray, responsive + a11y',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['3.2.1', '3.2.2'],
      descriptionMd:
        'The real-product states that keep the board from being a green-path-only prototype — drawn ' +
        'per `design/boards/`.\n\n' +
        '**Empty board.** A project with no issues (all columns empty) shows the board **empty ' +
        'state** (`EmptyState`) with a **create-issue** affordance (reuse the existing ' +
        '`CreateIssueButton` / create modal), not just six blank columns.\n\n' +
        "**Unmapped-statuses tray.** 3.1's projection returns `unmappedStatuses` — project " +
        'statuses mapped to no board column (e.g. a custom status added after the board was seeded; ' +
        'the Jira behaviour). Surface them as a **tray/banner** (the 3.2.1 treatment) listing the ' +
        'unmapped statuses with a path to the board/workflow admin to map them — **never silently ' +
        'drop them**. When `unmappedStatuses` is empty the tray does not render.\n\n' +
        '**Responsive + a11y polish.** Horizontal column scroll on desktop with a usable **mobile** ' +
        'layout (per 3.2.1); the board exposes the right landmark/roles so the column structure is ' +
        'navigable by assistive tech (complementing the 3.2.4 drag announcements); focus order is ' +
        'sane across columns.\n\n' +
        '**Out of scope here:** the loading/error shells (3.2.2 ships those); WIP/swimlanes (3.3).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A project with no issues shows the board empty state with a working create-issue affordance (reusing the shipped create flow), not blank columns.\n' +
        '- `unmappedStatuses` from the projection renders as a tray/banner (with a link to map them) when non-empty, and is absent when empty; unmapped statuses are never shown as columns and never dropped.\n' +
        '- The board is responsive (desktop horizontal scroll + a usable mobile layout per 3.2.1) and exposes sane landmarks/roles + focus order for assistive tech.\n' +
        '- Colours via `--el-*`, shape via element tokens, AA-safe; matches `design/boards/`.\n' +
        '- Component tests assert the empty state (with create affordance) and the unmapped-tray present/absent branches.\n\n' +
        '## Context refs\n\n' +
        '- `components/ui/EmptyState`; `app/(authed)/_components/CreateIssueButton.tsx` / `CreateIssueModal.tsx` — the create flow to reuse\n' +
        '- Story 3.1.4 — the `unmappedStatuses` field on `BoardProjectionDto`; Story 2.2.5 — the workflow editor the tray links to\n' +
        '- `design/boards/board.mock.html` + `design-notes.md` (3.2.1) — the empty + unmapped-tray + responsive specs\n' +
        '- finding #57 (completeness/states in scope); `prodect-core/CLAUDE.md` — token rules',
    },
    {
      id: '3.2.7',
      title: 'Story tests — board UI components + drag/snap-back + keyboard-DnD E2E',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['3.2.2', '3.2.3', '3.2.4', '3.2.5', '3.2.6'],
      descriptionMd:
        'The closing test subtask for the board UI — the same split Story 3.1.7 used: this story ' +
        'ships its OWN component tests + the core drag/snap-back/keyboard E2E, while the ' +
        'cross-cutting Epic-3 journey (drag + WIP + swimlanes at scale) lives in the Epic test ' +
        'story 3.5. The 3.1 API contract is already E2E-proven (3.1.7); this proves the UI on top ' +
        'of it.\n\n' +
        '**Component / unit (vitest).** The optimistic-move reducer (apply → confirm on 200 → ' +
        'revert on 409/422, with correct column-count deltas); `BoardCard` rendering (type hue, ' +
        'key/title/assignee/priority/points, blocked indicator); `BoardColumn` (count, empty ' +
        'state); the column page-append logic (cursor advance, no dupes); the unmapped-tray ' +
        'present/absent branch.\n\n' +
        '**E2E (Playwright) `tests/e2e/board-ui.spec.ts`.** Against a freshly seeded project:\n' +
        '- **Render** — `/boards` shows the default columns in workflow order with cards grouped ' +
        'into the right columns + per-column counts.\n' +
        '- **Legal move** — drag a card across columns under a legal transition → it lands, the ' +
        'count updates, and a re-fetch/quick-view shows the new status (the move-as-transition ' +
        'contract, end-to-end through the UI).\n' +
        '- **Snap-back** — an illegal cross-column move under a `restricted` workflow → the card ' +
        'returns to its origin column and the status is unchanged on re-fetch (the 409 path).\n' +
        '- **In-column reorder** — drag within a column → rank changes, status + membership ' +
        'unchanged, order persists on reload.\n' +
        '- **Keyboard DnD** — move a card to another column using the keyboard alone (pick up / ' +
        'arrow / drop) → the move happens.\n\n' +
        'Defers to Story 3.5: WIP-limit and swimlane journeys, and the large-scale virtualization ' +
        "E2E (this story's scale proof is the 3.2.5 acceptance check against `db:seed:large`).\n\n" +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` covers the optimistic-move reducer (confirm/revert), `BoardCard`/`BoardColumn` render, the page-append logic, and the unmapped-tray branch.\n' +
        '- `pnpm test:e2e --grep board-ui` runs green over the real stack, asserting: column render + grouping + counts, a legal drag move (status persists), an illegal-move snap-back (409, status unchanged), an in-column reorder (rank only), and a keyboard-DnD move.\n' +
        '- The E2E reuses the real-Postgres harness (`tests/helpers/db.ts` truncation) and the seeded project; it does NOT duplicate the WIP/swimlane/scale journeys (Story 3.5).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/board-projection.spec.ts` (Story 3.1.7) — the API-level board E2E this builds the UI E2E on top of; `tests/e2e/workflow-flow.spec.ts` — the closing-E2E pattern\n' +
        '- `tests/helpers/db.ts` — real-Postgres truncation; the dnd-kit testing notes for driving keyboard/pointer DnD in Playwright\n' +
        '- Story 3.5 — the Epic-3 test story this defers WIP/swimlane/scale journeys to; `prodect-core/CLAUDE.md` — test conventions (real Postgres, no mocks)',
    },
  ],
};
