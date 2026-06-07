import type { PlanStory } from '../types';

/**
 * Story 1.3 — Projects.
 * Faithful transcription of prodect_plan/story-1.3-projects.html (frozen archive).
 */
export const story_1_3: PlanStory = {
  id: '1.3',
  title: 'Projects',
  status: 'done',
  descriptionMd:
    'A workspace contains projects. Each project has a name, slug, and identifier (e.g., PROD). ' +
    'A workspace holds many projects (the project switcher lists them); the app scopes to one ' +
    '**active** project at a time at the UI level, and the non-unique `workspaceId` FK accommodates ' +
    'as many projects as a workspace needs — no per-workspace cap. Cross-project views that span ' +
    'projects at once (unified search / reporting) belong to the **Search, reporting & admin** ' +
    'epic (Epic 6).\n\n' +
    '**Prerequisites:** [Story 1.2 (Workspaces)](story-1.2-workspaces.html) ' +
    'must be complete — `project` FKs against `Workspace` with ' +
    '`onDelete: Cascade`, the project RLS policies key off the same ' +
    '`app.workspace_id` session GUC that 1.2.3 established, and the active-project ' +
    'selection rides on the existing `WorkspaceMembership` row. [Story 1.0.5 (Design system)](story-1.0.5-design-system.html) ' +
    'must be complete before 1.3.3 (mockups) and 1.3.4 (UI) — those compose the canonical ' +
    '`Button` / `Input` / `Card` / `Modal` / `Popover` primitives (Popover shipped in 1.2.6).',
  verificationRecipeMd:
    '- `project` table: id (cuid), workspaceId (FK, `onDelete: Cascade`), name, slug (workspace-unique),' +
    ' identifier (3-5 chars uppercase, workspace-unique), `lastWorkItemNumber` (int default 0 — the' +
    ' per-project key counter), createdAt, updatedAt, archivedAt (nullable — soft-delete/archive, never' +
    ' a hard delete that would orphan work-item history in 1.4+).\n' +
    '- Project identifier is workspace-unique and used as the prefix for work-item keys (e.g., `PROD-42`).' +
    ' Auto-generated from the name (uppercased, alphanumeric, 3-5 chars) with a numeric collision suffix;' +
    ' the user can override at creation.\n' +
    '- Work-item-key allocation is gap-free and per-project: a repository method increments' +
    " `project.lastWorkItemNumber` via `UPDATE … RETURNING` inside the caller's transaction (NOT a" +
    ' Postgres SEQUENCE — sequences are per-DB-object, leak on rollback, and would need one per project).' +
    ' Story 1.4 calls this when inserting a work item.\n' +
    '- Active project stored per-workspace-member on `WorkspaceMembership.activeProjectId` (nullable FK,' +
    ' `onDelete: SetNull`) — determines what the member sees on landing. Switching projects updates this,' +
    ' mirroring the `workspace_id` cookie pattern from 1.2.6.\n' +
    '- Postgres RLS on `project`: a row is visible/writable only when its `workspaceId` matches the active' +
    ' `app.workspace_id` GUC — the same structural gate 1.2.3 applied to workspace-scoped tables.' +
    ' Cross-workspace access is structurally impossible at the DB layer, not just the app layer.\n' +
    '- Creating a project requires active workspace membership; archiving/deleting requires the typed-name' +
    ' double-confirmation modal (same pattern as workspace delete in 1.2.6).\n' +
    '- Project creation flow: a modal with name + auto-generated identifier (overridable); on success the' +
    " new project becomes the member's active project. If the member has no projects in the active" +
    ' workspace, a "Create your first project" empty state appears instead of a project view.\n' +
    '- Project switcher in the top-nav (composed alongside the workspace switcher from 1.2.6): lists the' +
    ' workspace\'s projects with a check on the active one + a "Create project" entry. Selecting sets' +
    ' `activeProjectId` and re-renders.\n' +
    '- 4-layer rule respected (per `prodect-core/CLAUDE.md`): route/Server-Action → service → repository' +
    ' → Prisma; writes go through repo methods requiring `tx`; services own transactions + DTO mapping.' +
    ' All quality gates green; multi-tenant isolation proven by E2E + direct-DB RLS test (1.3.6).',
  items: [
    {
      id: '1.3.1',
      title:
        'Schema: project table + identifier generator + work-item-key counter + repo/service layer',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['1.2.2'],
      descriptionMd:
        'Add the `Project` model and the data layer that makes projects real, following ' +
        'the 4-layer architecture from `prodect-core/CLAUDE.md`. This is the schema-only + ' +
        'repository/service Subtask; RLS policies and the active-project resolution land in 1.3.2, the ' +
        'UI in 1.3.4.\n\n' +
        '**Schema (verbatim shape):** `Project { id String @id @default(cuid()), ' +
        'workspaceId String, name String, slug String, identifier String, lastWorkItemNumber Int ' +
        '@default(0), createdAt, updatedAt, archivedAt DateTime? }` with ' +
        '`workspace Workspace @relation(onDelete: Cascade)`, `@@unique([workspaceId, slug])`, ' +
        '`@@unique([workspaceId, identifier])`, `@@index([workspaceId])`, ' +
        '`@@map("project")`. Add `WorkspaceMembership.activeProjectId String?` with a ' +
        "relation to Project `onDelete: SetNull` (a member's active project clears, not cascades, " +
        'if that project is archived/deleted out from under them).\n\n' +
        '**Why a counter column, not a Postgres SEQUENCE:** work-item keys ' +
        '(`PROD-42`) must be per-project, gap-free, and transaction-safe. A SEQUENCE is a ' +
        "per-database object — you'd need one per project (unbounded DDL), and sequence values leak on " +
        'rollback (gaps). A `lastWorkItemNumber` column incremented via ' +
        '`UPDATE project SET last_work_item_number = last_work_item_number + 1 WHERE id = $1 ' +
        'RETURNING last_work_item_number` inside the work-item-create transaction is the durable ' +
        'B2B shape (Linear/Jira/GitHub all use a per-project counter, not DB sequences). Story 1.4 ' +
        'calls this allocator; 1.3.1 ships the column + the repo method + a unit test for it.\n\n' +
        '**Why `archivedAt`, not hard delete:** once Story 1.4 hangs work ' +
        'items off a project, hard-deleting a project would cascade-destroy issue history. Soft-delete ' +
        'via `archivedAt` is the durable shape a complete product ships; the "delete" UI in 1.3.4 ' +
        'archives. (A true hard-delete-with-cascade is an optional admin operation, addable later ' +
        'if ever needed — soft-delete is the default, not a stopgap.)\n\n' +
        "**What you'll do:** Extend `prisma/schema.prisma`; generate a " +
        'migration (`add_projects`). Add `lib/repositories/projectRepository.ts` ' +
        '(single-op: `findById`, `findBySlug`, `findByWorkspace`, ' +
        '`create(tx)`, `update(tx)`, `archive(tx)`, ' +
        '`allocateWorkItemNumber(id, tx)` via `$queryRaw … RETURNING`), extend ' +
        '`workspaceMembershipRepository` with `setActiveProject(userId, workspaceId, ' +
        'projectId, tx)`. Add `lib/services/projectsService.ts` (createProject with ' +
        'identifier generation + collision-suffix retry in a transaction, like ' +
        '`workspacesService.createWorkspace`; renameProject; archiveProject; listProjects; ' +
        'setActiveProject — all asserting workspace membership). Add `lib/dto/projects.ts` + ' +
        '`lib/mappers/projectMappers.ts`. Add typed errors to a ' +
        '`lib/projects/errors.ts` (e.g. `IdentifierCollisionError`, ' +
        '`NotAProjectMemberError` — reuse `NotAMemberError` from ' +
        '`lib/workspaces/errors.ts` where it fits).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `Project` model + `WorkspaceMembership.activeProjectId` added; migration `add_projects`' +
        ' applies cleanly and the down-migration is reversible.\n' +
        '- `projectRepository` exports the single-op methods above; all writes require' +
        ' `tx: Prisma.TransactionClient`; `allocateWorkItemNumber` uses `UPDATE … RETURNING` and is' +
        ' gap-free under concurrent calls (proven by a test in 1.3.5, but the method ships here).\n' +
        '- `projectsService.createProject` generates a workspace-unique 3-5-char uppercase identifier' +
        ' from the name, retries with a numeric suffix on collision, and creates the project in one' +
        ' transaction; returns a DTO, never a raw Prisma row.\n' +
        '- Identifier + slug are unique per workspace (DB constraints + typed-error translation, not' +
        ' generic Prisma errors).\n' +
        '- No `db.*` / `$transaction` outside the service/repository layers.\n' +
        '- All quality gates green: `pnpm prisma generate && typecheck && lint && format:check && build' +
        ' && test`. Existing suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `prodect-core/CLAUDE.md` — the 4-layer contract (auto-loaded)\n' +
        '- `prisma/schema.prisma` — current Workspace + WorkspaceMembership models\n' +
        '- `lib/services/workspacesService.ts` + `lib/repositories/workspace*Repository.ts` — the exact' +
        ' pattern to mirror (slug generation, collision retry, required-`tx` writes, DTO mapping)\n' +
        '- `lib/dto/workspaces.ts` + `lib/mappers/workspaceMappers.ts` — DTO/mapper shape\n' +
        '- Story 1.4 § work_item — the consumer of the key counter + project FK',
    },
    {
      id: '1.3.2',
      title: 'Project RLS policies + active-project resolution in workspace context',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['1.3.1'],
      descriptionMd:
        "The structural multi-tenant gate for projects, plus the read path that resolves a member's " +
        'active project. **(1) Postgres RLS** on the `project` table, keyed off ' +
        'the existing `app.workspace_id` session GUC that 1.2.3 established — a project row is ' +
        "visible/writable only when `project.workspace_id = current_setting('app.workspace_id', true)`. " +
        'Queries without the GUC see no rows (read AND write). This reuses the ' +
        '`withWorkspaceContext` machinery from 1.2.3 unchanged; projects just gain a policy. ' +
        '**(2) Active-project resolution:** a server helper ' +
        '`getActiveProject()` (analogue of `getWorkspaceContext()`) that reads the ' +
        "member's `activeProjectId` (or falls back to the workspace's first project, or null " +
        'if the workspace has none) inside a workspace-scoped transaction.\n\n' +
        '**Why RLS here too, not just app-layer filtering:** defense-in-depth, identical to ' +
        'the rationale in 1.2.3. The service always filters by `workspaceId`, but RLS catches ' +
        'any future endpoint that forgets to. The Story-level "structurally impossible" claim requires the ' +
        "DB-layer gate, validated by 1.3.6's direct-DB test.\n\n" +
        "**What you'll do:** Add a migration (`add_project_rls`) enabling RLS + " +
        'the workspace-match policy on `project`, granting the `prodect_app` role ' +
        '(from 1.2.3) the usual CRUD. Add `projectsService.getActiveProject(userId, workspaceId)` ' +
        'returning a DTO or null, reading via `withWorkspaceContext`. Wire it into ' +
        '`lib/workspaces/index.ts` or a sibling `lib/projects/index.ts` export so ' +
        'server components can read it the same way they read the workspace context. Note finding #5 ' +
        '(dev/CI connects as a BYPASSRLS superuser) — the RLS test in 1.3.6 must `SET LOCAL ROLE ' +
        'prodect_app` to make the policy bite; do NOT copy the direct-Prisma pattern from ' +
        '`lib/workspaces/middleware.ts` (finding #5/#7).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Migration `add_project_rls` enables RLS on `project` and creates a policy matching' +
        " `workspace_id` against `current_setting('app.workspace_id', true)`; grants `prodect_app` CRUD.\n" +
        "- `projectsService.getActiveProject(userId, workspaceId)` resolves the member's" +
        " `activeProjectId`, falling back to the workspace's first project (createdAt asc) or null; runs" +
        ' inside `withWorkspaceContext`; returns a DTO.\n' +
        '- A server-side `getActiveProject()` helper reads session + active workspace + active project,' +
        " mirroring `getWorkspaceContext()`'s shape.\n" +
        '- Existing 11 RLS tests stay green; no behavior change to workspace RLS. 4-layer rule respected.' +
        ' All quality gates green.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/migrations/…add_workspace_rls` — the exact RLS migration pattern to mirror\n' +
        '- `lib/workspaces/context.ts` (withWorkspaceContext) + `lib/workspaces/index.ts` (getWorkspaceContext)' +
        ' — the resolver shape to analogize\n' +
        '- `tests/workspace-rls.test.ts` — the `SET LOCAL ROLE prodect_app` test harness\n' +
        '- `PRODECT_FINDINGS.md` #5/#7 — RLS-inert-under-superuser + the middleware direct-Prisma' +
        ' anti-pattern to NOT copy',
    },
    {
      id: '1.3.3',
      title: 'Mockups: create-project modal, empty state, project switcher',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['1.0.5.2', '1.0.5.3'],
      descriptionMd:
        'Design-first, per Principle #13: mock the three project surfaces before any production React. ' +
        'Compose *only* existing primitives (`Button`, `Input`, ' +
        '`Card`, `Modal`, `Popover`, `EmptyState`) — the same ' +
        "set Story 1.2's UI used. Save to `/design/projects/*.pen` + PNG exports.\n\n" +
        '**Three surfaces:** (1) **Create-project modal** — name ' +
        '`Input` + a live-derived identifier field the user can override (show the ' +
        '`PROD` → `PROD-1` preview), Cancel + Create footer. (2) ' +
        '**Empty state** — "Create your first project" composing the `EmptyState` ' +
        'pattern, shown when the active workspace has zero projects. (3) **Project switcher** — ' +
        'a `Popover` in the top-nav sitting BESIDE the workspace switcher (document the ' +
        "two-switcher layout: workspace-left, project-next-to-it; this composes atop 1.2.6's TopNav, it " +
        'does not replace it). Include the archive double-confirmation modal variant (reuse the ' +
        'delete-confirm grammar from 1.2.6 — typed identifier to confirm).\n\n' +
        '**Top-nav note for 1.5:** Story 1.5 (app shell) will move project nav into a ' +
        "sidebar. Document in the switcher mockup's notes that this top-nav placement is the minimal 1.3 " +
        'form and 1.5 composes atop it — same minimal-then-expand pattern 1.2.1 recorded.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Three mockups exist under `/design/projects/`: `create-modal.png` (with the identifier-override' +
        ' + key preview), `empty-state.png`, `switcher.png` (closed + open), plus an' +
        ' `archive-confirm.png` variant.\n' +
        '- Each surface composes only existing primitives — introduces no new component patterns (Popover' +
        ' already exists as of 1.2.6).\n' +
        '- Copy strings drafted verbatim for 1.3.4 to consume (modal title/labels, empty-state' +
        ' headline/CTA, switcher heading, archive-confirm body).\n' +
        '- Reviewer can view the mockups and react before any production React is written.\n\n' +
        '## Context refs\n\n' +
        '- `docs/design-system.md` + `components/ui/{Button,Input,Card,Modal,Popover,EmptyState}.tsx`\n' +
        '- `/design/workspaces/*.png` from 1.2.1 — the visual grammar to match (switcher, modal,' +
        ' delete-confirm)\n' +
        '- `app/(authed)/_components/{TopNav,WorkspaceSwitcher}.tsx` from 1.2.6 — the nav this composes' +
        ' atop',
    },
    {
      id: '1.3.4',
      title: 'Project UI: create modal + empty state + project switcher + Server Actions',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['1.3.2', '1.3.3'],
      descriptionMd:
        'The production React for projects, following the 1.2.6 mockups-to-code pattern. Adds the ' +
        'project switcher to the existing `(authed)` TopNav (beside the workspace switcher), ' +
        'the create-project modal, the "create your first project" empty state, and the archive flow — ' +
        'all wired through Server Actions (not client fetches), DB access through ' +
        '`projectsService`.\n\n' +
        "**What you'll do:** Add `app/(authed)/_components/ProjectSwitcher.tsx` " +
        "(client; Popover listing the active workspace's projects with a check on active + " +
        '"Create project"; selecting calls a `setActiveProjectAction` Server Action + ' +
        '`router.refresh()`). Compose it into `TopNav.tsx` beside ' +
        '`WorkspaceSwitcher`. Add the create-project `Modal` (name + overridable ' +
        'identifier with live key-preview → `createProjectAction`). Add a project empty-state ' +
        'surface (when the active workspace has zero projects). Add `app/(authed)/_actions` or a ' +
        'project-scoped actions file with `createProjectAction`, ' +
        '`setActiveProjectAction`, `archiveProjectAction` (archive opens the ' +
        "typed-identifier double-confirmation modal). The active-project context comes from 1.3.2's " +
        '`getActiveProject()`. Honor the brand-mark-deferral principle (no wordmark).\n\n' +
        '## Acceptance criteria\n\n' +
        '- TopNav renders the project switcher beside the workspace switcher on every authed route;' +
        ' selecting a project sets `activeProjectId` via a Server Action + `router.refresh()`.\n' +
        '- Create-project modal: name + auto-derived identifier (overridable) with a live' +
        ' `{IDENTIFIER}-1` key preview; Create calls `createProjectAction`; new project becomes active;' +
        ' success toast via the existing Toast primitive.\n' +
        '- Empty state ("Create your first project") shows when the active workspace has zero projects,' +
        ' with a CTA opening the create modal.\n' +
        "- Archive: typed-identifier double-confirmation modal (matching 1.3.3's mockup); confirm calls" +
        ' `archiveProjectAction` (sets `archivedAt`, NOT a hard delete); active project falls back to a' +
        ' remaining project or the empty state.\n' +
        '- All form posts go through Server Actions; zero `db.*` in pages/actions/components. Modal width' +
        ' is correct (uses the fixed Modal primitive — finding #10). All quality gates green.\n\n' +
        '## Context refs\n\n' +
        '- `/design/projects/*.png` from 1.3.3\n' +
        '- `app/(authed)/_components/{TopNav,WorkspaceSwitcher,UserMenu}.tsx` + `app/(authed)/_actions.ts`' +
        ' + `app/(authed)/settings/workspace/*` from 1.2.6 — the exact switcher / Server-Action / modal' +
        ' patterns to mirror\n' +
        '- `lib/services/projectsService.ts` + `getActiveProject()` from 1.3.1/1.3.2\n' +
        "- `components/ui/{Modal,Popover,Toast}.tsx` — note Modal's fixed width variants (finding #10)",
    },
    {
      id: '1.3.5',
      title: 'Vitest: project CRUD + identifier uniqueness + gap-free key counter + active-project',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 14,
      dependsOn: ['1.3.1'],
      descriptionMd:
        'Service-layer integration tests against a real Postgres (no DB mocks, per ' +
        '`CLAUDE.md`), mirroring `tests/workspaces-service.test.ts`. Can run as soon ' +
        'as 1.3.1 lands — does not wait on the UI (1.3.4).\n\n' +
        '**Coverage:** createProject happy path (identifier derived + workspace-unique); ' +
        'identifier collision → numeric-suffix retry; slug + identifier uniqueness within a workspace ' +
        '(same identifier allowed in a DIFFERENT workspace); `allocateWorkItemNumber` is ' +
        'gap-free and monotonic per project AND independent across projects (PROD counter and ACME ' +
        "counter don't interfere); concurrent allocations don't double-issue a number (sequential calls in " +
        'the same transaction return 1,2,3…); setActiveProject persists and is per-member; archiveProject ' +
        'sets `archivedAt` and the project drops out of the active list; cascade — deleting the ' +
        "workspace removes its projects; SetNull — archiving/deleting a project clears members' " +
        '`activeProjectId`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `tests/projects-service.test.ts` covers all cases above; passes against the real dev Postgres.\n' +
        '- The gap-free-counter test proves per-project independence and monotonicity explicitly.\n' +
        '- All quality gates green; total Vitest count grows accordingly; prior suite stays green.\n\n' +
        '## Context refs\n\n' +
        '- `tests/workspaces-service.test.ts` — the exact service-test pattern (truncate beforeEach, real' +
        ' DB, typed-error assertions)\n' +
        '- `lib/services/projectsService.ts` + `lib/repositories/projectRepository.ts` from 1.3.1',
    },
    {
      id: '1.3.6',
      title: 'Project isolation E2E + direct-DB RLS test',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['1.3.2', '1.3.4'],
      descriptionMd:
        "The Story-closing test that proves project-level multi-tenancy is structural, mirroring 1.2.7's " +
        'two-layer approach. **(1) E2E** (Playwright, `@smoke`): user A in ' +
        "workspace A cannot see or act on workspace B's projects — switching the active workspace shows " +
        "only that workspace's projects, and any project-scoped Server Action / endpoint operating on a " +
        "foreign project is refused (cross-tenant returns 404, not 403, per the Story AC and 1.2.7's " +
        'anti-enumeration rule). **(2) Direct-DB** (Vitest, `SET LOCAL ROLE ' +
        'prodect_app`): a transaction without the `app.workspace_id` GUC sees zero ' +
        "`project` rows; with workspace A's GUC sees only A's projects; cross-workspace UPDATE " +
        'affects zero rows; INSERT for a non-matching workspace is denied.\n\n' +
        "**Reuse, don't reinvent:** the E2E helpers (`db-reset`, " +
        '`email-capture`), the `signUp` helper, and the rate-limit env-gate ' +
        '(`E2E_DISABLE_RATE_LIMIT`, already on main per finding #9) from 1.2.6/1.2.7. The RLS ' +
        'test reuses the `SET LOCAL ROLE prodect_app` harness from ' +
        '`tests/multi-tenant-rls.test.ts`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `tests/e2e/project-isolation.spec.ts` (`@smoke`): the project switcher shows only the active' +
        " workspace's projects; a cross-tenant project-scoped action returns 404 (not 403, not 200)." +
        ' Passes locally + CI, no flakes (verify with `--repeat-each`).\n' +
        "- `tests/project-rls.test.ts`: no-GUC → zero project rows; workspace-A GUC → only A's" +
        ' projects; cross-workspace UPDATE → 0 rows; cross-workspace INSERT → RLS denial (42501) —' +
        ' all under `prodect_app`.\n' +
        '- Cascade re-verified: deleting a workspace removes its projects (and their future work items' +
        ' by extension).\n' +
        '- All quality gates green; prior suites stay green.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/multi-tenant-isolation.spec.ts` + `tests/multi-tenant-rls.test.ts` from 1.2.7 —' +
        ' the exact two-layer patterns to mirror\n' +
        "- `tests/e2e/_helpers/{db-reset,email-capture}.ts` + `tests/e2e/workspace-flows.spec.ts`'s" +
        ' `signUp` helper\n' +
        '- `playwright.config.ts` — the `E2E_DISABLE_RATE_LIMIT` env-gate (finding #9)\n' +
        '- `PRODECT_FINDINGS.md` #5 (RLS inert under superuser) — why the role switch is mandatory',
    },
  ],
};
