// The active-organization cookie (Story 6.10.5 — the shell org switcher). The
// org analogue of WORKSPACE_COOKIE_NAME (lib/workspaces/middleware.ts): a
// non-httpOnly, lax cookie that pins which organization a multi-org account is
// currently administering. Resolution falls back to the user's first org when
// the cookie is absent or names an org the user no longer belongs to
// (organizationsService.resolveActiveOrganization re-validates membership), so a
// forged/stale value can never pin the shell to an org the user can't see.
//
// Switching the org (switchOrganizationAction) sets this AND re-points the
// workspace cookie to a workspace in the new org, so the active org and the
// active workspace stay consistent (the workspace's org === the active org).
export const ORGANIZATION_COOKIE_NAME = 'motir.org';
