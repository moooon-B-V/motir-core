// The comparable IDENTITY of a repository NAME — one definition, because three
// tables write the name and each writes a different form of it.
//
//   * `work_item.targetRepo` / `targetRepos` store the BARE name (`motir-core`),
//     which is what the CLI keys `<root>/<name>` on.
//   * `LinkedChangeRequestCompletionFact.repoName` is `github_repo.name` — bare.
//   * `LinkedPullRequestDto.repo` is `owner/name` (`moooon-B-V/motir-core`) —
//     the form the Development surface prints beside the PR number.
//
// Anything that compares a repository across two of those has to agree on what
// "the same repository" means, and a comparison that guesses is how the
// Development section came to assert "No pull request yet" about a repository
// whose pull request was on the line above it (MOTIR-3036): `owner/name` never
// equals `name`, so the cross-reference silently matched nothing.
//
// Kept in its OWN module rather than in `targetRepo.ts`, where the rule was
// born, because that module value-imports the GitHub repository and a workspace
// context — server code a CLIENT component cannot pull into its bundle. This
// file has no imports at all, so both sides can share the one rule instead of
// each restating it.

/**
 * Normalize a repository name to the bare NAME the column stores.
 *
 * Accepts either the bare name (`motir-core`) or the `owner/name` ref form
 * (`moooon/motir-core`) — the latter is what `resolveCodeContext` and the GitHub
 * surfaces display, so an agent that copies a repo from there gets the same
 * result as one that types the short name. A blank / whitespace-only string
 * normalizes to `null` (an explicit clear), so a caller never has to distinguish
 * "" from null.
 */
export function normalizeRepoName(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const slash = trimmed.lastIndexOf('/');
  const name = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  return name.length === 0 ? null : name;
}

/**
 * The case-folded key two repository names are EQUAL on — `null` for a value
 * that names no repository at all.
 *
 * Case-insensitive for the same reason `matchAuthoredTargetRepo` is: git hosts
 * treat repository names case-insensitively, and two spellings that differ only
 * in case name one checkout. `null` is returned rather than `''` so a caller
 * comparing two absent names never concludes they are the same repository.
 */
export function repoNameKey(value: string | null | undefined): string | null {
  return normalizeRepoName(value)?.toLowerCase() ?? null;
}
