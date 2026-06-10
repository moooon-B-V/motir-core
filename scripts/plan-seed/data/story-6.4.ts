import type { PlanStory } from '../types';

/**
 * Story 6.4 — Roles & permissions (project membership + access gating).
 *
 * Expanded from its `stubs.ts` entry. The spine is **project-level access
 * gating** — the thing the rest of the PM core has been deferring with
 * `// TODO(6.4): gate by project role` notes (2.2.5, 3.3.3, …). Until now access
 * was workspace-level only; this story makes it **project-level**, matching the
 * mirror.
 *
 * Mirror product (rung 1; VERIFIED June 2026, Atlassian docs — checked, not
 * asserted, per `notes.html` mistake #33): Jira DOES gate by project. A
 * **team-managed** project has an **Access level — Open / Limited / Private**:
 * Open = any site (workspace) member can view + edit; Limited = any member can
 * view + comment but not edit; **Private = only people explicitly added to the
 * project** (via a project role) can see it at all. Company-managed projects do
 * the same via the **"Browse Projects"** permission restricted to project roles.
 * So project access = a per-project membership/role, NOT just site membership.
 * We mirror the team-managed three-level model (it is the simpler, more direct
 * fit for Prodect's workspace→project shape).
 *
 * This formalizes Story 1.2's flat `WorkspaceMembership.role` string into an
 * explicit role set and adds a `ProjectMembership` + a project `accessLevel`.
 * Migration-aware: existing data is mapped to safe defaults so nobody is locked
 * out on deploy.
 *
 * ⚠️ Design gate (planning-time): the project **Access** settings + the project
 * **Members** admin + the no-access state are new UI, unspecified in
 * `design/projects/` — so 6.4.1 is a `type: design` subtask that produces them
 * FIRST, and every UI-touching code subtask (6.4.5 / 6.4.6) carries it in
 * `dependsOn` (Principle #13).
 *
 * Seed loop: once `ProjectMembership` exists, 6.4.7 updates `pnpm db:seed` to
 * enroll the moooon team in the `prodect` project (the project-gating half of
 * the workspace+project ask) — the workspace half already shipped.
 */
