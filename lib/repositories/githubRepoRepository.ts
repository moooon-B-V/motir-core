import { type GithubInstallation, type GithubRepo, type Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// GitHub-repo repository — single Prisma operations on the `github_repo` table
// (Story 7.10 · MOTIR-891). `installationId` here is the INTERNAL
// GithubInstallation.id (a cuid), never GitHub's numeric installation id.

export interface UpsertGithubRepoInput {
  installationId: string;
  /** WHOSE this repo is (MOTIR-1931) — the row's own tenancy, not the parent
   *  installation's. Required on every write: Motir's shared provisioning
   *  installation holds several tenants' repos, so the installation cannot
   *  answer this. */
  workspaceId: string;
  /** WHOSE this repository is at the tier that OWNS it (Story MOTIR-4669 ·
   *  MOTIR-4649). A repository is connected once, to the organisation; the
   *  workspace above is the tier it was connected FROM.
   *
   *  REQUIRED on every write, deliberately, even though the column is nullable:
   *  the column is nullable for the DEPLOY WINDOW (an old build must still be
   *  able to insert while the migration is applied), and making the input
   *  required is what guarantees the NEW build never writes a null. A caller with
   *  no organisation in hand has to go and read one, which is the point. */
  organizationId: string;
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** Whether the repository is ARCHIVED on the host (MOTIR-1959) — read-only, so
   *  no branch or PR can be opened against it. Omit to leave the column at its
   *  `false` default on create; every write path that has the host's own value
   *  passes it, so a re-selection RE-STAMPS liveness the same way it re-stamps
   *  the coordinates. */
  archived?: boolean;
  /** Provider discriminator for the row — omit for GitHub (the column default),
   *  pass `'gitlab'` when persisting a GitLab project selection (MOTIR-1478). */
  provider?: string;
}

export const githubRepoRepository = {
  /** The repos selected on an installation, stable-ordered for display. Runs
   *  inside a context transaction, so it takes `tx`. */
  async listByInstallation(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { installationId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** Every repo connected under ANY of a workspace's installations, stable-ordered
   *  (Story 7.9 · MOTIR-1804) — the workspace's connected repo SET as one read,
   *  the validation domain + default source for a work item's `targetRepo`.
   *  DELIBERATELY provider-agnostic (unlike `resolveCodeContext`, which reads the
   *  GitHub installation only): the CLI routes on a CHECKOUT, and a GitLab-connected
   *  repo is checked out exactly like a GitHub one, so narrowing by provider here
   *  would reject a legitimate pin. Read inside a context transaction (the
   *  `github_repo` RLS policy is workspace-keyed), so it takes `tx`. Empty when
   *  the workspace has no connected or created repo at all.
   *
   *  Filters on the repo's OWN `workspace_id` (MOTIR-1931), not on a join through
   *  the installation: a repo Motir CREATES for this workspace sits behind the
   *  shared provisioning installation, which is bound to no workspace at all — the
   *  old join dropped every such repo from the set, so a created repo was not a
   *  legal `targetRepo` and no agent could be told to build in it. */
  async listByWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { workspaceId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** Record the default branch's CURRENT head, as the push webhook saw it
   *  (Story MOTIR-4669 · MOTIR-4724). Half of "is the graph behind the code".
   *
   *  ⚠️ KEYED ON THE REPO ROW'S OWN id, not on `(installation_id, repo_id)`. The
   *  first cut took that pair and was handed the PROVIDER's installation id,
   *  because that is what the webhook has in scope — while `github_repo
   *  .installation_id` is the internal FK. It matched nothing and wrote nothing,
   *  silently, and only an end-to-end read of the derived state caught it. One
   *  id, already resolved by the caller, cannot be the wrong one.
   *
   *  Returns the update count; 0 means the row was gone by the time the delivery
   *  landed, which is an honest outcome rather than an error. */
  async setDefaultBranchHeadSha(
    id: string,
    headSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.updateMany({
      where: { id },
      data: { defaultBranchHeadSha: headSha },
    });
    return result.count;
  },

  /** Claim a repository as INDEXING, stamping the run that owns it and the head
   *  it is being indexed AT (MOTIR-4724).
   *
   *  ⚠️ The head is stamped at START, not at finish, and the direction of that
   *  imprecision is the point: a push landing mid-run leaves the stored value
   *  behind and the repository reads `stale`. Stamping at finish would read
   *  `indexed` for a graph that had already missed a commit. */
  async markIndexStarted(
    repoRef: string,
    runId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name },
      data: { indexingRunId: runId },
    });
    return result.count;
  },

  /** Settle a finished index: record what it indexed and release the claim.
   *  `headSha` is the head observed when the run STARTED (see above); a run that
   *  failed passes none, so the row keeps whatever it last successfully indexed
   *  and only the in-flight claim is cleared. */
  async markIndexSettled(
    repoRef: string,
    args: { headSha?: string | null; indexedAt?: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name },
      data: {
        indexingRunId: null,
        ...(args.headSha
          ? { indexedHeadSha: args.headSha, indexedAt: args.indexedAt ?? new Date() }
          : {}),
      },
    });
    return result.count;
  },

  /** One repo by its INTERNAL id — the lookup a link write does after a picker
   *  hands back an id it read from `listByOrganization` (MOTIR-4678). Returns
   *  null when the id names nothing the current RLS context admits, which is the
   *  same answer a foreign organisation's id gives: the caller must not be able
   *  to tell a real id in another org from a fictional one. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<GithubRepo | null> {
    return tx.githubRepo.findUnique({ where: { id } });
  },

  /** THE ORGANISATION'S whole repository inventory (Story MOTIR-4669 · MOTIR-4678)
   *  — every repo connected to `organizationId`, ACROSS every workspace of that
   *  org. This is the read the `Add repository` picker's first segment is built
   *  from, and the reason it is keyed on the organisation rather than the
   *  workspace is the story's whole claim: a repository is connected once, to the
   *  org, and which projects use it is visibility configuration.
   *
   *  ⚠️ IT MUST RUN UNDER A TRANSACTION THAT HAS BOUND `app.organization_id`.
   *  `github_repo`'s shipped `FOR ALL` policy is workspace-keyed, so a plain
   *  `withWorkspaceContext` sees only the caller's own workspace and this read
   *  silently returns a SUBSET — which would look like a short picker rather
   *  than a bug. MOTIR-4677 added `github_repo_org_read` (`FOR SELECT`) for
   *  exactly this, and `bindOrganizationContext` is what turns it on. */
  async listByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { organizationId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** Every connected repo WITH its parent installation, optionally narrowed to one
   *  workspace (MOTIR-1961) — the operator first-index sweep's one read. The
   *  installation is included because the enqueue payload needs the PROVIDER's
   *  installation id (`GithubInstallation.installationId`, the token-minting key),
   *  which the repo row holds only as the internal FK. Cross-workspace by design:
   *  the never-indexed-repo defect is not one tenant's, so the sweep's default
   *  domain is every affected tenant — the caller narrows with `workspaceId` and
   *  MUST run under `withSystemContext` when it does not (the `github_repo` RLS
   *  policy is workspace-keyed). Stable-ordered so the sweep's report is diffable. */
  async listWithInstallation(
    tx: Prisma.TransactionClient,
    opts: { workspaceId?: string } = {},
  ): Promise<(GithubRepo & { installation: GithubInstallation })[]> {
    return tx.githubRepo.findMany({
      where: opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
      include: { installation: true },
      orderBy: [{ workspaceId: 'asc' }, { owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** One selected repo by its `(installation_id, repo_id)` pair — the webhook's
   *  lookup from a normalized change request's `providerRepoId` (GitHub's numeric
   *  repo id) to the internal `GithubRepo.id` the PR row FKs against. Null when
   *  the repo isn't selected on this installation. */
  async findByInstallationAndRepoId(
    installationId: string,
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo | null> {
    return tx.githubRepo.findUnique({
      where: { installationId_repoId: { installationId, repoId } },
    });
  },

  /** Create-or-refresh one selected repo, keyed on the unique
   *  `(installation_id, repo_id)` pair. `provider` defaults to the column default
   *  (`'github'`) when omitted; a GitLab project selection passes `'gitlab'`
   *  (MOTIR-1478). A `provider: undefined` is a Prisma no-op on both create (the
   *  `@default` applies) and update (the field is left untouched). */
  async upsert(input: UpsertGithubRepoInput, tx: Prisma.TransactionClient): Promise<GithubRepo> {
    const { installationId, repoId, ...rest } = input;
    // `rest` carries `workspaceId`, so a re-selection re-stamps the owning tenant
    // as well as the coordinates — the row's tenancy is refreshed, never inherited
    // from whatever wrote it first.
    return tx.githubRepo.upsert({
      where: { installationId_repoId: { installationId, repoId } },
      create: { installationId, repoId, ...rest },
      update: rest,
    });
  },

  /**
   * Re-stamp a mirror row's COORDINATES after the repository moved on the host —
   * the takeover's mirror update (MOTIR-711), driven by the `repository`
   * `transferred` delivery.
   *
   * ⚠️ THIS WRITE IS WHAT MAKES TWO OTHER GUARANTEES FALL OUT FOR FREE, and
   * neither has any code of its own:
   *
   *   * the CI-Actions pause fan-out re-checks `githubRepo.owner` against the
   *     provisioning org at call time (`ciActionsGateService`'s `assertPending`),
   *     so a transferred row silently leaves the sweep — nobody has to remember to
   *     exclude it;
   *   * the CI meter gates on the RUN's own repository owner rather than on this
   *     mirror (`ci-minutes-allowance.md` §5.5), so metering already stops at the
   *     transfer whether or not this row has caught up yet. Updating it keeps the
   *     mirror honest; it is not what stops the billing.
   *
   * `updateMany` (not `update`) so a webhook REDELIVERY after the row is gone is
   * an idempotent no-op (count 0) rather than a `P2025` throw. Returns the count.
   */
  async updateOwnerByRepoId(
    repoId: string,
    data: { owner: string; name: string; defaultBranch?: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.updateMany({ where: { repoId }, data });
    return result.count;
  },

  /**
   * Re-stamp a mirror row's ARCHIVED state after the repository was archived (or
   * un-archived) on the host — the `repository` `archived` / `unarchived`
   * delivery's write (MOTIR-1959).
   *
   * This is what keeps the recorded liveness TRUE rather than merely INITIAL. The
   * establish/connect paths stamp `archived` at the moment they mirror the repo,
   * and the incident MOTIR-1956 recorded is precisely a repository archived a
   * month AFTER that: without this write, a set established while the repo was
   * live would keep dispatching against it forever.
   *
   * `updateMany` (not `update`) for the same reason {@link updateOwnerByRepoId}
   * uses it: a webhook REDELIVERY after the row is gone must be an idempotent
   * no-op (count 0), never a `P2025` throw that makes GitHub retry a delivery no
   * retry can fix. Returns the count.
   */
  async setArchivedByRepoId(
    repoId: string,
    archived: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.updateMany({ where: { repoId }, data: { archived } });
    return result.count;
  },

  /** Remove ONE selected repo by its `(installation_id, repo_id)` pair — the
   *  in-app "disconnect this project" write (MOTIR-1478, the GitLab settings
   *  surface). `deleteMany` (not `delete`) so a double-submit / redelivery after
   *  the row is gone is an idempotent no-op (count 0) rather than a `P2025`
   *  throw. Its `github_pull_request` rows cascade with it. Returns the count. */
  async deleteByInstallationAndRepoId(
    installationId: string,
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.deleteMany({ where: { installationId, repoId } });
    return result.count;
  },

  /** One connected repo by `(owner, name)` within a WORKSPACE — the code-scanning
   *  proxy's resolution (MOTIR-1605) from an audit `repoRef` to the tenant's
   *  installation. Owner/name match case-insensitively (GitHub coordinates are
   *  case-insensitive). The filter is the repo's OWN `workspace_id` (MOTIR-1931),
   *  which scopes the lookup to the caller's own workspace (defense-in-depth
   *  alongside the `withWorkspaceContext` RLS gate on `github_repo`) — another
   *  tenant's repo can never resolve, and a repo Motir CREATED for this workspace
   *  now DOES (the old join through the installation missed it, because the shared
   *  provisioning installation belongs to no workspace). Includes the parent
   *  installation (its provider + numeric `installationId` drive the token mint).
   *  Null when the repo isn't connected in this workspace. Read inside a context
   *  transaction, so it takes `tx`. */
  async findConnectedByWorkspaceAndName(
    workspaceId: string,
    owner: string,
    name: string,
    tx: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation }) | null> {
    return tx.githubRepo.findFirst({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        name: { equals: name, mode: 'insensitive' },
        workspaceId,
      },
      include: { installation: true },
    });
  },

  /** Resolve a connected repo GLOBALLY by `(owner, name)` — the keyless-OIDC
   *  trust seam (MOTIR-1650). A GitHub Actions OIDC token's `repository` claim
   *  (`owner/name`) DETERMINES the tenant, so this read runs OUTSIDE any
   *  workspace context (like the webhook keying on GitHub's global installation
   *  id), on the `db` singleton. Case-insensitive (GitHub coordinates are).
   *  Returns EVERY match so the caller can reject an AMBIGUOUS coordinate (the
   *  same repo connected under two workspaces) rather than silently pick one —
   *  it never scopes to a workspace because the caller has none yet. Read-only →
   *  no `tx`. Includes the parent installation (its provider drives the token
   *  mint); the TENANT is the row's own `workspaceId` (MOTIR-1931), never the
   *  installation's — under one shared provisioning org a coordinate is globally
   *  unique, so the ambiguity guard below could never fire for a hosted repo and
   *  reading the tenant off the installation would have authenticated an Actions
   *  run into whichever workspace held the shared row. */
  async findConnectedByName(
    owner: string,
    name: string,
    tx?: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation })[]> {
    const client = tx ?? dbRead;
    return client.githubRepo.findMany({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        name: { equals: name, mode: 'insensitive' },
      },
      include: { installation: true },
    });
  },

  /** Resolve a connected repo by its host repo id under a given PROVIDER (Story
   *  7.23 · MOTIR-1475) — the GitLab webhook's key. A GitLab MR/pipeline delivery
   *  carries the project id but NO Motir connection id (unlike GitHub's App
   *  delivery, which carries its global installation id), so the webhook resolves
   *  the connection through the repo: match `(repo_id, installation.provider)` and
   *  include the parent installation (its workspace + provider drive the sync).
   *  Runs OUTSIDE any workspace context (the webhook has no active workspace, like
   *  the GitHub path keying on the global installation id), inside the sync's
   *  system-context transaction, so it takes `tx`. A host project id is unique per
   *  GitLab instance; the oldest-connected row wins if the same project is somehow
   *  connected twice. Null when the project isn't connected. */
  async findByRepoIdAndProvider(
    repoId: string,
    provider: string,
    tx: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation }) | null> {
    return tx.githubRepo.findFirst({
      where: { repoId, installation: { is: { provider } } },
      include: { installation: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Reconcile the selected set: delete every repo on this installation whose
   *  `repo_id` is NOT in `keepRepoIds` (a de-selected repo). An empty keep set
   *  deletes them all (`NOT IN ()` is always true). Returns the delete count.
   *
   *  ONLY correct for a workspace's OWN installation, where one reconcile sees
   *  that workspace's whole selection. It is NEVER reachable for Motir's shared
   *  provisioning installation (MOTIR-1931): its only caller is
   *  `githubInstallationService.persistInstallation`, which requires a
   *  `workspaceId: string`, and a shared installation's `workspaceId` is NULL —
   *  so the call cannot be formed. That is a reachability property, not a
   *  caution: there is no flag to forget to check. */
  async deleteExcept(
    installationId: string,
    keepRepoIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.deleteMany({
      where: { installationId, NOT: { repoId: { in: keepRepoIds } } },
    });
    return result.count;
  },

  /**
   * The DISTINCT workspaces holding at least one repository owned by `owner` —
   * the entry point for any org-wide fan-out over Motir-hosted repos
   * (MOTIR-1907).
   *
   * ⚠️ THIS EXISTS BECAUSE "the org's workspaces" IS NOT READABLE FROM A
   * BACKGROUND PATH. `workspaceRepository.listByOrganization` looks like the
   * natural read and is NOT reachable here: `workspace`'s RLS admits a row only
   * via `id = app.workspace_id` or the caller's OWN memberships, with **no
   * `app.system_admin` escape** — so both of its shipped callers run under
   * `withOrgContext({ userId, … })`, a cookie-session surface. The CI-Actions gate
   * fires from metering and from a sweep, where there is no user at all.
   *
   * `github_repo` is the way in: it carries `workspace_id` directly (MOTIR-1931)
   * and its policy DOES have the system escape the webhook path already relies
   * on. So the traversal runs mirror → workspace → org, one workspace at a time,
   * binding each workspace's own GUC — the same direction `ciMinutesMeterService`
   * §5.2 takes, and entirely within shipped policy. Widening `workspace`'s RLS
   * instead would be a cross-tenant access change, which is not this card's to
   * make.
   *
   * Compared case-INSENSITIVELY: GitHub logins are case-insensitive and the
   * mirror echoes the payload's casing, which an operator's `GITHUB_FALLBACK_ORG`
   * need not match — the same comparison `isMotirOwnedRepo` makes.
   */
  async listWorkspaceIdsByOwner(
    owner: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ workspaceId: string }>> {
    return tx.$queryRaw<Array<{ workspaceId: string }>>`
      SELECT DISTINCT "workspace_id" AS "workspaceId"
      FROM "github_repo"
      WHERE lower("owner") = lower(${owner})
    `;
  },
};

/** `owner/name` → its two halves. A ref without a slash names no repository, and
 *  the callers above turn that into a zero-row no-op rather than a wildcard
 *  update — a `where` built from a half-parsed ref is how one repo's write
 *  reaches another's row. */
function splitRepoRef(repoRef: string): [string, string] | [null, null] {
  const cut = repoRef.lastIndexOf('/');
  if (cut <= 0 || cut === repoRef.length - 1) return [null, null];
  return [repoRef.slice(0, cut), repoRef.slice(cut + 1)];
}
