import { withOrgContext } from '@/lib/organizations/context';
import { isOrgAdminRole } from '@/lib/organizations/roles';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { NotAMemberError, WorkspaceForbiddenError } from '@/lib/workspaces/errors';
import { UserNotFoundError } from '@/lib/users/errors';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { twoFactorPolicyRepository } from '@/lib/repositories/twoFactorPolicyRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import {
  toOrganizationTwoFactorPolicyDTO,
  toTwoFactorRequirementDTO,
  toWorkspaceTwoFactorPolicyDTO,
} from '@/lib/mappers/twoFactorPolicyMappers';
import type {
  OrganizationTwoFactorPolicyDTO,
  TwoFactorRequirementDTO,
  WorkspaceTwoFactorPolicyDTO,
} from '@/lib/dto/twoFactorPolicy';

// The require-2FA POLICY layer (Story MOTIR-1215 · Subtask MOTIR-3645) — read
// and write each tier's setting, and answer the one question the enforcement
// gate asks: does this person need a second factor right now, who is asking,
// and do they already have one?
//
// `lib/` only. This module adds no route, no Server Action, no component and no
// i18n key; its four callers are MOTIR-3646 (the org pane), MOTIR-3647 (the
// workspace control), MOTIR-3648 (the page gate) and MOTIR-3653 (the API gate).
//
// ⚠️ TWO ABSOLUTE SETTERS, NEVER A TOGGLE. Both `set*Policy` methods take the
// DESIRED boolean. A toggle is a read-derived write: two admins flipping at
// once read the same value, both invert it, and the final state depends on
// which commit landed last — so a policy nobody chose. An absolute set is
// idempotent, needs no row lock, and cannot land anywhere the caller did not
// name. Do not helpfully add a `toggle`.
//
// ⚠️ NO SIDE EFFECTS. Nothing is emailed, no session is revoked, no membership
// is touched. Rung 1 is explicit that enforcing two-step verification neither
// logs users out nor emails them (Atlassian), and GitHub removes only outside
// collaborators — a tier Motir does not have. The flip writes one column and
// stops; enforcement happens at the person's NEXT request (MOTIR-3648).

