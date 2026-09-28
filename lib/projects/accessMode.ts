import type {
  ProjectAccessLevel,
  ProjectAccessMode,
  WorkspaceAccessScope,
} from '@/generated/prisma/client';

// Project ACCESS MODES and membership ACCESS SCOPES (Story MOTIR-6169 ·
// MOTIR-6541, `docs/decisions/role-model.md` Q1). Access decides who may ENTER a
// project; what a person may DO once inside is their workspace role and never
// this. Sits beside `lib/projects/roles.ts`, which still owns the legacy
// `PROJECT_ACCESS_LEVELS` for as long as `project.accessLevel` exists.
//
// The mode is STORED in `project.accessMode`, NOT NULL, and read directly —
// never derived (MOTIR-6686 retired the NULL-mode fallback). The retired
// `accessLevel` is still written beside it by `projectRepository.setAccessMode`,
// using `levelForMode`, until phase 2 (MOTIR-6692) stops the writes.

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
 * The legacy level written BESIDE a mode, so the two columns never disagree
 * while the previous image — which still reads `accessLevel` — serves.
 * `members` writes `private` (not `limited`): `limited` meant "everyone views,
 * only members edit", which no mode reproduces, so the narrow level is the one
 * that admits exactly the people a Members-only project admits.
 */
const MODE_TO_LEVEL: Record<ProjectAccessMode, ProjectAccessLevel> = {
  workspace: 'open',
  members: 'private',
  public: 'public',
};

/** The legacy `accessLevel` written together with `mode`. */
export function levelForMode(mode: ProjectAccessMode): ProjectAccessLevel {
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
