import type { WorkspaceRole } from '@/generated/prisma/client';
import type { ProjectRole } from '@/lib/projects/roles';
import type { PermissionKey } from '@/lib/permissions/catalog';

// The BUILT-IN ROLES as permission SETS (Story MOTIR-2255 · Subtask MOTIR-2261).
// A role stops being a name the policy switches on and becomes a chosen set over
// `lib/permissions/catalog.ts`. These three are IMMUTABLE.
//
// ⚠️ THEY ARE WORKSPACE ROLES NOW (Story MOTIR-6168 · MOTIR-6459;
// `docs/decisions/role-model.md` §2–§3). Each person holds ONE role per workspace
// — Manager, Member or Viewer, or a workspace custom role authored from one of
// them — and it is their role in every project of that workspace. Projects carry
// no roles: a project only says whether the person was ADDED to it, which is
// what the access level reads. The sets below are the old project `admin` /
// `member` / `viewer` sets carried over UNCHANGED as Manager / Member / Viewer,
// so the move changes who holds a set, never what a set means. And there is no
// "workspace member with no role" any more, so the implicit set that stood below
// them is gone (`member-facing-permissions.md`, the 2026-09-26 amendment).
//
// Each set is the role's MAXIMAL grant, i.e. what it holds on the most-open
// access level. The project's `accessLevel` then SUBTRACTS from it — see
// `lib/permissions/resolve.ts`, which owns that half. Keeping the two separate is
// what makes a role readable on its own ("what does Member mean?") without
// having to hold four access levels in your head at the same time.
//
// ⚠️ The three `public_request:*` keys are NOT in any role set. They are decided
// by the project's access LEVEL alone (`public`), for every actor including an
// anonymous one — the Story 6.12 grant. A role cannot hold or withhold them, so
// putting them in a role set would be a lie in the grid the settings page renders.

/**
 * The permissions a role can hold. This is also the set the workspace-manager
 * always-pass rail resolves to (see `resolvePermissions`), which is why it is
 * named here rather than inlined: "the full role-gated catalog" is a concept the
 * resolution and the role editor both need.
 *
 * ⚠️ It IS now every catalog key minus the three level-gated public-request
 * grants — MOTIR-2256 put its twelve administrative keys in, and MOTIR-2349 has
 * put MOTIR-2291's eight member-facing ones in (below). That is a property of
 * where the two stories got to, not a rule: a key the catalog (MOTIR-2277) adds
 * for an operation nobody has wired stays OUT of every role set until the card
 * that wires it puts it in, because a role that offers a switch controlling
 * nothing is a lie in the grid the settings page renders.
 *
 * ⚠️ Membership here is INERT until a gate consults the key, which is why a key
 * can be role-holdable while its `enforcement` is still `planned`. The eight
 * below were exactly that when MOTIR-2349 added them; every one is now wired and
 * `enforced` (MOTIR-2356), so the seam has served its purpose and the property it
 * describes is what makes the NEXT such key safe to name before it is gated.
 *
 * ⚠️ THE TWELVE ADMINISTRATIVE KEYS ARE HERE, AND THAT IS BEHAVIOUR-NEUTRAL.
 * They enter alongside `project:administer` and nowhere else: `member` /
 * `viewer` gain none. Because `levelGrants` in `lib/permissions/resolve.ts`
 * treats every key but `work_item:edit` identically, each of the twelve resolves
 * to EXACTLY the actors `project:administer` resolves to, on all four access
 * levels. `tests/permissions/accessParity.test.ts` proves that over the whole
 * input space rather than asserting it here.
 */
