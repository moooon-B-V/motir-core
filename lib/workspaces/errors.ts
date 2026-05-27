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

export class InvalidEmailError extends Error {
  readonly code = 'INVALID_EMAIL' as const;
  constructor() {
    super('Email format is invalid.');
    this.name = 'InvalidEmailError';
  }
}
