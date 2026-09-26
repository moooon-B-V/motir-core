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

/**
 * Authoring a workspace custom role — create, edit, delete — is the workspace
 * MANAGER's, or the org Owner's (Story MOTIR-6168 · MOTIR-6460). A ROLE check,
 * not a permission key: workspace administration belongs to the built-in
 * Manager, and a custom role carries project-scope keys only, so no custom role
 * can author roles. → 403.
 */
export class WorkspaceRoleForbiddenError extends Error {
  readonly code = 'WORKSPACE_ROLE_FORBIDDEN' as const;
  constructor(userId: string, workspaceId: string) {
    super(
      `User ${userId} is not a Manager of workspace ${workspaceId}, so cannot change its roles.`,
    );
    this.name = 'WorkspaceRoleForbiddenError';
  }
}

/** A second workspace custom role with a name the workspace already uses. → 409. */
export class WorkspaceRoleNameTakenError extends Error {
  readonly code = 'WORKSPACE_ROLE_NAME_TAKEN' as const;
  constructor(readonly roleName: string) {
    super(`This workspace already has a role called "${roleName}".`);
    this.name = 'WorkspaceRoleNameTakenError';
  }
}

/**
 * Deleting a workspace custom role somebody holds, with no role to move them
 * to. Carries the COUNT the confirmation dialog names, and nothing is written.
 * → 409.
 */
export class WorkspaceRoleInUseError extends Error {
  readonly code = 'WORKSPACE_ROLE_IN_USE' as const;
  constructor(
    readonly roleName: string,
    readonly count: number,
  ) {
    super(`"${roleName}" is held by ${count} member(s); choose a role to move them to.`);
    this.name = 'WorkspaceRoleInUseError';
  }
}

/**
 * A role change that would leave the workspace with no Manager (Story MOTIR-6168 ·
 * MOTIR-6463). → 409. Nothing is written.
 */
export class LastManagerError extends Error {
  readonly code = 'LAST_MANAGER' as const;
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} needs at least one Manager.`);
    this.name = 'LastManagerError';
  }
}

/** The person whose role is being changed is not a member of this workspace. → 404. */
export class WorkspaceMemberNotFoundError extends Error {
  readonly code = 'WORKSPACE_MEMBER_NOT_FOUND' as const;
  constructor(userId: string, workspaceId: string) {
    super(`User ${userId} is not a member of workspace ${workspaceId}.`);
    this.name = 'WorkspaceMemberNotFoundError';
  }
}

/** A role value that is not Manager, Member or Viewer. → 422. */
export class InvalidWorkspaceRoleError extends Error {
  readonly code = 'INVALID_WORKSPACE_ROLE' as const;
  constructor(value: string) {
    super(`"${value}" is not a workspace role (manager, member or viewer).`);
    this.name = 'InvalidWorkspaceRoleError';
  }
}

/**
 * The person is the organization's Owner or an Admin, so they are a Manager of
 * every workspace of the org and their role here is not the workspace's to change
 * (MOTIR-6456 panel 6a; `role-model.md` AMENDMENT 1). → 409.
 */
export class OrgManagedWorkspaceRoleError extends Error {
  readonly code = 'ORG_MANAGED_WORKSPACE_ROLE' as const;
  constructor(userId: string, workspaceId: string) {
    super(
      `User ${userId} is an organization Owner or Admin, so is a Manager of workspace ` +
        `${workspaceId}; change their organization role instead.`,
    );
    this.name = 'OrgManagedWorkspaceRoleError';
  }
}
