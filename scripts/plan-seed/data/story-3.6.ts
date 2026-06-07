import type { PlanStory } from '../types';

/**
 * Story 3.6 — Board configuration: columns + status→column mapping.
 *
 * The board's ADMIN surface — the missing resolution screen for the
 * unmapped-statuses state Story 3.1 deliberately allows and Story 3.2.6
 * surfaces. A project's default board auto-seeds one column per status (3.1.2),
 * but a status added LATER in the workflow editor (Story 2.2.5) is deliberately
 * left **unmapped, not auto-columned** (3.1 out-of-scope + its acceptance test).
 * Until this story there was NO in-product way to put that status on the board —
 * the 3.2.6 tray could only link to a "Manage statuses" interim. 3.6 ships the
 * real thing: a board-settings surface to manage columns (add / rename / reorder
 * / delete) and the column↔status mapping, plus rename the board.
 *
 * This is NOT a "v1 vs later" deferral being un-deferred — Prodect has no V1
 * tier; the planned epics ARE the complete product, so an admin a complete
 * Jira-equivalent needs must live in a story. 3.6 gives the board-column admin
 * its home; the "board CRUD / column-remap admin (not v1)" notes in 3.1/3.2/3.3
 * are rewritten to forward-reference it. (Multiple boards per project — board
 * CRUD/create/delete/switch — is the SEPARATE Story 3.7; 3.6 configures the
 * single default board.)
 *
 * Pure config over EXISTING schema + write seams — adds NO new table: the
 * `board` / `board_column` / `board_column_status` model is Story 3.1.1, and the
 * board-config write path (4-layer `boardsService` + `PATCH …/board/columns/[id]`
 * + the `boardColumn*`/`boardColumnStatus*` repos) already exists from Story 3.3
 * (swimlane group-by + WIP). 3.6 extends that seam with column CRUD + mapping.
 *
 * ⚠️ Design gate: NO `design/boards/` asset draws this admin surface (the 3.2.1
 * board mockup is the board itself; the column `[⋯]` menu there is a disabled
 * seam). So 3.6.1 is a `type: design` subtask producing
 * `design/boards/board-config.mock.html` + PNG + design-notes, and the UI code
 * subtask (3.6.3) carries it in `dependsOn` (Principle #13: design before code).
 *
 * Mirror product: Jira board settings → **Columns** (the column manager where an
 * admin creates columns and maps statuses into them). Membership-gated now with
 * a `TODO(6.4)` to role-gate later, matching the 2.2.5 workflow editor + the 3.3
 * board config (no early RBAC build — roles are Epic 6).
 */
