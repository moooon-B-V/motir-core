import type { GithubIdentity } from '@prisma/client';
import type { GithubIdentityDTO } from '@/lib/dto/github';

// Prisma → DTO conversion for the GitHub integration (Story 7.10 · MOTIR-1498).
// The mapper is the enforcement point for "the token never crosses the API
// boundary": it reads only the safe, displayable columns and structurally
// cannot leak `accessTokenEncrypted` — it's never referenced here.

export function toGithubIdentityDTO(row: GithubIdentity): GithubIdentityDTO {
  return {
    id: row.id,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
  };
}
