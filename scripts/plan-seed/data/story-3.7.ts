import type { PlanStory } from '../types';

/**
 * Story 3.7 — Multiple boards per project (board CRUD + switcher).
 *
 * Expanded from its `stubs.ts` entry. A project goes from its ONE auto-seeded
 * board to **many** (e.g. a team board + a triage board): create / rename /
 * delete boards, a **default** board, a **switcher** on `/boards`, and per-board
 * configuration (the 3.3 swimlane/WIP + 3.6 column→status mapping are already
 * board-scoped — reused per board, not rebuilt).
 *
 * Mirror product (rung 1; VERIFIED June 2026, Atlassian docs — checked, not
 * asserted, per `notes.html` mistake #33): Jira supports **multiple boards per
 * project** ("one team per board, many teams per project"); a board has a
 * **type** (Scrum / Kanban) and its own column/swimlane config; any user can
 * create one, an admin deletes via board settings. In Jira a board is
 * ultimately **backed by a saved filter** (and can therefore span projects) —
 * but board filters are **Epic 6** (the disabled `[Filter]` seam + Story 3.8's
 * cap note). So THIS story ships multiple **project-scoped** boards (each shows
 * the project's issues under its own column/swimlane config); the JQL-filter
 * backing + cross-project boards are the Epic-6 extension (noted, not built).
 *
 * Additive by construction: the Story-3.1 schema already allows N boards per
 * project (`Board.@@index([projectId])` is non-unique), `boardsService.getBoard`
 * already takes a `boardId`, and the move / config / column routes are
 * board-scoped. This story adds the default-board concept, the CRUD path, the
 * switcher, and threads the SELECTED board through the read — no breaking change
 * to the single-default-board path.
 *
 * ⚠️ Design gate (planning-time): the **board switcher** + the **create / rename
 * / delete / set-default** board UI are new, unspecified in `design/boards/` — so
 * 3.7.1 is a `type: design` subtask producing them FIRST; the UI code subtask
 * (3.7.4) carries it in `dependsOn` (Principle #13).
 */
