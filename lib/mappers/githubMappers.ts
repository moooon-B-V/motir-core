import type { GithubIdentity, GithubInstallation, GithubRepo } from '@prisma/client';
import type {
  GithubIdentityDTO,
  GithubInstallationDTO,
  GithubRepoDTO,
  LinkedPullRequestDto,
} from '@/lib/dto/github';
import type { GithubPullRequestWithContext } from '@/lib/repositories/githubPullRequestRepository';
import { derivePrCiState } from '@/lib/github/prCiState';

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

/**
 * A linked PR row → the Development surface's display-ready shape (Story 7.10
 * · MOTIR-1579): title falls back to the head branch (pre-capture rows carry
 * no title), `merged` collapses the raw open/closed pair, the per-PR CI state
 * derives from the check rows at the latest recorded commit, and the link-out
 * URL is composed here so the client never string-builds it.
 */
export function toLinkedPullRequestDto(row: GithubPullRequestWithContext): LinkedPullRequestDto {
  return {
    title: row.title ?? row.headRef,
    repo: `${row.repo.owner}/${row.repo.name}`,
    number: row.number,
    state: row.merged ? 'merged' : row.state === 'open' ? 'open' : 'closed',
    ci: derivePrCiState(row.checkRuns),
    url: `https://github.com/${row.repo.owner}/${row.repo.name}/pull/${row.number}`,
  };
}
