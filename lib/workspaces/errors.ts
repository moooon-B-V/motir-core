// Typed errors for the workspaces repository. Kept in their own file (like
// lib/users/errors.ts) so callers — route handlers, server actions, server
// components — can import them without pulling in the Prisma client.

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
