import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { toLinkedPullRequestDto, toPullRequestLinkCandidateDto } from '@/lib/mappers/githubMappers';
import { GithubNotConnectedError, GithubPullRequestNotFoundError } from '@/lib/github/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { LinkedPullRequestDto, PullRequestLinkCandidateDto } from '@/lib/dto/github';

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
   * when the workspace has no installation (the disconnected banner). An
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
      return githubInstallationRepository.findByWorkspaceId(ctx.workspaceId, tx);
    });
    if (!connected) throw new GithubNotConnectedError();

    if (query.trim().length < QUICK_SEARCH_MIN_QUERY_LENGTH) return [];
    const rows = await githubPullRequestRepository.searchCandidates(
      ctx.workspaceId,
      query,
      PR_CANDIDATE_LIMIT,
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
      if (!pr || pr.repo.installation.workspaceId !== ctx.workspaceId)
        throw new GithubPullRequestNotFoundError(pullRequestId);

      const updated = await githubPullRequestRepository.setWorkItemLink(
        pullRequestId,
        currentItemId,
        tx,
      );
      return toLinkedPullRequestDto(updated);
    });
  },
};
