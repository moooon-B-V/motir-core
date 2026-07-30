import type { GithubRepo, Project, ProjectRepo } from '@prisma/client';
import type {
  ProjectRepoDto,
  ProjectRepoOwnershipDto,
  ProjectRepoProposalSignalDto,
  ProjectRepoRoleDto,
  ProjectRepoSetDto,
  ProjectRepoStateDto,
  RealizedProjectRepoDto,
} from '@/lib/dto/projectRepos';
import { isEstablishedState } from '@/lib/projectRepos/vocabulary';

// Prisma `ProjectRepo` row (+ its joined `GithubRepo`) → API DTO (Story
// MOTIR-1775 · MOTIR-1780). The single place the persisted enums narrow to their
// string unions, Dates become ISO strings, and the two-part `established` rule is
// computed — so no Prisma row leaks past the service boundary (the 4-layer rule)
// and no consumer re-derives establishment.

/** A `ProjectRepo` row with its realized repo joined (`include: { githubRepo }`) —
 *  the shape `projectRepoRepository`'s reads return. */
export type ProjectRepoWithRealized = ProjectRepo & { githubRepo: GithubRepo | null };

function toRealizedDto(repo: GithubRepo): RealizedProjectRepoDto {
  return {
    id: repo.id,
    provider: repo.provider,
    owner: repo.owner,
    name: repo.name,
    repoRef: `${repo.owner}/${repo.name}`,
    defaultBranch: repo.defaultBranch,
  };
}

export function toProjectRepoDto(row: ProjectRepoWithRealized): ProjectRepoDto {
  return {
    id: row.id,
    projectId: row.projectId,
    role: row.role as ProjectRepoRoleDto,
    label: row.label,
    name: row.name,
    seedSource: row.seedSource,
    state: row.state as ProjectRepoStateDto,
    failureReason: row.failureReason,
    // Narrowed, not validated: the set service rejects any value outside ADR
    // §0.1's ladder at the only writer, so a row that reaches here carries a
    // signal the UI can map to copy — or null, which is the honest answer for a
    // user-added row and for every row written before MOTIR-1892.
    proposalSignal: row.proposalSignal as ProjectRepoProposalSignalDto | null,
    realizedRepo: row.githubRepo ? toRealizedDto(row.githubRepo) : null,
    // BOTH halves, deliberately: a settled state whose mirror row has since been
    // deleted is NOT established (the repository no longer exists), even though
    // the plan it records survives.
    established: isEstablishedState(row.state) && row.githubRepo !== null,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The full set read: the ordered rows plus the project's SET-level ownership
 *  decision (ADR §3.2 / §3.4), which lives on the `project` row. */
export function toProjectRepoSetDto(
  projectId: string,
  rows: ProjectRepoWithRealized[],
  project: Pick<Project, 'repoSetOwnership' | 'repoSetTargetAccount'>,
): ProjectRepoSetDto {
  return {
    projectId,
    rows: rows.map(toProjectRepoDto),
    ownership: (project.repoSetOwnership as ProjectRepoOwnershipDto | null) ?? null,
    targetAccount: project.repoSetTargetAccount,
  };
}
