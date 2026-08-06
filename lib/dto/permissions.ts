import type { PermissionDomain, PermissionKey } from '@/lib/permissions/catalog';
import type { ProjectRole } from '@/lib/projects/roles';

// DTOs for the permission model (Story MOTIR-2255 · Subtask MOTIR-2262). These
// define EXACTLY what crosses the HTTP / Server-Action boundary — no `Set`, no
// Prisma model, nothing non-serialisable.
//
// ⚠️ EVERY permission array is SORTED IN CATALOG ORDER, never insertion order.
// A `Set` does not cross the server/client boundary at all, and an array whose
// order depends on how the resolution happened to accumulate it would make the
// rendered grid reshuffle between requests for no reason the user can see.
// `sortByCatalogOrder` is the one place that order is decided.

/** One domain group as the grid renders it: the heading plus its permissions. */
export interface PermissionDomainDTO {
  domain: PermissionDomain;
  /** i18n key for the group heading (`permissions.domain.<domain>`). */
  labelKey: string;
  permissions: PermissionDescriptorDTO[];
}

/** One permission as the grid renders it — human keys, never a raw catalog key. */
export interface PermissionDescriptorDTO {
  key: PermissionKey;
  domain: PermissionDomain;
  labelKey: string;
  descriptionKey: string;
}

/** One role in the catalog: its identity, and the permissions it holds. */
export interface RoleDTO {
  role: ProjectRole;
  /** i18n key for the role's display name (`settings.roles.<role>.name`). */
  labelKey: string;
  /** i18n key for the one-line "who is this for" description. */
  descriptionKey: string;
  /**
   * True for a role the code owns and a user cannot edit. Every role is built-in
   * until Story MOTIR-2257 ships custom roles; the flag exists now so the grid's
   * `Built-in` chip reads a field rather than assuming.
   */
  builtIn: boolean;
  /** The permissions this role holds, in catalog order. */
  permissions: PermissionKey[];
}

/**
 * What the Roles & permissions settings page renders: every role in the project
 * alongside the catalog's domain grouping, so the grid can draw its rows without
 * a second read or a static import.
 */
export interface RoleCatalogDTO {
  roles: RoleDTO[];
  domains: PermissionDomainDTO[];
}

/** The ACTOR's own resolved permissions on a project, in catalog order. */
export interface ActorPermissionsDTO {
  projectId: string;
  permissions: PermissionKey[];
}
