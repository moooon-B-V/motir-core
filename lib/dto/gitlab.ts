// DTOs for the GitLab integration's settings surface (Story 7.23 · MOTIR-1478).
//
// A GitLab CONNECTION reuses the shared `GithubInstallationDTO` (the connection is
// the `GithubInstallation` entity under `provider: 'gitlab'`, MOTIR-1474), and a
// CONNECTED project reuses `GithubRepoDTO` (a `github_repo` row under the GitLab
// connection). The only GitLab-specific shape is the in-app project PICKER's
// candidate row (Panel 2b) — the honest inverse of GitHub's out-of-app install
// screen: Motir enumerates the user's GitLab projects and marks which are already
// connected. Like the GitHub DTOs, nothing here carries a token.

export interface GitlabSelectableProjectDTO {
  /** GitLab's numeric project id, as a string (never do math on it) — the value
   *  the connect action receives; stable across renames. */
  repoId: string;
  /** The project namespace (everything before the last `/` of the full path;
   *  GitLab groups can nest, e.g. `moooon/infra`). */
  owner: string;
  /** The project slug (the last path segment). */
  name: string;
  /** The project's default branch. */
  defaultBranch: string;
  /** True when this project is already connected in the workspace — the picker
   *  shows a neutral "Connected" chip in place of the Connect affordance. */
  connected: boolean;
}