/**
 * The TIER a membership on a PROJECT custom role sits at (Story MOTIR-2257; Yue,
 * 2026-08-09).
 *
 * ⚠️ LEGACY SINCE MOTIR-6459. The resolver no longer reads a project role at all;
 * its successor is `CUSTOM_WORKSPACE_ROLE_TIER` (`lib/workspaces/roles.ts`), which
 * a workspace custom role sits at for the same reason. This constant survives only
 * for the project-role writers MOTIR-6464 retires, and the follow-up contract
 * story drops the columns it describes.
 *
 * `ProjectMembership.role` and `.roleDefinitionId` move together, and this is
 * the value the first takes whenever the second is set. It exists because the
 * model still needs a tier for two things a permission set cannot answer:
 * `private` gates on holding a membership at all, and `levelGrants` reads the
 * column.
 *
 * ⚠️ IT IS `member`, AND THAT MEANS THE ACCESS LEVEL SUBTRACTS NOTHING FROM A
 * CUSTOM ROLE — a custom role grants EXACTLY WHAT IT LISTS, on every access
 * level. That is deliberate: the level's tier subtraction exists to narrow the
 * COARSE built-in roles, and a permission set an admin enumerated by hand is not
 * coarse. Second-guessing it would mean a role could list `work_item:edit` and
 * silently not have it.
 *
 * (An earlier revision derived this per-role from a stored `based_on` column.
 * That column recorded PROVENANCE which never re-flowed, so it was a claim about
 * how the role was once authored rather than a fact about it — removed, and this
 * one constant replaces the whole mechanism.)
 */
export const CUSTOM_ROLE_TIER: ProjectRole = 'member';

export const ROLE_GATED_PERMISSIONS: readonly PermissionKey[] = [
  'project:browse',
  'project:administer',
  'work_item:edit',
  // MOTIR-3629 — the REVERSIBLE half of removal, split out of `work_item:delete`.
  // Role-gated (a role may hold or withhold it) and NOT level-gated: an access
  // level decides who may see and edit a project, and hiding a row you may
  // already edit is not a different kind of act. It sits beside `work_item:edit`
  // rather than beside `work_item:delete` because that is who holds it —
  // `member` gains it, `admin` gains it as part of this whole set, and the
  // implicit workspace-member grant does not.
  'work_item:archive',
  'comment:add',
  'comment:moderate',
  'attachment:create',
  'attachment:delete_any',
  'watcher:manage',
  // MOTIR-5292 — deciding an approval gate routed to somebody ELSE, the escape
  // hatch when the routed recipient is away. It used to be the WORKSPACE ROLE
  // itself (`isWorkspaceManager`), which no custom role could ever hold and which
  // even a project `admin` failed. Entering here keeps every workspace owner/admin
  // able to unblock (the always-pass rail resolves to this whole set) and GIVES
  // it to the built-in project `admin` — a deliberate widening. `member`,
  // `viewer` and the implicit workspace-member grant do not take it: deciding
  // work that is not yours is an act of ownership over the project.
  'approval:decide_any',
  // MOTIR-5305 — SEEING every approval record of the project, not only your own.
  // Role-gated beside its `decide_any` sibling and on the same terms: the built-in
  // `admin` holds it through this whole set, workspace owners/admins hold it
  // through the always-pass rail, and a custom role can be granted it. `member`,
  // `viewer` and the implicit workspace-member grant do NOT — a member sees the
  // records routed to them and the ones they decided, which is a RELATIONSHIP to
  // a row and needs no key. MOTIR-5305 named it `planned` while nothing consulted
  // it; MOTIR-5301's records read (`approvalGatesService.listRecords`) enforces it.
  // ⚠️ SUPERSEDED for `member` and `viewer` by MOTIR-6328 (below): the DECISION
  // card MOTIR-6165 (Q2, 2026-09-24) gives every built-in role that browses every
  // view-any key, so the rooms open on the whole project by default.
  'approval:view_any',
  // MOTIR-6328 — the Plans and Runs rooms' view-any keys, beside the Approvals
  // room's (Story MOTIR-6179). `admin` holds both through this whole set and a
  // custom role can be granted or denied them, which is how a team closes a room.
  // `levelGrants` does not name them, so each resolves exactly like
  // `project:browse` on all four access levels and both rails —
  // `tests/permissions/accessParity.test.ts` proves that rather than assuming it.
  'plan:view_any',
  'run:view_any',
  // MOTIR-2256 — the twelve per-domain administrative keys that fall out of
  // `project:administer`. Admin holds all twelve, which is what makes the split
  // neutral wherever the umbrella already stood.
  'member:manage',
  'project:manage_access',
  'board:configure',
  'workflow:manage',
  'automation:manage',
  'field:manage',
  'component:manage',
  'label:manage',
  'estimation:manage',
  'repository:manage',
  'repository:manage_access',
  // MOTIR-5260 — beside them, and granted to exactly the roles that already hold
  // `repository:manage`: connecting a third-party credential is the same tier of
  // act as attaching a repository, and this key is NEW, so no actor loses
  // anything by its arriving here.
  'integration:manage',
  'ai:configure',
  // MOTIR-2291 — the eight MEMBER-FACING keys, assigned by
  // `docs/decisions/member-facing-permissions.md`. Unlike the twelve above, these
  // are NOT equivalent to `project:administer`: six of them reach `member` and one
  // reaches `viewer` and the implicit workspace-member grant. The operations they
  // will govern are ungated today, so wiring them REMOVES capability — which is
  // why the assignment was argued in a record before any of it was typed here.
  'sprint:manage',
  'report:view',
  'saved_filter:manage',
  // MOTIR-5293 — the saved-filter "anyone's" tier, and it lands in `admin` ALONE
  // (not `member`, `viewer` or the implicit grant). It replaces a ROLE read —
  // workspace owner/admin, or project role `admin` — and the manager rail plus
  // this set resolve to exactly those actors; `levelGrants` does not name it, so
  // a project admin keeps it on every level, as the role read (which ignored the
  // level) did. Behaviour-neutral for every built-in role, proved over all 64
  // inputs in `tests/permissions/accessParity.test.ts`. What it ADDS is that a
  // custom role can list it.
  'saved_filter:manage_any',
  'import:run',
  'work_item:delete',
  'work_item:triage',
  'ai:plan',
  'ai:view_plan',
  // MOTIR-3188 — DECIDE, split out of the conflated `ai:view_plan`. It enters
  // here and at `member` (below) and nowhere else, which is what makes the split
  // behaviour-neutral: every actor who could approve a plan before can approve
  // one after. `levelGrants` names only the three edit-ish keys, so this one
  // takes the default arm and resolves exactly as `ai:view_plan` does on all
  // four access levels and both rails — `tests/permissions/planDecisionSplit.test.ts`
  // proves that equivalence rather than asserting it here.
  'ai:decide_plan',
  // MOTIR-3336 — the lesson library. Role-gated (a role may hold or withhold
  // them), so `admin`, which is defined as this whole set, gains both with no
  // edit below; `member` and `viewer` name their keys explicitly and gain
  // neither. Not level-gated: an access level decides who can see a PROJECT,
  // and what its planner learned is not part of what `public` publishes.
  'lesson:view',
  'lesson:manage',
  // MOTIR-3553 — beside them, and role-gated for the same reason. It sits with
  // `lesson:view` rather than below it: reinforcing presupposes reading.
  'lesson:reinforce',
];

