import { adminDb } from './adminDb';
import { keyForAppend } from '@/lib/workItems/positioning';

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
  // ⚠️ A REAL FRACTIONAL KEY, NOT `test-000000`. The column is a fractional index
  // and `projectRepoSetService.addRow` appends against the LAST one — so a
  // synthetic key that `generateKeyBetween` cannot parse makes the next real
  // `addRow` in the same project throw `invalid order key`. A fixture that writes
  // a row nothing else can be added after is a trap for whoever mixes the two.
  const last = await adminDb.projectRepo.findFirst({
    where: { projectId: opts.projectId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const position = keyForAppend(last?.position ?? null);
  return adminDb.projectRepo.create({
    data: {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      githubRepoId: opts.githubRepoId,
      role: opts.role ?? 'other',
      name: opts.name,
      seedSource: 'blank',
      state: 'connected',
      position,
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
