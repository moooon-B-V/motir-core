import type { RoleMigrationReason, WorkspaceRole } from '@/generated/prisma/client';

// DTOs for the workspace endpoints + settings surfaces. These define
// EXACTLY what crosses the HTTP / Server-Action boundary — no Prisma
// model leaks. Add fields here when the UI needs them, never on raw
// Prisma rows in a service return type.

// ── GET /api/workspaces/current (Subtask 1.2.4) ──
export interface WorkspaceDTO {
  id: string;
  name: string;
  slug: string;
}

export interface MembershipDTO {
  id: string;
  role: string;
  userId: string;
  workspaceId: string;
}

// The user's active workspace plus their membership in it.
export interface CurrentWorkspaceDTO {
  workspace: WorkspaceDTO;
  membership: MembershipDTO;
}

// ── Settings surfaces (Subtask 1.2.6) ──
export interface WorkspaceMemberDTO {
  userId: string;
  name: string;
  email: string;
  /**
   * The member's WORKSPACE role (Story MOTIR-6168 · MOTIR-6463) — their role in
   * every project of the workspace. A custom-role holder reads the custom role's
   * tier (`member`); `customRole` names the role itself.
   */
  workspaceRole: WorkspaceRole;
  /** The workspace custom role they hold, or null on a built-in. */
  customRole: { id: string; name: string } | null;
}

/** The answer to a role change (MOTIR-6463): the member's role as it now stands. */
export interface WorkspaceMemberRoleDTO {
  userId: string;
  workspaceRole: WorkspaceRole;
  customRole: { id: string; name: string } | null;
}

export interface WorkspaceSummaryDTO {
  id: string;
  name: string;
  slug: string;
}

/**
 * One row of the org Workspaces section (MOTIR-6309): a workspace in the
 * organization with the two counts the section shows. `projectCount` includes
 * archived projects — it is the count removal REACHES (the same number the
 * remove confirmation states), not the count a picker would offer.
 */
export interface OrgWorkspaceRowDTO {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  projectCount: number;
  createdAt: string;
  /**
   * Whether the viewer is on this workspace's roster. An org Owner / Admin
   * reaches it as its Manager either way; the row marks the ones they reach
   * only through the organization (MOTIR-6456 panel 6b).
   */
  viewerIsMember: boolean;
}

/** One keyset page of {@link OrgWorkspaceRowDTO}s. */
export interface OrgWorkspacePageDTO {
  workspaces: OrgWorkspaceRowDTO[];
  nextCursor: string | null;
  total: number;
}

// ── The workspace Members page's role surfaces (Story MOTIR-6168 · MOTIR-6465) ──

/** What the Members page needs beyond the member list to draw the role column. */
export interface MemberRoleContextDTO {
  /** Whether the viewer is a Manager of this workspace (their role, or the org's reach). */
  canManageRoles: boolean;
  /**
   * The members who are the org's Owner or an Admin — a Manager of every
   * workspace by their org role, drawn locked at Manager (MOTIR-6456 panel 6a).
   */
  orgManagedUserIds: string[];
  /** The organization's name, for the locked row's reason. */
  organizationName: string;
  /** This workspace's custom roles, the picker's second group. */
  customRoles: { id: string; name: string }[];
}

/** What a person held before the move to workspace roles, as the report recorded it. */
export interface RoleMigrationBeforeDTO {
  /** The legacy workspace role (`owner` / `admin` / `member` / `viewer`), when recorded. */
  workspaceRole: string | null;
  /** Every project role held, when recorded. */
  projects: { projectKey: string; role: string | null; customRoleName: string | null }[];
  /** Where their keys narrowed (the never-wider check's rows). */
  narrowedIn: { projectKey: string; lost: string[] }[];
}

/** One open row of the migration report. */
export interface RoleMigrationEntryDTO {
  id: string;
  userId: string;
  name: string;
  email: string;
  before: RoleMigrationBeforeDTO;
  afterRole: WorkspaceRole;
  /** The workspace custom role they were put on, if any. */
  afterCustomRoleName: string | null;
  reason: RoleMigrationReason;
}

/** One page of the report, and how many rows are open in all. */
export interface RoleMigrationPageDTO {
  entries: RoleMigrationEntryDTO[];
  total: number;
  nextCursor: string | null;
}