export const story_3_7: PlanStory = {
  id: '3.7',
  title: 'Multiple boards per project (board CRUD + switcher)',
  status: 'planned',
  descriptionMd:
    'Turn the project’s single auto-seeded board into **many boards per project** — create / ' +
    'rename / delete, a **default** board, a **switcher** on `/boards`, and per-board config ' +
    '(the 3.3 swimlane group-by + WIP and the 3.6 column→status mapping are already keyed by ' +
    '`boardId`, so each board carries its own config; reused, not rebuilt). Additive: the 3.1 ' +
    'schema + API already carry `boardId` and the per-project board index is non-unique, so the ' +
    'single-default-board path keeps working.\n\n' +
    '**Verified mirror (rung 1, mistake #33).** Jira has multiple boards per project (one team ' +
    'per board, many teams per project); a board has a type (Scrum/Kanban) + its own column/' +
    'swimlane config; any member creates one, an admin deletes it. A Jira board is ultimately ' +
    'backed by a saved **filter** (so it can span projects) — but filters are **Epic 6**, so this ' +
    'story ships **project-scoped** boards (each shows the project’s issues under its own config); ' +
    'the JQL-filter backing + cross-project boards are the Epic-6 extension (the disabled ' +
    '`[Filter]` seam already reserves it; see Story 3.8’s cap note).\n\n' +
    '**Default board + lifecycle.** Each project has exactly **one default board** (the 3.1 ' +
    'auto-seeded board migrates to default); creating a board seeds its **default columns** off the ' +
    'project workflow (reuse the 3.1 board-bootstrap path) so it’s usable immediately; deleting a ' +
    'board removes only the board + its column/config rows (issues belong to the **project**, never ' +
    'a board, so none are lost). Guards: a project always keeps **at least one** board (the last ' +
    'board can’t be deleted), and deleting the default **promotes** another to default (never a ' +
    'project with no default).\n\n' +
    '**Selecting a board.** The board the user is viewing is URL-addressable (a `?board=<id>` param ' +
    'on `/boards`, mirroring the 2.5.19 `?peek` pattern — shareable / reload-safe), defaulting to ' +
    'the project’s default board when absent. The selected board id threads into the projection ' +
    '(GET), the move, the group-by/WIP config, and the column-mapping — all already board-scoped.\n\n' +
    '**Permissions.** Board CRUD is a project-config write — membership-gated now, with a ' +
    '`// TODO(6.4): gate by project role` note (consistent with 2.2.5 / 3.3.3); when Story 6.4 ' +
    'lands, board admin is gated by the project **admin** role. No early RBAC build.\n\n' +
    '**Out of scope:** the Scrum board variant (Story 4.5 — moved to Epic 4 per mistake #32); the ' +
    'column/status-mapping admin itself (Story 3.6 — reused per board, not rebuilt); filter-backed ' +
    '/ cross-project boards (Epic 6); board sharing / favourites (Jira has them; no stated need → ' +
    'deferred).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev`, `pnpm db:seed`, `pnpm dev`; open `/boards` on the seeded `moooon` → `prodect` project.\n' +
    '- **Create:** use the switcher’s “New board” → name it (e.g. "Triage") → it’s created with default columns and becomes the active board; the switcher now lists both.\n' +
    '- **Switch:** pick the other board in the switcher → the board re-lays from that board’s projection + config (its own group-by / WIP / columns); the URL carries `?board=<id>` and a reload keeps it.\n' +
    '- **Per-board config is independent:** set group-by Assignee + a WIP limit on board A; board B is unaffected (each board’s config is its own).\n' +
    '- **Rename / set default / delete:** rename a board; set a non-default board as default → new sessions open it; delete a board → it’s gone, its issues still exist on the project (visible on the other board); deleting the default promotes another; the **last** board cannot be deleted (guard + disabled affordance).\n' +
    '- `pnpm test` + `pnpm test:e2e --grep board-crud` green over the real stack.',
  items: [
    {
      id: '3.7.1',
      title:
        'Design — board switcher + create / rename / delete / set-default UI (extends design/boards/)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: [],
      descriptionMd:
        'The design asset the multi-board UI builds against — new surfaces unspecified in ' +
        '`design/boards/`. Specify: (a) the **board switcher** in the board header (a ' +
        'select/menu listing the project’s boards with the active one marked + the default badged, ' +
        'reusing a shipped select/menu primitive; placed alongside the 3.3.5 group-by control); ' +
        '(b) **New board** (a small modal — name + type, type fixed to Kanban for now with Scrum ' +
        'noted as Epic-4); (c) **Manage board** (rename, set-default, delete from the switcher’s ' +
        '`[⋯]` or a manage item) with the **delete confirm** + the **last-board** disabled state; ' +
        '(d) the **one-board** state (switcher still present, no clutter). Output: extend ' +
        '`design/boards/` with a mockup (`*.mock.html` from `components/ui/*` + `--el-*`/shape ' +
        'tokens) + PNG + a "Multiple boards (Story 3.7)" section in `design/boards/design-notes.md`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The asset + a "Multiple boards (Story 3.7)" notes section exist; built from `components/ui/*` + `--el-*`/element-shape tokens (no Tier-0 `--color-*`, no raw shape utilities), AA-safe, passes the render checklist.\n' +
        '- Draws: the header switcher (active + default marked), New-board modal (name + type, Kanban-only w/ Scrum noted), rename/set-default/delete, the delete confirm, the last-board disabled state, and the one-board state.\n' +
        '- `design-notes.md` names the composing primitives (the select/menu, `Modal`, `Input`, `Button`, `Pill` for the default badge) and states board CRUD is membership-gated now / project-admin-gated under Story 6.4.\n\n' +
        '## Context refs\n\n' +
        '- `design/boards/board.mock.html` + `swimlanes-wip.mock.html` + `design-notes.md` (3.2.1 / 3.3.1) — the board header (the group-by control slot) this extends\n' +
        '- `components/ui/*` (Combobox/menu, Modal, Input, Button, Pill); Jira’s board switcher + create/manage-board as the mirror (rung 1)',
    },
    {
      id: '3.7.2',
      title:
        'Schema — default-board flag + switcher ordering (N boards per project; migration-aware)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['3.1.1'],
      descriptionMd:
        'Make the `board` table first-class multi-per-project. The per-project index is already ' +
        'non-unique (3.1.1), so add: a **`board.isDefault Boolean @default(false)`** (exactly one ' +
        'default per project — enforced in the service + a partial unique index `(projectId) WHERE ' +
        'is_default`), and a **`board.position`** (fractional-index string) for stable switcher ' +
        'ordering. ONE migration; the existing auto-seeded board per project **backfills to ' +
        '`isDefault = true`** + an initial position, so no project is left without a default. No RLS ' +
        'change (the board table is already workspace-RLS-forced from 3.1.1).\n\n' +
        '**Out of scope:** the CRUD service/routes (3.7.3); UI (3.7.4); the read wiring (3.7.5).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `board.isDefault @default(false)` + `board.position` added in ONE migration; a partial unique index guarantees ≤1 default per project; `migrate dev` applies cleanly + idempotently.\n' +
        '- Existing boards backfill to `isDefault = true` + an initial position (every project keeps exactly one default); `prisma generate` types the fields.\n' +
        '- A vitest (real Postgres) asserts the one-default invariant (a second `isDefault=true` for the same project is rejected) and the backfill.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` `Board` (3.1.1 — the non-unique `@@index([projectId])` + RLS) ; the fractional-index `position` convention used on `work_item` / `board_column`\n' +
        '- `prodect-core/CLAUDE.md` — one migration, application-seeded data, partial indexes',
    },
    {
      id: '3.7.3',
      title:
        'Board CRUD service + API — create (seed columns) / rename / set-default / delete (guards)',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['3.7.2', '3.1.3'],
      descriptionMd:
        'The board lifecycle, 4-layer (Route → Service → Repository → Prisma) with the explicit ' +
        '`workspaceId` gate (finding #26). `boardsService`: **`createBoard(projectId, { name, type })`** ' +
        '— creates the board AND seeds its default columns off the project workflow (REUSE the 3.1 ' +
        'board-bootstrap helper so a new board is immediately usable), non-default; **`renameBoard`**; ' +
        '**`setDefaultBoard`** — flips the project’s default in one tx (clears the prior default, sets ' +
        'the new — preserving the one-default invariant); **`deleteBoard`** — removes the board + its ' +
        'column/config rows (issues are untouched — they belong to the project), with two guards: the ' +
        '**last board cannot be deleted** (typed error), and deleting the **default promotes** the ' +
        'next board (by position) to default. Membership-gated with a `// TODO(6.4): project-admin` ' +
        'note (mirror 2.2.5 / 3.3.3). Routes (board-scoped, not project-key — consistent with the ' +
        '3.1.6 active-project routing): `GET /api/boards` (list for the active project), `POST ' +
        '/api/boards` (create), `PATCH /api/boards/[id]` (rename / setDefault), `DELETE ' +
        '/api/boards/[id]`; HTTP-only, typed-error→status (400 invalid, 403 wrong workspace / not ' +
        'admited later, 404 missing, 409 last-board).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `createBoard` (+ seeds default columns via the 3.1 bootstrap), `renameBoard`, `setDefaultBoard` (one-default invariant in one tx), `deleteBoard` (removes board + config, NOT issues) exist, own their transaction, return DTOs, enforce the `workspaceId` gate.\n' +
        '- Guards: last-board delete → typed 409; deleting the default promotes the next board by position; a `// TODO(6.4)` project-admin note is present (no early RBAC).\n' +
        '- `GET/POST /api/boards` + `PATCH/DELETE /api/boards/[id]` are HTTP-only (one service call, typed-error→status); a cross-workspace board is 404.\n' +
        '- Vitest (real Postgres): create-with-columns, rename, set-default (invariant holds), delete (issues survive), the last-board + promote-default guards, cross-workspace denial.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/boardsService.ts` + `lib/repositories/boardRepository.ts` (3.1.3) — the service/repo to extend; the 3.1 board-bootstrap (auto-seed columns) helper to reuse for `createBoard`\n' +
        '- `lib/services/workflowsService.ts` (2.2.5) — the membership-gate + "RBAC later" precedent; `lib/dto/boards.ts` / `boardMappers.ts`; `prodect-core/CLAUDE.md` (4-layer)',
    },
    {
      id: '3.7.4',
      title: 'UI — board switcher + create / rename / delete / set-default',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['3.7.1', '3.7.3'],
      descriptionMd:
        'The multi-board UI on `/boards`, per `design/boards/` (3.7.1). A **board switcher** in the ' +
        'header (lists the project’s boards from `GET /api/boards`, active one marked, default ' +
        'badged) that changes the selected board → updates `?board=<id>` and re-lays from that ' +
        'board’s projection. **New board** (modal: name + type Kanban) → `POST /api/boards` → switch ' +
        'to it. **Manage** (rename / set-default / delete via the switcher `[⋯]`) → the 3.7.3 ' +
        'routes; delete shows a confirm and the **last-board** affordance is disabled. Optimistic ' +
        'where safe; reconciles to the returned DTO. Membership-gated (non-admin sees CRUD ' +
        'affordances hidden/disabled once 6.4 lands; today any member).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A header board switcher lists the project’s boards (active marked, default badged) and switching updates `?board=<id>` + re-lays the board; New/rename/set-default/delete call the 3.7.3 API and reconcile.\n' +
        '- Delete shows a confirm; the last-board delete is disabled with an explanation; colours via `--el-*`, shape via element tokens, AA-safe; matches the 3.7.1 design.\n' +
        '- Component tests cover the switcher render + select, the create flow, rename/set-default, and the last-board-disabled + delete-confirm.\n\n' +
        '## Context refs\n\n' +
        '- `app/(authed)/boards/page.tsx` + `_components/BoardContainer.tsx` (the header + the `?board` wiring; mirror the `?peek` URL pattern from 2.5.19); `design/boards/` (3.7.1); Story 3.7.3 (the API)',
    },
    {
      id: '3.7.5',
      title:
        'Board-scoped read — resolve the selected board (`?board=`/default) through the projection',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['3.7.3', '3.1.4'],
      descriptionMd:
        'Thread the SELECTED board through the read path. Today `GET /api/board` resolves the active ' +
        'project’s single default board (3.1.6). Generalize: resolve the board from a `boardId` query ' +
        'param, **defaulting to the project’s `isDefault` board** when absent (and 404 if the id isn’t ' +
        'a board of the active project / workspace — never cross-tenant). The board page passes the ' +
        '`?board=` selection through; the projection (`getBoard`), the move, the group-by/WIP config, ' +
        'and the 3.6 column-mapping all already take a `boardId` — this just makes the SELECTED id ' +
        'flow instead of the implicit default. The `swimlaneGroupBy` / WIP / columns the UI shows are ' +
        'thus the selected board’s.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `GET /api/board?boardId=` returns the named board’s projection; absent → the project’s default board; a board id outside the active project/workspace → 404 (tenant-safe).\n' +
        '- The board page resolves `?board=` (default when absent) and every board-scoped call (projection, move, group-by/WIP, column-mapping) uses the selected board id; the single-default path is unchanged when no `?board=`.\n' +
        '- Vitest (real Postgres): selecting board A vs B returns each board’s own columns/config; the default fallback; the cross-project/workspace 404.\n\n' +
        '## Context refs\n\n' +
        '- `app/api/board/route.ts` (3.1.6 — the active-project board resolution to generalize) + `boardsService.getBoard` (already `boardId`-taking, 3.1.4); `app/(authed)/boards/page.tsx` + `BoardContainer.tsx`\n' +
        '- Story 3.7.3 (`GET /api/boards` list) + 3.7.4 (the switcher that sets `?board=`)',
    },
    {
      id: '3.7.6',
      title: 'Tests — board CRUD + guards + switcher + board-scoped read (component + focused E2E)',
      status: 'planned',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['3.7.2', '3.7.3', '3.7.4', '3.7.5'],
      descriptionMd:
        'Prove multi-board end-to-end — the 3.1.7 / 3.2.7 split. **Component / unit (vitest, real ' +
        'Postgres):** the CRUD services (create-with-seeded-columns, rename, set-default invariant, ' +
        'delete keeps issues), the guards (last-board 409, promote-default on delete), the ' +
        'one-default schema invariant, and board-scoped read resolution (selected vs default vs ' +
        'cross-tenant 404). **E2E (Playwright) `tests/e2e/board-crud.spec.ts`:** create a second ' +
        'board → it appears in the switcher + becomes active with default columns; set group-by/WIP ' +
        'on one board, confirm the other is unaffected; switch boards (URL `?board=` + reload ' +
        'persists); set default; delete a non-default board (its issues still show on the remaining ' +
        'board); the last board can’t be deleted. Reuses the real-Postgres harness + the seeded ' +
        'project.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` covers the CRUD services + guards + the one-default invariant + board-scoped read resolution.\n' +
        '- `pnpm test:e2e --grep board-crud` runs green: create/switch/rename/set-default/delete, per-board config isolation, the `?board=` URL + reload, and the last-board guard.\n' +
        '- Reuses `tests/helpers/db.ts` truncation + the seeded project; no mocks beyond `getSession`.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/board-ui.spec.ts` (3.2.7) + the board projection tests (3.1.7) — the board E2E this builds on; the 3.7.2–3.7.5 surfaces under test; `prodect-core/CLAUDE.md` (real Postgres, no mocks)',
    },
  ],
};
