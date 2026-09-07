import { adminDb } from '../helpers/adminDb';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
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

  // THE SECOND HALF — the project's own set row, realized against that mirror.
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx);
  await adminDb.projectRepo.update({ where: { id: row.id }, data: { githubRepoId: repo.id } });

  return { githubRepoId: repo.id, repoRef: `acme/${name}` };
}
