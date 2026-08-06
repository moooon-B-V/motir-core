import {
  permissionsByDomain,
  sortByCatalogOrder,
  type PermissionKey,
} from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { PROJECT_ASSIGNABLE_ROLES, type ProjectRole } from '@/lib/projects/roles';
import type {
  ActorPermissionsDTO,
  PermissionDomainDTO,
  RoleCatalogDTO,
  RoleDTO,
} from '@/lib/dto/permissions';

// Permission → DTO conversion (Story MOTIR-2255 · Subtask MOTIR-2262). Pure
// mapping, called by `projectAccessService` just before it returns. Every
// permission list leaves here in CATALOG order, so the boundary is deterministic
// and the grid never reshuffles between two identical requests.

/** The catalog's domain grouping, as the grid renders it. */
export function toPermissionDomainDTOs(): PermissionDomainDTO[] {
  return permissionsByDomain().map(({ domain, permissions }) => ({
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

/** One built-in role as a DTO — its i18n identity plus its set, in catalog order. */
export function toBuiltinRoleDTO(role: ProjectRole): RoleDTO {
  return {
    role,
    labelKey: `settings.roles.${role}.name`,
    descriptionKey: `settings.roles.${role}.description`,
    builtIn: true,
    permissions: sortByCatalogOrder(BUILTIN_ROLE_PERMISSIONS[role]),
  };
}

/**
 * The whole role catalog for a project. Today every role is built-in and the
 * answer is the same for every project; Story MOTIR-2257 adds the project's own
 * custom roles to the `roles` array, which is why the service reads it per
 * project rather than importing a constant.
 */
export function toRoleCatalogDTO(): RoleCatalogDTO {
  return {
    roles: PROJECT_ASSIGNABLE_ROLES.map(toBuiltinRoleDTO),
    domains: toPermissionDomainDTOs(),
  };
}

/** The actor's own resolved set for a project, in catalog order. */
export function toActorPermissionsDTO(
  projectId: string,
  held: Iterable<PermissionKey>,
): ActorPermissionsDTO {
  return { projectId, permissions: sortByCatalogOrder(held) };
}
