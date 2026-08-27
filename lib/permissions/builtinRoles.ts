import type { ProjectRole } from '@/lib/projects/roles';
import type { PermissionKey } from '@/lib/permissions/catalog';

// The BUILT-IN ROLES as permission SETS (Story MOTIR-2255 · Subtask MOTIR-2261).
// A role stops being a name the policy switches on and becomes a chosen set over
// `lib/permissions/catalog.ts`. These three are IMMUTABLE and seeded to reproduce
// today's behaviour EXACTLY — Story MOTIR-2257 adds project-scoped custom roles
// that start from one of these as their base.
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
 * `viewer` / {@link IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS} gain none. Because
 * `levelGrants` in `lib/permissions/resolve.ts` treats every key that is not
 * `work_item:edit` / `comment:add` / `attachment:create` identically, each of the
 * twelve resolves to EXACTLY the actors `project:administer` resolves to, on all
 * four access levels and both rails. `tests/permissions/accessParity.test.ts`
 * proves that equivalence over the whole 64-row input space rather than asserting
 * it here.
 */
/**
 * The TIER a membership on a CUSTOM role sits at (Story MOTIR-2257; Yue,
 * 2026-08-09).
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
 * The three built-in project roles, as sets over the catalog. Typed against
 * {@link PermissionKey}, so a key that does not exist fails to compile.
 *
 *   * **admin**  — the whole role-gated catalog: administers the project (and
 *                  each of MOTIR-2256's twelve per-domain administrative keys),
 *                  moderates comments and attachments, manages watchers.
 *   * **member** — browses, edits work items, comments, attaches, and (MOTIR-2291)
 *                  runs the planner, manages sprints and saved filters, triages
 *                  and acts on a generated plan, and (MOTIR-3629) ARCHIVES a work
 *                  item. No administrative or moderation
 *                  grant, and NOT `import:run` / `work_item:delete` — both mirrors
 *                  put a bulk import and a delete cascade at admin, and the
 *                  reversible soft-remove is what MOTIR-3629 separated from the
 *                  second of those.
 *   * **viewer** — READ-ONLY EVERYWHERE. Browse, plus (MOTIR-2291) `report:view`:
 *                  the shipped viewer contract denies comment and attachment
 *                  creation on every access level (the Story 5.1 decision), and a
 *                  report is an aggregation of rows they may already read one at a
 *                  time — Jira has no report permission separate from browse.
 *
 * The eight MOTIR-2291 additions are assigned by
 * `docs/decisions/member-facing-permissions.md`; that record is the source, and a
 * divergence between it and these sets is a bug here, not a judgement call.
 */
export const BUILTIN_ROLE_PERMISSIONS: Record<ProjectRole, ReadonlySet<PermissionKey>> = {
  admin: new Set<PermissionKey>(ROLE_GATED_PERMISSIONS),
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
    // resolved through `ai:view_plan`, so the key lands beside it; `viewer` and
    // the implicit workspace-member grant take neither, exactly as before.
    'ai:decide_plan',
  ]),
  viewer: new Set<PermissionKey>(['project:browse', 'report:view']),
};

/**
 * The implicit grant of a WORKSPACE member who holds NO project membership.
 * They are not a role — nobody assigned them anything — but the shipped policy
 * still admits them to `open` / `limited` / `public` projects, so the resolution
 * needs a base set for them. The access level is what then takes `work_item:edit`
 * away on `limited` and everything away on `private`.
 *
 * Naming it here (rather than reusing `BUILTIN_ROLE_PERMISSIONS.member` inline)
 * keeps the two ideas distinct: one is a role a human chose, the other is what
 * the workspace grants by default. Story MOTIR-2257's custom roles may change the
 * former without touching the latter.
 *
 * ⚠️ AND THE TWO SETS NOW DIVERGE (MOTIR-2291), which is the whole reason the
 * constant exists. Of the eight member-facing keys this set takes exactly ONE —
 * `report:view`. A stranger to the project may read its charts, because a
 * burndown aggregates rows they can already read one at a time. They may NOT
 * spend the workspace's AI credits, run an importer, restructure a sprint,
 * author a shared saved filter, accept a triage submission or delete a subtree
 * on a project nobody put them on: those are acts of ownership, and a workspace
 * membership is not one. Argued in `docs/decisions/member-facing-permissions.md`
 * §2 — copying `member`'s set here is now a REAL capability grant, not a
 * shortcut.
 *
 * ⚠️ AND `work_item:archive` DOES NOT ENTER EITHER (MOTIR-3629), which is the
 * one place that key parts from `member`. The argument above is what decides it:
 * archiving takes a row out of every active view for the whole team, and a
 * stranger to the project making the board's contents disappear is an act of
 * ownership even though it is reversible. Editing a field they can already read
 * is not the same act, which is why `work_item:edit` is here and this is not.
 */
export const IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS: ReadonlySet<PermissionKey> =
  new Set<PermissionKey>([
    'project:browse',
    'work_item:edit',
    'comment:add',
    'attachment:create',
    'report:view',
  ]);

/**
 * The grants decided by the project's ACCESS LEVEL alone, held by every actor —
 * signed-in or not, in the workspace or not — when the project is `public`
 * (Story 6.12 · `docs/decisions/public-projects.md`). `project:browse` is
 * `canBrowse`'s leading unconditional branch; the three request grants are the
 * only writes a public non-member may perform.
 */
export const PUBLIC_PROJECT_PERMISSIONS: readonly PermissionKey[] = [
  'project:browse',
  'public_request:submit',
  'public_request:upvote',
  'public_request:comment',
];
