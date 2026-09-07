import type { GithubRepo, Project } from '@/generated/prisma/client';
import type {
  OrgRepoOptionDto,
  OrgRepoProviderDto,
  UsingProjectDto,
} from '@/lib/dto/organizationRepos';

/** One `github_repo` row as the picker's first segment renders it (MOTIR-4678). */
export function toOrgRepoOptionDto(row: GithubRepo): OrgRepoOptionDto {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    fullName: `${row.owner}/${row.name}`,
    defaultBranch: row.defaultBranch,
    provider: row.provider as OrgRepoProviderDto,
    archived: row.archived,
    connectedFromWorkspaceId: row.workspaceId,
  };
}

/** One project as the `Used by N projects` expansion names it (MOTIR-4679). */
export function toUsingProjectDto(project: Project): UsingProjectDto {
  return {
    id: project.id,
    name: project.name,
    identifier: project.identifier,
    workspaceId: project.workspaceId,
  };
}
