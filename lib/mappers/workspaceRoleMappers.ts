import type { WorkspaceRole } from '@/generated/prisma/client';
import { isEnforced, sortByCatalogOrder, type PermissionKey } from '@/lib/permissions/catalog';
import { ROLE_GATED_PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { toPermissionDomainDTOs } from '@/lib/mappers/permissionMappers';
import { WORKSPACE_ROLES } from '@/lib/workspaces/roles';
import type {
  WorkspaceBuiltInRoleDTO,
  WorkspaceRoleCatalogDTO,
  WorkspaceRoleDTO,
} from '@/lib/dto/workspaceRoles';

// Workspace role rows → DTOs (Story MOTIR-6168 · MOTIR-6460). The stored array is
// intersected with the OFFERED role-gated set and re-sorted into catalog order —
// the read posture `toCustomRoleDTO` takes for a project role, so a key retired
// from the catalog after the role was authored is neither counted nor shown.

function offered(): ReadonlySet<string> {
  return new Set<string>(ROLE_GATED_PERMISSIONS.filter((key) => isEnforced(key)));
}

export function toWorkspaceBuiltInRoleDTO(
  key: WorkspaceRole,
  holderCount: number,
): WorkspaceBuiltInRoleDTO {
  const keep = offered();
  return {
    key,
    builtIn: true,
    permissions: sortByCatalogOrder(
      [...WORKSPACE_ROLE_PERMISSIONS[key]].filter((k) => keep.has(k)),
    ),
    holderCount,
  };
}

export function toWorkspaceRoleDTO(
  row: { id: string; name: string; permissions: string[] },
  holderCount: number,
): WorkspaceRoleDTO {
  const keep = offered();
  return {
    id: row.id,
    name: row.name,
    builtIn: false,
    permissions: sortByCatalogOrder(
      row.permissions.filter((key): key is PermissionKey => keep.has(key)),
    ),
    holderCount,
  };
}

export function toWorkspaceRoleCatalogDTO(
  workspaceId: string,
  builtInCounts: Partial<Record<WorkspaceRole, number>>,
  customRoles: { id: string; name: string; permissions: string[] }[],
  customCounts: ReadonlyMap<string, number>,
): WorkspaceRoleCatalogDTO {
  const domains = toPermissionDomainDTOs();
  return {
    workspaceId,
    roles: [
      ...WORKSPACE_ROLES.map((key) => toWorkspaceBuiltInRoleDTO(key, builtInCounts[key] ?? 0)),
      ...[...customRoles]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((row) => toWorkspaceRoleDTO(row, customCounts.get(row.id) ?? 0)),
    ],
    domains,
    roleGatedPermissionCount: domains.reduce((n, d) => n + d.permissions.length, 0),
  };
}
