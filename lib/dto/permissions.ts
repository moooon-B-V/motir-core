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

/**
 * ONE custom role definition, as the write API returns it (Story MOTIR-2257 ·
 * Subtask MOTIR-2472). Distinct from {@link RoleDTO}, which is what the READ
 * screens render for every role in a project, built-in ones included — this is
 * the row the create / rename / re-permission calls just wrote, and nothing
 * more.
 */
export interface RoleDefinitionDTO {
  id: string;
  name: string;
  /** The permissions it holds, in CATALOG order (never insertion order). */
  permissions: PermissionKey[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One role in the catalog: its identity, and the permissions it holds.
 *
 * ⚠️ WIDENED BY MOTIR-2478, and the widening IS the ripple of custom roles. Until
 * a project could have roles of its own, every role was one of three known
 * things — so `role` could be its identity, its URL segment AND a translation
 * key all at once. A role somebody invented breaks all three: its name is text a
 * person typed in their own language and must never go through a translation
 * lookup, and its identity has to survive being renamed.
 */
export interface RoleDTO {
  /**
   * The role's IDENTITY and its `[roleKey]` URL segment: `admin` / `member` /
   * `viewer` for a built-in, the definition's id for a custom role. Replaces the
   * old `role` field, which doubled as identity and enum.
   */
  key: string;
  /**
   * The `ProjectRole` enum where it still exists — a built-in's own value, or
   * `null` for a custom role. What the icon map and the tint choice key off, and
   * the one field a `Record<ProjectRole, …>` may be indexed with.
   */
  builtInRole: ProjectRole | null;
  /**
   * i18n key for a BUILT-IN's display name (`settings.roles.<role>.name`), or
   * `null` for a custom role. Exactly one of `labelKey` / `name` is non-null.
   */
  labelKey: string | null;
  /** i18n key for a BUILT-IN's one-line description, or `null` for a custom role. */
  descriptionKey: string | null;
  /** A CUSTOM role's literal name, as its author typed it. Null for a built-in. */
  name: string | null;
  /** A CUSTOM role's literal description. Null for a built-in — and today always null. */
  description: string | null;
  /**
   * True for a role the code owns and a user cannot edit — the three built-ins.
   * A custom role is `false`.
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
