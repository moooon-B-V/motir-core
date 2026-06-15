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

// ── Edit project details + change key errors (Story 6.8 · Subtask 6.8.1) ─────
// The PATCH /api/projects/[key] + DELETE .../aliases/[alias] write path throws
// these; `projectErrorResponse` maps them:
//   InvalidProjectNameError / InvalidIdentifierError / IdentifierUnchangedError
//       / InvalidAvatarError                                 → 400
//   IdentifierTakenError / IdentifierReservedError           → 409
//   AliasNotFoundError                                       → 404
// (admin-gating reuses NotProjectAdminError → 403 and ProjectNotFoundError → 404
// from above / projectAccessService — no existence leak on a non-browser.)

export class InvalidProjectNameError extends Error {
  readonly code = 'INVALID_PROJECT_NAME' as const;
  constructor() {
    super('A project name is required and cannot be blank.');
    this.name = 'InvalidProjectNameError';
  }
}

// The public Overview/README body exceeds the maximum allowed length (Story
// 6.12 · Subtask 6.12.8). Project admins author it, but the field is a stored
// public-projection payload, so a generous server cap keeps a single edit from
// bloating the row / public read. Maps to 400.
export class ProjectOverviewTooLongError extends Error {
  readonly code = 'PROJECT_OVERVIEW_TOO_LONG' as const;
  constructor(readonly max: number) {
    super(`The project overview must be at most ${max} characters.`);
    this.name = 'ProjectOverviewTooLongError';
  }
}

// The new key is not a legal project key. STRICT (reject, don't normalize): an
// explicit admin key change must not silently pad/truncate a malformed key the
// way the create-time `normalizeIdentifier` does — renaming every issue to a key
// the admin didn't type would be a surprising, hard-to-undo mutation. The shape
// is the shipped column contract: 3–5 chars, uppercase A–Z / 0–9 (Jira likewise
// rejects a malformed key rather than coercing it — decision-ladder rung 1).
export class InvalidIdentifierError extends Error {
  readonly code = 'INVALID_IDENTIFIER' as const;
  constructor(identifier: string) {
    super(`"${identifier}" is not a valid project key (use 3–5 uppercase letters or digits).`);
    this.name = 'InvalidIdentifierError';
  }
}

// The new key equals the current one — a typed no-op so the surface can tell
// "nothing to change" apart from a real collision (and never runs the rewrite).
export class IdentifierUnchangedError extends Error {
  readonly code = 'IDENTIFIER_UNCHANGED' as const;
  constructor(identifier: string) {
    super(`The project key is already "${identifier}".`);
    this.name = 'IdentifierUnchangedError';
  }
}

// The key is the LIVE identifier of another project in the workspace.
export class IdentifierTakenError extends Error {
  readonly code = 'IDENTIFIER_TAKEN' as const;
  constructor(identifier: string) {
    super(`Another project in this workspace already uses the key "${identifier}".`);
    this.name = 'IdentifierTakenError';
  }
}

// The key is RESERVED by another project's previous-key alias. Distinct from
// IdentifierTakenError so the UI can show distinct copy (the 6.8.3 design): a
// reserved key is freed only by deleting that project or releasing its alias.
export class IdentifierReservedError extends Error {
  readonly code = 'IDENTIFIER_RESERVED' as const;
  constructor(identifier: string) {
    super(`The key "${identifier}" is reserved by another project's previous key.`);
    this.name = 'IdentifierReservedError';
  }
}

// An avatar icon/colour key that is not in the preset registry (lib/projects/avatar.ts).
export class InvalidAvatarError extends Error {
  readonly code = 'INVALID_AVATAR' as const;
  constructor(field: 'icon' | 'color', value: string) {
    super(`"${value}" is not a valid avatar ${field}.`);
    this.name = 'InvalidAvatarError';
  }
}

// No alias with this key belongs to the project (release of a non-existent
// previous key). 404 — indistinguishable shape from a missing resource.
export class AliasNotFoundError extends Error {
  readonly code = 'ALIAS_NOT_FOUND' as const;
  constructor(identifier: string) {
    super(`No previous key "${identifier}" is reserved for this project.`);
    this.name = 'AliasNotFoundError';
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
    super(
      `"${level}" is not a valid project access level (use public, open, limited, or private).`,
    );
    this.name = 'InvalidAccessLevelError';
  }
}
