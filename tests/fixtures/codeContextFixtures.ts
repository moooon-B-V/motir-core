import { adminDb } from '../helpers/adminDb';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import type { WorkItemFixture } from './workItemFixtures';

// GIVING A PROJECT CODE CONTEXT, in a fixture (Story MOTIR-1754 · MOTIR-1767).
//
// ⚠️ CONNECTING A REPOSITORY TO THE WORKSPACE IS NO LONGER ENOUGH, and that is
// the whole point of this helper's existence. `resolveCodeContextState` reads the
// PROJECT's configured set (`project_repository`), not the workspace
// installation's grant list — a repository the workspace has connected but nobody
// added to this project is correctly absent from it.
//
// Before that change a fixture could `persistInstallation` and the project had
// code context as a side effect. Afterwards the same fixture leaves the project
// code-BLIND, and every assertion downstream of that reads as a mysterious
// `skipped`/`fired: 0` rather than as a missing link. So the two halves are done
// together, here, once.
/**
 * Put EVERY repository the workspace has connected into a project's set, realized
 * against the grant mirror — the BULK form of {@link connectAndLinkRepo}'s second
 * half (MOTIR-4653).
 *
 * ⚠️ IT EXISTS BECAUSE `resolveCodeContext` STOPPED READING THE GRANT. A fixture
 * that calls `persistInstallation` and then expects a planning envelope to carry
 * `context.code` used to be complete; the resolver reads the PROJECT's configured
 * set now, so the same fixture leaves the project code-BLIND and its assertions
 * fail as an empty answer rather than as a missing link. This is the one line
 * such a fixture adds.
 *
 * Rows are added in the grant mirror's own display order (owner asc, name asc),
 * so a suite that was asserting positionally against the workspace grant keeps
 * the order it had.
 *
 * ⚠️ IT WRITES AN *ESTABLISHED* ROW, THROUGH `linkProjectRepo`, AND THAT IS NOT A
 * SHORTCUT PAST THE SERVICE. `projectRepoSetService.addRow` records a PROPOSED
 * row — an intent — and `resolveProjectCodeContext` filters proposals out
 * (`isEstablishedState`). A fixture built on `addRow` therefore leaves the
 * project code-BLIND at the exact layer this helper exists to feed, and the
 * symptom is an empty envelope rather than a missing link: the same silent
 * failure the note above describes, one rung down. `linkProjectRepo` is the
 * shared helper `main` uses for this, so there is ONE way a fixture states the
 * link.
 */
export async function linkAllWorkspaceReposIntoProject(ctx: {
  userId: string;
  workspaceId: string;
  projectId: string;
}): Promise<void> {
  const repos = await adminDb.githubRepo.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ owner: 'asc' }, { name: 'asc' }],
  });
  for (const repo of repos) {
    await linkProjectRepo({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      githubRepoId: repo.id,
      name: repo.name,
      role: 'web',
    });
  }
}

export async function connectAndLinkRepo(
  fx: WorkItemFixture,
  opts: { name?: string } = {},
): Promise<{ githubRepoId: string; repoRef: string }> {
  const name = opts.name ?? 'web';
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: `inst-${fx.workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: `repo-${fx.workspaceId}`,
        owner: 'acme',
        name,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });

  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: fx.workspaceId, owner: 'acme', name },
  });

  // THE SECOND HALF — the project's own set row, ESTABLISHED against that mirror.
  // See the note on `linkAllWorkspaceReposIntoProject` for why it is not
  // `addRow`: that writes a PROPOSED row, and a proposal is filtered out of every
  // code-context read.
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
    role: 'web',
  });

  return { githubRepoId: repo.id, repoRef: `acme/${name}` };
}
