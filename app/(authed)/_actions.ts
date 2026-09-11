'use server';

import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectsService } from '@/lib/services/projectsService';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { EntitlementExceededError } from '@/lib/billing/errors';
import type { EntitlementKind } from '@/lib/billing/entitlements';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import { toWorkspaceSummaryDTO } from '@/lib/mappers/workspaceMappers';

// Server Actions shared by the top-nav org control + workspace switcher. These
// are HTTP/transport only (per CLAUDE.md, Server Actions are a route-layer
// equivalent): they read the session, call exactly one service method, and set
// the active-tier cookie(s). No db.* and no $transaction here — the service
// owns those.

const COOKIE_OPTIONS = {
  httpOnly: false,
  sameSite: 'lax',
  secure: shouldUseSecureCookies(),
  path: '/',
} as const;

/**
 * Persist the active workspace selection. Validates that the signed-in user is
 * actually a member of the target before trusting the cookie — a forged value
 * can't pin the request to a workspace the user can't access (the
 * workspace-context middleware re-validates on read anyway, but setting an
 * invalid cookie would just silently fall back, so we refuse it here for a
 * clearer contract).
 */
export async function switchWorkspaceAction(workspaceId: string): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');

  await workspacesService.assertMembership(session.user.id, workspaceId);

  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE_NAME, workspaceId, COOKIE_OPTIONS);

  // 8.8.28 — switching to W means you start working in W's active project;
  // mirror it onto the global last-active pointer so re-login lands here. After
  // the cookie write, best-effort (never fails the switch).
  await projectsService.recordLastActiveProjectForWorkspace(session.user.id, workspaceId);
}

/**
 * The answer `createWorkspaceAction` gives. A §4.4 CAP REFUSAL is a legitimate
 * business-rule answer, not a fault, so it travels as a VALUE (MOTIR-5130) —
 * the same shape `items/actions.ts` `createIssueAction` already returns for the
 * §4.1 work-item cap. `entitlement` is the discriminator
 * `lib/billing/entitlements.ts` calls "the field on `EntitlementExceededError`
 * the UI keys its upgrade" prompt from; it is carried across the boundary so the
 * prompt (8.1.7/8.1.8) has something to key on, even though today's callers only
 * render `error`.
 */
export type CreateWorkspaceResult =
  | { ok: true; workspace: WorkspaceSummaryDTO }
  | { ok: false; error: string; entitlement: EntitlementKind };

/**
 * Create a new workspace under the ACTIVE organization and switch to it (Story
 * 6.10.5 — the org menu's "New workspace" entry, the discoverable path to
 * reveal tier 2). The active org comes from the org cookie (resolved + membership-
 * re-validated by the service); passing its id makes `createWorkspace` nest the
 * new workspace under it rather than minting a fresh org (the 6.10.4 org-aware
 * create path). Returns the new workspace summary so the client can reflect it
 * before router.refresh() re-renders the server tree.
 *
 * (The copy-on-create config clone — making the new workspace open already
 * configured like the source — is Subtask 6.10.9, layered on this path later.)
 */
