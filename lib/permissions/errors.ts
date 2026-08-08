// Typed errors for the custom-project-roles domain (Story MOTIR-2257 · Subtask
// MOTIR-2472). Their own file so callers — route handlers, server actions,
// server components — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, services throw typed errors with stable string `code`s and the
// ROUTE layer translates them to HTTP statuses; the shared mapping is
// `lib/permissions/errorResponse.ts` (MOTIR-2474). The gate denials reuse
// `NotProjectAdminError` / `PermissionDeniedError` from `lib/projects/errors`
// and the no-existence-leak 404 reuses `ProjectNotFoundError` — this file adds
// only what is genuinely new to roles.

import { MAX_CUSTOM_ROLES_PER_PROJECT, MAX_ROLE_NAME_LENGTH } from '@/lib/permissions/limits';

export class RoleDefinitionNotFoundError extends Error {
  readonly code = 'ROLE_DEFINITION_NOT_FOUND' as const;
  constructor(roleId: string) {
    super(`Role definition ${roleId} not found.`);
    this.name = 'RoleDefinitionNotFoundError';
  }
}

/** An empty, blank or over-long role name. */
export class InvalidRoleNameError extends Error {
  readonly code = 'INVALID_ROLE_NAME' as const;
  constructor() {
    super(`A role name must be a non-empty string of at most ${MAX_ROLE_NAME_LENGTH} characters.`);
    this.name = 'InvalidRoleNameError';
  }
}

/**
 * A name already taken by another role IN THE SAME PROJECT — the translation of
 * the `(project_id, name)` unique index's P2002. The service catches the raw
 * database error and rethrows this, so a P2002 never escapes to a route.
 */
export class RoleNameTakenError extends Error {
  readonly code = 'ROLE_NAME_TAKEN' as const;
  constructor(readonly name_: string) {
    super(`A role named "${name_}" already exists in this project.`);
    this.name = 'RoleNameTakenError';
  }
}

/**
 * A permission key the server will not let a role hold — because it is not in
 * the ROLE-GATED, `enforced` set.
 *
 * ⚠️ Two distinct causes, deliberately ONE error: a key that no gate consults
 * (`enforcement: 'planned'`) and a key no role can ever hold (a level-gated
 * `public_request:*`). Both are "this switch would control nothing", which is
 * the failure the whole epic exists to remove — a settings screen showing a
 * switch that does nothing is a promise the code does not keep.
 */
export class UngrantablePermissionError extends Error {
  readonly code = 'UNGRANTABLE_PERMISSION' as const;
  constructor(readonly key: string) {
    super(`"${key}" is not a permission a role may hold.`);
    this.name = 'UngrantablePermissionError';
  }
}

/** The per-project cap on custom roles, reached. */
export class RoleLimitReachedError extends Error {
  readonly code = 'ROLE_LIMIT_REACHED' as const;
  constructor(readonly limit: number = MAX_CUSTOM_ROLES_PER_PROJECT) {
    super(`A project may define at most ${limit} custom roles.`);
    this.name = 'RoleLimitReachedError';
  }
}

/**
 * An operation aimed at one of the three BUILT-IN roles. Refused rather than
 * reported as not-found, because the caller asked for something meaningful and
 * impossible: `admin` / `member` / `viewer` exist, and may never be written.
 * Their immutability is what makes "reset to the default" always available.
 */
export class BuiltInRoleImmutableError extends Error {
  readonly code = 'BUILT_IN_ROLE_IMMUTABLE' as const;
  constructor(readonly role: string) {
    super(`"${role}" is a built-in role and cannot be edited or deleted.`);
    this.name = 'BuiltInRoleImmutableError';
  }
}

/**
 * A delete refused because members still hold the role and no destination was
 * given. **Carries the affected COUNT** — that number is not decoration: it is
 * what the confirmation dialog says before it asks where those people should go
 * (`design/projects/roles-permissions.mock.html` panel 5). So it has to survive
 * the service boundary and, at MOTIR-2474, the HTTP one.
 */
export class RoleInUseError extends Error {
  readonly code = 'ROLE_IN_USE' as const;
  constructor(
    readonly roleName: string,
    readonly count: number,
  ) {
    super(`"${roleName}" is held by ${count} member(s); choose a role to move them to.`);
    this.name = 'RoleInUseError';
  }
}

/**
 * A reassign destination that cannot receive the members: the role being
 * deleted, a role in another project, or a name that is neither a built-in nor
 * one of this project's roles. Refused BEFORE any write.
 */
export class InvalidRoleReassignTargetError extends Error {
  readonly code = 'INVALID_ROLE_REASSIGN_TARGET' as const;
  constructor() {
    super('The destination must be a different role belonging to this project.');
    this.name = 'InvalidRoleReassignTargetError';
  }
}

/** A `basedOn` that is not one of the three project-assignable built-ins. */
export class InvalidRoleBaseError extends Error {
  readonly code = 'INVALID_ROLE_BASE' as const;
  constructor(readonly base: string) {
    super(`"${base}" is not a base a role can start from (use admin, member or viewer).`);
    this.name = 'InvalidRoleBaseError';
  }
}
