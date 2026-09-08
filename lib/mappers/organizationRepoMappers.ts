import type { GithubRepo, Project } from '@/generated/prisma/client';
import type {
  OrgRepoOptionDto,
  OrgRepoProviderDto,
  UsingProjectDto,
} from '@/lib/dto/organizationRepos';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';

/**
 * One `github_repo` row as the picker's first segment renders it (MOTIR-4678).
 *
 * ⚠️ `hostOwner` IS A REQUIRED PARAMETER, not an optional one (bug MOTIR-4892).
 * It is the provisioning organisation's login — `provisioningOrgLogin()`, which
 * the SERVICE resolves and threads in, exactly as `ProjectRepoRoomViewDto`
 * carries it for the project room. A mapper that read the environment itself
 * would put a server value inside a function whose output crosses the wire, and
 * a DEFAULTED parameter is a classification one caller away from being silently
 * absent — which is the bug this field exists to fix, arriving through the
 * parameter list instead of the query. `null` is a legitimate ANSWER (a
 * deployment with no `GITHUB_FALLBACK_ORG` hosts nothing), never an omission.
 */
export function toOrgRepoOptionDto(row: GithubRepo, hostOwner: string | null): OrgRepoOptionDto {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    fullName: `${row.owner}/${row.name}`,
    defaultBranch: row.defaultBranch,
    provider: row.provider as OrgRepoProviderDto,
    archived: row.archived,
    connectedFromWorkspaceId: row.workspaceId,
    hostedByMotir: isMotirHostedOwner(row.owner, hostOwner),
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
