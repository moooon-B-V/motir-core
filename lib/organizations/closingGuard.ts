import type { Prisma } from '@/generated/prisma/client';
import { OrganizationClosingError } from '@/lib/organizations/errors';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE ORG-TIER HALF OF "A CLOSING ORGANIZATION IS READ-ONLY" (Story MOTIR-6306 ·
// MOTIR-6396; `docs/decisions/organization-deletion.md` §3).
//
// Every project-scoped write is closed by ONE read, in `projectAccessService`'s
// resolution: the resolver intersects the actor's set with the viewer set. Org
// settings, workspaces, members, billing and Git connections are not project-
// scoped and never pass through that resolver, so each of their writes calls one
// of these guards instead — inside its own transaction, AFTER its capability
// check, so an actor with no business in the org is still told 404 / 403 rather
// than learning the org's state.
//
// Transfer is deliberately NOT guarded here: its refusal while closing belongs to
// the schedule service (MOTIR-6399), which owns the request row's lock.
//
// Nothing here writes. A cancel clears `closingSince`, and the next request
// passes — no state to restore.

/** Refuse when organization `organizationId` is closing. `tx` must admit the org row. */
export async function assertOrgNotClosing(
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if ((await organizationRepository.findClosingSinceById(organizationId, tx)) !== null) {
    throw new OrganizationClosingError(organizationId);
  }
}

/** Refuse when the organization owning `workspaceId` is closing. */
export async function assertWorkspaceOrgNotClosing(
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const rows = await organizationRepository.findClosingByWorkspaceId(workspaceId, tx);
  if (rows) throw new OrganizationClosingError(rows.organizationId);
}

/**
 * Whether the organization owning `workspaceId` is closing — for the ACTORLESS
 * automated paths (the automation engine, the dispatch claim, a run start) that
 * skip a closing org rather than refuse a person. Read under the system context:
 * those paths bind no user, so `organization_membership_visible` cannot admit the
 * org, and both `workspace` and `organization` carry a system read arm.
 */
export async function isWorkspaceOrgClosing(workspaceId: string): Promise<boolean> {
  return withSystemContext(
    async (tx) => (await organizationRepository.findClosingByWorkspaceId(workspaceId, tx)) !== null,
  );
}
