import {
  PERMISSIONS,
  permissionsByDomain,
  sortByCatalogOrder,
  type PermissionDescriptor,
  type PermissionDomain,
  type PermissionKey,
} from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS, ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { PROJECT_ASSIGNABLE_ROLES, type ProjectRole } from '@/lib/projects/roles';
import type {
  ActorPermissionsDTO,
  PermissionDomainDTO,
  RoleCatalogDTO,
  RoleDTO,
} from '@/lib/dto/permissions';

// Permission → DTO conversion (Story MOTIR-2255 · Subtask MOTIR-2262; widened by
// MOTIR-2439). Pure mapping, called by `projectAccessService` just before it
// returns. Every permission list leaves here in CATALOG order, so the boundary is
// deterministic and the grid never reshuffles between two identical requests.

/** How many of the project's members hold each role — a role absent from the map is `0`. */
export type RoleMemberCounts = Partial<Record<ProjectRole, number>>;

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

/** One built-in role as a DTO — its i18n identity, its set in catalog order, and its headcount. */
export function toBuiltinRoleDTO(role: ProjectRole, memberCount: number): RoleDTO {
  return {
    role,
    labelKey: `settings.roles.${role}.name`,
    descriptionKey: `settings.roles.${role}.description`,
    builtIn: true,
    permissions: sortByCatalogOrder(BUILTIN_ROLE_PERMISSIONS[role]),
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
export function toRoleCatalogDTO(memberCounts: RoleMemberCounts = {}): RoleCatalogDTO {
  const domains = toPermissionDomainDTOs();
  return {
    roles: PROJECT_ASSIGNABLE_ROLES.map((role) => toBuiltinRoleDTO(role, memberCounts[role] ?? 0)),
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
