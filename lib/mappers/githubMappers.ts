import type { GithubIdentity, GithubInstallation, GithubRepo } from '@prisma/client';
import type { GithubIdentityDTO, GithubInstallationDTO, GithubRepoDTO } from '@/lib/dto/github';

// Prisma → DTO conversion for the GitHub integration (Story 7.10 · MOTIR-1498 /
// MOTIR-891). The mapper is the enforcement point for "no secret crosses the API
// boundary": for the identity it structurally cannot leak `accessTokenEncrypted`
// (never referenced), and the installation DTO carries NO access token at all
// (the installation token is minted on demand, never stored).

export function toGithubIdentityDTO(row: GithubIdentity): GithubIdentityDTO {
  return {
    id: row.id,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toGithubRepoDTO(row: GithubRepo): GithubRepoDTO {
  return {
    id: row.id,
    repoId: row.repoId,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
  };
}

export function toGithubInstallationDTO(
  installation: GithubInstallation,
  repos: GithubRepo[],
): GithubInstallationDTO {
  return {
    id: installation.id,
    provider: installation.provider,
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repos: repos.map(toGithubRepoDTO),
    createdAt: installation.createdAt.toISOString(),
  };
}
