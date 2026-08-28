import { accountRepository } from '@/lib/repositories/accountRepository';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { dataExportRequestRepository } from '@/lib/repositories/dataExportRequestRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { passkeyRepository } from '@/lib/repositories/passkeyRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { twoFactorRepository } from '@/lib/repositories/twoFactorRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withOrgContext } from '@/lib/organizations/context';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import {
  ACCOUNT_ERASURE_KEPT_EXCEPTIONS,
  type AccountErasurePreviewDTO,
  type ErasureBlockingOrganizationDTO,
  type ErasureWorkspaceDTO,
} from '@/lib/dto/accountErasure';
import {
  toBlockingOrganizationDTO,
  toErasureWorkspaceDTO,
} from '@/lib/mappers/accountErasureMappers';

// The account-erasure IMPACT PREVIEW (Story 8.4 · Subtask MOTIR-3699) — the
// FIRST of the two backend capabilities a destructive flow needs.
//
// `design/settings/design-notes.md` → `Data & privacy`: *"a destructive flow
// always has two distinct backend capabilities — the preview/impact read and the
// do-the-action write… the numbers are not decoration and the preview is not
// free."* This file is the read. The write (schedule / cancel) is MOTIR-3700 and
// shares nothing with it on purpose: the preview can be exercised freely, by the
// pane at rest and by tests, and the write stays a small locked transaction.
//
// ⚠️ IT WRITES NOTHING AND LOCKS NOTHING. Nothing has been decided when this
// runs. In particular the BLOCK is computed from `assertNotLastOwner`'s
// CONDITION rather than by calling the delete path and catching
// `LastOrgOwnerError` — which is the whole point of the card: a reader who is
// the sole owner of a shared organization must meet that refusal on the pane at
// rest, not after typing their email address into a type-to-confirm field for an
// action that was always going to be refused.
//
// ⚠️ AND IT TAKES NO ROW LOCK, which is the SECOND half of the same decision.
// The shipped guard reads `countOwnersByOrgForUpdate`, because a guard that
// counts and then WRITES has to serialize its racers. A preview derives no
// write, so it uses the non-locking twin — locking every owner row of every
// organization a reader owns, for a screen that only paints numbers, would be a
// write-shaped cost for a read.
//
// ── WHY THE TRANSACTIONS ARE PLURAL ─────────────────────────────────────────
// One per tenant, and that is STRUCTURAL rather than a shape to optimise away.
// The GUCs the RLS policies read are transaction-local, and the tables this
// preview counts are gated on DIFFERENT ones:
//
//   `workspace` / `workspace_membership` / `organization` /
//   `organization_membership` / `data_export_request`
//                              → an `app.user_id` arm, so ONE `withUserContext`
//                                answers "which tenants is this reader in?" and
//                                "how many archives do they hold?"
//   `project` / `work_item` / `comment`
//                              → `app.workspace_id` ONLY, so each workspace's
//                                counts need that workspace bound
//   the other owners of an org → `app.organization_id`, so each owned
//                                organization needs that org bound
//
// `docs/decisions/bound-read-transaction-shape.md`'s ONE-transaction-per-service
// -method convention explicitly carves out "a fan-out whose members need
// DIFFERENT bindings", and this is that case: no single transaction can express
// N workspaces at once, and widening a policy so that it could would hand every
// reader cross-tenant sight to save a screen some round trips.
//
// ── THE SCOPE RULE IS LOAD-BEARING ──────────────────────────────────────────
// The preview reports what erasure reaches AS FAR AS THE READER'S OWN ACCESS
// REACHES. A preview is not a privilege escalation: a member of a shared
// workspace does not learn counts they could not already read, and a workspace
// the reader has been removed from contributes NOTHING — its rows survive their
// erasure as somebody else's data, and naming them here would leak a count out
// of a tenant they were shown the door of. Enforced twice over: the candidate
// set is the reader's OWN memberships, and every count then runs under RLS
// bound to that workspace.

/**
 * The per-workspace numbers, read inside that workspace's own bound
 * transaction. `memberCount` is what partitions the ledger: a workspace where
 * the reader is the only member goes with the account (the `deleted` group), and
 * one they share contributes their attributions to the `anonymised` group.
 */
interface WorkspaceImpact {
  workspace: ErasureWorkspaceDTO;
  memberCount: number;
  projects: number;
  workItems: number;
  /** The reader's own comments in this workspace. */
  authoredComments: number;
  /** Work items here the reader reported or was assigned — one row, once. */
  attributedWorkItems: number;
}

