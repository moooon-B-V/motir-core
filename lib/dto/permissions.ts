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
  /**
   * How many of the project's members hold this role — the `3 members` the role
   * LIST row draws beside the permission count (MOTIR-2439). It is the one value
   * on that screen that is not a fact about the permission model: it comes from
   * `ProjectMembership`, resolved by ONE grouped read for the whole catalog. A
   * role nobody holds is `0`, never a missing key.
   */
  memberCount: number;
}

/**
 * What the Roles & permissions settings page renders: every role in the project
 * alongside the catalog's domain grouping, so the grid can draw its rows without
 * a second read or a static import.
 */
export interface RoleCatalogDTO {
  roles: RoleDTO[];
  /**
   * The permission rows the screens draw — the ROLE-GATED set, grouped by domain.
   * NOT the whole catalog: the level-gated `public_request:*` keys are decided by
   * the project's access level and no role can hold or withhold them.
   */
  domains: PermissionDomainDTO[];
  /**
   * The `M` in the list row's `N of M permissions` — the size of the role-gated
   * set, i.e. the total of every group in {@link domains}. Carried on the DTO so
   * a client never re-derives it by importing the catalog: MOTIR-2257 makes the
   * answer genuinely project-scoped, and a page wired to a constant would be
   * wrong the day the first custom role narrows it.
   */
  roleGatedPermissionCount: number;
  /**
   * The permissions {@link domains} deliberately LEAVES OUT — the ones the
   * project's ACCESS LEVEL decides for every visitor rather than any role. The
   * list screen draws them as their own card beneath the roles, because a reader
   * who knows the product governs public requests and cannot find them in a role
   * would otherwise conclude the page is incomplete.
   *
   * It is the exact complement of `domains` over the catalog, computed in the
   * same place and from the same constant — so the two can never both omit a key
   * and silently hide it from the only screen that describes the model.
   */
  levelGatedDomains: PermissionDomainDTO[];
}

/** The ACTOR's own resolved permissions on a project, in catalog order. */
export interface ActorPermissionsDTO {
  projectId: string;
  permissions: PermissionKey[];
}
