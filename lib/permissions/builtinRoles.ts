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
 * ⚠️ It is NOT yet every catalog key minus the three level-gated public-request
 * grants. The catalog (MOTIR-2277) covers the whole operation surface, and the
 * keys whose gates nobody has wired — `enforcement: 'planned'` — stay out of
 * every role set until the card that wires them puts them in. Today that leaves
 * MOTIR-2291's eight member-facing keys outside; MOTIR-2256 has put its twelve
 * administrative ones in (below).
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
export const ROLE_GATED_PERMISSIONS: readonly PermissionKey[] = [
  'project:browse',
  'project:administer',
  'work_item:edit',
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
];

/**
 * The three built-in project roles, as sets over the catalog. Typed against
 * {@link PermissionKey}, so a key that does not exist fails to compile.
 *
 *   * **admin**  — the whole role-gated catalog: administers the project (and
 *                  each of MOTIR-2256's twelve per-domain administrative keys),
 *                  moderates comments and attachments, manages watchers.
 *   * **member** — browses, edits work items, comments, attaches. No
 *                  administrative or moderation grant.
 *   * **viewer** — READ-ONLY EVERYWHERE. Browse and nothing else: the shipped
 *                  viewer contract denies comment and attachment creation on
 *                  every access level (the Story 5.1 decision), so the set is a
 *                  single key rather than "member minus edit".
 */
export const BUILTIN_ROLE_PERMISSIONS: Record<ProjectRole, ReadonlySet<PermissionKey>> = {
  admin: new Set<PermissionKey>(ROLE_GATED_PERMISSIONS),
  member: new Set<PermissionKey>([
    'project:browse',
    'work_item:edit',
    'comment:add',
    'attachment:create',
  ]),
  viewer: new Set<PermissionKey>(['project:browse']),
};

/**
 * The implicit grant of a WORKSPACE member who holds NO project membership.
 * They are not a role — nobody assigned them anything — but the shipped policy
 * still admits them to `open` / `limited` / `public` projects, so the resolution
 * needs a base set for them. It matches `member`; the access level is what then
 * takes `work_item:edit` away on `limited` and everything away on `private`.
 *
 * Naming it here (rather than reusing `BUILTIN_ROLE_PERMISSIONS.member` inline)
 * keeps the two ideas distinct: one is a role a human chose, the other is what
 * the workspace grants by default. Story MOTIR-2257's custom roles may change the
 * former without touching the latter.
 */
export const IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS: ReadonlySet<PermissionKey> =
  new Set<PermissionKey>(['project:browse', 'work_item:edit', 'comment:add', 'attachment:create']);

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
