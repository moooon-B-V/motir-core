import { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { toLinkedPullRequestDto, toPullRequestLinkCandidateDto } from '@/lib/mappers/githubMappers';
import {
  GithubNotConnectedError,
  GithubPullRequestNotFoundError,
  GithubRepoNotFoundError,
} from '@/lib/github/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { LinkedPullRequestDto, PullRequestLinkCandidateDto } from '@/lib/dto/github';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Explicit item→PR link (Story 7.10 · MOTIR-1596, design/github Panel 5) — the
// MANUAL override of the MOTIR-892 auto-resolver. Two operations back the
// detail-page "+ Link pull request" affordance:
//   * searchLinkCandidates — the query-driven picker's server search over the
//     workspace's ingested PRs (installation → repo → PR), annotating any PR
//     already linked elsewhere (the takeover chip).
//   * linkPullRequest — set the picked PR's `workItemId` (a re-link/takeover is
//     allowed, no confirm; the repo write also stamps `linkedManually`, which
//     keeps the link sticky against the webhook resolver — see
//     githubWebhookService.handlePullRequest).
// 4-layer: this owns the workspace validation + the one transaction and returns
// DTOs; the Server Action is transport-only.

/** Picker candidate cap — a bounded, keystroke-driven read (mirrors the issue
 *  link picker's quick-search window). */
const PR_CANDIDATE_LIMIT = 10;

export const githubPullRequestService = {
  /**
   * Candidate PRs for the explicit-link picker, server-searched by `query`
   * (title / repo owner+name / number) — the detail-page Combobox fetches this
   * per debounced keystroke. Gates the current item to the caller's workspace
   * (cross-workspace / missing → 404). Throws {@link GithubNotConnectedError}
   * when the workspace has no connected or created REPO (the disconnected
   * banner) — asked of the repo rows, not of the installation (MOTIR-1931): a
   * project whose repos Motir CREATED has no installation of its own, and
   * asking the old question would have made this picker permanently
   * "not connected" for it. An
   * empty/short query returns `[]` (the picker prompts "type to search"). PRs
   * already linked to the CURRENT item are dropped (they're already shown);
   * a PR linked to ANOTHER item is kept with its `linkedTo` takeover chip.
   */
  async searchLinkCandidates(
    currentItemId: string,
    query: string,
    ctx: ServiceContext,
  ): Promise<PullRequestLinkCandidateDto[]> {
    // Tenant gate + connectivity, both under workspace context so the work_item
    // RLS policy scopes the read (a cross-workspace id then reads as absent).
    const connected = await withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(currentItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(currentItemId);
      return githubRepoRepository.listByWorkspace(ctx.workspaceId, tx);
    });
    if (connected.length === 0) throw new GithubNotConnectedError();

    if (query.trim().length < QUICK_SEARCH_MIN_QUERY_LENGTH) return [];
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      githubPullRequestRepository.searchCandidates(ctx.workspaceId, query, PR_CANDIDATE_LIMIT, tx),
    );
    return rows
      .filter((row) => row.workItemId !== currentItemId)
      .map(toPullRequestLinkCandidateDto);
  },

  /**
   * Link an ingested PR to the current item — the explicit override that sets
   * `GithubPullRequest.workItemId` (+ `linkedManually`). Gates the current item
   * AND the PR to the caller's workspace in ONE transaction (a cross-workspace or
   * unknown PR → {@link GithubPullRequestNotFoundError}, no existence leak). A
   * re-link (takeover from another item) is allowed with no confirm — the single
   * FK moves. Returns the linked-row DTO for the caller to reflect optimistically.
   */
  async linkPullRequest(
    currentItemId: string,
    pullRequestId: string,
    ctx: ServiceContext,
  ): Promise<LinkedPullRequestDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(currentItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(currentItemId);

      const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
      // The REPO row is the tenant (MOTIR-1931), not its installation. A `!==`
      // against a now-nullable column still compiles, so the compiler could not
      // name this site the way it named the other ten — but the behaviour is the
      // same class: for a repo behind Motir's shared provisioning installation
      // `installation.workspaceId` is NULL, so this gate rejected every hosted
      // repo's PR (fail-CLOSED, so never a leak — but the explicit item→PR link
      // affordance would have been permanently broken for created repos).
      if (!pr || pr.repo.workspaceId !== ctx.workspaceId)
        throw new GithubPullRequestNotFoundError(pullRequestId);

      const updated = await githubPullRequestRepository.setWorkItemLink(
        pullRequestId,
        currentItemId,
        tx,
      );
      return toLinkedPullRequestDto(updated);
    });
  },

  /**
   * Link a pull request to a work item by its GITHUB COORDINATES —
   * `(owner/name, number)` — creating the row when no webhook delivery has
   * arrived yet (Story MOTIR-3525 · Subtask MOTIR-3526).
   *
   * ── Why this is not {@link linkPullRequest} with a different lookup ────────
   * The picker resolves an INGESTED pull request by Motir's internal cuid, which
   * is a reasonable thing to ask of a person reading a list. It is the wrong
   * question for the actor this path is for. An agent that has just run
   * `gh pr create` is the FIRST party to know the pull request exists — ahead of
   * GitHub's own webhook — and it addresses it the way the world does, by
   * repository and number. So the row may not be there yet, and requiring it to
   * be there would make the link impossible in exactly the moment it is certain.
   *
   * ── The division of authority ─────────────────────────────────────────────
   * The caller is authoritative about the LINK and about nothing else; the
   * webhook is authoritative about STATE and about nothing else. `linkedManually`
   * is the boundary between those two claims and already exists, which is what
   * turns a race into a handshake: `syncChangeRequestStatus` short-circuits its
   * branch/title parse on a `linkedManually` row, so every later delivery
   * refreshes `state` / `merged` / `headRef` / `baseRef` / `title` and leaves
   * `work_item_id` alone.
   *
   * That is why the two arms below are asymmetric, and the asymmetry is the
   * whole behaviour rather than an optimisation:
   *
   *  · **No row yet** — write one from what the caller truthfully knows at that
   *    moment (`state: 'open'`, `merged: false`, plus the refs and title it was
   *    given) AND the link.
   *  · **A row already** — touch ONLY the link. The caller's `open` / `false` are
   *    stale guesses about a row the webhook has already spoken for, and writing
   *    them would re-open a merged pull request.
   *
   * ── Tenancy ───────────────────────────────────────────────────────────────
   * The repository is resolved from the REPO ROW's own `workspace_id`
   * (MOTIR-1931), never through its installation — under Motir's shared
   * provisioning installation the installation names no workspace, so the older
   * join would have made this permanently not-found for every repository Motir
   * created. An unknown or cross-workspace repository and an unknown item both
   * raise their typed not-found, so neither leaks existence.
   *
   * ⚠️ The FK is SINGULAR: a call naming a different work item MOVES the link
   * rather than adding one. `movedFrom` carries the identifier it was taken
   * from so a caller can say so rather than report an addition.
   */
  async linkPullRequestByCoordinates(
    input: {
      /** The work item to link — already resolved and known to the caller. */
      workItemId: string;
      /** Its project, for the permission assertion. */
      projectId: string;
      owner: string;
      name: string;
      number: number;
      /** The branch the pull request is FROM, as the caller knows it. */
      headRef: string;
      /** The branch it TARGETS, as the caller knows it. */
      baseRef: string;
      title: string | null;
    },
    ctx: ServiceContext,
  ): Promise<{ link: LinkedPullRequestDto; created: boolean; movedFrom: string | null }> {
    // The key this tool DECLARES, asserted where the write happens rather than
    // left to the MCP permission gate alone: the gate says what the TOKEN may
    // reach, this says what its owner may do to this project. Runs BEFORE the
    // transaction so a refusal costs no row lock.
    await projectAccessService.assertPermission(input.projectId, ctx, 'work_item:edit');

    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(input.workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(input.workItemId);

      const repo = await githubRepoRepository.findConnectedByWorkspaceAndName(
        ctx.workspaceId,
        input.owner,
        input.name,
        tx,
      );
      if (!repo) throw new GithubRepoNotFoundError(`${input.owner}/${input.name}`);

      // Lock BEFORE reading, because what is written next is DERIVED from what
      // is read (the lock-before-read-derived-update rule): a concurrent webhook
      // delivery deciding whether to preserve a manual link must serialize
      // against this. A no-op when the row does not exist yet — the upsert's
      // P2002 catch is what converges that case.
      await githubPullRequestRepository.lockByRepoAndNumber(repo.id, input.number, tx);
      const existing = await githubPullRequestRepository.findByRepoAndNumber(
        repo.id,
        input.number,
        tx,
      );

      let prId: string;
      if (existing) {
        prId = existing.id;
      } else {
        const row = {
          // ⚠️ THE REPO ROW's discriminator, never `repo.installation.provider`
          // — MOTIR-1931's rule one layer deeper than it is usually met. The
          // repo row resolves here because it carries its own `workspace_id`;
          // its INSTALLATION does not, because under Motir's shared
          // provisioning install that row's `workspace_id` is NULL and
          // `github_installation` is policy-gated, so the join comes back null
          // inside a workspace-bound transaction. Prisma types the include as
          // present, so this is a runtime null the compiler cannot name — the
          // suite is what names it.
          provider: repo.provider,
          repoId: repo.id,
          number: input.number,
          // What the caller can truthfully assert about a pull request it just
          // opened. Every one of these is REPLACED by the first delivery.
          state: 'open',
          merged: false,
          headRef: input.headRef,
          baseRef: input.baseRef,
          title: input.title,
          workItemId: input.workItemId,
          linkedManually: true,
        };
        try {
          prId = (await githubPullRequestRepository.upsert(row, tx)).id;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // Converge on a lost `(repo_id, number)` race exactly as
          // `syncChangeRequestStatus` does: the winner wrote the same row, so
          // re-write to reflect this call and carry on.
          prId = (await githubPullRequestRepository.upsert(row, tx)).id;
        }
      }

      const previousWorkItemId = existing?.workItemId ?? null;
      // ONE write for both arms, and it is the narrow one: `setWorkItemLink`
      // touches `work_item_id` + `linked_manually` and nothing else, so the
      // already-ingested case cannot clobber a delivery's state fields.
      const updated = await githubPullRequestRepository.setWorkItemLink(prId, input.workItemId, tx);

      let movedFrom: string | null = null;
      if (previousWorkItemId && previousWorkItemId !== input.workItemId) {
        const previous = await workItemRepository.findById(previousWorkItemId, tx);
        movedFrom = previous?.identifier ?? null;
      }

      return { link: toLinkedPullRequestDto(updated), created: existing === null, movedFrom };
    });
  },
};

/** A lost unique-constraint race, spelled the same way `changeRequestStatusSync`
 *  spells it — the two converge on the same `(repo_id, number)` pair. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