export const accountErasureService = {
  /**
   * What deleting this account would reach — the ledger the confirmation modal
   * renders, and the verdict the `Data › Data & privacy` pane renders at rest.
   *
   * Read-only, and total: a reader with no workspaces, no organizations they own
   * and nothing written gets every count at zero and an empty
   * `soleMemberWorkspaces`. That is an ANSWER, not an error — the pane still has
   * a ledger to render, and "you have nothing to lose" is a thing a confirmation
   * is allowed to say.
   */
  async previewAccountErasure(userId: string): Promise<AccountErasurePreviewDTO> {
    // ── The identity rows ────────────────────────────────────────────────────
    // `account`, `passkey` and `two_factor` are Better-Auth-owned tables with
    // RLS DISABLED, so they are read on the singleton with nothing bound. That
    // is not an oversight to bind later: there is no policy for a context to
    // satisfy, and every one of these reads is already keyed to `userId`.
    const [credentials, passkeys, twoFactor] = await Promise.all([
      accountRepository.countByUserId(userId),
      passkeyRepository.countByUserId(userId),
      twoFactorRepository.findByUserId(userId),
    ]);

    // ── The tenants the reader is in, their API tokens, their exports ────────
    // One bound transaction: every table here carries an `app.user_id` arm.
    //
    // ⚠️ `data_export_request` BELONGS IN THIS TRANSACTION AND NOWHERE ELSE.
    // Its policy (`data_export_request_owner_or_system`) reads `app.user_id`,
    // that GUC is transaction-local, and the repository's own header states the
    // consequence: a singleton read returns ZERO ROWS while raising nothing, so
    // a reader with a real archive would be told on a consent surface that they
    // have never asked for one.
    const { workspaces, ownedOrganizations, apiTokens, dataExports } = await withUserContext(
      userId,
      async (tx) => ({
        workspaces: await workspaceMembershipRepository.findWorkspacesByUser(userId, tx),
        ownedOrganizations: await organizationMembershipRepository.findOwnedOrganizationsByUser(
          userId,
          tx,
        ),
        apiTokens: await apiTokenRepository.countByUser(userId, tx),
        // EVERY status, matching `deleteAllForUser`'s own predicate — the
        // number the ledger renders has to be the number the sweep deletes
        // (Bug MOTIR-3747).
        dataExports: await dataExportRequestRepository.countByUserId(userId, tx),
      }),
    );

    // ── The block, org by org ────────────────────────────────────────────────
    let blockingOrganization: ErasureBlockingOrganizationDTO | null = null;
    for (const organization of ownedOrganizations) {
      const { owners, members } = await withOrgContext(
        { userId, organizationId: organization.id },
        async (tx) => ({
          owners: await organizationMembershipRepository.countOwnersByOrg(organization.id, tx),
          members: await organizationMembershipRepository.countByOrg(organization.id, tx),
        }),
      );
      // `assertNotLastOwner`'s own condition (owner count ≤ 1, on an OWNER
      // target — which `ownedOrganizations` already selected for), AND the org
      // being SHARED. The second conjunct is what keeps a solo organization from
      // trapping its only user inside their own account: the guard would refuse
      // the membership removal there too, but nobody is left behind, so the
      // erasure takes the organization with it exactly as it takes a
      // sole-membership workspace. The design's blocked panel is explicit that
      // the case it draws is *"sole owner of a SHARED organization"*.
      if (owners <= 1 && members > 1) {
        blockingOrganization = toBlockingOrganizationDTO(organization, members);
        break;
      }
    }

    // ── The per-workspace impact ─────────────────────────────────────────────
    const impacts: WorkspaceImpact[] = [];
    for (const workspace of workspaces) {
      impacts.push(
        await withWorkspaceContext({ userId, workspaceId: workspace.id }, async (tx) => ({
          workspace: toErasureWorkspaceDTO(workspace),
          memberCount: await workspaceMembershipRepository.countByWorkspace(workspace.id, tx),
          projects: await projectRepository.countByWorkspace(workspace.id, tx),
          workItems: await workItemRepository.countByWorkspace(workspace.id, tx),
          authoredComments: await commentRepository.countByAuthorInWorkspace(
            userId,
            workspace.id,
            tx,
          ),
          attributedWorkItems: await workItemRepository.countByReporterOrAssigneeInWorkspace(
            userId,
            workspace.id,
            tx,
          ),
        })),
      );
    }

    // A workspace the reader is the ONLY member of is DELETED — `deleteWorkspace`
    // asserts membership and checks no role, so nothing stops it, and nobody
    // else can open it once they are gone. A workspace they SHARE survives, and
    // only their attributions inside it are anonymised. The two arms are
    // exhaustive and disjoint, which is what stops a row being both counted as
    // lost and counted as kept.
    const soleMember = impacts.filter((i) => i.memberCount <= 1);
    const shared = impacts.filter((i) => i.memberCount > 1);

    return {
      blocked: blockingOrganization !== null,
      blockingOrganization,
      deleted: {
        credentials,
        passkeys,
        twoFactorEnrolments: twoFactor === null ? 0 : 1,
        apiTokens,
        dataExports,
        soleMemberWorkspaces: soleMember.map((i) => i.workspace),
        projects: sum(soleMember.map((i) => i.projects)),
        workItems: sum(soleMember.map((i) => i.workItems)),
      },
      anonymised: {
        comments: sum(shared.map((i) => i.authoredComments)),
        workItems: sum(shared.map((i) => i.attributedWorkItems)),
      },
      // NOT counted from the database, deliberately. `content/legal/privacy.md`
      // §6 states these as exceptions in approved copy — invoices and tax records
      // for "generally seven years", and data still in an unrotated backup — and
      // the ledger's job is to NAME them. Article 17 erasure is not absolute, and
      // a confirmation that implies otherwise is a false statement on a consent
      // surface.
      kept: [...ACCOUNT_ERASURE_KEPT_EXCEPTIONS],
    };
  },
};

function sum(values: number[]): number {
  return values.reduce((total, n) => total + n, 0);
}
