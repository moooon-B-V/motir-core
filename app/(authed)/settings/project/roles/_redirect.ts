// The retired project Roles URLs (Story MOTIR-6168 · MOTIR-6466; design panel
// 4c). Roles live on the workspace, so every `/settings/project/roles/**` route
// PERMANENTLY redirects to its workspace twin with `?from=project`, which draws
// the one-line note explaining where the page went.
//
// A built-in key moves with its meaning: `admin` is now the Manager, `member`
// and `viewer` keep their names. A project CUSTOM role's id names a row the
// workspace does not have — the mapping (MOTIR-6458) re-created each one on the
// workspace under a new id — so it lands on the list, where the role is found by
// its name.

const BUILT_IN: Record<string, string> = { admin: 'manager', member: 'member', viewer: 'viewer' };

export const WORKSPACE_ROLES_HOME = '/settings/workspace/roles';

/** The workspace path for an old `[roleKey]` segment, plus an optional suffix. */
export function workspaceRolePath(roleKey: string, suffix = ''): string {
  const mapped = BUILT_IN[roleKey];
  return mapped
    ? `${WORKSPACE_ROLES_HOME}/${mapped}${suffix}?from=project`
    : `${WORKSPACE_ROLES_HOME}?from=project`;
}