export const story_3_6: PlanStory = {
  id: '3.6',
  title: 'Board configuration — columns + status→column mapping',
  status: 'planned',
  descriptionMd:
    'The **board administration** surface: a project admin manages the default board’s ' +
    '**columns** (add / rename / reorder / delete) and the **column ↔ status mapping**, and ' +
    'renames the board. This is the screen the **unmapped-statuses tray (Story 3.2.6)** has been ' +
    'pointing users toward — the place to put a status that has no column onto the board.\n\n' +
    '**Why this story exists.** Story 3.1 auto-seeds one column per status when a board is created ' +
    '(3.1.2) but **deliberately leaves a LATER-added status unmapped** (3.1 out-of-scope: "reacting ' +
    'to LATER status changes"; its acceptance test asserts a new status is "not dropped, **not ' +
    'auto-columned**"). The intended resolution was always an admin that maps it — but that admin ' +
    'was labelled "board CRUD / column-remap admin (not v1)" in 3.1/3.2/3.3 with **no owning ' +
    'story**. Prodect has no V1 tier (the planned epics are the complete product), so a complete ' +
    'Jira-equivalent’s column manager must be planned: **this is its home.** Auto-columning ' +
    'stays rejected (it would reverse 3.1’s tested decision) — the user maps via this UI.\n\n' +
    '**Pure config over the shipped schema (no new table).** The `board` + `board_column` + ' +
    '`board_column_status` model is Story 3.1.1; the board-config WRITE seam — `boardsService` ' +
    '(`setSwimlaneGroupBy` / `setColumnWipLimit`), the `PATCH /api/board/columns/[columnId]` route, ' +
    'and the `boardColumnRepository` (`create` / `update`) + `boardColumnStatusRepository` ' +
    '(`create` / `deleteByColumn` / `deleteByStatus`) repos — already exists from **Story 3.3** ' +
    '(swimlane group-by + WIP). 3.6 **extends that exact seam** with column create/reorder/delete ' +
    'and status mapping; it adds NO new repository entity and NO migration.\n\n' +
    '**The mapping contract.** `board_column_status` carries `@@unique([boardId, statusId])` (3.1.1) ' +
    '— a status maps to **at most one column per board**. So "map status S to column C" is an ' +
    'UPSERT that **moves** S’s mapping (delete any existing row for S on this board, create the ' +
    'new one) inside one transaction, never a second row. Unmapping deletes the row — S returns ' +
    'to the `unmappedStatuses` tray (3.2.6), its work items hidden from the board but never deleted ' +
    '(a card’s column is DERIVED from its `work_item.status`, Story 3.1 — config never touches ' +
    'work items).\n\n' +
    '**Deleting a column** unmaps its statuses (they go back to the tray) and is **refused while a ' +
    'mapped status still holds work items on the board** UNLESS the admin remaps those statuses ' +
    'first — mirroring Jira’s "you can’t delete a column with issues" guard (decided ' +
    'at 3.6.2). No work item is ever deleted by a board-config write.\n\n' +
    '**Where it lives.** A new project-settings page `app/(authed)/settings/project/board/` beside ' +
    'the **Workflow** editor (`settings/project/workflow`, Story 2.2.5) — the two are siblings ' +
    '(workflow owns the statuses/transitions; board-config owns how those statuses map onto board ' +
    'columns). The board’s 3.2.6 unmapped tray and the 3.2.3 column `[⋯]` menu (a disabled ' +
    'seam today) both deep-link here.\n\n' +
    '**Out of scope (Story 3.7):** multiple boards per project — board create/delete, the board ' +
    'switcher, per-board config (the board API already takes a `boardId`, 3.1). 3.6 configures the ' +
    'single default board only. Roles/permissions are Epic 6.4 (membership-gated now, `TODO(6.4)`).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm dev` (NO migration — pure config over the Story-3.1 schema). Sign in to the seeded `moooon` → `prodect` project as an owner.\n' +
    '- `pnpm test` — vitest covers the column-config service (add / rename / reorder / delete; map/unmap with the `@@unique([boardId, statusId])` move-not-duplicate behaviour; delete-column unmaps its statuses and never deletes work items; the membership + workspace gates) and the route layer (typed-error → status).\n' +
    '- `pnpm test:e2e --grep board-config` — Playwright drives the real resolution flow: add a custom status in **Workflow settings** → it appears in the board’s **unmapped-statuses tray** → open **Board settings** → map it to a column → it now shows as/in that column on `/boards`; the tray entry is gone.\n' +
    '- **Column CRUD check:** add a column, rename it, drag to reorder it (order persists on reload), delete an empty column — its previously-mapped statuses return to the unmapped tray, and no work items are lost.\n' +
    '- **Mapping check:** move a status from column A to column B — its cards move columns on the board, and the status maps to exactly ONE column (no duplicate). Unmap a status — it returns to the tray; its work items are hidden from the board but still exist (open one via search / issue list).\n' +
    '- **Guard check:** deleting a column whose mapped status still holds board cards is refused (or requires remapping first) per the 3.6.2 decision; a non-admin (non-owner) member sees the board-config surface read-only and every write is re-gated 403 server-side; a write against another workspace’s board is 403/404.\n' +
    '- **Board rename check:** rename the board in Board settings → the new name shows in the `/boards` header.\n' +
    '- **Tray round-trip (the headline):** the 3.2.6 unmapped tray’s CTA now reads **"Map columns →"** and opens Board settings (no longer the "Manage statuses" interim); after mapping, the tray is empty and absent.',
  items: [
    {
      id: '3.6.1',
      title: 'Design — board-configuration surface: column manager + status mapping',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      dependsOn: ['1.5.1', '3.2.1'],
      descriptionMd:
        'The design asset the UI subtask (3.6.3) builds against — NO `design/boards/` mockup ' +
        'draws the board-config admin (the 3.2.1 asset is the board itself; its column `[⋯]` ' +
        'menu is a disabled seam), so the design gate requires producing it FIRST (mirrors 1.0.5 / ' +
        '1.2.1 / 1.3.3 / 1.5.1 / 3.2.1). Output: `design/boards/board-config.mock.html` (an HTML ' +
        'mockup built from the real design system — `components/ui/*` + the issue/board pills + ' +
        'the `--el-*`/element-shape tokens) + a PNG export + a `design/boards/design-notes.md` ' +
        'section. `--el-*` only (no Tier-0 `--color-*`); shape via the element tokens; AA-safe; ' +
        'mirrors **Jira board settings → Columns** as the reference.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Page layout** — a project-settings page beside the **Workflow** editor (the ' +
        '`settings/project/workflow` page, Story 2.2.5): the same settings header/grammar, a board ' +
        '**name** field, and the column manager below. Document the settings-nav entry (Board, ' +
        'next to Workflow).\n' +
        '- **Column manager** — the ordered list/row of columns (reuse the board’s column ' +
        'visual language from 3.2.1): each column shows its name (editable), a drag handle to ' +
        'reorder, a delete affordance, and the **status chips mapped to it** (the `Pill` neutral ' +
        'tone from the 3.2.6 tray). An **"Add column"** affordance.\n' +
        '- **Status mapping** — the Jira "Columns" interaction: an **unmapped-statuses** rail/' +
        'tray (the statuses with no column) + the ability to **assign a status to a column** (drag ' +
        'a status chip into a column, AND a non-drag fallback — a per-column status ' +
        'picker/menu — so it is keyboard-operable, finding #35). Moving a status between ' +
        'columns is a re-map; removing it returns it to the unmapped rail.\n' +
        '- **States** — a **delete-column confirm** (naming what happens to its mapped statuses ' +
        '→ they return to unmapped; and the guard when its status still holds board cards), the ' +
        '**read-only** (non-admin) treatment, loading + error + save feedback, and the **empty** ' +
        '(brand-new board) shape.\n' +
        '- **Cross-links** — where the board’s 3.2.6 unmapped tray ("Map columns →") ' +
        'and the 3.2.3 column `[⋯]` menu land in this surface.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/boards/board-config.mock.html` + PNG + a `design-notes.md` section exist; built from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no raw `rounded-*`/`p-*` for control shape); passes the render checklist (icon viewBox, no nested buttons, prettier); AA-safe.\n' +
        '- The mockup draws: the settings page (name field + column manager), per-column rename/reorder/delete, the status mapping (unmapped rail + assign-to-column, with a non-drag keyboard fallback), the delete-column confirm + guard, and the read-only / loading / error / empty states.\n' +
        '- `design-notes.md` names each composing primitive (`Pill`, `Button`, `Modal`/confirm, `Input`, the board column language), documents the keyboard mapping path (not drag-only, finding #35), states the surface lives beside the Workflow editor, and names Jira board settings → Columns as the mirror.\n' +
        '- Mapping/drag affordances are not colour-alone (finding #35); status chips use the palette via `--el-*` (finding #54).\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/board.mock.html` + `design-notes.md` (3.2.1) — the board + column visual language + the unmapped-statuses tray this resolves\n' +
        '- `app/(authed)/settings/project/workflow/_components/WorkflowEditor.tsx` (2.2.5) — the sibling settings surface to match in grammar/placement\n' +
        '- `components/ui/*` (Pill, Button, Modal, Input, Tooltip) + the board column markup (3.2.3) to reuse\n' +
        '- `app/globals.css` `--el-*` + element-shape tokens; the `/tokens` specimen route\n' +
        '- Jira board settings → Columns as the mirror; findings #35 (not colour-alone), #54 (use the palette)',
    },
    {
      id: '3.6.2',
      title: 'Column config service + API — add/rename/reorder/delete column; map/unmap status',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['3.1.1', '3.3.3'],
      descriptionMd:
        'The write path for board-column administration, through the 4-layer architecture (Route ' +
        '→ Service → Repository → Prisma), **extending the Story-3.3 board-config ' +
        'seam** rather than adding a new service or table.\n\n' +
        '**Service (`boardsService`, the 3.3 config home).** Add: `addColumn(boardId, { name, ' +
        'position? })`, `renameColumn(columnId, name)`, `reorderColumn(columnId, position)` ' +
        '(fractional-index between neighbours, the same rank scheme work items use), ' +
        '`deleteColumn(columnId)`, `mapStatusToColumn(boardId, columnId, statusId)`, ' +
        '`unmapStatus(boardId, statusId)`, and `renameBoard(boardId, name)`. Each is ONE ' +
        'transaction, returns a DTO (extend `lib/dto/boards.ts` + `lib/mappers/boardMappers.ts`), ' +
        'throws typed errors (`lib/boards/errors.ts`), and calls `assertProjectAdmin` (membership ' +
        'gate, `TODO(6.4)`, mirroring `setColumnWipLimit` / the 2.2.5 workflow writes).\n\n' +
        '**The mapping is a MOVE, not a duplicate.** `board_column_status` has ' +
        '`@@unique([boardId, statusId])` (3.1.1). `mapStatusToColumn` therefore, in one ' +
        '`$transaction`: `boardColumnStatusRepository.deleteByStatus(statusId, tx)` then `.create(' +
        '{ columnId, statusId }, tx)` — so re-mapping a status replaces its row; a P2002 ' +
        'backstop covers the concurrent race (mirror `createStatus`).\n\n' +
        '**Delete-column safety.** `deleteColumn` unmaps the column’s statuses ' +
        '(`deleteByColumn`) — they return to `unmappedStatuses` — then deletes the ' +
        '`board_column` row. It **never deletes a work item** (a card’s column is derived from ' +
        'its status). Decide + implement the Jira-style guard: **refuse to delete a column whose ' +
        'mapped status still holds board cards** (`ColumnNotEmptyError` → 409) unless those ' +
        'statuses are remapped first; the last column / a column mapping the INITIAL status may ' +
        'need extra guards (decide from the mirror).\n\n' +
        '**Routes (HTTP-only, one service call each, typed-error → status):** `POST ' +
        '/api/board/columns` (add), **extend** `PATCH /api/board/columns/[columnId]` (3.3.3 — ' +
        'add `name` / `position` alongside the existing `wipLimit`), `DELETE ' +
        '/api/board/columns/[columnId]`, `PUT /api/board/columns/[columnId]/statuses` (set the ' +
        'column’s mapped statuses) + `DELETE .../statuses/[statusId]` (unmap), and **extend** ' +
        '`PATCH /api/board` (3.3.3 group-by) with `name`. A write from another workspace is ' +
        '403/404 (the `workspaceId` gate, finding #26). No Prisma/transaction in any route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `boardsService` gains `addColumn` / `renameColumn` / `reorderColumn` / `deleteColumn` / `mapStatusToColumn` / `unmapStatus` / `renameBoard`, each one transaction, returning DTOs, throwing typed errors, gated by `assertProjectAdmin` (`TODO(6.4)`).\n' +
        '- `mapStatusToColumn` is a MOVE: a status maps to exactly one column per board (the `@@unique([boardId, statusId])` invariant holds; re-mapping replaces, never duplicates), proven by a vitest test.\n' +
        '- `deleteColumn` unmaps its statuses (they reappear in `unmappedStatuses`) and deletes NO work item; the empty/guard rule (a column whose status still holds cards) behaves per the chosen mirror-product semantics with a typed error.\n' +
        '- Routes are HTTP-only (no Prisma, no `$transaction`), map typed errors to status codes, and reject cross-workspace + non-admin writes (403/404); the existing WIP-limit + group-by behaviour of the extended routes is unchanged.\n' +
        '- Repository writes go through `boardColumnRepository` / `boardColumnStatusRepository` (add a `boardColumnRepository.delete` if missing) with required `tx`; no new table / migration.\n' +
        '- Vitest (real Postgres) covers add/rename/reorder/delete/map/unmap, the unique-move, the delete guard, and the workspace + membership gates.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/boardsService.ts` — `setColumnWipLimit` / `setSwimlaneGroupBy` (3.3.3): the config-write home + `assertProjectAdmin` pattern to extend\n' +
        '- `lib/repositories/boardColumnRepository.ts` (`create` / `update` / `findById`) + `boardColumnStatusRepository.ts` (`create` / `deleteByColumn` / `deleteByStatus`) — the repos to reuse / extend (add column `delete`)\n' +
        '- `app/api/board/columns/[columnId]/route.ts` (PATCH wipLimit, 3.3.3) + `app/api/board/route.ts` (PATCH group-by) — the routes to extend\n' +
        '- Story 3.1.1 — the `board` / `board_column` / `board_column_status` schema + `@@unique([boardId, statusId])`; `lib/workflows/*` for the status source\n' +
        '- `lib/services/workflowsService.ts` `createStatus` — the P2002-backstop + `assertProjectAdmin` precedent; `prodect-core/CLAUDE.md` (4-layer rules)',
    },
    {
      id: '3.6.3',
      title: 'Board-configuration UI — column manager + status mapping; repoint the unmapped tray',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['3.6.1', '3.6.2', '3.2.6', '2.2.5'],
      descriptionMd:
        'The admin surface itself, per `design/boards/board-config.mock.html` (3.6.1), consuming ' +
        'the 3.6.2 API — and the subtask that finally CLOSES the 3.2.6 unmapped-tray loop.\n\n' +
        '**The page.** A new `app/(authed)/settings/project/board/page.tsx` (Server Component ' +
        'resolving the active project + the caller’s admin role, mirroring the ' +
        '`settings/project/workflow` page, Story 2.2.5) handing typed data to a client ' +
        '`BoardConfigEditor`. Add the **settings-nav entry** ("Board", beside "Workflow"). The ' +
        'editor: rename the board; the **column manager** (add / rename / reorder via drag / ' +
        'delete — reuse the dnd-kit setup from 3.2.4, no new lib); and the **status mapping** ' +
        '(each column shows its mapped status `Pill`s; an unmapped-statuses rail; drag a status ' +
        'into a column OR use a per-column status picker — keyboard-operable, finding #35). ' +
        'Every write is optimistic-with-reconcile against the 3.6.2 endpoints; the delete-column ' +
        'confirm + guard from the design. Membership-gated affordances (read-only for non-admins, ' +
        'the server re-gates).\n\n' +
        '**Close the 3.2.6 loop (the headline).** Repoint the **unmapped-statuses tray** ' +
        '(`UnmappedStatusesTray`, 3.2.6): the interim **"Manage statuses →"** CTA (which went ' +
        'to the workflow editor because no mapping admin existed) becomes **"Map columns →"** ' +
        'linking to `settings/project/board` — the real surface. Update the `boards` i18n keys ' +
        '(en + zh) and the `design/boards/design-notes.md` "CTA reality" note accordingly. Also ' +
        'wire the 3.2.3 column `[⋯]` menu (a disabled seam) to open here.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `settings/project/board` renders the board-config editor (board rename + column manager + status mapping) per `design/boards/board-config.mock.html`, with a settings-nav entry beside Workflow; colours via `--el-*`, shape via element tokens; render checklist clean; AA-safe.\n' +
        '- An admin can add / rename / reorder / delete a column and map / unmap / move a status; changes reconcile against the 3.6.2 API and reflect on `/boards` (a mapped status appears as/in its column; an unmapped one returns to the tray).\n' +
        '- Status mapping is operable by keyboard, not drag-only (finding #35); the delete-column confirm names the consequence (statuses → unmapped) and respects the 3.6.2 guard.\n' +
        '- The **3.2.6 unmapped tray CTA is repointed** to this surface ("Map columns →" → `settings/project/board`), the `boards` i18n keys updated (en + zh, parity holds), and the design-notes "CTA reality" note updated; the 3.2.3 column `[⋯]` menu opens here.\n' +
        '- Non-admins get the read-only treatment; component tests cover the column manager, the map/unmap interaction (incl. the keyboard path), and the tray repoint.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/settings/project/workflow/page.tsx` + `_components/WorkflowEditor.tsx` (2.2.5) — the sibling settings page + client-editor pattern to mirror; the settings nav to extend\n' +
        '- `app/(authed)/boards/_components/UnmappedStatusesTray.tsx` (3.2.6) — the tray to repoint ("Manage statuses" → "Map columns"); `messages/en.json` + `zh.json` `boards.*`; `design/boards/design-notes.md` (the "CTA reality" note)\n' +
        '- `app/(authed)/boards/_components/BoardContainer.tsx` (3.2.4 dnd-kit setup to reuse) + `BoardColumn.tsx` (the `[⋯]` seam) — reuse, do not add a second DnD lib\n' +
        '- Story 3.6.2 — the column-config service + API this consumes; `components/ui/*` (Pill, Button, Modal, Input); `prodect-core/CLAUDE.md` (`--el-*` + element-shape rules)',
    },
    {
      id: '3.6.4',
      title: 'Story tests — column config service + the unmapped→mapped resolution E2E',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['3.6.2', '3.6.3'],
      descriptionMd:
        'The closing test subtask — the same split Stories 3.1.7 / 3.2.7 used: component/unit ' +
        'over the config logic + a Playwright E2E proving the headline resolution end-to-end ' +
        '(unmapped status → mapped → on the board).\n\n' +
        '**Component / unit (vitest, real Postgres).** The column-config service: add / rename / ' +
        'reorder / delete; `mapStatusToColumn` enforces `@@unique([boardId, statusId])` ' +
        '(re-map replaces, never duplicates); `deleteColumn` unmaps its statuses and deletes no ' +
        'work item; the delete guard; the membership + workspace gates. The `BoardConfigEditor` ' +
        'render + the map/unmap interaction (incl. the keyboard path) + the repointed tray CTA.\n\n' +
        '**E2E (Playwright) `tests/e2e/board-config.spec.ts`.** Against a seeded project: add a ' +
        'custom status in **Workflow settings** → assert it shows in the board’s ' +
        '**unmapped-statuses tray** on `/boards` → open **Board settings**, map it to a column ' +
        '→ assert it now renders as/in that column on `/boards` and the tray entry is gone. ' +
        'Plus: reorder a column (persists on reload); delete an empty column (its statuses return ' +
        'to the tray, no cards lost); a non-admin sees the surface read-only.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` covers the config service (add/rename/reorder/delete/map/unmap, the unique-move, the delete guard, the gates) and the editor render + map/unmap (incl. keyboard) + the repointed tray.\n' +
        '- `pnpm test:e2e --grep board-config` runs green over the real stack, asserting the unmapped→mapped→on-board resolution end-to-end, a column reorder persisting, a column delete returning statuses to the tray without losing work items, and the non-admin read-only gate.\n' +
        '- Reuses the real-Postgres harness (`tests/helpers/db.ts`) + the seeded project; it does NOT duplicate the 3.2.7 drag/board-UI journeys.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/board-projection.spec.ts` (3.1.7) + `tests/e2e/board-ui.spec.ts` (3.2.7) — the board E2E patterns this builds on; `tests/helpers/db.ts` — real-Postgres truncation\n' +
        '- `tests/components/board-completeness.test.tsx` (3.2.6) — the unmapped-tray component test to extend for the repointed CTA\n' +
        '- Story 3.6.2 / 3.6.3 — the service + UI under test; `prodect-core/CLAUDE.md` — test conventions (real Postgres, no mocks)',
    },
  ],
};
