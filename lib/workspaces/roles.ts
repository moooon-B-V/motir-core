// Workspace membership roles (Story 1.2's `workspace_membership.role` column).
//
// Story 1.2 shipped the column with a single live value (`member`) and a
// `member` default, leaving real RBAC to a future Story. Subtask 1.6.5 needs a
// privileged tier for the operator dashboard's "Replay" gate (only a workspace
// owner may replay a dead-lettered job), so it promotes the workspace CREATOR
// to `owner` — the role `insertWorkspaceWithOwner` was always named for. This
// file is the single source of truth for those role strings so the gate, the
// creator assignment, and any future RBAC read the same constants instead of
// scattering magic strings.
//
// NOTE (PRODECT_FINDINGS #36): this is the minimal two-tier model the dashboard
// gate requires — creator = owner, everyone invited = member. A full
// role-management surface (promote/demote UI, multiple admin tiers, per-action
// permission matrix) is still future RBAC work; this only materializes the
// owner tier the replay gate depends on.

export const WORKSPACE_ROLE = {
  owner: 'owner',
  member: 'member',
} as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLE)[keyof typeof WORKSPACE_ROLE];

/** True when the given role string is the privileged workspace-owner tier. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return role === WORKSPACE_ROLE.owner;
}
