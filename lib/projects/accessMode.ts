import type { ProjectAccessMode, WorkspaceAccessScope } from '@/generated/prisma/client';
import type { ProjectDTO } from '@/lib/dto/projects';

// Project ACCESS MODES and membership ACCESS SCOPES (Story MOTIR-6169 ·
// MOTIR-6541, `docs/decisions/role-model.md` Q1). Access decides who may ENTER a
// project; what a person may DO once inside is their workspace role and never
// this.
//
// The mode is STORED in `project.accessMode`, NOT NULL, and read directly —
// never derived (MOTIR-6686 retired the NULL-mode fallback). The retired
// `project.accessLevel` column is neither read nor written (MOTIR-6692); what
// survives of the level is the DERIVED `accessLevel` on `ProjectDTO`, API v1
// and MCP, which `levelForMode` computes from the mode.

/** The valid `project.accessMode` values (mirrors the Prisma enum). */
export const PROJECT_ACCESS_MODES = [
  'workspace',
  'members',
  'public',
] as const satisfies readonly ProjectAccessMode[];

/** The valid `workspaceMembership.accessScope` values (mirrors the Prisma enum). */
export const WORKSPACE_ACCESS_SCOPES = [
  'full',
  'limited',
] as const satisfies readonly WorkspaceAccessScope[];

/**
 * The DERIVED legacy level a mode is published as — the `accessLevel` field on
 * `ProjectDTO`, API v1 and MCP. Typed as that DTO's own union rather than the
 * Prisma enum, so the enum can go with the column in phase 3 without touching
 * this. `members` answers `private` (not `limited`): `limited` meant "everyone
 * views, only members edit", which no mode reproduces, so the narrow level is
 * the one that admits exactly the people a Members-only project admits.
 */
const MODE_TO_LEVEL: Record<ProjectAccessMode, ProjectDTO['accessLevel']> = {
  workspace: 'open',
  members: 'private',
  public: 'public',
};

/** The derived `accessLevel` a project in `mode` is published with. */
export function levelForMode(mode: ProjectAccessMode): ProjectDTO['accessLevel'] {
  return MODE_TO_LEVEL[mode];
}

/** Narrow an arbitrary value to a `ProjectAccessMode`, or null. */
export function asAccessMode(value: unknown): ProjectAccessMode | null {
  return typeof value === 'string' && (PROJECT_ACCESS_MODES as readonly string[]).includes(value)
    ? (value as ProjectAccessMode)
    : null;
}

/** Narrow an arbitrary value to a `WorkspaceAccessScope`, or null. */
export function asAccessScope(value: unknown): WorkspaceAccessScope | null {
  return typeof value === 'string' && (WORKSPACE_ACCESS_SCOPES as readonly string[]).includes(value)
    ? (value as WorkspaceAccessScope)
    : null;
}
