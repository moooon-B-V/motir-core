import type { ProjectAccessMode } from '@/generated/prisma/client';
import { levelForMode } from '@/lib/projects/accessMode';

// The ONE way a test sets a project's access (MOTIR-6685).
//
// A project's access is its MODE (`project.accessMode`). Until the retired
// `accessLevel` column is dropped, the product writes the mode AND the level it
// maps to, together — `projectRepository.setAccessMode`, through `levelForMode`.
// A fixture writes exactly the same pair, through the same mapping, so a fixture
// and the product cannot disagree about what "public" means.
//
// Why this exists: while `accessMode` is NULL, `accessModeOf` derives the mode
// from `accessLevel`, so a fixture writing ONLY `accessLevel: 'public'` got a
// public project. Once `access_mode` is NOT NULL with DEFAULT `workspace`
// (MOTIR-6686), that same fixture gets an Open-to-the-workspace project, and every
// public-read test built on it fails for a reason unrelated to what it tests.
//
// `tests/projects/accessFixtureGuard.test.ts` fails on any test that writes
// `accessLevel` itself instead of coming through here.

/** The `data` fields that give a project `mode`: the mode, and the level written beside it. */
export function projectAccessData(mode: ProjectAccessMode) {
  return { accessMode: mode, accessLevel: levelForMode(mode) };
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

/** Set an existing project's access to `mode`, writing both columns as the product does. */
export async function setProjectAccess(
  client: ProjectUpdater,
  projectId: string,
  mode: ProjectAccessMode,
): Promise<void> {
  await client.project.update({ where: { id: projectId }, data: projectAccessData(mode) });
}
