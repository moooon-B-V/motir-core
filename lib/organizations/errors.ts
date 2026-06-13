// Typed errors for the organizations domain (Story 6.10). Kept in their own
// file so callers — route handlers (6.10.5), server actions, server components,
// tests — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, services throw typed errors with stable string `code`s; the
// route layer translates those codes to HTTP status codes. The org-tier
// cross-tenant posture mirrors the workspace/project one: a non-member of the
// org must NOT be able to distinguish "org exists, you're forbidden" from "org
// doesn't exist" — so the gate raises OrganizationNotFoundError (→ 404), never a
// 403, for an org the actor cannot see (the 404-not-403 rule).

export class OrganizationNotFoundError extends Error {
  readonly code = 'ORGANIZATION_NOT_FOUND' as const;
  constructor(organizationId: string) {
    super(`Organization ${organizationId} not found.`);
    this.name = 'OrganizationNotFoundError';
  }
}

export class OrgSlugCollisionError extends Error {
  readonly code = 'ORG_SLUG_COLLISION' as const;
  constructor(slug: string) {
    super(`Could not generate a unique organization slug after retries (last attempt: ${slug}).`);
    this.name = 'OrgSlugCollisionError';
  }
}

export class AlreadyOrgMemberError extends Error {
  readonly code = 'ALREADY_ORG_MEMBER' as const;
  constructor(userId: string, organizationId: string) {
    super(`User ${userId} is already a member of organization ${organizationId}.`);
    this.name = 'AlreadyOrgMemberError';
  }
}

export class NotAnOrgMemberError extends Error {
  readonly code = 'NOT_AN_ORG_MEMBER' as const;
  constructor(userId: string, organizationId: string) {
    super(`User ${userId} is not a member of organization ${organizationId}.`);
    this.name = 'NotAnOrgMemberError';
  }
}

/**
 * Thrown when an org-administrative action requires owner/admin and the actor
 * is a plain org member. A surface a non-admin can SEE (it appears in their org)
 * but cannot operate raises this (→ 403) — distinct from the not-found gate,
 * which hides orgs the actor is not in at all (→ 404).
 */
export class OrgForbiddenError extends Error {
  readonly code = 'ORG_FORBIDDEN' as const;
  constructor(userId: string, organizationId: string) {
    super(`User ${userId} lacks org-admin rights on organization ${organizationId}.`);
    this.name = 'OrgForbiddenError';
  }
}

/**
 * Thrown when removing/demoting the membership would leave the organization
 * with zero owners. An org with no owner is unadministrable, so the last owner
 * must transfer ownership (promote another member to owner) before leaving or
 * being demoted — the org-tier analogue of the workspace LastMemberError.
 */
export class LastOrgOwnerError extends Error {
  readonly code = 'LAST_ORG_OWNER' as const;
  constructor(organizationId: string) {
    super(
      `Cannot remove or demote the last owner of organization ${organizationId}: ` +
        `promote another member to owner first.`,
    );
    this.name = 'LastOrgOwnerError';
  }
}
