import { adminDb } from './adminDb';

/**
 * Make an already-mirrored organisation repository part of one project's
 * explicit repository set.
 *
 * Production code deliberately never infers this relationship from workspace
 * connectivity (MOTIR-4955). Tests that build repositories directly therefore
 * have to state the project link just as their real setup flow would.
 */
export async function linkProjectRepo(opts: {
  workspaceId: string;
  projectId: string;
  githubRepoId: string;
  name: string;
  role?: 'web' | 'api' | 'mobile' | 'shared' | 'infra' | 'other';
}) {
  const position = await adminDb.projectRepo.count({ where: { projectId: opts.projectId } });
  return adminDb.projectRepo.create({
    data: {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      githubRepoId: opts.githubRepoId,
      role: opts.role ?? 'other',
      name: opts.name,
      seedSource: 'blank',
      state: 'connected',
      position: `test-${String(position).padStart(6, '0')}`,
    },
  });
}

/** Link selected mirrored repositories from a workspace to one project. */
export async function linkWorkspaceReposToProject(opts: {
  workspaceId: string;
  projectId: string;
  names: readonly string[];
}) {
  const repos = await adminDb.githubRepo.findMany({
    where: { workspaceId: opts.workspaceId, name: { in: [...opts.names] } },
  });
  const byName = new Map(repos.map((repo) => [repo.name, repo]));
  for (const name of opts.names) {
    const repo = byName.get(name);
    if (!repo) throw new Error(`test repository ${name} was not mirrored`);
    await linkProjectRepo({
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      githubRepoId: repo.id,
      name,
    });
  }
}
