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
  /** The identifiers (`MOTIR-<n>`) of every work item this pull request already
   *  DELIVERS, oldest link first — the neutral chip in the option's trailing slot
   *  (MOTIR-3756, ADR `docs/decisions/delivery-reader-migration.md` §3).
   *
   *  A SET rather than the one item a singular FK named, because one pull request
   *  delivering several cards is the ordinary shape of a `motir auto` run. The
   *  renderer reads its LENGTH: empty → the PR-state pill; exactly one → the
   *  unchanged "Linked to {key}" copy; two or more → "Delivers {count} work
   *  items". Candidates already delivering the CURRENT item are dropped by the
   *  service, so no member is ever the item being edited.
   *
   *  ⚠️ The chip is INFORMATION, not a takeover warning: picking a candidate ADDS
   *  a delivery row (`work_item_delivery`), it does not move an existing one. */
  linkedTo: string[];
}

/**
 * ONE MEMBER of a work item's DELIVERY SET (Story MOTIR-3655 · MOTIR-3697, ADR
 * `docs/decisions/work-item-delivery-links.md`) — one pull request that delivers
 * this card, with everything a reader needs to say whether it has ARRIVED.
 *
 * ── Why the pull request is NESTED rather than flattened ───────────────────
 * `pullRequest` is the SAME {@link LinkedPullRequestDto} the Development surface
 * already renders, carried whole. Flattening it would mean a second spelling of
 * `ci` and of the merged/closed collapse on the same pull request, and two
 * spellings of one answer is the defect this whole story is about — one level
 * up, at the schema. So `merged` is `pullRequest.state === 'merged'` and the CI
 * verdict is `pullRequest.ci`; there is no copy of either here.
 *
 * ⚠️ `ci` therefore comes from `derivePrCiState` and from nothing else. It is
 * the one verdict `ciPromotion` reads and the one the Development pill shows, so
 * a lane that watches CI through this DTO cannot drift from what a person sees
 * (MOTIR-3685's own acceptance criterion forbids a second one).
 *
 * ── What the two extra fields are FOR ─────────────────────────────────────
 * `baseRef` and `defaultBranch` exist so a consumer can tell the three shortfall
 * kinds `lib/workItems/deliverySet.ts` computes apart without a second round
 * trip: OUTSTANDING (not merged), STRANDED (merged onto a base that is not its
 * repository's default branch — a merge that delivered nothing to the trunk) and
 * UNKNOWN (merged with no base recorded). The comparison is PER REPOSITORY and
 * never against a hard-coded `'main'`: a self-hoster's trunk is `master` or
 * `trunk`, and a card spanning two repositories may face two different names.
 */
export interface WorkItemDeliveryDto {
  /** The delivering pull request, in the shape every other surface renders it. */
  pullRequest: LinkedPullRequestDto;
  /** That pull request's OWN repository's default branch — the branch a merge
   *  has to reach for the delivery to count. */
  defaultBranch: string;
  /** The branch the pull request TARGETS. Null on a row mirrored before Motir
   *  recorded base branches, which is the UNKNOWN kind: whether the work reached
   *  the trunk cannot be told, and the remedy is an operator backfill rather
   *  than a merge. */
  baseRef: string | null;
}
