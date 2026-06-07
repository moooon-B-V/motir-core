import type { PlanStory } from '../types';

/**
 * Story 3.3 — Swimlanes + WIP limits.
 *
 * The board's flow-management layer, on top of the Story-3.2 Kanban surface:
 * group-by **swimlanes** (assignee / epic / priority / none) that slice the
 * board into collapsible horizontal rows, and per-column **WIP limits** with
 * *soft* over-limit warnings. Both are board configuration (the group-by lives
 * on the `board` entity; the per-column limit reuses the `board_column.wipLimit`
 * column 3.1.1 already shipped), so this story is part backend (a tiny schema
 * add + the config write path + a projection extension) and part frontend (the
 * group-by control, the swimlane rendering + cross-lane drag-reassign, and the
 * WIP config + over-limit treatment).
 *
 * ⚠️ Design gate (planning-time): the 3.2.1 `design/boards/board.mock.html`
 * mockup drew a WIP slot only as a NON-enforced placeholder and drew NO
 * swimlanes, NO WIP-config editor, and NO over-limit treatment — i.e. those
 * surfaces are *unspecified*, which under the gate means NO design exists. So
 * subtask 3.3.1 is a `type: design` subtask that EXTENDS `design/boards/`
 * (swimlanes layout + group-by control + WIP-config + over-limit warning), and
 * EVERY UI-touching code subtask (3.3.5, 3.3.6) carries 3.3.1 in `dependsOn` and
 * names the asset in Context-refs. A board-config code subtask never reaches the
 * ready set before its design asset exists (Principle #13: design before code).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 3.3`. Matches the
 * canonical depth + string-literal style of Stories 3.1 / 3.2.
 */
