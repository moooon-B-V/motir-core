import {
  PERMISSIONS,
  permissionsByDomain,
  sortByCatalogOrder,
  type PermissionDescriptor,
  type PermissionDomain,
  type PermissionKey,
} from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS, ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { asProjectRole, PROJECT_ASSIGNABLE_ROLES, type ProjectRole } from '@/lib/projects/roles';
import type {
  ActorPermissionsDTO,
  PermissionDomainDTO,
  RoleCatalogDTO,
  RoleDefinitionDTO,
  RoleDTO,
} from '@/lib/dto/permissions';

// Permission → DTO conversion (Story MOTIR-2255 · Subtask MOTIR-2262; widened by
// MOTIR-2439). Pure mapping, called by `projectAccessService` just before it
// returns. Every permission list leaves here in CATALOG order, so the boundary is
// deterministic and the grid never reshuffles between two identical requests.

/** How many of the project's members hold each BUILT-IN role — a role absent from the map is `0`. */
export type RoleMemberCounts = Partial<Record<ProjectRole, number>>;

/** The slice of a `ProjectRoleDefinition` row the mappers need (MOTIR-2478). */
export interface CustomRoleRow {
  id: string;
  name: string;
  basedOn: string;
  permissions: string[];
}

/**
 * The catalog's domain grouping, as the role screens render it — the ROLE-GATED
 * rows only (MOTIR-2439). The three level-gated `public_request:*` keys are
 * excluded because no role can hold or withhold them; drawn as role rows they
 * would be a permanent dash against every role, which reads as a capability
 * nobody has rather than one roles do not govern. They are not hidden — see
 * {@link toLevelGatedDomainDTOs}, which is this function's exact complement.
 */
export function toPermissionDomainDTOs(): PermissionDomainDTO[] {
  return groupsToDTOs(permissionsByDomain({ include: ROLE_GATED_PERMISSIONS }));
}

/**
 * The permissions {@link toPermissionDomainDTOs} leaves out — the ones a
 * project's ACCESS LEVEL decides for every visitor, signed in or not. The role
 * list draws them as their own card, because a reader who knows the product
 * governs public requests and cannot find them under any role would otherwise
 * conclude the page is describing less than the whole model.
 *
 * ⚠️ Derived as the COMPLEMENT of the role-gated set over the catalog, not from a
 * second hand-written list of keys. Two lists would let a key added to neither
 * fall off the only screen that describes the model; a complement cannot.
 */
export function toLevelGatedDomainDTOs(): PermissionDomainDTO[] {
  const roleGated = new Set<PermissionKey>(ROLE_GATED_PERMISSIONS);
  const levelGated = PERMISSIONS.filter((key) => !roleGated.has(key));
  return groupsToDTOs(permissionsByDomain({ include: levelGated }));
}

/** The shared descriptor → DTO shaping behind the two grouping functions above. */
function groupsToDTOs(
  groups: { domain: PermissionDomain; permissions: PermissionDescriptor[] }[],
): PermissionDomainDTO[] {
  return groups.map(({ domain, permissions }) => ({
    domain,
    labelKey: `permissions.domain.${domain}`,
    permissions: permissions.map((descriptor) => ({
      key: descriptor.key,
      domain: descriptor.domain,
      labelKey: descriptor.labelKey,
      descriptionKey: descriptor.descriptionKey,
    })),
  }));
}

/**
 * One BUILT-IN role as a DTO — its i18n identity, its set in catalog order, and
 * its headcount. Its `key` IS its enum value, which is what keeps every existing
 * `/settings/project/roles/admin` URL working after the MOTIR-2478 widening.
 */
export function toBuiltinRoleDTO(role: ProjectRole, memberCount: number): RoleDTO {
  return {
    key: role,
    builtInRole: role,
    labelKey: `settings.roles.${role}.name`,
    descriptionKey: `settings.roles.${role}.description`,
    name: null,
    description: null,
    basedOn: null,
    basedOnDelta: null,
    builtIn: true,
    permissions: sortByCatalogOrder(BUILTIN_ROLE_PERMISSIONS[role]),
    memberCount,
  };
}

/**
 * One CUSTOM role as a DTO (Story MOTIR-2257 · Subtask MOTIR-2478).
 *
 * ⚠️ ITS NAME IS A LITERAL, NEVER AN i18n KEY. A built-in's copy must stay
 * translatable; an author's name must never be run through a translation lookup,
 * because it is text a person typed in their own language. So `labelKey` /
 * `descriptionKey` are null here and `name` / `description` carry the strings —
 * the client renders whichever is present.
 *
 * ⚠️ `builtInRole` IS NULL, and that is what makes the icon map safe. A
 * `Record<ProjectRole, …>` may only be indexed with a real enum value; a custom
 * role's `key` is a cuid, so a component that reached for `ROLE_ICON[role.key]`
 * would be indexing a total record with a string that is not in its domain.
 *
 * The stored `permissions` array is intersected with the ROLE-GATED set and
 * re-sorted into catalog order — the same posture `resolvePermissions` takes
 * (MOTIR-2470), so a key retired from the catalog after the role was authored is
 * neither counted nor shown.
 */
