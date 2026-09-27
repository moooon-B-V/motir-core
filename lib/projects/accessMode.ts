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
// The mode is stored in `project.accessMode`, added BESIDE the legacy
// `accessLevel` (expand → migrate → contract). While a row's `accessMode` is
// NULL — not migrated yet, or created by the still-serving old build — the mode
// is DERIVED from `accessLevel`, which is what `accessModeOf` answers. The two
// columns are written together by `projectRepository.setAccessMode`, using
// `levelForMode` for the legacy half.

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
 * The DECISION's mapping from a legacy level to a mode (`role-model.md` Q1):
 * `open` → Open to the workspace; `limited` and `private` → Members only;
 * `public` → Public. A `Record` over the enum, so a new level fails the type
 * check here rather than falling through at run time.
 */
const LEVEL_TO_MODE: Record<ProjectAccessLevel, ProjectAccessMode> = {
  open: 'workspace',
  limited: 'members',
  private: 'members',
  public: 'public',
};

/**
 * The legacy level written BESIDE a mode, so the two columns never disagree —
 * above all for the RLS policies that still key on `"accessLevel" = 'public'`.
 * `members` writes `private` (not `limited`): `limited` meant "everyone views,
 * only members edit", which no mode reproduces, so the narrow level is the one
 * that admits exactly the people a Members-only project admits.
 */
const MODE_TO_LEVEL: Record<ProjectAccessMode, ProjectAccessLevel> = {
  workspace: 'open',
  members: 'private',
  public: 'public',
};

/**
 * A project's access mode: the stored `accessMode`, or — while that is NULL —
 * the mode its legacy `accessLevel` maps to.
 */
export function accessModeOf(project: {
  accessMode: ProjectAccessMode | null;
  accessLevel: ProjectAccessLevel;
}): ProjectAccessMode {
  return project.accessMode ?? LEVEL_TO_MODE[project.accessLevel];
}

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