export const story_3_3: PlanStory = {
  id: '3.3',
  title: 'Swimlanes + WIP limits',
  status: 'planned',
  descriptionMd:
    'Two board flow-management features that turn the 3.2 Kanban surface from "columns of cards" ' +
    'into a tool a team manages flow with: **swimlanes** (group the board into horizontal rows by ' +
    'a dimension) and **WIP limits** (a per-column ceiling with a *soft* over-limit warning). Both ' +
    'are **board configuration persisted on the board entity** (the stub): the swimlane group-by is ' +
    'a new field on `board`; the per-column WIP limit reuses the `board_column.wipLimit Int?` column ' +
    'Story 3.1.1 already shipped FOR this story (no WIP migration needed). This story adds the ' +
    'config write path, the projection extension that groups cards into lanes, and the UI for both. ' +
    'It changes NO part of the 3.2 move contract — a drag is still a workflow transition; swimlanes ' +
    'and WIP sit on top.\n\n' +
    '**Swimlanes — the durable shape (mirror product = Jira; decision-ladder rung 1).** A swimlane ' +
    'is a horizontal row that slices EVERY column by a group-by dimension, so the board becomes a ' +
    'grid of (column × lane) cells. The group-by values this story ships, per the stub, are ' +
    '**`none` / `assignee` / `epic` / `priority`** — a `BoardSwimlaneGroupBy` enum on `board` ' +
    '(default `none`, i.e. the flat 3.2 board). Jira behaviours we mirror: lanes render only for ' +
    'group values **present on the board** (no empty 200-row assignee list); a card with no value ' +
    'for the dimension (unassigned / no epic) falls into a **catch-all lane** ("No assignee" / "No ' +
    'epic") that always sorts last; each lane has a header with its label + an aggregate card count ' +
    'and is **collapsible** (collapsed lanes persist client-side). Group-by `epic` groups by a ' +
    "card's ancestor **epic**, not its immediate parent — so the projection resolves each card's " +
    'lane membership server-side (below), the client never re-derives it.\n\n' +
    '**Cross-lane drag = reassign the grouped field (mirror-faithful, reuses existing endpoints).** ' +
    'Once the board is sliced into lanes, dragging a card between lanes must DO something — a lane a ' +
    'card can be dropped into that silently snaps back is a broken affordance. Jira reassigns the ' +
    'grouped field on a cross-lane drop, so we do the same: dropping a card into another **assignee** ' +
    'lane reassigns the assignee, another **priority** lane changes priority, another **epic** lane ' +
    'reparents to that epic — each via the **existing Story-2.5 issue-field update endpoints** (the ' +
    'same inline-edit paths `IssueInlineEdit` already calls), NOT a new backend and NOT the ' +
    'board/move endpoint (which is status only). A drag may change BOTH column and lane (a diagonal ' +
    'drop): the column change is the 3.2 transition, the lane change is the field reassign, applied ' +
    'as the two appropriate writes; both reconcile optimistically and snap back independently on ' +
    'rejection (the 3.2.4 pattern). A drop into the catch-all lane clears the field (unassign / ' +
    'remove epic) where that is legal. This is the justified-deviation rung-1 default, not added ' +
    'complexity for its own sake — it reuses shipped endpoints and is the standard board behaviour.\n\n' +
    '**WIP limits — per-column, SOFT (the stub says "soft over-limit warnings").** A column may ' +
    'carry an optional integer WIP limit (the existing `board_column.wipLimit`). When a column holds ' +
    'MORE cards than its limit it is shown **over-limit** — a warning treatment on the column header ' +
    'and its count (e.g. `6/5`), NOT signalled by colour alone (finding #35: pair the hue with an ' +
    'icon/label). Crucially **soft means advisory, never blocking**: an over-limit column does NOT ' +
    'reject drops, so the 3.2.4 move contract is unchanged — WIP only *warns*. The limit is ' +
    '**per-column total** (the Jira-classic shape), counted across all swimlanes when lanes are on; ' +
    'per-lane WIP is a deviation with no stated use case, so we match the mirror (no complexity for ' +
    'nothing). The limit is edited inline via the column actions `[⋯]` menu the 3.2.1 design already ' +
    'reserved — no separate settings page.\n\n' +
    '**Where the config lives + who can set it.** The group-by selector is a control in the board ' +
    'header (3.2.1 reserved "a place for the 3.3 controls"); the WIP limit is set per column via ' +
    'its `[⋯]` menu. Both are board-config **writes** that go through the 4-layer architecture ' +
    '(Route → Service → Repository → Prisma) with the explicit application-layer `workspaceId` gate ' +
    '(finding #26). Roles/permissions are Epic 6.4 (not built yet), so — like the Story-2.2.5 ' +
    'workflow editor, which is a project-settings write any member can make today — these config ' +
    'writes are membership-gated now and will be role-gated when 6.4 lands (a note in the service, ' +
    'not an early RBAC build — rung-2 consistency with shipped code).\n\n' +
    '**Scale shape — lanes stay bounded, never "load every row" (finding #57).** Swimlanes must not ' +
    'regress the 3.1/3.2 bounded projection. The projection stays **paged per column**; each card ' +
    'already carries its lane membership (the service stamps a resolved `swimlaneKey` per the active ' +
    'group-by), and the projection additionally returns the **ordered lane list** (key + label + ' +
    'per-lane total count) via a bounded grouped/distinct aggregate (lanes-with-cards only, + the ' +
    'catch-all) — NOT by loading every card to discover the lanes. The UI buckets the loaded ' +
    'per-column page into (lane, column) cells and a column\'s 3.2.5 "load more" pulls the rest; the ' +
    'per-column 3.2.5 virtualization still applies. A board that fetched all cards to build lanes ' +
    'would be prototype-thinking; the lane list is an aggregate and the cards stay paged.\n\n' +
    '**Completeness — the real-product states.** Switching group-by re-lays the board with a loading ' +
    'transition (not a flash of the old layout); a board with a single lane value collapses to the ' +
    'flat view sensibly; the catch-all lane renders even when it is the only populated lane; an ' +
    'over-limit column at exactly the limit is NOT warned (strictly greater than); clearing a WIP ' +
    'limit removes the warning. Swimlanes + WIP must remain keyboard- and screen-reader-navigable ' +
    '(lane headers are landmarks/regions; collapse is operable; over-limit state is announced, not ' +
    'colour-only).\n\n' +
    '**Out of scope (Epic-3 siblings / later):** the sprint-scoped Scrum board (Story 3.4); the ' +
    'cross-cutting drag + WIP + swimlane Playwright journey **at scale** (Story 3.5 — this story ' +
    'ships its OWN component tests + the focused swimlane/WIP E2E, the same split 3.1.7 / 3.2.7 ' +
    'used); per-lane (rather than per-column) WIP limits (no stated use case → match the mirror); ' +
    'the column↔status mapping admin (**Story 3.6**, which extends THIS story’s board-config ' +
    'service/API seam) and board CRUD / multi-board (**Story 3.7**); ' +
    'saved swimlane queries / JQL-style custom lanes (Jira has them; not in the stub, no stated use ' +
    'case → deferred). The flat board, the drag-as-transition contract, the per-column count, and ' +
    'the load-more/virtualization all come from Stories 3.1 + 3.2 and are reused, not rebuilt.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (picks up the `board.swimlaneGroupBy` column), `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test` — vitest covers: the `swimlaneGroupBy` write + `wipLimit` write services (workspace-gated), the projection lane-grouping (correct `swimlaneKey` per group-by incl. epic-ancestor resolution, the catch-all lane, per-lane counts, still bounded/paged), the over-limit predicate (strictly-greater, exactly-at-limit not warned), and the cross-lane reassign reducer.\n' +
    '- `pnpm test:e2e --grep board-swimlanes` — Playwright drives the real board: set group-by → lanes render; collapse a lane; set a column WIP limit → over-limit warning shows; an over-limit drop still SUCCEEDS (soft); a cross-lane drag reassigns the field.\n' +
    '- **Swimlane render check:** open `/boards` on the seeded `moooon` → `prodect` project, switch group-by to **Assignee** → the board re-lays into one row per assignee that has cards + a "No assignee" catch-all lane last; each lane header shows a label + an aggregate count; switching to **Priority** and **Epic** regroups; **None** returns the flat 3.2 board. The layout matches `design/boards/swimlanes-wip.mock.html`.\n' +
    '- **Group-by epic check:** with group-by **Epic**, a story/task lands in the lane of its ancestor **epic** (not its immediate parent); a card with no epic ancestor falls into the "No epic" catch-all.\n' +
    '- **Cross-lane reassign check:** with group-by Assignee, drag a card from one assignee lane into another → the assignee is reassigned (re-open the issue / quick-view to confirm) with no status change; drag into "No assignee" → the card is unassigned. Under group-by Priority, the same drag changes priority. A diagonal drag (different column AND lane) both transitions and reassigns; an illegal transition snaps the column part back while the lane part is unaffected (independent reconcile).\n' +
    '- **WIP soft-warning check:** set a column WIP limit of 2 via the column `[⋯]` menu on a column holding 3 cards → the column header + count render the over-limit warning (`3/2`) paired with an icon/label (not colour-alone, finding #35). Drag a 4th card in → the drop **succeeds** (soft, never blocked) and the warning persists. Remove the limit → the warning clears. A column at exactly its limit (2/2) is NOT warned.\n' +
    '- **Scale check (finding #57):** `pnpm db:seed:large`, group by Assignee on a project with hundreds of cards → lanes render from the bounded aggregate (no all-cards fetch), each (lane, column) cell shows the loaded cards + the column "load more" still pages, and the DOM row count stays bounded (virtualization intact).\n' +
    '- **a11y check:** group-by selector + lane collapse are keyboard-operable; lane headers expose region/landmark roles; the over-limit state is announced to assistive tech, not signalled by colour alone.',
  items: [
    {
      id: '3.3.1',
      title:
        'Design — swimlanes layout + group-by control + WIP config + over-limit warning (extends design/boards/)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      dependsOn: ['3.2.1'],
      descriptionMd:
        'The design asset every UI subtask of this story builds against. The 3.2.1 board mockup drew ' +
        'a WIP slot only as a NON-enforced **placeholder** and drew NO swimlanes, NO WIP-config ' +
        'editor, and NO over-limit treatment — under the design gate, unspecified == no design, so ' +
        'this subtask produces it FIRST (mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 and the 3.2.1 board ' +
        'design it extends). Output: `design/boards/swimlanes-wip.mock.html` (an HTML mockup built ' +
        'from the real design system — `components/ui/*` + the `--el-*` tokens, so a coding agent ' +
        'has no Pencil→code gap) + a PNG export + an extension of `design/boards/design-notes.md` ' +
        '(a "Swimlanes + WIP (Story 3.3)" section) naming the composing primitives, copy, and ' +
        'placement. `--el-*` only (no Tier-0 `--color-*`); shape via the element shape tokens; ' +
        'AA-safe; Jira/Linear boards as the mirror.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Group-by control** — a board-header control (in the slot 3.2.1 reserved for the 3.3 ' +
        'controls) letting the user pick None / Assignee / Epic / Priority. Reuse a shipped ' +
        'select/segmented primitive (do not invent a control); show the active group-by; note it ' +
        'persists to the board (server) so all viewers see it.\n' +
        '- **Swimlane row** — a horizontal lane spanning all columns: a sticky **lane header** ' +
        '(group label — assignee name+avatar / epic key+title / priority pill / the catch-all "No ' +
        '<dim>") + an **aggregate card count** + a **collapse/expand** chevron (collapsed lanes ' +
        'show just the header + count). Draw the lane grid (column boundaries align across lanes), ' +
        'the catch-all lane sorted last, and the flat (group-by None) board as the baseline. Lane ' +
        'order rule documented (alpha / priority-rank / epic-position; catch-all last).\n' +
        '- **Cross-lane drag** — the drop treatment when a card is dragged into a DIFFERENT lane ' +
        '(reassign the grouped field): the target-lane highlight + insertion indicator (NOT ' +
        'colour-alone, finding #35), and the diagonal case (different column AND lane). Document the ' +
        '`aria-live` announcement copy for a reassign vs a transition vs a diagonal move.\n' +
        '- **WIP-limit config** — the editor reached from the column actions `[⋯]` menu (reserved in ' +
        '3.2.1): a small "Set WIP limit" field (integer, clearable). Document the empty/none state ' +
        '(no limit → the count shows plain).\n' +
        '- **Over-limit warning (SOFT)** — the column header + count treatment when cards > limit ' +
        '(e.g. `6/5`): a warning hue (`--el-warning`/`--el-danger` family) PAIRED with an icon and/' +
        'or the `n/limit` label so it is not colour-alone (finding #35); the at-limit (`5/5`) and ' +
        'under-limit (`3/5`) states for contrast. Make explicit in the notes that the warning is ' +
        'advisory and does NOT block drops.\n' +
        '- **States** — switching group-by (the re-lay loading transition), a single-lane board, the ' +
        'catch-all-only board, and the over-limit + collapsed-lane combinations.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/boards/swimlanes-wip.mock.html` + a PNG export + a "Swimlanes + WIP (Story 3.3)" section in `design/boards/design-notes.md` exist; the mockup is built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape), passes the render checklist (icon viewBox, no nested buttons, prettier), and is AA-safe.\n' +
        '- The mockup draws: the group-by control, the swimlane row (header + count + collapse), the catch-all lane (sorted last), the cross-lane drag/diagonal drop treatment (not colour-alone), the column-`[⋯]` WIP-config editor, and the under/at/over-limit count states.\n' +
        '- `design-notes.md` names each composing primitive (the select/segmented control, `Pill`, `IssueTypeIcon`, the column `[⋯]` menu, `Tooltip`), documents the lane-order rule, the collapse-persistence, the `aria-live` copy for reassign/transition/diagonal, and states explicitly that WIP is a SOFT warning (never blocks a drop).\n' +
        '- Over-limit + drop affordances do not rely on colour alone (finding #35); hues come from `--el-*`.\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/board.mock.html` + `design-notes.md` (3.2.1) — the base board this extends (the reserved WIP slot + the column `[⋯]` + the 3.3-controls slot in the header)\n' +
        '- `design/work-items/list.mock.html` + `design-notes.md` (2.5) — the card/cell visual language + the assignee/priority/epic primitives reused in lane headers\n' +
        '- `components/ui/*` (Select/Segmented, Pill, Tooltip, the menu primitive) + `app/(authed)/issues/_components/issueCellPrimitives.tsx` + `IssueTypeIcon` — the primitives to compose\n' +
        '- `app/globals.css` `--el-*` (incl. `--el-warning`/`--el-danger`) + element-shape tokens; the `/tokens` specimen route\n' +
        '- Jira / Linear swimlanes + column WIP as the mirror; finding #35 (not colour-alone), #54 (use the palette)',
    },
    {
      id: '3.3.2',
      title: 'Schema — `board.swimlaneGroupBy` enum + migration (WIP column already exists)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['3.1.1'],
      descriptionMd:
        'Persist the swimlane group-by on the board entity (the stub: "Config persisted on the board ' +
        'entity"). This is the ONLY schema change the story needs — the per-column WIP limit reuses ' +
        'the `board_column.wipLimit Int?` column Story 3.1.1 already shipped explicitly for 3.3, so ' +
        'there is NO WIP migration.\n\n' +
        '**The change.** Add a Prisma enum `BoardSwimlaneGroupBy { none, assignee, epic, priority }` ' +
        'and a `board.swimlaneGroupBy BoardSwimlaneGroupBy @default(none)` column, in ONE migration. ' +
        '`none` is the flat 3.2 board (the default, so every existing/seeded board is unchanged). ' +
        'The enum values are exactly the stub-specified dimensions; adding more later (e.g. a custom ' +
        'query lane) is a non-breaking enum addition. No new table, no RLS change (the column lives ' +
        'on the already-RLS-forced `board` table from 3.1.1; tenant isolation is inherited).\n\n' +
        '**What this does NOT do:** the config write service/route (3.3.3); the projection grouping ' +
        '(3.3.4); any UI (3.3.5/3.3.6). It also does NOT touch `board_column.wipLimit` (already ' +
        'present) or add a per-lane-WIP column (out of scope — per-column WIP only).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `BoardSwimlaneGroupBy` enum + `board.swimlaneGroupBy @default(none)` added in ONE Prisma migration; `prisma migrate dev` applies cleanly against a fresh DB and is idempotent on re-run.\n' +
        '- Existing/seeded boards default to `none` (the flat board) with no data backfill needed.\n' +
        '- No new table and no RLS policy change (the column inherits the 3.1.1 `board` RLS); `prisma generate` types the new field.\n' +
        '- A vitest assertion (real Postgres) confirms a board defaults to `none` and accepts each enum value.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — the `board` model + `BoardType` enum (3.1.1) to mirror for the new enum; `board_column.wipLimit` (already present — confirm, do not re-add)\n' +
        '- Story 3.1.1 — the board tables + RLS pattern this extends\n' +
        '- `prodect-core/CLAUDE.md` — migration conventions (one migration, application-seeded data, RLS-forced tables)',
    },
    {
      id: '3.3.3',
      title: 'Board config service + API — set swimlane group-by + per-column WIP limit',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.3.2', '3.1.3'],
      descriptionMd:
        'The write path for both pieces of board config, through the 4-layer architecture (Route → ' +
        'Service → Repository → Prisma), with the explicit application-layer `workspaceId` gate ' +
        '(finding #26). No business logic in the route; the service owns the transaction + DTO ' +
        'mapping; the repository writes are single-op with required `tx`.\n\n' +
        '**`boardsService.setSwimlaneGroupBy(boardId, groupBy, ctx)`** — validates `groupBy` is a ' +
        '`BoardSwimlaneGroupBy`, updates `board.swimlaneGroupBy` (via `boardRepository.update`, ' +
        'tx-required), returns the updated board DTO. **`boardsService.setColumnWipLimit(columnId, ' +
        'limit, ctx)`** — `limit` is a non-negative integer OR `null` (clear); validates ' +
        '(reject negatives / non-integers with a typed error), updates `board_column.wipLimit` (via ' +
        '`boardColumnRepository.update`, tx-required), returns the updated column DTO. Both verify the ' +
        "board/column belongs to a project in the caller's workspace BEFORE writing (the finding-#26 " +
        'app-layer gate; RLS is the backstop, not the sole guard).\n\n' +
        '**Permissions note (no early RBAC).** Roles/permissions are Epic 6.4. Mirror the Story-2.2.5 ' +
        'workflow editor — a project-settings write any workspace member can make today — so these ' +
        'config writes are **membership-gated now**, with a `// TODO(6.4): gate by project role` note ' +
        'in the service. Do NOT build a role check this story (rung-2 consistency with shipped code; ' +
        'inventing RBAC early is the forbidden shortcut in the other direction).\n\n' +
        '**Routes.** `PATCH /api/projects/[key]/board` (body `{ swimlaneGroupBy }`) → ' +
        '`setSwimlaneGroupBy`; `PATCH /api/projects/[key]/board/columns/[columnId]` (body ' +
        '`{ wipLimit: number | null }`) → `setColumnWipLimit`. Both read the session via ' +
        '`getSession()`, call exactly one service method, and map typed errors to status codes ' +
        '(400 invalid limit, 403 wrong workspace, 404 missing board/column).\n\n' +
        '**Out of scope here:** reading the config back into the board (the projection — 3.3.4 ' +
        'returns `swimlaneGroupBy` + per-column `wipLimit`); any UI (3.3.5/3.3.6).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `boardsService.setSwimlaneGroupBy` + `setColumnWipLimit` exist, own their transaction, validate input (invalid group-by / negative / non-integer limit → typed error), and write via tx-required repository methods; both enforce the explicit `workspaceId` gate before writing.\n' +
        '- `setColumnWipLimit` accepts a non-negative integer or `null` (clear); a negative/non-integer is rejected with a typed error mapped to HTTP 400.\n' +
        '- `PATCH …/board` and `PATCH …/board/columns/[columnId]` routes are HTTP-only (one service call each, typed-error→status mapping, no Prisma/transaction in the route); a write from a different workspace is 403/404.\n' +
        '- A `// TODO(6.4)` role-gate note is present; NO role check is built this story (membership gate only, matching 2.2.5).\n' +
        '- Returns DTOs (no raw Prisma rows cross the boundary), mapped in `lib/mappers/boardMappers.ts`.\n' +
        '- Vitest (real Postgres) covers: a successful group-by set, a successful + a clearing WIP set, the invalid-limit rejection, and the cross-workspace denial.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/boardsService.ts` + `lib/repositories/boardRepository.ts` / `boardColumnRepository.ts` (Story 3.1.3) — the services/repos this extends (add the two writes)\n' +
        '- `lib/services/workflowsService.ts` + `app/api/.../settings/project/workflow` (Story 2.2.5) — the project-settings write + membership-gate precedent to mirror (incl. the "member can write, RBAC later" stance)\n' +
        '- `lib/dto/boards.ts` + `lib/mappers/boardMappers.ts` — the board/column DTO shapes to return\n' +
        '- finding #26 — the explicit app-layer `workspaceId` gate; `prodect-core/CLAUDE.md` — the 4-layer rules (route HTTP-only, service owns tx + DTO, repo single-op tx-required write)',
    },
    {
      id: '3.3.4',
      title:
        'Projection — swimlane grouping (resolved `swimlaneKey` + bounded lane list) + WIP count, in `getBoard`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['3.3.3', '3.1.4'],
      descriptionMd:
        'Extend the Story-3.1.4 `boardsService.getBoard` projection so the UI can render swimlanes ' +
        'and the WIP state — **without regressing the bounded, never-load-all shape** (finding #57). ' +
        '3.1.4 already returns ordered columns, each with a bounded first page of `BoardCardDto`, a ' +
        'per-column total + cursor, and the `wipLimit` on each column. This subtask adds the lane ' +
        'dimension.\n\n' +
        "**`swimlaneGroupBy` on the projection.** `getBoard` returns the board's active " +
        '`swimlaneGroupBy`. When it is `none`, the projection is exactly the 3.1.4 flat shape (no ' +
        'behaviour change). When it is `assignee` / `epic` / `priority`:\n' +
        '- **Per-card `swimlaneKey` (resolved server-side).** Each `BoardCardDto` is stamped with a ' +
        '`swimlaneKey` for the active group-by so the client never re-derives it: `assignee` → ' +
        '`assigneeId` (or the catch-all key for unassigned); `priority` → the priority value; ' +
        "`epic` → the card's **ancestor epic** id (walk the parent chain to the epic, NOT the " +
        'immediate parent — a task under a story under an epic groups by the epic), or the catch-all ' +
        'key when there is no epic ancestor.\n' +
        '- **The lane list (bounded aggregate, NOT load-all).** A top-level `swimlanes: ' +
        'BoardSwimlaneDto[]` — `{ key, label, kind, count }` — built from a **grouped/distinct ' +
        "aggregate query** over the project's issues (lanes that actually have cards + the " +
        'catch-all), ordered by the documented lane-order rule (assignee alpha / priority rank / ' +
        'epic position; catch-all last). This is an aggregate, so it does NOT load every card to ' +
        'discover lanes. The label/kind let the UI render the lane header (assignee summary / epic ' +
        'key+title / priority) without extra fetches.\n\n' +
        '**Pagination stays per column (finding #57).** Cards continue to page per column via the ' +
        '3.1.4 first-page + `loadColumnCards` cursor; the client buckets the loaded page into (lane, ' +
        'column) cells by `swimlaneKey`, and "load more" on a column pulls the rest. The projection ' +
        'does NOT page per (lane × column) cell (that CxL explosion is over-engineering with no ' +
        'stated need); per-lane TOTAL counts come from the aggregate, per-column totals from 3.1.4. ' +
        'Document this as the durable bounded shape.\n\n' +
        "**Epic-ancestor resolution.** Resolve each card's epic ancestor efficiently (a single " +
        "batched lookup over the page's cards' ancestor chains / a recursive CTE), not an N+1 walk; " +
        'reuse any Story-1.4 / 2.5 ancestor helper if one exists.\n\n' +
        '**Out of scope here:** WIP *enforcement* (there is none — it stays a UI soft warning, 3.3.6; ' +
        'the projection just carries `wipLimit` + the per-column count); any UI (3.3.5/3.3.6); the ' +
        'config writes (3.3.3).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `getBoard` returns the active `swimlaneGroupBy`; with `none` the projection is byte-for-byte the 3.1.4 flat shape (no regression).\n' +
        '- With a non-`none` group-by, each `BoardCardDto` carries a correct `swimlaneKey` (assignee / priority value / **ancestor-epic** id / catch-all), and a top-level `swimlanes: { key, label, kind, count }[]` lists lanes-with-cards + the catch-all, in the documented order.\n' +
        '- The lane list is built from a bounded grouped/distinct aggregate (no all-cards fetch); per-card cursor pagination per column is unchanged; the projection never returns every card.\n' +
        '- Epic grouping uses the ancestor epic (not the immediate parent), resolved without N+1.\n' +
        '- `wipLimit` + the per-column total count remain on each column (carried for 3.3.6; the projection does NOT enforce WIP).\n' +
        '- Vitest (real Postgres) covers: each group-by resolving the right `swimlaneKey` (incl. epic-ancestor + each catch-all), the lane list + per-lane counts, the `none` no-op, and that pagination/bounding is preserved (no load-all).\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/boardsService.ts` `getBoard` + `lib/mappers/boardMappers.ts` + `lib/dto/boards.ts` (Story 3.1.4) — the projection + `BoardProjectionDto`/`BoardCardDto` this extends\n' +
        '- `lib/repositories/workItemRepository.ts` — `findProjectIssuesFlat` / count + any ancestor/parent-chain helper (Story 1.4 / 2.5) for epic resolution\n' +
        '- `lib/dto/workItems.ts` — the assignee-summary / priority / parent fields the lane labels reuse\n' +
        '- finding #57 — bounded projection (no load-all); `prodect-core/CLAUDE.md` — service owns DTO mapping, mappers in `lib/mappers/*`',
    },
    {
      id: '3.3.5',
      title:
        'Swimlane UI — group-by control, collapsible lanes + catch-all, cross-lane drag-reassign',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['3.3.1', '3.3.4', '3.2.4', '3.2.5'],
      descriptionMd:
        'Render swimlanes on the 3.2 board and make cross-lane drag reassign the grouped field — ' +
        'drawn per `design/boards/swimlanes-wip.mock.html`, reusing the 3.2 board container, ' +
        'columns, cards, dnd-kit context, and virtualization (NOT a parallel board).\n\n' +
        '**Group-by control.** A board-header control (in the 3.2.1-reserved 3.3-controls slot) ' +
        'offering None / Assignee / Epic / Priority, reusing a shipped select/segmented primitive. ' +
        'Changing it PATCHes `board.swimlaneGroupBy` (3.3.3) and re-lays the board from the 3.3.4 ' +
        'projection (a loading transition, not a flash of the old layout). The active value is read ' +
        'from the projection so all viewers share it.\n\n' +
        '**Swimlane rendering.** When group-by ≠ none, render one **lane** per `swimlanes[]` entry: ' +
        'a sticky lane header (label/kind from the DTO — assignee avatar+name / epic key+title / ' +
        'priority pill / the catch-all "No <dim>") + the aggregate count + a **collapse/expand** ' +
        'chevron (collapsed state persisted client-side, e.g. localStorage keyed by board+lane). ' +
        'Within a lane, the existing `BoardColumn`/`BoardCard` (3.2.3) render the cards bucketed by ' +
        '`swimlaneKey`; column boundaries align across lanes; the catch-all lane sorts last. ' +
        'Group-by none renders the flat 3.2 board unchanged.\n\n' +
        '**Cross-lane drag = reassign (reuses existing endpoints, no new backend).** Extend the ' +
        "3.2.4 dnd-kit drop handler: resolve the drop's target **column** AND target **lane**. A " +
        'column change is the 3.2 transition (`POST …/board/move`, unchanged). A **lane** change ' +
        'reassigns the grouped field via the EXISTING Story-2.5 issue-field update endpoint — ' +
        'assignee lane → reassign assignee, priority lane → change priority, epic lane → reparent to ' +
        'that epic (drop into the catch-all clears the field where legal). A diagonal drop applies ' +
        'BOTH writes. Each write is **optimistic with independent snap-back** (the 3.2.4 pattern): ' +
        'on rejection of one (e.g. an illegal transition 409), revert only that axis; never leave the ' +
        'card in a lying position. `aria-live` announces reassign vs transition vs diagonal per the ' +
        '3.3.1 copy. Keyboard DnD must move a card across lanes too.\n\n' +
        '**Virtualization coexistence.** Lanes must keep the 3.2.5 per-column windowing + load-more ' +
        "working within each lane's column slice (do NOT add a second virtualization lib; reuse the " +
        '2.5.15 primitive). A collapsed lane unmounts its card bodies (cheap) but keeps its header + ' +
        'count.\n\n' +
        '**Out of scope here:** the WIP config + over-limit warning (3.3.6); per-lane WIP (per-column matches the mirror; no stated use case for per-lane).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A board-header group-by control (None/Assignee/Epic/Priority) PATCHes `board.swimlaneGroupBy` (3.3.3) and re-lays the board from the projection with a loading transition; the active value is shared (read from the projection).\n' +
        '- Group-by ≠ none renders one collapsible lane per `swimlanes[]` entry (sticky header + label/kind + aggregate count + chevron), cards bucketed by `swimlaneKey`, column boundaries aligned across lanes, the catch-all lane last; collapse state persists client-side; group-by none is the flat 3.2 board.\n' +
        '- A cross-lane drag reassigns the grouped field via the existing 2.5 issue-field endpoint (assignee/priority/epic-reparent; catch-all clears where legal) — NOT the board/move endpoint, NO new backend; a diagonal drop applies both the transition and the reassign, each optimistic with independent snap-back on rejection.\n' +
        '- Keyboard DnD moves a card across lanes with the correct `aria-live` announcement; per-column virtualization + load-more still work within lanes (no second virtualization dep).\n' +
        '- Colours via `--el-*`, shape via element tokens, AA-safe; drag/lane affordances not colour-alone (finding #35); matches `design/boards/swimlanes-wip.mock.html`.\n' +
        '- Component tests assert lane rendering + bucketing + catch-all, collapse persistence, and the cross-lane reassign reducer (incl. diagonal + independent revert).\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/_components/*` (Stories 3.2.2–3.2.5) — the board container, `BoardColumn`/`BoardCard`, the dnd-kit `DndContext` + drop handler, and the load-more/virtualization to extend (NOT fork)\n' +
        '- `app/(authed)/issues/_components/IssueInlineEdit.tsx` + the Story-2.5 assignee/priority/parent update endpoints — the field-reassign path the cross-lane drop reuses (the same optimistic precedent 3.2.4 mirrors)\n' +
        '- Story 3.3.3 — the `PATCH …/board` group-by write; Story 3.3.4 — the `swimlaneGroupBy` + `swimlanes[]` + per-card `swimlaneKey` projection this binds to\n' +
        '- Story 2.5.15 — the virtualization primitive to reuse; `design/boards/swimlanes-wip.mock.html` + `design-notes.md` (3.3.1) — the lane/drag/announcement spec\n' +
        '- finding #35 (not colour-alone); `prodect-core/CLAUDE.md` — `--el-*` + element-shape rules (client UI)',
    },
    {
      id: '3.3.6',
      title: 'WIP-limit UI — per-column config (column `[⋯]` menu) + SOFT over-limit warning',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['3.3.1', '3.3.3', '3.2.3'],
      descriptionMd:
        'Let a user set a per-column WIP limit and surface an over-limit column as a **soft** ' +
        'warning — drawn per `design/boards/swimlanes-wip.mock.html`, on the 3.2.3 `BoardColumn` ' +
        '(which already reserved the WIP slot + the `[⋯]` actions menu).\n\n' +
        '**Config editor.** The column `[⋯]` menu gains a **"Set WIP limit"** action opening a small ' +
        'integer field (clearable to remove the limit). Saving calls `PATCH …/board/columns/' +
        '[columnId]` (3.3.3) with `{ wipLimit }` (or `null`), optimistically updates the column, and ' +
        'reconciles to the returned column DTO. Validation mirrors the service (non-negative ' +
        'integer); an invalid entry is blocked client-side with the error copy.\n\n' +
        '**Over-limit warning (SOFT — the load-bearing semantic).** The column header + count badge ' +
        'render the limit as `n/limit` (e.g. `3/5`). When `n > limit` (strictly greater — `5/5` is ' +
        'NOT warned) the column shows the over-limit treatment from 3.3.1: a warning hue ' +
        '(`--el-warning`/`--el-danger`) PAIRED with an icon and/or the `n/limit` label so it is ' +
        '**not colour-alone** (finding #35), and announced to assistive tech. **Soft = advisory:** ' +
        'an over-limit column does NOT block drops — the 3.2.4 move contract is untouched; dragging a ' +
        'card into an at/over-limit column still succeeds. No limit set → the count renders plain (no ' +
        'slot, no warning). When swimlanes are on, the limit is the **per-column total** across lanes ' +
        '(counted from the per-column total, not per lane).\n\n' +
        '**Out of scope here:** swimlane rendering + cross-lane drag (3.3.5); per-lane WIP; any ' +
        'HARD/blocking enforcement (explicitly NOT built — the stub says soft).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The column `[⋯]` menu offers "Set WIP limit" with an integer field (clearable); saving PATCHes `…/board/columns/[id]` (3.3.3), updates optimistically, reconciles to the DTO, and blocks an invalid (negative/non-integer) entry client-side.\n' +
        '- A column with a limit shows `n/limit`; when `n > limit` it shows the over-limit warning (hue + icon/label, not colour-alone, finding #35) and announces it; `n == limit` is NOT warned; no limit → plain count.\n' +
        '- The warning is SOFT: a drop into an at/over-limit column still succeeds (the 3.2.4 move contract is unchanged) — verified, not assumed.\n' +
        '- With swimlanes on, the limit is evaluated against the per-column total across lanes.\n' +
        '- Colours via `--el-*`, shape via element tokens, AA-safe; matches `design/boards/swimlanes-wip.mock.html`.\n' +
        '- Component tests assert the over-limit predicate (under/at/over), the no-limit plain state, the optimistic config update, and that an over-limit drop is not blocked.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/_components/BoardColumn.tsx` (Story 3.2.3) — the column header + reserved WIP slot + `[⋯]` menu this fills; the 3.2.4 drop handler (confirm it is NOT WIP-gated)\n' +
        '- Story 3.3.3 — the `PATCH …/board/columns/[id]` WIP write this calls; Story 3.3.4 — the `wipLimit` + per-column count on the projection\n' +
        '- `components/ui/*` (the menu primitive, input, `Tooltip`, the warning Pill/badge) + `--el-warning`/`--el-danger` tokens\n' +
        '- `design/boards/swimlanes-wip.mock.html` + `design-notes.md` (3.3.1) — the WIP-config + over-limit spec; finding #35 (not colour-alone); `prodect-core/CLAUDE.md` — token rules',
    },
    {
      id: '3.3.7',
      title:
        'Story tests — swimlane grouping + WIP soft-warning + cross-lane reassign (component + focused E2E)',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.3.2', '3.3.3', '3.3.4', '3.3.5', '3.3.6'],
      descriptionMd:
        'The closing test subtask for swimlanes + WIP — the same split Stories 3.1.7 / 3.2.7 used: ' +
        'this story ships its OWN component/unit tests + a focused swimlane/WIP E2E, while the ' +
        'cross-cutting Epic-3 journey (drag + WIP + swimlanes AT SCALE) lives in the Epic test story ' +
        '3.5. The 3.1 API + 3.2 UI are already proven; this proves the 3.3 layer on top.\n\n' +
        '**Component / unit (vitest, real Postgres where DB-touching).** The config write services ' +
        '(group-by set, WIP set + clear, invalid-limit reject, cross-workspace deny — may overlap ' +
        '3.3.3, keep the integration assertions here); the projection lane-grouping (correct ' +
        '`swimlaneKey` per group-by incl. epic-ancestor, catch-all, per-lane counts, the `none` ' +
        'no-op, bounded/paged preserved); the over-limit predicate (under/at/over, strictly-greater); ' +
        'the cross-lane reassign reducer (assignee/priority/epic, catch-all clear, diagonal, ' +
        'independent revert); lane render + bucketing + collapse persistence.\n\n' +
        '**E2E (Playwright) `tests/e2e/board-swimlanes.spec.ts`.** Against a freshly seeded project:\n' +
        '- **Group-by** — set group-by Assignee → the board re-lays into one lane per assignee-with-' +
        'cards + a "No assignee" catch-all last; switch to Priority / Epic / None and the layout ' +
        'regroups / flattens.\n' +
        '- **Collapse** — collapse a lane → its cards hide, header + count remain; it stays collapsed ' +
        'on reload.\n' +
        '- **Cross-lane reassign** — drag a card into another assignee lane → the assignee is ' +
        'reassigned (confirmed via re-fetch/quick-view), status unchanged; drag into "No assignee" → ' +
        'unassigned.\n' +
        '- **WIP soft warning** — set a column WIP limit below its card count via the `[⋯]` menu → ' +
        'the over-limit warning shows (`n/limit` + icon, not colour-alone); drag another card in → ' +
        'the drop SUCCEEDS (soft) and the warning persists; clear the limit → the warning goes; a ' +
        'column at exactly its limit is not warned.\n\n' +
        'Defers to Story 3.5: the combined drag + WIP + swimlane journey at scale and the ' +
        "large-data lane/virtualization E2E (this story's scale proof is the 3.3.4/3.3.5 acceptance " +
        'checks against `db:seed:large`).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` covers the config writes, the projection lane-grouping (incl. epic-ancestor + catch-all + the `none` no-op + bounded preservation), the over-limit predicate, the cross-lane reassign reducer (incl. diagonal + independent revert), and lane render/bucketing/collapse.\n' +
        '- `pnpm test:e2e --grep board-swimlanes` runs green over the real stack, asserting: group-by re-lay (each dimension + catch-all + flatten), lane collapse persistence, a cross-lane reassign (field changed, status unchanged), and the WIP SOFT warning (over-limit shows, drop still succeeds, clear removes it, at-limit not warned).\n' +
        '- The E2E reuses the real-Postgres harness (`tests/helpers/db.ts` truncation) and the seeded project; it does NOT duplicate the at-scale combined journey (Story 3.5).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/board-ui.spec.ts` (Story 3.2.7) — the board UI E2E this builds on (group-by/WIP layer); `tests/e2e/board-projection.spec.ts` (3.1.7) — the projection E2E precedent\n' +
        '- `tests/helpers/db.ts` — real-Postgres truncation; the dnd-kit testing notes for driving keyboard/pointer DnD (incl. cross-lane drops) in Playwright\n' +
        '- Story 3.5 — the Epic-3 test story this defers the at-scale combined journey to; `prodect-core/CLAUDE.md` — test conventions (real Postgres, no mocks, single `getSession` mock)',
    },
  ],
};