export async function createWorkspaceAction(name: string): Promise<CreateWorkspaceResult> {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');

  const trimmed = name.trim();
  if (!trimmed) throw new Error('EMPTY_NAME');

  const cookieStore = await cookies();
  const orgCookie = cookieStore.get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const activeOrg = await organizationsService.resolveActiveOrganization(
    session.user.id,
    orgCookie,
  );

  // MOTIR-5130 — the §4.4 cap (`entitlementsService.assertWithinWorkspaceCap`)
  // throws a TYPED `EntitlementExceededError` carrying the plan's limit and the
  // upgrade discriminator. Letting it escape a Server Action renders a 500,
  // which makes the opposite claim to the true one: a 500 says Motir
  // malfunctioned, where in fact the cap worked and the plan has a ceiling. The
  // `try` wraps ONLY this call, and only this error class is converted — every
  // other fault (including `CapLockUnavailableError`, which IS a server-side
  // invariant failure and maps to 500 by design) propagates untouched.
  let workspace;
  try {
    ({ workspace } = await workspacesService.createWorkspace({
      name: trimmed,
      ownerUserId: session.user.id,
      organizationId: activeOrg?.organization.id,
    }));
  } catch (err) {
    if (err instanceof EntitlementExceededError) {
      return { ok: false, error: err.message, entitlement: err.entitlement };
    }
    throw err;
  }

  cookieStore.set(WORKSPACE_COOKIE_NAME, workspace.id, COOKIE_OPTIONS);

  // MOTIR-4870 — YOU ARE ALWAYS IN A PROJECT, and this is the second of the
  // three doors into a project-less workspace (the others are registration and
  // archiving the last project). Seeded here rather than inside
  // `createWorkspace` for the same reason the default WORKSPACE is seeded in
  // the auth hook rather than inside the user insert: the service layer has no
  // service-to-service edge to spend on it, and `projectsService` already
  // depends on `workspacesService`.
  //
  // BEST-EFFORT, exactly like its workspace analogue: the workspace is already
  // committed and the cookie already points at it, so a throw here would 500 a
  // switch that has in fact happened. The guarantee is the lazy self-heal in
  // `getActiveProject`, which the very next page render goes through.
  try {
    await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: session.user.id,
    });
  } catch (err) {
    console.error(
      `[workspaces] default-project seed failed for workspace ${workspace.id}; ` +
        `the lazy self-heal will retry on the next active-project resolution.`,
      err,
    );
  }

  // 8.8.28 — a newly created workspace becomes active; record its active project
  // for the global last-active pointer. It resolves a real project now that the
  // seed above has run (it used to be a no-op here, because a brand-new
  // workspace had none until the reader created one).
  await projectsService.recordLastActiveProjectForWorkspace(session.user.id, workspace.id);

  return { ok: true, workspace: toWorkspaceSummaryDTO(workspace) };
}

/**
 * Switch the active organization (Story 6.10.5 — the org menu's "Switch
 * organization" section, shown only to a multi-org account). Sets the org
 * cookie AND re-points the workspace cookie to a workspace the user can reach
 * in the target org, so the active org and active workspace stay consistent
 * (the active workspace's org === the active org). The service re-validates
 * membership; a non-member resolve returns null and we no-op.
 */
export async function switchOrganizationAction(organizationId: string): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');

  const active = await organizationsService.resolveActiveOrganization(
    session.user.id,
    organizationId,
  );
  // resolveActiveOrganization only returns the requested org when the user is a
  // member of it; a mismatch means a forged/stale id — refuse silently.
  if (!active || active.organization.id !== organizationId) return;

  const cookieStore = await cookies();
  cookieStore.set(ORGANIZATION_COOKIE_NAME, organizationId, COOKIE_OPTIONS);

  // Re-point the active workspace to one in the new org (the first the user is a
  // member of). An org-only member with no workspace there keeps no workspace
  // pinned — the shell shows the org with no workspace switcher.
  const workspaces = await workspacesService.listUserWorkspaces(session.user.id);
  const firstInOrg = workspaces.find((w) => w.organizationId === organizationId);
  if (firstInOrg) {
    cookieStore.set(WORKSPACE_COOKIE_NAME, firstInOrg.id, COOKIE_OPTIONS);

    // 8.8.28 — the org switch re-points the active workspace; record THAT
    // workspace's active project as the global last-active pointer. Best-effort;
    // skipped implicitly when the org has no workspace (no firstInOrg).
    await projectsService.recordLastActiveProjectForWorkspace(session.user.id, firstInOrg.id);
  }
}

/**
 * Create a new organization (Story 6.10.5 — the switch-org section's "Create
 * organization") with the signed-in user as its owner, and make it the active
 * org. The new org has no workspace yet, so the workspace cookie is cleared;
 * the user lands in the new (empty) org and creates its first workspace via
 * "New workspace". Returns the new org so the client can reflect it before
 * router.refresh().
 */
export async function createOrganizationAction(name: string): Promise<OrganizationDTO> {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');

  const trimmed = name.trim();
  if (!trimmed) throw new Error('EMPTY_NAME');

  const organization = await organizationsService.createOrganization({
    name: trimmed,
    actorUserId: session.user.id,
  });

  const cookieStore = await cookies();
  cookieStore.set(ORGANIZATION_COOKIE_NAME, organization.id, COOKIE_OPTIONS);
  cookieStore.delete(WORKSPACE_COOKIE_NAME);
  return organization;
}
