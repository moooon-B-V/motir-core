// DTOs for the GitHub integration (Story 7.10 · MOTIR-1498). What crosses the
// API boundary for a member's GitHub identity — deliberately WITHOUT the access
// token (encrypted or not): the token never leaves the service layer.

export interface GithubIdentityDTO {
  id: string;
  /** The GitHub numeric user id, as a string (GitHub ids exceed 2^53 headroom
   *  concerns are avoided by never doing math on it). */
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
  createdAt: string;
}

// The installation grant (MOTIR-891) — "Grant 2". What crosses the API boundary
// for a workspace's GitHub App installation + its selected repos. Like the
// identity DTO, it deliberately carries NO token: the installation access token
// is minted on demand and never leaves the service layer.

export interface GithubRepoDTO {
  id: string;
  /** GitHub's numeric repository id, as a string. */
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface GithubInstallationDTO {
  id: string;
  /** Provider discriminator — `'github'` for these rows. */
  provider: string;
  /** GitHub's numeric installation id, as a string. */
  installationId: string;
  accountLogin: string;
  accountType: string;
  repos: GithubRepoDTO[];
  createdAt: string;
}
