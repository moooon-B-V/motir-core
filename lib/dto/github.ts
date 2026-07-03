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
