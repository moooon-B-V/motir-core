import type { WorkspaceRole } from '@/generated/prisma/client';
import type { PermissionDomainDTO } from '@/lib/dto/permissions';
import type { PermissionKey } from '@/lib/permissions/catalog';

// The WORKSPACE role catalog (Story MOTIR-6168 · MOTIR-6460) — what the workspace
// Roles pages (MOTIR-6466) read: the three built-ins and every custom role the
// workspace authored, each with its permission set and how many members hold it.
// The same shape the project catalog (`RoleCatalogDTO`) has, re-keyed on the
// workspace.

/** One of the three built-in workspace roles. */
export interface WorkspaceBuiltInRoleDTO {
  key: WorkspaceRole;
  builtIn: true;
  /** Its permission set, in CATALOG order. */
  permissions: PermissionKey[];
  holderCount: number;
}

/** A workspace custom role. */
export interface WorkspaceRoleDTO {
  id: string;
  name: string;
  builtIn: false;
  /** The stored set intersected with the offered catalog, in CATALOG order. */
  permissions: PermissionKey[];
  holderCount: number;
}

export interface WorkspaceRoleCatalogDTO {
  workspaceId: string;
  /** The three built-ins first (Manager, Member, Viewer), then custom roles by name. */
  roles: (WorkspaceBuiltInRoleDTO | WorkspaceRoleDTO)[];
  /** The ROLE-GATED permission rows, grouped by domain — what the grid draws. */
  domains: PermissionDomainDTO[];
  /** The `M` in `N of M permissions`: the size of the role-gated set the grid draws. */
  roleGatedPermissionCount: number;
}
