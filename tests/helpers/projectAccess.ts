import type { ProjectAccessMode } from '@/generated/prisma/client';

// The ONE way a test sets a project's access (MOTIR-6685).
//
// A project's access is its MODE (`project.accessMode`), and a fixture writes
// exactly what the product writes — `projectRepository.setAccessMode` — which
// since phase 2 (MOTIR-6692) is the mode ALONE. The retired `accessLevel` column
// is `@ignore`d: the client can no longer write it, and it keeps its database
// default until the phase-3 drop. A test that must touch the column itself goes
// through `tests/helpers/legacyProjectAccess.ts`.
//
// Why this exists: while `accessMode` was NULL, the retired fallback derived the
// mode from `accessLevel`, so a fixture writing ONLY `accessLevel: 'public'` got a
// public project. Once `access_mode` is NOT NULL with DEFAULT `workspace`
// (MOTIR-6686), that same fixture gets an Open-to-the-workspace project, and every
// public-read test built on it fails for a reason unrelated to what it tests.
//
// `tests/projects/accessFixtureGuard.test.ts` fails on any test that writes
// `accessLevel` itself instead of coming through here.

/** The `data` fields that give a project `mode`. */
export function projectAccessData(mode: ProjectAccessMode) {
  return { accessMode: mode };
}

/**
 * The mode a RETIRED level maps to (`docs/decisions/role-model.md` Q1) — for the
 * access matrices still keyed on the four legacy levels. `limited` and `private`
 * both land at Members only.
 */
export function modeForLegacyLevel(
  level: 'open' | 'limited' | 'private' | 'public',
): ProjectAccessMode {
  return level === 'open' ? 'workspace' : level === 'public' ? 'public' : 'members';
}

/** Anything with a Prisma `project.update` — `adminDb`, an e2e `db`, a transaction client. */
type ProjectUpdater = {
  project: {
    update: (args: {
      where: { id: string };
      data: ReturnType<typeof projectAccessData>;
    }) => PromiseLike<unknown>;
  };
};

/** Set an existing project's access to `mode`, writing exactly what the product writes. */
export async function setProjectAccess(
  client: ProjectUpdater,
  projectId: string,
  mode: ProjectAccessMode,
): Promise<void> {
  await client.project.update({ where: { id: projectId }, data: projectAccessData(mode) });
}
