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

/**
 * One linked pull request on a work item's "Development" surface (Story 7.10
 * · MOTIR-1579, design/github Panels 3 + 4a + 5a) — rendered on BOTH the
 * quick-view peek and the detail page. Display-ready: the title fallback,
 * merged/closed collapse, per-PR CI derivation, and link-out URL are all
 * resolved server-side so the client stays purely presentational.
 */
export interface LinkedPullRequestDto {
  /** The PR title, falling back to its head branch for rows ingested before
   *  title capture (MOTIR-1579). */
  title: string;
  /** `owner/name` — the pr-meta line's repo half. */
  repo: string;
  number: number;
  /** Display state: `merged` wins over the raw open/closed pair. */
  state: 'open' | 'merged' | 'closed';
  /** Per-PR CI at its latest recorded commit (lib/github/prCiState) — null
   *  renders NO CI pill (absence of CI is not a state). */
  ci: 'passing' | 'failing' | 'running' | null;
  /** The GitHub link-out (`https://github.com/<owner>/<name>/pull/<n>`). */
  url: string;
  /** Provenance (MOTIR-1596): true when the link was set by the explicit item→PR
   *  affordance rather than the MOTIR-892 auto-resolver — the detail row shows the
   *  quiet "linked manually" meta suffix (design/github Panel 5a). */
  linkedManually: boolean;
}

/**
 * One candidate PR for the explicit item→PR link picker (Story 7.10 ·
 * MOTIR-1596, design/github Panel 5b) — a workspace-ingested PR the "+ Link pull
 * request" Combobox offers. `id` is the internal `GithubPullRequest.id` (the
 * link target the Server Action takes).
 */
export interface PullRequestLinkCandidateDto {
  /** Internal `GithubPullRequest.id` — the value the link action receives. */
  id: string;
  /** The PR title, falling back to its head branch (pre-title-capture rows). */
  title: string;
  /** `owner/name` — the option meta line's repo half. */
  repo: string;
  number: number;
  /** Display state: `merged` wins over the raw open/closed pair. */
  state: 'open' | 'merged' | 'closed';
  /** When the PR is already linked to ANOTHER item, that item's identifier
   *  (`MOTIR-<n>`) — the neutral "Linked to {key}" takeover chip; picking it MOVES
   *  the link. Null when the PR is unlinked. */
  linkedTo: string | null;
}
