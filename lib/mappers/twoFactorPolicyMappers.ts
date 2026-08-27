import type { Organization, Workspace } from '@/generated/prisma/client';
import type {
  OrganizationTwoFactorPolicyDTO,
  TwoFactorMandateDTO,
  TwoFactorRequirementDTO,
  WorkspaceTwoFactorPolicyDTO,
} from '@/lib/dto/twoFactorPolicy';
import type { TwoFactorRequirementRow } from '@/lib/repositories/twoFactorPolicyRepository';
import { hasSecondFactor } from '@/lib/twoFactor/hasSecondFactor';

// Rows → the require-2FA policy DTOs (Story MOTIR-1215 · Subtask MOTIR-3645).
//
// The derivations live here rather than in the service so `lockedByOrganization`
// and the org-wins precedence have ONE definition each, testable without a
// database.

/** An organization row → its policy DTO. */
export function toOrganizationTwoFactorPolicyDTO(
  org: Pick<Organization, 'id' | 'requiresTwoFactor'>,
): OrganizationTwoFactorPolicyDTO {
  return { organizationId: org.id, requiresTwoFactor: org.requiresTwoFactor };
}

/**
 * A workspace row plus its org's setting → the workspace policy DTO.
 *
 * `lockedByOrganization` is the org's value verbatim, and deliberately not
 * `orgRequires && !workspaceRequires`: the control is locked whenever the org
 * mandates it, INCLUDING when the workspace had already set its own. That is
 * MOTIR-3642's panel 4 — "on here AND above" — and collapsing it into panel 3
 * would lose the fact that turning the org policy off leaves the workspace's
 * own requirement standing.
 */
export function toWorkspaceTwoFactorPolicyDTO(
  workspace: Pick<Workspace, 'id' | 'requiresTwoFactor'>,
  organizationRequiresTwoFactor: boolean,
): WorkspaceTwoFactorPolicyDTO {
  return {
    workspaceId: workspace.id,
    requiresTwoFactor: workspace.requiresTwoFactor,
    organizationRequiresTwoFactor,
    lockedByOrganization: organizationRequiresTwoFactor,
  };
}

/**
 * The requirement row → the verdict the enforcement gate reads.
 *
 * ⚠️ THE ORGANIZATION IS REPORTED WHENEVER IT MANDATES, even if a workspace
 * does too. It is the floor; naming the workspace would tell the reader that
 * switching the workspace policy off would let them in, and it would not.
 *
 * A `null` row means the user does not exist. The caller decides what that is;
 * this mapper is never handed one.
 */
export function toTwoFactorRequirementDTO(row: TwoFactorRequirementRow): TwoFactorRequirementDTO {
  const mandatedBy = resolveMandate(row);
  return {
    required: mandatedBy !== null,
    mandatedBy,
    compliant: hasSecondFactor({ enabled: row.enabled, passkeyCount: row.passkeyCount }),
  };
}

/**
 * The precedence rule, as its own function so the four-combination test reads
 * as an assertion about the RULE rather than about a query.
 *
 * A row carries an org id only when that org requires it and a workspace id
 * only when that workspace requires it — the SQL filters on the column — so the
 * presence of an id IS the tier's vote.
 */
function resolveMandate(row: TwoFactorRequirementRow): TwoFactorMandateDTO | null {
  if (row.orgId !== null && row.orgName !== null) {
    return { tier: 'organization', id: row.orgId, name: row.orgName };
  }
  if (row.workspaceId !== null && row.workspaceName !== null) {
    return { tier: 'workspace', id: row.workspaceId, name: row.workspaceName };
  }
  return null;
}