export const story_6_4: PlanStory = {
  id: '6.4',
  title: 'Roles & permissions — project membership + access gating',
  status: 'done',
  descriptionMd:
    'Gate access at the **project** level, not just the workspace — the mirror-faithful model the ' +
    'PM core has been deferring (`// TODO(6.4): gate by project role`). A project gets an **access ' +
    'level** (Jira team-managed: **open / limited / private**) and an explicit **project membership ' +
    "with a per-project role** (admin / member / viewer); Story 1.2's flat workspace-membership " +
    '`role` string is formalized into the same role set. **Browse access** is then computed: *open* ' +
    '→ any workspace member (view + edit); *limited* → any workspace member (view + comment, no ' +
    'edit); *private* → only project members (workspace owner/admin always). This is enforced at the ' +
    'service layer and gated in the UI.\n\n' +
    '**Verified mirror (rung 1, mistake #33 — checked, not asserted).** Jira gates by project: a ' +
    'team-managed project’s Access level (open/limited/private) decides whether site members see it, ' +
    'and a private project requires explicit per-project role assignment; company-managed restrict ' +
    'the "Browse Projects" permission to project roles. So project access = per-project ' +
    'membership/role. We mirror the team-managed three-level model.\n\n' +
    '**Migration-aware (no lockout).** Existing `WorkspaceMembership.role` values map to the new role ' +
    'set (owner→owner/admin, the rest→member); **existing projects default to `open`** so every ' +
    'current workspace member keeps access on deploy (a private default would lock everyone out). ' +
    'Project membership is created lazily / on access-level change — making a project private ' +
    'seeds its current viewers as members (the Jira "set private → add the people who had access" ' +
    'shape), never an empty private project the owner is locked out of.\n\n' +
    '**Scope:** the role + project-membership + access-level model; the service-layer browse/edit ' +
    'gate threaded into the existing project / board / issue reads (the retrofit of the deferred ' +
    'seams); the project **Members** + **Access** admin UI; UI gating (inaccessible projects hidden ' +
    'from the switcher + a no-access state on direct nav; assignable users scoped to project ' +
    'members, the Jira behaviour); the seed update; tests.\n\n' +
    '**Out of scope (Epic-6 siblings / later):** field-level / workflow-level permission schemes ' +
    '(Jira’s full permission-scheme matrix — we ship the browse/edit gate + project roles, not the ' +
    'dozen-permission grid); global/site admin roles beyond workspace owner/admin; per-issue ' +
    'security levels; the unified project-admin area (Story 6.5 folds Members/Access in alongside ' +
    'workflow 2.2.5 + board-column 3.6).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev`, `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test` — vitest covers: the browse gate per access level (open/limited/private), project-role assignment, the workspace-role migration mapping + the `open` project default, and assignable-users scoping to project members.\n' +
    '- **Private-project gating (the core check):** as the PM (`zhuyue@prodect.co`) set the `prodect` project to **Private**; sign in as a workspace member who is NOT a project member → the project is absent from the switcher and a direct `/boards` / `/issues` link shows the no-access state; add them as a project member → it appears and opens.\n' +
    '- **Roles:** a project **viewer** can open the board/issues but cannot edit (create/move/assign disabled); a **member** can edit; an **admin** can manage members + access. Workspace **owner/admin** always have access regardless of project membership.\n' +
    '- **Access levels:** **open** → every workspace member sees + edits; **limited** → every member sees + comments but cannot edit; **private** → only members.\n' +
    '- **Assignable users:** on a private project, the assignee/reporter pickers list only project members (not the whole workspace).\n' +
    '- `pnpm test:e2e --grep project-access` drives the real stack: a non-member is denied a private project; a member/viewer/admin get the right capabilities.',
  items: [
    {
      id: '6.4.1',
      title:
        'Design — project Access settings + Members admin + the no-access state (extends design/projects/)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      dependsOn: [],
      descriptionMd:
        'The design asset the project-permissions UI builds against. New surfaces unspecified in ' +
        '`design/projects/`: (a) the project **Access** control (Open / Limited / Private, with a ' +
        'one-line explanation of each, mirroring Jira team-managed); (b) the project **Members** panel ' +
        '— a list of members with their per-project role (admin / member / viewer), an add-member ' +
        'combobox (workspace members not yet on the project), remove, and role-change; (c) the ' +
        '**no-access** state a non-member hits on direct navigation to a private project’s board/issues ' +
        '(an `EmptyState`/`ErrorState`-family panel, "You don’t have access to this project," not a ' +
        'crash); (d) how role-gated affordances read (a viewer sees create/edit controls disabled ' +
        'with a tooltip, not absent-and-confusing). Output: extend `design/projects/` with a mockup ' +
        '(`*.mock.html` from `components/ui/*` + `--el-*`/shape tokens) + PNG + a "Roles & permissions ' +
        '(Story 6.4)" section in `design/projects/design-notes.md`.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The asset + a "Roles & permissions (Story 6.4)" notes section exist; built from `components/ui/*` + `--el-*`/element-shape tokens (no Tier-0 `--color-*`, no raw shape utilities), AA-safe, passes the render checklist.\n' +
        '- Draws: the Access-level control (open/limited/private + copy), the Members panel (list + role + add/remove), the no-access state, and the viewer disabled-affordance treatment (with tooltip).\n' +
        '- `design-notes.md` names the composing primitives (`Combobox` for add-member + role, `Pill` for role, the EmptyState/ErrorState family for no-access, `Tooltip`) and states the migration default (existing projects = open) + that workspace owner/admin always have access.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/` + `design-notes.md` (Story 1.3) — the project surface this extends; `design/workspaces/` (members list precedent)\n' +
        '- `components/ui/*` (Combobox, Pill, EmptyState, ErrorState, Tooltip); Jira team-managed Access (open/limited/private) + project roles as the mirror (rung 1)',
    },
    {
      id: '6.4.2',
      title: 'Schema — role enum + `ProjectMembership` + `project.accessLevel` (migration-aware)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['1.2'],
      descriptionMd:
        'The data model for project gating, in ONE migration. (a) Formalize the role set — a ' +
        '`MemberRole` enum `{ owner, admin, member, viewer }`; keep `WorkspaceMembership.role` (migrate ' +
        'the existing string column: `owner`→`owner`, everything else→`member`). (b) A ' +
        '`ProjectMembership { userId, projectId, role: MemberRole }` join (unique `[userId, projectId]`, ' +
        'RLS-forced + tenant-scoped like `WorkspaceMembership`; cascade on project/user delete). (c) A ' +
        '`project.accessLevel` enum `{ open, limited, private } @default(open)` — existing projects ' +
        'backfill to `open` so no one is locked out.\n\n' +
        '**What this does NOT do:** the enforcement gate (6.4.3), the management API (6.4.4), any UI ' +
        '(6.4.5/6.4.6), or the seed (6.4.7). It also does not build a full permission-scheme matrix — ' +
        'project roles + access level are the model; the browse/edit policy is computed in 6.4.3.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `MemberRole` enum + `ProjectMembership` + `project.accessLevel @default(open)` added in one Prisma migration; `prisma migrate dev` applies cleanly on a fresh DB and is idempotent.\n' +
        '- Existing `WorkspaceMembership.role` values migrate into the enum (owner→owner, else→member); existing projects backfill to `open` (no lockout); `ProjectMembership` is RLS-forced + tenant-scoped (mirror `WorkspaceMembership`).\n' +
        '- `prisma generate` types the new model/enums; a vitest (real Postgres) asserts a project defaults to `open` and a `ProjectMembership` round-trips under RLS.\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — `WorkspaceMembership` (Story 1.2, the `role` string + RLS pattern to mirror) + `Project`\n' +
        '- `prodect-core/CLAUDE.md` — one migration, application-seeded data, RLS-forced tenant tables',
    },
    {
      id: '6.4.3',
      title:
        'Service enforcement — `projectAccess` browse/edit gate threaded into project/board/issue reads',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 34,
      dependsOn: ['6.4.2'],
      descriptionMd:
        'The permission policy + its enforcement, at the service layer (the retrofit of the deferred ' +
        '`TODO(6.4)` seams). A `projectAccessService` (or a guard in `projectsService`) computes, for ' +
        'a `(user, project)`: **canBrowse** — `open`/`limited` → any workspace member; `private` → a ' +
        '`ProjectMembership` exists (or the user is workspace owner/admin, who always pass); ' +
        '**canEdit** — `limited` → false for non-members (view+comment only); else gated by project ' +
        'role (viewer → false, member/admin → true). Thread `canBrowse` into the existing project ' +
        'read, the board projection (`getBoard`), and the issue list/detail reads so a non-member ' +
        'gets a typed `ProjectAccessDeniedError` (→ 403/404 at the route, the no-access state in the ' +
        'UI); thread `canEdit` into the write paths (create/move/assign/update) so a viewer’s writes ' +
        'are rejected. Workspace owner/admin bypass throughout.\n\n' +
        '**Out of scope:** the management API (6.4.4) + UI (6.4.5/6.4.6). This subtask is the policy + ' +
        'wiring it into reads/writes that already exist.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A single `canBrowse(project, ctx)` + `canEdit(project, ctx)` policy (open/limited/private × role), with workspace owner/admin always passing; a typed `ProjectAccessDeniedError` mapped to 403 (existing project) / 404 (hidden).\n' +
        '- `canBrowse` gates the project read + `getBoard` + the issue list/detail reads; `canEdit` gates the issue/board write paths (create/move/assign/update); no read or write path bypasses the gate.\n' +
        '- Vitest (real Postgres) covers each access level × role for both browse + edit, and the owner/admin bypass.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/projectsService.ts`, `boardsService.getBoard`, `workItemsService` reads/writes — the seams to gate (search the `TODO(6.4)` notes, e.g. workflowsService 2.2.5, boardsService 3.3.3)\n' +
        '- finding #26 (explicit app-layer workspace gate — this adds the project tier beneath it); `prodect-core/CLAUDE.md`',
    },
    {
      id: '6.4.4',
      title:
        'Project members + access API — manage memberships, roles, access level (project-admin-gated)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['6.4.2'],
      descriptionMd:
        'The write path for project membership + access, 4-layer (Route → Service → Repository → ' +
        'Prisma) with the explicit workspace gate (finding #26) + a project-admin check. ' +
        '`projectMembersService`: `addMember(projectId, userId, role)` (the user must be a workspace ' +
        'member), `removeMember`, `setRole`, and `setAccessLevel(projectId, level)`. Setting a project ' +
        '**private** seeds its currently-eligible viewers as `member` rows (so the owner + current ' +
        'users aren’t locked out — the Jira "go private → keep current people" shape). All gated to ' +
        'project **admin** (or workspace owner/admin). Routes: `…/projects/[key]/members` ' +
        '(GET/POST/PATCH/DELETE) + `PATCH …/projects/[key]/access`; HTTP-only, typed-error→status.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `projectMembersService` add/remove/setRole + `setAccessLevel` exist, own their transaction, validate (add target must be a workspace member; last-admin guard on remove/role-change), return DTOs; setting `private` seeds current viewers as members.\n' +
        '- Routes are HTTP-only (one service call, typed-error→status: 400 invalid, 403 not project admin, 404 missing); project-admin (or workspace owner/admin) gated.\n' +
        '- Vitest (real Postgres) covers add/remove/setRole, the go-private seeding, the last-admin guard, and a non-admin denial.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/workspacesService.ts` `addMember`/`removeMember`/`listMembers` (Story 1.2) — the membership service precedent to mirror at project scope; the last-member guard pattern\n' +
        '- Story 6.4.2 (`ProjectMembership` + `accessLevel`); `prodect-core/CLAUDE.md` (4-layer)',
    },
    {
      id: '6.4.5',
      title: 'UI — project settings → Members + Access',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['6.4.1', '6.4.4'],
      descriptionMd:
        'The project-settings **Members** + **Access** UI, per `design/projects/` (6.4.1). The ' +
        'Members panel lists project members with their role `Pill`, an add-member `Combobox` (scoped ' +
        'to workspace members not yet on the project), remove, and a role select; the Access control ' +
        'sets open / limited / private with the explanatory copy. Calls the 6.4.4 API optimistically; ' +
        'project-admin-only (non-admins see it read-only). Lives in the project settings area ' +
        '(alongside the 2.2.5 workflow editor; Story 6.5 later unifies these).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A project-settings Members panel (list + role + add/remove via the 6.4.4 API) + an Access control (open/limited/private) render per the 6.4.1 design; project-admin-gated (read-only for non-admins).\n' +
        '- Colours via `--el-*`, shape via element tokens, AA-safe; matches the mockup; the add-member picker is scoped to workspace-members-not-yet-on-project.\n' +
        '- Component tests cover the members list, add/remove/role, and the access-level control.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/` + `design-notes.md` (6.4.1); the workspace Members UI (Story 1.2/1.3) to mirror; `components/ui/*` (Combobox, Pill); Story 6.4.4 (the API)',
    },
    {
      id: '6.4.6',
      title:
        'UI gating — hide inaccessible projects, no-access state, assignable-users scoping, role affordances',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['6.4.1', '6.4.3'],
      descriptionMd:
        'Make the gate visible in the app. (a) The project switcher / nav lists only projects the ' +
        'user can browse (private projects they’re not on are absent). (b) Direct navigation to an ' +
        'inaccessible project’s board/issues renders the **no-access state** (6.4.1), not a crash, ' +
        'off the `ProjectAccessDeniedError`. (c) **Assignable users** — the assignee/reporter pickers ' +
        'on a private project list only project members (the Jira behaviour), workspace members on ' +
        'open/limited. (d) **Role affordances** — a viewer (or a member on a `limited` project) sees ' +
        'create / move / assign / edit controls disabled with an explanatory tooltip, not missing.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The switcher/nav omits non-browsable projects; a direct link to one shows the no-access state (no crash); both driven by the 6.4.3 policy.\n' +
        '- Assignee/reporter pickers are scoped to project members on a private project; viewers / limited-project members see edit affordances disabled with a tooltip (not absent).\n' +
        '- Colours via `--el-*`, shape via element tokens, AA-safe; matches the 6.4.1 design.\n' +
        '- Component tests cover the project-list filtering, the no-access state, the scoped picker, and the disabled-affordance treatment.\n\n' +
        '## Context refs\n\n' +
        '- the project switcher (Story 1.3/1.5 shell) + the assignee/reporter pickers (Story 2.5) — the surfaces to gate; Story 6.4.3 (the policy) + 6.4.1 (the no-access design)',
    },
    {
      id: '6.4.7',
      title:
        'Seed — enroll the moooon team in the `prodect` project (close the project-gating loop)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['6.4.2', '6.4.4'],
      descriptionMd:
        'Now that `ProjectMembership` exists, update `pnpm db:seed` to enroll the team in the ' +
        '`prodect` project — the project-gating half of the original "add the team to the workspace ' +
        'AND the project" ask (the workspace half already shipped). Add each seed user as a ' +
        '`ProjectMembership` (zhuyue@prodect.co = project **admin**, the rest = **member**) and set ' +
        'the `prodect` project’s `accessLevel` (keep **open** so the demo tenant is browsable, OR ' +
        '**private** to showcase gating — pick one and document it; default **open** for a friendly ' +
        'demo). Idempotent with the existing clear/reseed.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm db:seed` creates a `ProjectMembership` for every seed user on the `prodect` project (zhuyue = admin, others = member) and sets the project access level explicitly; re-running stays idempotent.\n' +
        '- A note in `seed.ts` (and the PRODECT.md Plan-seed section) records the chosen access level + the per-user project roles.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/seed.ts` — the team/workspace seeding to extend (the per-item reporter/assignee/priority work already landed); Story 6.4.2/6.4.4 (the model + service)',
    },
    {
      id: '6.4.8',
      title: 'Tests — project access gating (browse/edit per level × role) + focused E2E',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['6.4.2', '6.4.3', '6.4.4', '6.4.5', '6.4.6', '6.4.7'],
      descriptionMd:
        'Prove the gate end-to-end — the same split the other epics use (unit/component + a focused ' +
        'E2E). **Component / unit (vitest, real Postgres):** the browse + edit policy for every ' +
        'access level × project role (incl. the owner/admin bypass), the workspace-role migration ' +
        'mapping + the `open` project default, the go-private member-seeding, the last-admin guard, ' +
        'and assignable-users scoping. **E2E (Playwright) `tests/e2e/project-access.spec.ts`:** set ' +
        'the project private; a non-member is denied (absent from switcher + no-access state on direct ' +
        'nav); add them → they get in; a viewer cannot edit; an admin can manage members. Reuses the ' +
        'real-Postgres harness + the seeded team.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` covers the browse/edit policy matrix (level × role + bypass), the migration defaults, the go-private seeding + last-admin guard, and assignable-users scoping.\n' +
        '- `pnpm test:e2e --grep project-access` runs green: private-project denial + grant, the no-access state, viewer-cannot-edit, admin-manages-members.\n' +
        '- Reuses `tests/helpers/db.ts` truncation + the seeded team; no mocks beyond `getSession`.\n\n' +
        '## Context refs\n\n' +
        '- the 6.4.2–6.4.7 surfaces under test; `tests/helpers/db.ts`; `prodect-core/CLAUDE.md` (real Postgres, no mocks)',
    },
  ],
};
