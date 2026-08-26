// Progressive disclosure of the WORKSPACE tier (MOTIR-3502 · Story 6.10 ·
// `docs/decisions/organization-tier.md` §6).
//
// §6 reveals a tenancy tier only once it offers a CHOICE, and the settings half
// of that rule was never shipped: the header hid the switcher below two
// workspaces while `/settings/workspace` — titled "Workspace settings", carrying
// a Delete workspace danger zone — stayed reachable from four entry points.
//
// ⚠️ WHOSE COUNT. §6 says "count ≥ 2" and does not say whose, and the two
// readings are NOT the same number: an ORGANISATION's workspaces, or the
// VIEWER's workspaces within it. The shipped gate has always used the second —
// `ShellTierNav` counts the list the (authed) layout hands it, which is
// `listUserWorkspaces(session.user.id)` filtered to the active org — and that is
// the right predicate for a DISCLOSURE rule: the question a rendered entry point
// answers is "does this person have a choice to make?", and a workspace they are
// not a member of offers them nothing. (It is emphatically NOT the right
// predicate for the MEMBERSHIP arm in §5, where whether an invitee is
// auto-joined must not depend on the inviter's memberships — that arm reads the
// org's own count and is MOTIR-3501's, not this file's.)
//
// This module is PURE and client-safe on purpose: `AppCommandPalette` and
// `ShellTierNav` are `'use client'`, and a predicate that dragged `next/headers`
// and the service layer behind it could not be shared with them. The server-side
// resolution lives in `tierDisclosure.server.ts`.
//
// This module exists so the number is computed ONCE. The rule is enforced in two
// places that must agree — the entry points that hide the door, and the route
// that answers 404 — and a shell hiding a door to a page that still renders (or
// worse, showing one to a page that 404s) is the failure mode a second
// implementation would produce.

/** Workspaces in the active org at or above which the tier is revealed. */
export const WORKSPACE_TIER_REVEAL_MIN = 2;

/** Anything carrying the org a workspace belongs to — the model or its DTO. */
interface OrgScoped {
  organizationId: string;
}

/**
 * The population the reveal test counts: the viewer's workspaces, narrowed to
 * the active org. With no resolvable active org the list is returned unfiltered,
 * which is what the shell already does — there is no org to scope to, so there
 * is nothing to narrow by.
 */
export function scopeWorkspacesToActiveOrg<T extends OrgScoped>(
  workspaces: T[],
  activeOrgId: string | null,
): T[] {
  if (!activeOrgId) return workspaces;
  return workspaces.filter((w) => w.organizationId === activeOrgId);
}

/**
 * The reveal test itself. Takes the count of an ALREADY org-scoped list — pass
 * the output of `scopeWorkspacesToActiveOrg`, never a raw `listUserWorkspaces`
 * length, or a member of two orgs with one workspace each reads as revealed.
 */
export function isWorkspaceTierRevealed(orgScopedWorkspaceCount: number): boolean {
  return orgScopedWorkspaceCount >= WORKSPACE_TIER_REVEAL_MIN;
}

/**
 * The org the shell treats as active, resolved the way the (authed) layout
 * resolves it: the active WORKSPACE's org wins, and the org cookie is only the
 * fallback for a user with no active workspace (an org-only member). Extracted
 * so the standalone route below cannot drift from the layout.
 */
export function preferredOrganizationId(
  activeWorkspace: OrgScoped | null,
  orgCookie: string | null,
): string | null {
  return activeWorkspace?.organizationId ?? orgCookie;
}
