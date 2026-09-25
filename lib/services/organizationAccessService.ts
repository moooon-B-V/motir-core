import type { OrganizationRole, Prisma } from '@/generated/prisma/client';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { withOrgContext } from '@/lib/organizations/context';
import { orgCan, type OrgCapability } from '@/lib/organizations/capabilities';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';

/**
 * WHO MAY ADMINISTER AN ORGANISATION — asked in more than one service, so it is
 * declared once (Story MOTIR-4669 · MOTIR-4678).
 *
 * These two guards lived as private functions inside `organizationsService`.
 * MOTIR-4678 needs the same question answered from `organizationRepoService`,
 * and `lib/organizations/roles.ts` already says what happens when it is answered
 * twice: *"Two copies of 'who may administer an organization' is exactly the
 * shape that drifts when a fourth role is added."* Copying them would have made
 * that comment describe the tree. So they moved here and
 * `organizationsService` imports them — one definition, two callers.
 *
 * ⚠️ THE TWO GUARDS RAISE DIFFERENT ERRORS ON PURPOSE, and the difference is the
 * cross-tenant posture rather than a convenience:
 *
 *   - a NON-MEMBER gets `OrganizationNotFoundError` (→ 404). An org the actor is
 *     not in must be indistinguishable from an org that does not exist; a 403
 *     would confirm the id names something real.
 *   - a plain MEMBER of the org gets `OrgForbiddenError` (→ 403). They can
 *     already see the organisation, so there is nothing left to hide, and a 404
 *     here would tell them their own org had vanished.
 *
 * Both take the CALLER's `tx`: the membership read must run inside the same
 * transaction as the write it gates, or a concurrent role change could land
 * between the check and the effect.
 */
export async function assertOrgMember(
  userId: string,
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<OrganizationRole> {
  const membership = await organizationMembershipRepository.findByOrgAndUserInTx(
    organizationId,
    userId,
    tx,
  );
  if (!membership) throw new OrganizationNotFoundError(organizationId);
  return membership.role;
}

/**
 * {@link assertOrgMember}, then require `capability` from the org-role table
 * (`lib/organizations/capabilities.ts`, MOTIR-6305). Same two codes as the
 * member guard: a non-member → `OrganizationNotFoundError` (404), a member whose
 * role lacks the capability → `OrgForbiddenError` (403).
 *
 * Pass the caller's `tx` when the check gates a write in that transaction (the
 * reason the member guard takes one). Without it the read opens its own org
 * context — for a caller that only needs the answer, not a lock-step with a write.
 */
export async function assertOrgCapability(
  userId: string,
  organizationId: string,
  capability: OrgCapability,
  tx?: Prisma.TransactionClient,
): Promise<OrganizationRole> {
  const check = async (t: Prisma.TransactionClient): Promise<OrganizationRole> => {
    const role = await assertOrgMember(userId, organizationId, t);
    if (!orgCan(role, capability)) throw new OrgForbiddenError(userId, organizationId);
    return role;
  };
  if (tx) return check(tx);
  return withOrgContext({ userId, organizationId }, check);
}

/**
 * {@link assertOrgMember}, then require the org-settings capability — an Owner
 * or an Admin. Kept as a thin wrapper over {@link assertOrgCapability} so its
 * existing callers read the capability table without each being re-pointed.
 */
export async function assertOrgAdmin(
  userId: string,
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await assertOrgCapability(userId, organizationId, 'manageOrgSettings', tx);
}

/**
 * WHETHER THE ACTOR ADMINISTERS THE ORGANISATION THAT OWNS A WORKSPACE — the
 * boolean a SURFACE needs, as distinct from the assertion a WRITE needs
 * (Story MOTIR-4669 · MOTIR-4681).
 *
 * ⚠️ IT IS NOT A SECOND GATE, and the distinction matters. The write's gate is
 * `assertOrgAdmin`, inside the transaction that performs it — that is what makes
 * the refusal real. This answers a rendering question: does the room draw the
 * `Add repository` button, or the sentence that says who can. A surface that
 * decided the answer for itself would be a second implementation of "who may
 * administer an organisation", which `lib/organizations/roles.ts` names as the
 * shape that drifts; a surface that called the ASSERTION would have to catch an
 * exception to render a button.
 *
 * Returns FALSE rather than throwing for a non-member: a caller asking "may I
 * see this affordance?" is not asking about existence, and the 404-not-403 posture
 * belongs on the door, not on the question.
 */
export async function isOrgAdminForWorkspace(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  return orgCanForWorkspace(userId, workspaceId, 'manageOrgSettings');
}

/**
 * {@link isOrgAdminForWorkspace} for ANY capability — whether the actor holds
 * `capability` on the organisation that owns `workspaceId`. The same rendering
 * question, asked of a different row of the table: the workspace danger zone
 * asks `manageWorkspaces` to decide whether to point at where removal went
 * (MOTIR-6312). Same fail-closed posture: an unresolvable workspace is `false`.
 */
export async function orgCanForWorkspace(
  userId: string,
  workspaceId: string,
  capability: OrgCapability,
): Promise<boolean> {
  try {
    return await withWorkspaceContext({ userId, workspaceId }, async (tx) => {
      const organizationId = await resolveOrganizationId(workspaceId, tx);
      const membership = await organizationMembershipRepository.findByOrgAndUserInTx(
        organizationId,
        userId,
        tx,
      );
      return orgCan(membership?.role, capability);
    });
  } catch {
    // An unresolvable workspace is a caller error, not an admin. The room renders
    // the no-permission arm, which is the safe answer for a question about an
    // affordance.
    return false;
  }
}