export const twoFactorPolicyService = {
  /**
   * The organization's own require-2FA setting.
   *
   * ⚠️ RLS IS THE GATE HERE, deliberately, and it is the reason this binds the
   * USER rather than the org. Under `withUserContext` the only arm that admits
   * `organization` is `organization_membership_visible`
   * (`id IN (SELECT "organizationId" FROM organization_membership WHERE
   * "userId" = current_setting('app.user_id', true))`), so an org the actor is
   * not a member of comes back as `null` and raises
   * `OrganizationNotFoundError` — the 404-not-403 rule, with no separate gate
   * read to keep in step with it. `withOrgContext` would be the WRONG choice:
   * it binds the org id from the ARGUMENT, so `organization_active` would admit
   * the row for a stranger and the refusal would rest entirely on a second read.
   *
   * Every org MEMBER may read the policy — a person about to be held at the
   * enrolment door is owed the ability to see who is asking.
   */
  async getOrganizationPolicy(
    organizationId: string,
    actorUserId: string,
  ): Promise<OrganizationTwoFactorPolicyDTO> {
    const org = await withUserContext(actorUserId, (tx) =>
      organizationRepository.findByIdInTx(organizationId, tx),
    );
    if (!org) throw new OrganizationNotFoundError(organizationId);
    return toOrganizationTwoFactorPolicyDTO(org);
  },

  /**
   * Set the organization's require-2FA policy. Org owner/admin only.
   *
   * Modelled on `organizationsService.setAcceptanceVideoEnabled`, the shipped
   * precedent for an org-level boolean policy: ONE `withOrgContext`
   * transaction, the membership gate read inside it, then the repository write
   * with `tx` threaded through. `organization_mutate_active` gates the UPDATE on
   * `id = current_setting('app.organization_id')`, which is what that context
   * binds.
   */
  async setOrganizationPolicy(input: {
    organizationId: string;
    actorUserId: string;
    requiresTwoFactor: boolean;
  }): Promise<OrganizationTwoFactorPolicyDTO> {
    const org = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        const membership = await organizationMembershipRepository.findByOrgAndUserInTx(
          input.organizationId,
          input.actorUserId,
          tx,
        );
        // Not a member ⇒ 404, not 403: the org must stay indistinguishable from
        // one that does not exist (`lib/organizations/errors.ts`).
        if (!membership) throw new OrganizationNotFoundError(input.organizationId);
        if (!isOrgAdminRole(membership.role)) {
          throw new OrgForbiddenError(input.actorUserId, input.organizationId);
        }
        return organizationRepository.update(
          input.organizationId,
          { requiresTwoFactor: input.requiresTwoFactor },
          tx,
        );
      },
    );
    return toOrganizationTwoFactorPolicyDTO(org);
  },

  /**
   * The workspace's own setting AND its organization's, because MOTIR-3642's
   * locked control has to render both — and a control that knew only its own
   * value could not tell "off" from "off but overridden from above".
   *
   * ONE `withWorkspaceContext` transaction. The org row is readable inside it
   * through `organization_membership_visible`, whose arm reads `app.user_id`
   * (bound here) — and the access gate above has already established that the
   * actor is a member of that org, so the arm admits the row.
   */
  async getWorkspacePolicy(
    workspaceId: string,
    actorUserId: string,
  ): Promise<WorkspaceTwoFactorPolicyDTO> {
    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      const access = await organizationsService.resolveWorkspaceAccess(
        actorUserId,
        workspaceId,
        tx,
      );
      if (!access) throw new NotAMemberError(actorUserId, workspaceId);

      const workspace = await workspaceRepository.findByIdInTx(workspaceId, tx);
      /* v8 ignore next 2 -- UNREACHABLE, and the invariant that forbids it is
         asserted rather than asserted-about: `resolveWorkspaceAccess` above
         admits only through a `workspace_membership` row, and a membership
         cannot outlive its workspace because the FK cascades. The test is
         `tests/integration/twoFactorEnforcementStoryGate.test.ts` →
         "⚠️ a workspace_membership cannot outlive its workspace — the FK
         cascades", which deletes a workspace and watches the membership go with
         it. An ignore with no test to cite hides the gap instead of closing it. */
      if (!workspace) throw new NotAMemberError(actorUserId, workspaceId);

      const org = await organizationRepository.findByIdInTx(workspace.organizationId, tx);
      // The access gate resolved through this org's membership row, so the org
      // exists and is visible; a null here is a row that vanished mid-transaction.
      if (!org) throw new OrganizationNotFoundError(workspace.organizationId);

      return toWorkspaceTwoFactorPolicyDTO(workspace, org);
    });
  },

  /**
   * Set the workspace's require-2FA policy. Workspace manager (`owner` /
   * `admin`) only — `isWorkspaceManager` from `lib/projects/roles.ts`.
   *
   * ⚠️ NOT `lib/workspaces/roles.ts`'s `WORKSPACE_ROLE`, which carries only
   * `owner` and `member` and predates the four-value `MemberRole` enum; gating
   * on it would refuse a workspace `admin`.
   *
   * An org owner/admin passes WITHOUT a workspace membership row, as they do
   * everywhere else beneath the org tier: `resolveWorkspaceAccess` composes the
   * org role into `effectiveRole`, reporting `owner` for them.
   *
   * The write is admitted by `workspace_mutate_active`
   * (`id = current_setting('app.workspace_id')`), which needs no user arm — so
   * the AUTHORIZATION is entirely the gate below, and RLS only scopes the write
   * to this one row.
   */
  async setWorkspacePolicy(input: {
    workspaceId: string;
    actorUserId: string;
    requiresTwoFactor: boolean;
  }): Promise<WorkspaceTwoFactorPolicyDTO> {
    return withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      async (tx) => {
        const access = await organizationsService.resolveWorkspaceAccess(
          input.actorUserId,
          input.workspaceId,
          tx,
        );
        if (!access) throw new NotAMemberError(input.actorUserId, input.workspaceId);
        if (!isWorkspaceManager(access.effectiveRole)) {
          throw new WorkspaceForbiddenError(input.actorUserId, input.workspaceId);
        }

        const workspace = await workspaceRepository.update(
          input.workspaceId,
          { requiresTwoFactor: input.requiresTwoFactor },
          tx,
        );
        const org = await organizationRepository.findByIdInTx(access.organizationId, tx);
        if (!org) throw new OrganizationNotFoundError(access.organizationId);

        return toWorkspaceTwoFactorPolicyDTO(workspace, org);
      },
    );
  },

  /**
   * ⚠️ THE METHOD THE WHOLE STORY TURNS ON, AND IT IS ON THE HOT PATH.
   *
   * It runs in the `(authed)` layout on EVERY signed-in page load (MOTIR-3648)
   * and again on EVERY cookie-authenticated API call (MOTIR-3653), so it is one
   * transaction and, inside it, ONE query
   * (`twoFactorPolicyRepository.findRequirement` — which carries the RLS
   * reasoning and the policy arms it depends on).
   *
   * The rule it implements:
   *
   *   required   = org.requiresTwoFactor
   *             OR ANY(w.requiresTwoFactor) over the user's workspaces
   *   mandatedBy = the ORGANIZATION when one requires it, else the first
   *                mandating WORKSPACE, else null
   *   compliant  = hasSecondFactor({ enabled, passkeyCount })
   *
   * ⚠️ WHY THE READ IS OVER EVERY ORG THE USER BELONGS TO, not one active org.
   * The card states the rule as *"org requires OR any workspace the user
   * belongs to IN THAT ORG requires"*. Unioned over the user's orgs that is the
   * same set as *"any of their orgs OR any of their workspaces"*, because the
   * §5i upward invariant makes membership of a workspace imply membership of
   * its org — you cannot be in a workspace without being in the organization
   * that owns it. Reading it that way also means the gate needs no active-org
   * cookie, which matters: it runs in a layout that has not resolved one yet.
   *
   * ⚠️ AND IT MUST BE BOUND TO THE USER. Every arm that admits these tables
   * reads `app.user_id`, so a transaction that does not bind it returns the
   * plausible SHORT answer — no error, `required: false`, and someone who
   * should have been held at the door walking through. The repository comment
   * names the arm per table and records the one prediction of the card that
   * measurement corrected.
   */
  async resolveRequirement(userId: string): Promise<TwoFactorRequirementDTO> {
    const row = await withUserContext(userId, (tx) =>
      twoFactorPolicyRepository.findRequirement(userId, tx),
    );
    if (!row) throw new UserNotFoundError(userId);
    return toTwoFactorRequirementDTO(row);
  },
};
