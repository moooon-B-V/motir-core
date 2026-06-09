// Typed errors for the projects domain. Kept in their own file so callers
// — route handlers, server actions, server components — can import them
// without pulling in the Prisma client.
//
// Per CLAUDE.md, services throw typed errors with stable string `code`s;
// route handlers translate those codes to HTTP status codes. The
// membership gate reuses NotAMemberError from lib/workspaces/errors.ts
// rather than duplicating it here.

export class IdentifierCollisionError extends Error {
  readonly code = 'IDENTIFIER_COLLISION' as const;
  constructor(identifier: string) {
    super(
      `Could not generate a unique project identifier after retries (last attempt: ${identifier}).`,
    );
    this.name = 'IdentifierCollisionError';
  }
}

export class ProjectNotFoundError extends Error {
  readonly code = 'PROJECT_NOT_FOUND' as const;
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectWorkspaceMismatchError extends Error {
  readonly code = 'PROJECT_WORKSPACE_MISMATCH' as const;
  constructor(projectId: string, workspaceId: string) {
    super(`Project ${projectId} does not belong to workspace ${workspaceId}.`);
    this.name = 'ProjectWorkspaceMismatchError';
  }
}

// ── Project membership + access errors (Story 6.4 · Subtask 6.4.4) ──────────
// The management surface (add/remove member, set role, set access level) is
// gated to project admins (or the workspace owner/admin, who always pass). The
// route maps these to: NotProjectAdminError → 403, TargetNotWorkspaceMemberError
// / InvalidProjectRoleError / InvalidAccessLevelError → 400, ProjectNotFoundError
// / NotAProjectMemberError → 404, AlreadyProjectMemberError / LastProjectAdminError
// → 409.

// The browse/edit access gate (Story 6.4 · Subtask 6.4.3). One typed error
// covers both denials; `kind` decides the HTTP mapping the route applies:
//   * `kind: 'browse'` → 404. A project the actor can't browse is HIDDEN — it
//     must be indistinguishable from a non-existent one (no existence leak,
//     same shape as ProjectNotFoundError / finding #26 / Jira private projects).
//   * `kind: 'edit'`   → 403. The actor CAN see the project (browse passed) but
//     is read-only on it (a viewer, or a plain member on a limited project), so
//     the project's existence is already known — a 403 "forbidden" is correct.
// Either way the stable `code` lets the UI (6.4.6) render the no-access / no-edit
// state instead of a crash.
export class ProjectAccessDeniedError extends Error {
  readonly code = 'PROJECT_ACCESS_DENIED' as const;
  constructor(
    projectId: string,
    readonly kind: 'browse' | 'edit',
  ) {
    super(
      kind === 'browse'
        ? `You do not have access to project ${projectId}.`
        : `You have read-only access to project ${projectId} and cannot make this change.`,
    );
    this.name = 'ProjectAccessDeniedError';
  }
}

export class NotProjectAdminError extends Error {
  readonly code = 'NOT_PROJECT_ADMIN' as const;
  constructor(projectId: string) {
    super(`You must be a project admin (or workspace owner/admin) to manage project ${projectId}.`);
    this.name = 'NotProjectAdminError';
  }
}

export class TargetNotWorkspaceMemberError extends Error {
  readonly code = 'TARGET_NOT_WORKSPACE_MEMBER' as const;
  constructor(userId: string, workspaceId: string) {
    super(
      `User ${userId} is not a member of workspace ${workspaceId}, so they cannot be added to a project in it.`,
    );
    this.name = 'TargetNotWorkspaceMemberError';
  }
}

export class AlreadyProjectMemberError extends Error {
  readonly code = 'ALREADY_PROJECT_MEMBER' as const;
  constructor(userId: string, projectId: string) {
    super(`User ${userId} is already a member of project ${projectId}.`);
    this.name = 'AlreadyProjectMemberError';
  }
}

export class NotAProjectMemberError extends Error {
  readonly code = 'NOT_A_PROJECT_MEMBER' as const;
  constructor(userId: string, projectId: string) {
    super(`User ${userId} is not a member of project ${projectId}.`);
    this.name = 'NotAProjectMemberError';
  }
}

export class LastProjectAdminError extends Error {
  readonly code = 'LAST_PROJECT_ADMIN' as const;
  constructor(projectId: string) {
    super(
      `Cannot remove or demote the last admin of project ${projectId}: ` +
        `promote another member to admin first.`,
    );
    this.name = 'LastProjectAdminError';
  }
}

export class InvalidProjectRoleError extends Error {
  readonly code = 'INVALID_PROJECT_ROLE' as const;
  constructor(role: string) {
    super(`"${role}" is not an assignable project role (use admin, member, or viewer).`);
    this.name = 'InvalidProjectRoleError';
  }
}

export class InvalidAccessLevelError extends Error {
  readonly code = 'INVALID_ACCESS_LEVEL' as const;
  constructor(level: string) {
    super(`"${level}" is not a valid project access level (use open, limited, or private).`);
    this.name = 'InvalidAccessLevelError';
  }
}
