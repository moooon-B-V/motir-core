import { withOrgContext } from '@/lib/organizations/context';
import { orgCan } from '@/lib/organizations/capabilities';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';
import { isWorkspaceManager } from '@/lib/projects/roles';
import {
  type TransactionBudget,
  withUserContext,
  withWorkspaceContext,
} from '@/lib/workspaces/context';
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

/**
 * The budget the 2FA GATE's one read runs under (MOTIR-5866) — raised from
 * Prisma's 5000 ms default because of what the transaction WAITS for, never
 * because of what it does.
 *
 * It does almost nothing: `withUserContext` binds one GUC and
 * `twoFactorPolicyRepository.findRequirement` issues ONE indexed read. It holds
 * no row lock and makes no network call. Production still expired it once
 * (2026-09-20, `GET /api/notifications/unread-count`): *5000 ms, however
 * 17684 ms passed*, with the read not yet issued — a stall in the database or
 * the process, which no transaction this small can cause or avoid.
 *
 * ⚠️ THE DEFAULT NEVER SHORTENED THAT WAIT. Prisma does not cancel the statement
 * in flight when the timer fires: it queues the rollback behind it. So the
 * request waited the full 17.7 s and THEN answered 500 — the expiry only threw
 * away the answer the wait had already paid for. The 5 s default exists to bound
 * how long a transaction holds LOCKS, and this one holds none. On a gate that
 * every signed-in page load and every cookie-authenticated API call passes
 * through (MOTIR-3648 / MOTIR-3653), the wrong answer after a stall is a 500 on
 * whichever request was unlucky.
 *
 * 30 s is more than half again the observed wait and the same ceiling the other
 * wait-shaped budget uses (`CI_FEEDBACK_TX_TIMEOUT_MS`, MOTIR-5865). It widens
 * nothing but the ceiling: a read that is not waiting finishes exactly as fast as
 * before. `maxWaitMs` stays Prisma's default — this is about a transaction that
 * STARTED and then waited, not about waiting for a connection to start one.
 */
const TWO_FACTOR_GATE_TX: TransactionBudget = { timeoutMs: 30_000, maxWaitMs: 2_000 };

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
   * Modelled on `organizationsService.renameOrganization`, the shipped shape for
   * an org-admin write. (It named `setAcceptanceVideoEnabled` until MOTIR-5172
   * removed that method with the switch's move to the project tier; the shape it
   * described is the rename's, unchanged): ONE `withOrgContext`
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
        if (!orgCan(membership.role, 'manageOrgSettings')) {
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
         admits only through a `workspace` row it has just read (a membership, or
         the org Owner's reach over that same row), and a membership cannot
         outlive its workspace because the FK cascades. The test is
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
   * The org OWNER passes WITHOUT a workspace membership row, as they do
   * everywhere else beneath the org tier: `resolveWorkspaceAccess` composes the
   * org role into `effectiveRole`, reporting `owner` for them. An org Admin
   * passes through their workspace membership's role (MOTIR-6308).
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
    const row = await withUserContext(
      userId,
      (tx) => twoFactorPolicyRepository.findRequirement(userId, tx),
      TWO_FACTOR_GATE_TX,
    );
    if (!row) throw new UserNotFoundError(userId);
    return toTwoFactorRequirementDTO(row);
  },
};