/**
 * The three built-in WORKSPACE roles, as sets over the catalog. Typed against
 * {@link PermissionKey}, so a key that does not exist fails to compile.
 *
 *   * **manager** — the whole role-gated catalog, in every project of the
 *                  workspace (the old project `admin` set — and exactly what the
 *                  resolver's manager rail already granted): administers the project (and
 *                  each of MOTIR-2256's twelve per-domain administrative keys),
 *                  moderates comments and attachments, manages watchers, and
 *                  (MOTIR-5293) manages anyone's saved filters.
 *   * **member**  — browses, edits work items, comments, attaches, and (MOTIR-2291)
 *                  runs the planner, manages sprints and saved filters, triages
 *                  and acts on a generated plan, and (MOTIR-3629) ARCHIVES a work
 *                  item. No administrative or moderation
 *                  grant, and NOT `import:run` / `work_item:delete` — both mirrors
 *                  put a bulk import and a delete cascade at admin, and the
 *                  reversible soft-remove is what MOTIR-3629 separated from the
 *                  second of those.
 *   * **viewer**  — READ-ONLY EVERYWHERE. Browse, plus (MOTIR-2291) `report:view`:
 *                  the shipped viewer contract denies comment and attachment
 *                  creation on every access level (the Story 5.1 decision), and a
 *                  report is an aggregation of rows they may already read one at a
 *                  time — Jira has no report permission separate from browse.
 *
 * The eight MOTIR-2291 additions are assigned by
 * `docs/decisions/member-facing-permissions.md`; that record is the source, and a
 * divergence between it and these sets is a bug here, not a judgement call.
 */