export function toCustomRoleDTO(
  row: { id: string; name: string; basedOn: string; permissions: string[] },
  memberCount: number,
): RoleDTO {
  const roleGated = new Set<string>(ROLE_GATED_PERMISSIONS);
  const held = sortByCatalogOrder(
    row.permissions.filter((key): key is PermissionKey => roleGated.has(key)),
  );
  const basedOn = asProjectRole(row.basedOn);
  /* istanbul ignore next -- unreachable: `basedOn` is NOT NULL in the schema and the service refuses any value outside PROJECT_ASSIGNABLE_ROLES */
  if (!basedOn) throw new Error(`Role definition ${row.id} carries a non-assignable base.`);
  return {
    key: row.id,
    builtInRole: null,
    labelKey: null,
    descriptionKey: null,
    name: row.name,
    description: null,
    basedOn,
    // The chip's ±N, computed HERE so a component never re-derives it.
    basedOnDelta: held.length - BUILTIN_ROLE_PERMISSIONS[basedOn].size,
    builtIn: false,
    permissions: held,
    memberCount,
  };
}

/**
 * The whole role catalog for a project. Today every role is built-in and the
 * permission answer is the same for every project; Story MOTIR-2257 adds the
 * project's own custom roles to the `roles` array, which is why the service reads
 * it per project rather than importing a constant. The member counts have always
 * been project-scoped.
 *
 * `roleGatedPermissionCount` is derived from the very groups the screens render,
 * so the `M` in `N of M` can never disagree with the rows above it. And
 * `levelGatedDomains` carries what `domains` leaves out, so the two together are
 * always the whole catalog.
 */
export function toRoleCatalogDTO(
  memberCounts: RoleMemberCounts = {},
  customRoles: CustomRoleRow[] = [],
  customRoleMemberCounts: Record<string, number> = {},
): RoleCatalogDTO {
  const domains = toPermissionDomainDTOs();
  return {
    // ⚠️ DETERMINISTIC ORDER: the three built-ins in their canonical order, THEN
    // the project's own roles by name. An order that depended on insertion would
    // reshuffle the list between two identical requests for no reason a reader
    // can see — the same argument this file already makes about permission
    // order. (The repository returns them name-ordered; re-sorting here means
    // the DTO's contract does not rest on a `findMany` option.)
    roles: [
      ...PROJECT_ASSIGNABLE_ROLES.map((role) => toBuiltinRoleDTO(role, memberCounts[role] ?? 0)),
      ...[...customRoles]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((row) => toCustomRoleDTO(row, customRoleMemberCounts[row.id] ?? 0)),
    ],
    domains,
    roleGatedPermissionCount: domains.reduce((total, group) => total + group.permissions.length, 0),
    levelGatedDomains: toLevelGatedDomainDTOs(),
  };
}

/** The actor's own resolved set for a project, in catalog order. */
export function toActorPermissionsDTO(
  projectId: string,
  held: Iterable<PermissionKey>,
): ActorPermissionsDTO {
  return { projectId, permissions: sortByCatalogOrder(held) };
}

/**
 * ONE custom role definition → the DTO the write API returns (Story MOTIR-2257 ·
 * Subtask MOTIR-2472). Not `RoleDTO`: that is what the READ screens render for
 * every role in a project, built-ins included. This is the row that was just
 * written.
 *
 * The stored `permissions` array is INTERSECTED with the role-gated set and
 * re-sorted into catalog order on the way out — the same posture
 * `resolvePermissions` takes on the read side (MOTIR-2470). The service refuses
 * an ungrantable key at write time, so this is not a second policy: it is what
 * keeps a row authored BEFORE a key was retired from reporting a permission the
 * product no longer governs.
 */
export function toRoleDefinitionDTO(row: {
  id: string;
  name: string;
  basedOn: string;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}): RoleDefinitionDTO {
  const roleGated = new Set<string>(ROLE_GATED_PERMISSIONS);
  const held = row.permissions.filter((key): key is PermissionKey => roleGated.has(key));
  const base = asProjectRole(row.basedOn);
  /* istanbul ignore next -- unreachable: `basedOn` is NOT NULL and the service refuses any value outside PROJECT_ASSIGNABLE_ROLES, so a row can only carry a valid base */
  if (!base) throw new Error(`Role definition ${row.id} carries a non-assignable base.`);
  return {
    id: row.id,
    name: row.name,
    basedOn: base,
    permissions: sortByCatalogOrder(held),
    basedOnPermissionCount: BUILTIN_ROLE_PERMISSIONS[base].size,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
