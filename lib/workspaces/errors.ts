// Typed errors for the workspaces domain. Kept in their own file so
// callers — route handlers, server actions, server components — can
// import them without pulling in the Prisma client.
//
// Per CLAUDE.md, services throw typed errors with stable string `code`s;
// route handlers translate those codes to HTTP status codes.

export class SlugCollisionError extends Error {
  readonly code = 'SLUG_COLLISION' as const;
  constructor(slug: string) {
    super(`Could not generate a unique workspace slug after retries (last attempt: ${slug}).`);
    this.name = 'SlugCollisionError';
  }
}

export class AlreadyMemberError extends Error {
  readonly code = 'ALREADY_MEMBER' as const;
  constructor(userId: string, workspaceId: string) {
    super(`User ${userId} is already a member of workspace ${workspaceId}.`);
    this.name = 'AlreadyMemberError';
  }
}

export class NotAMemberError extends Error {
  readonly code = 'NOT_A_MEMBER' as const;
  constructor(userId: string, workspaceId: string) {
    super(`User ${userId} is not a member of workspace ${workspaceId}.`);
    this.name = 'NotAMemberError';
  }
}

/**
 * Thrown when a workspace-administrative action requires the MANAGER tier
 * (`owner` / `admin` — `isWorkspaceManager`) and the actor is a plain `member`
 * or a `viewer` (Story MOTIR-1215 · Subtask MOTIR-3645).
 *
 * The org-tier analogue is `OrgForbiddenError`, and the same 404-not-403 split
 * applies: a workspace the actor cannot SEE raises `NotAMemberError` (→ 404) so
 * a cross-tenant workspace stays indistinguishable from a missing one, while a
 * workspace they can see but may not administer raises THIS (→ 403).
 */
export class WorkspaceForbiddenError extends Error {
  readonly code = 'WORKSPACE_FORBIDDEN' as const;
  constructor(userId: string, workspaceId: string) {
    super(`User ${userId} lacks workspace-manager rights on workspace ${workspaceId}.`);
    this.name = 'WorkspaceForbiddenError';
  }
}

export class InviteTargetAlreadyMemberError extends Error {
  readonly code = 'ALREADY_MEMBER' as const;
  constructor(email: string, workspaceId: string) {
    super(`${email} is already a member of workspace ${workspaceId}.`);
    this.name = 'InviteTargetAlreadyMemberError';
  }
}

export class InviteRateLimitedError extends Error {
  readonly code = 'RATE_LIMITED' as const;
  constructor(public readonly max: number) {
    super(`Already sent ${max} invites recently; please wait before sending another.`);
    this.name = 'InviteRateLimitedError';
  }
}

export class InviteExpiredOrMissingError extends Error {
  readonly code = 'INVITE_EXPIRED_OR_MISSING' as const;
  constructor() {
    super('Invite is expired or no longer valid.');
    this.name = 'InviteExpiredOrMissingError';
  }
}

export class InviteEmailMismatchError extends Error {
  readonly code = 'INVITE_EMAIL_MISMATCH' as const;
  constructor(public readonly inviteEmail: string) {
    super(`This invite is for ${inviteEmail}. Sign in with that address, or ask for a new invite.`);
    this.name = 'InviteEmailMismatchError';
  }
}

export class LastMemberError extends Error {
  readonly code = 'LAST_MEMBER' as const;
  constructor(workspaceId: string) {
    super(
      `Cannot leave workspace ${workspaceId}: you are the last member. ` +
        `Delete the workspace instead.`,
    );
    this.name = 'LastMemberError';
  }
}

export class InvalidEmailError extends Error {
  readonly code = 'INVALID_EMAIL' as const;
  constructor() {
    super('Email format is invalid.');
    this.name = 'InvalidEmailError';
  }
}

/**
 * The workspace named does not exist, or does not belong to the organization
 * the request addressed it through (MOTIR-6309 — the org-tier remove route).
 * Both read as 404: a workspace in another org must be indistinguishable from
 * one that does not exist.
 */
export class WorkspaceNotFoundError extends Error {
  readonly code = 'WORKSPACE_NOT_FOUND' as const;
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} was not found.`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Account erasure may delete a workspace only when the leaving user is its SOLE
 * member (`design/settings/design-notes.md` → Data & privacy → DECISION 3;
 * MOTIR-6309). Raised,
 * under the membership lock, when a second member is present — a workspace
 * somebody else now shares is not the account's to delete.
 */
export class WorkspaceNotSoleMemberError extends Error {
  readonly code = 'WORKSPACE_NOT_SOLE_MEMBER' as const;
  constructor(userId: string, workspaceId: string) {
    super(`User ${userId} is not the sole member of workspace ${workspaceId}.`);
    this.name = 'WorkspaceNotSoleMemberError';
  }
}