export const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<PermissionKey>> = {
  manager: new Set<PermissionKey>(ROLE_GATED_PERMISSIONS),
  member: new Set<PermissionKey>([
    'project:browse',
    'work_item:edit',
    // MOTIR-3629 — and this one is NOT behaviour-neutral; it is the point of the
    // split. A member holds `work_item:edit` and not `work_item:delete`, so under
    // one key they could not archive at all — a far stronger restriction than
    // "may not destroy a subtree", and one nobody chose: the shared ⋯ menu offers
    // them the Archive row on `work_item:edit` and the service refused it on
    // `work_item:delete`, so the product has been showing a member an affordance
    // that 403s. The mirror it is read from is the one this archive semantic is
    // already copied from — Linear, where archiving is every member's ordinary
    // remove and destroying is not (`archiveWorkItem`'s own header cites "the
    // Linear shape" for leaving children intact). `viewer` does NOT gain it: a
    // read-only actor removes nothing.
    'work_item:archive',
    'comment:add',
    'attachment:create',
    // MOTIR-2291 — the six member-facing keys the decision puts at `member`.
    'sprint:manage',
    'report:view',
    'saved_filter:manage',
    'work_item:triage',
    'ai:plan',
    'ai:view_plan',
    // MOTIR-3188 — the DECIDE half. `member` is where approve/decline already
    // resolved through `ai:view_plan`, so the key lands beside it; `viewer` takes
    // neither, exactly as before.
    'ai:decide_plan',
    // MOTIR-6328 — the three rooms' view-any keys (DECISION MOTIR-6165 Q2,
    // 2026-09-24): a member sees every plan, approval record and run of the
    // project, and ALSO gets a Mine tab because they can act in each room.
    // `approval:view_any` is a widening for them — before, a member saw only the
    // records routed to them or decided by them.
    'approval:view_any',
    'plan:view_any',
    'run:view_any',
  ]),
  // MOTIR-6328 — the same three view-any keys, and NOTHING that authors, decides
  // or starts (DECISION MOTIR-6165 Q2). A viewer opens Plans, Approvals and Runs
  // on the whole project and sees the Project tab alone; `approval:view_any` is
  // the widening the owner asked for, because a viewer's own-records Approvals
  // room was empty by construction (nothing is ever routed to a read-only actor).
  viewer: new Set<PermissionKey>([
    'project:browse',
    'report:view',
    'approval:view_any',
    'plan:view_any',
    'run:view_any',
  ]),
};

/**
 * The LEGACY project-role view of the sets above — `admin` is the Manager set —
 * for the two surfaces that still speak project roles until they move: the
 * project Roles page's catalogue (`permissionMappers`, MOTIR-6466 moves it to the
 * workspace) and the project custom-role editor's "Start from"
 * (`projectRoleDefinitionService`, retired by MOTIR-6464). Derived, never
 * declared, so it cannot drift from the sets the resolver reads — and the role
 * migration's literal-snapshot test (MOTIR-6458) reads it too.
 */
export const BUILTIN_ROLE_PERMISSIONS: Record<ProjectRole, ReadonlySet<PermissionKey>> = {
  admin: WORKSPACE_ROLE_PERMISSIONS.manager,
  member: WORKSPACE_ROLE_PERMISSIONS.member,
  viewer: WORKSPACE_ROLE_PERMISSIONS.viewer,
};

/**
 * The grants decided by the project's ACCESS LEVEL alone, held by every actor —
 * signed-in or not, in the workspace or not — when the project is `public`
 * (Story 6.12 · `docs/decisions/public-projects.md`). `project:browse` is
 * `canBrowse`'s leading unconditional branch; the three request grants are the
 * only writes a public non-member may perform.
 */
export const PUBLIC_PROJECT_PERMISSIONS: readonly PermissionKey[] = [
  'project:browse',
  // MOTIR-6328 — a signed-in non-member of a `public` project opens `/plans` and
  // `/runs` on browse today, so they keep that reach once the reads assert the
  // rooms' view keys. Not `approval:view_any`, which they have never held.
  'plan:view_any',
  'run:view_any',
  'public_request:submit',
  'public_request:upvote',
  'public_request:comment',
];
