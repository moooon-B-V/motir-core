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
 * Thrown by the org-admin "invite to organization" flow (6.10.5) when the email
 * entered has no Motir account yet. Org membership is the root tenancy tier, so
 * an org member must be an existing user; brand-new people join Motir by
 * accepting a WORKSPACE invite (which auto-enrols them in that workspace's org
 * via the upward invariant — 6.10.2 §5i). The UI surfaces this as "no Motir
 * account with that email — invite them to a workspace first."
 */
export class OrgInviteeNotFoundError extends Error {
  readonly code = 'ORG_INVITEE_NOT_FOUND' as const;
  constructor(email: string) {
    super(`No Motir account exists for ${email}.`);
    this.name = 'OrgInviteeNotFoundError';
  }
}

/**
 * Thrown when a member path asks to MAKE someone an owner — `addMember`,
 * `addMemberByEmail`, `changeMemberRole` with `role: 'owner'` — or when a role
 * write would put a second `owner` row in an organization (the one-owner partial
 * unique index refusing it). An organization has exactly one Owner
 * (`docs/decisions/role-model.md` §1), and the only door to ownership is the
 * Owner's own transfer. → 409.
 */
export class OwnerOnlyByTransferError extends Error {
  readonly code = 'ORG_OWNER_ONLY_BY_TRANSFER' as const;
  constructor(organizationId: string) {
    super(
      `An organization has exactly one owner. Ownership of ${organizationId} moves only ` +
        `by the owner transferring it.`,
    );
    this.name = 'OwnerOnlyByTransferError';
  }
}

/**
 * Thrown when a member path would change or remove the OWNER's own membership —
 * a demotion, a removal, or the Owner leaving — whoever is acting, the Owner
 * included. The Owner's row changes only by transfer, which is what keeps the
 * organization at exactly one Owner and never zero. → 409.
 */
export class OwnerMembershipLockedError extends Error {
  readonly code = 'ORG_OWNER_MEMBERSHIP_LOCKED' as const;
  constructor(organizationId: string) {
    super(
      `The owner's membership of ${organizationId} cannot be changed or removed; ` +
        `the owner must transfer ownership first.`,
    );
    this.name = 'OwnerMembershipLockedError';
  }
}
