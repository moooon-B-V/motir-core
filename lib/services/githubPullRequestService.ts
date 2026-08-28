import { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { refreshLinkCheckForPullRequest } from './pullRequestLinkCheckService';
import { resyncLinkedPullRequest } from './changeRequestStatusSync';
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
   * empty/short query returns `[]` (the picker prompts "type to search").
   *
   * ⚠️ THE SELF-EXCLUSION IS A **CONTAINS** TEST, over the DELIVERY SET
   * (MOTIR-3756, ADR `docs/decisions/delivery-reader-migration.md` §3). It used to
   * be `row.workItemId !== currentItemId` — scalar inequality against the one item
   * the FK named — which dropped a candidate only when the current item happened to
   * be the item that column pointed at. A pull request DELIVERING the current item
   * alongside three others named at most one of them, so the picker offered the
   * page's own pull request back to it as a fresh candidate. The question is
   * unchanged in words and now true in fact: *does this pull request already
   * deliver me?*
   *
   * It is deliberately the same predicate as the subsumption advisory's
   * (`proseGraphAdvisoryService`), and the two are written to agree: both ask
   * whether an id is IN a delivery set, neither asks whether a set is exactly one
   * id.
   *
   * A candidate that survives carries `linkedTo` — every card it already delivers,
   * oldest link first. The chip the picker renders from it is INFORMATION rather
   * than a takeover warning: picking a candidate ADDS a delivery row.
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
    // ONE transaction for both reads: the delivery table's only tenant gate is an
    // RLS policy on `app.workspace_id`, so a read outside the bound context comes
    // back EMPTY rather than raising — every candidate would then look unlinked.
    const { rows, deliveredBy } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const found = await githubPullRequestRepository.searchCandidates(
        ctx.workspaceId,
        query,
        PR_CANDIDATE_LIMIT,
        tx,
      );
      // ONE batched read for all ten candidates, not one per row.
      const deliveries = await workItemDeliveryRepository.listByPullRequests(
        found.map((row) => row.id),
        tx,
      );
      const byPr = new Map<string, string[]>();
      for (const d of deliveries) {
        const ids = byPr.get(d.githubPullRequestId);
        if (ids) ids.push(d.workItemId);
        else byPr.set(d.githubPullRequestId, [d.workItemId]);
      }
      // Identifiers are resolved separately and TOLERANTLY, the same shape
      // `resolveDeliveredWorkItems` uses: a delivery whose target this tenant
      // context cannot see must shorten the chip's count, never fabricate an
      // item. The `Map` preserves the read's (pull request, link age) order.
      const targets = await workItemRepository.findByIds(
        [...new Set(deliveries.map((d) => d.workItemId))],
        tx,
      );
      const identifierById = new Map(targets.map((t) => [t.id, t.identifier]));
      return { rows: found, deliveredBy: { byPr, identifierById } };
    });

    return rows
      .filter((row) => !(deliveredBy.byPr.get(row.id) ?? []).includes(currentItemId))
      .map((row) =>
        toPullRequestLinkCandidateDto(
          row,
          (deliveredBy.byPr.get(row.id) ?? []).flatMap((id) => {
            const identifier = deliveredBy.identifierById.get(id);
            return identifier ? [identifier] : [];
          }),
        ),
      );
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

      // The DECLARED-not-inferred stamp. It no longer records a link — the FK it
      // qualified is gone (MOTIR-3757) — and it is written for its own sake, so
      // that the surviving `linked_manually` column keeps meaning the same thing
      // for a row written today as for one written before the drop. The re-read
      // it returns is what the DTO is built from.
      const updated = await githubPullRequestRepository.markLinkedManually(pullRequestId, tx);
      // THE LINK (Story MOTIR-3655 · MOTIR-3658, ADR
      // `docs/decisions/work-item-delivery-links.md`), and since MOTIR-3757 the
      // ONLY one: a pull request's association with a work item is a row in this
      // table and lives nowhere else.
      //
      // It is a SET, which is the shape the retired column could never express:
      // a re-link ADDS rather than moving, because one pull request delivering
      // several cards is a real thing (a `motir auto` run is exactly it). Taking
      // an association back is `unlinkPullRequest`, not a side effect of linking
      // somewhere else.
      await workItemDeliveryRepository.add(
        {
          workspaceId: ctx.workspaceId,
          workItemId: currentItemId,
          githubPullRequestId: pullRequestId,
          repoId: pr.repoId,
        },
        tx,
      );
      return toLinkedPullRequestDto(updated);
    }).then(async (dto) => {
      // MOTIR-3675 — turn the unlinked-pull-request check GREEN, now rather than
      // on the next push. That immediacy is what makes "link it" an escape hatch
      // instead of an instruction to go and push something. POST-COMMIT and
      // best-effort by construction: the link is the durable fact, the check is a
      // view of it, and a host that refuses the write must never turn a recorded
      // link into an error the caller sees.
      await refreshLinkCheckForPullRequest(pullRequestId);
      // …and apply the sync the `opened` delivery could not, because at the
      // moment it arrived this link did not exist. See `resyncLinkedPullRequest`.
      await resyncLinkedPullRequest(pullRequestId);
      return dto;
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
   * webhook is authoritative about STATE and about nothing else. That used to
   * need a boundary marker, because both wrote the same column: `linkedManually`
   * made a declared link STICKY against the sync's branch/title parse. Neither
   * side of that is left — the parse went with MOTIR-3674 and the column with
   * MOTIR-3757 — so the two claims now live in two different tables and cannot
   * collide. A delivery refreshes `state` / `merged` / `headRef` / `baseRef` /
   * `title` on the mirror row and reaches no association at all.
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
   * ⚠️ THE ASSOCIATION IS A SET: a call naming a different work item ADDS a
   * second delivery rather than moving the first, and there is no move to report
   * (MOTIR-3757 — the scalar `movedFrom` described is gone with the column). A
   * mistaken link is retracted by `unlinkPullRequest`, which is why that door
   * exists.
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
  ): Promise<{ link: LinkedPullRequestDto; created: boolean }> {
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

      // ONE write for both arms, and it is the narrow one: `markLinkedManually`
      // touches `linked_manually` and nothing else, so the already-ingested case
      // cannot clobber a delivery's state fields.
      const updated = await githubPullRequestRepository.markLinkedManually(prId, tx);
      // THE LINK — see the note on the sibling arm. `repo.id` rather than a
      // re-read: this arm already resolved the repository row, and the gate
      // compares each member's merge against THAT repository's own default
      // branch, so the column is stored rather than joined for per member.
      await workItemDeliveryRepository.add(
        {
          workspaceId: ctx.workspaceId,
          workItemId: input.workItemId,
          githubPullRequestId: prId,
          repoId: repo.id,
        },
        tx,
      );

      return {
        link: toLinkedPullRequestDto(updated),
        created: existing === null,
        prId,
      };
    }).then(async ({ prId, ...result }) => {
      // MOTIR-3675 — the same post-commit refresh the sibling arm does, and this
      // is the arm that matters most: it is the one a RUN calls, seconds after
      // `gh pr create`, often before any delivery has arrived at all.
      await refreshLinkCheckForPullRequest(prId);
      // The arm a RUN calls, so the one where the delivery has almost always
      // already been and gone — and `created` is exactly how this arm knows.
      // A row this call CREATED means no delivery has arrived yet: there is
      // nothing to catch up on, and the `opened` delivery still to come will
      // transition the card itself. A row that already existed means a delivery
      // came, found no link, and correctly moved nothing.
      if (!result.created) await resyncLinkedPullRequest(prId);
      return result;
    });
  },

  /**
   * Remove ONE delivery link — the door a mistaken link needs (Story MOTIR-3655 ·
   * MOTIR-3658).
   *
   * ── Why this has to exist now, when it never did before ───────────────────
   * While the association was one nullable column a correction was expressible as
   * a MOVE: link the pull request to the right item and the wrong association
   * vanished, because there was only ever one. `work_item_delivery` is a set, so
   * a re-link ADDS and the mistaken row stays. Removal therefore stops being a
   * side effect of the fix and has to be its own operation.
   *
   * ── What it does NOT touch ────────────────────────────────────────────────
   * The pull-request MIRROR row. It holds no association to remove — the scalar
   * that used to sit beside this table was dropped by MOTIR-3757 — so this door
   * deletes one delivery row and leaves `github_pull_request` exactly as the
   * webhook last wrote it, `linked_manually` included.
   *
   * Returns whether a row was actually removed, so a caller can say "nothing to
   * unlink" rather than reporting a success that did nothing.
   */
  async unlinkPullRequest(
    workItemId: string,
    pullRequestId: string,
    ctx: ServiceContext,
  ): Promise<{ removed: boolean }> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId)
        throw new WorkItemNotFoundError(workItemId);

      const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
      // The REPO row is the tenant (MOTIR-1931), never its installation — the
      // same gate the link arms use, and for the same reason.
      if (!pr || pr.repo.workspaceId !== ctx.workspaceId)
        throw new GithubPullRequestNotFoundError(pullRequestId);

      const count = await workItemDeliveryRepository.remove(workItemId, pullRequestId, tx);
      return { removed: count > 0 };
    }).then(async (result) => {
      // The mirror of the link arm (MOTIR-3675): removing the last delivery makes
      // the pull request unlinked again, and the check has to say so. Post-commit
      // and best-effort, for the same reason.
      if (result.removed) await refreshLinkCheckForPullRequest(pullRequestId);
      return result;
    });
  },

  /**
   * Remove ONE delivery link addressed by GITHUB COORDINATES — `(owner/name,
   * number)` — the correction door an AGENT can reach (MOTIR-3756).
   *
   * ── Why it is not {@link unlinkPullRequest} with a different lookup ────────
   * Exactly the asymmetry {@link linkPullRequestByCoordinates} documents, in the
   * other direction. The item page addresses a pull request by Motir's internal
   * cuid because it is rendering a row it already read; an agent that mis-linked
   * one seconds ago knows it as `owner/name#number` and nothing else. Requiring
   * the cuid would make the correction unreachable by the actor who makes the
   * mistake, which is the whole population this door is for.
   *
   * ── Why a coordinate that names NOTHING is a not-found, not a no-op ───────
   * An unknown repository or an unknown number raises rather than answering
   * `removed: false`. The two answers look alike and mean opposite things: *there
   * is no such pull request* is almost always a typo in the argument, and
   * reporting it as a successful nothing lets the caller believe a mis-link was
   * corrected while it stands. `removed: false` is reserved for the one case that
   * really is benign — the pull request exists, the item exists, and they were
   * simply not linked (a retry, or a correction somebody else already made).
   *
   * ── What it does NOT touch ────────────────────────────────────────────────
   * The pull-request mirror row, for the reason the sibling arm states.
   */
  async unlinkPullRequestByCoordinates(
    input: {
      /** The work item to unlink — already resolved and known to the caller. */
      workItemId: string;
      /** Its project, for the permission assertion. */
      projectId: string;
      owner: string;
      name: string;
      number: number;
    },
    ctx: ServiceContext,
  ): Promise<{ removed: boolean; pullRequestId: string }> {
    // The key this tool DECLARES — the same one `link_pull_request` asserts, and
    // asserted here rather than left to the MCP gate alone, for the same reason:
    // the gate says what the TOKEN may reach, this says what its owner may do to
    // this project. Undoing a link is editing the card the link was made against.
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

      const pr = await githubPullRequestRepository.findByRepoAndNumber(repo.id, input.number, tx);
      if (!pr)
        throw new GithubPullRequestNotFoundError(`${input.owner}/${input.name}#${input.number}`);

      // EXACTLY ONE row: the repository's `deleteMany` is keyed on the
      // `(work_item_id, github_pull_request_id)` unique pair, so the pair it names
      // is the only row it can reach. A pull request delivering four cards loses
      // the one named here and keeps the other three, which is the difference
      // between a correction and a retraction.
      const count = await workItemDeliveryRepository.remove(input.workItemId, pr.id, tx);
      return { removed: count > 0, pullRequestId: pr.id };
    }).then(async (result) => {
      // The same post-commit refresh both other arms do (MOTIR-3675): removing the
      // LAST delivery makes the pull request unlinked again and its check has to
      // say so. Best-effort — the removal is the durable fact, the check a view of
      // it, and a host that refuses the write must never turn a recorded removal
      // into an error the caller sees.
      if (result.removed) await refreshLinkCheckForPullRequest(result.pullRequestId);
      return result;
    });
  },
};

/** A lost unique-constraint race, spelled the same way `changeRequestStatusSync`
 *  spells it — the two converge on the same `(repo_id, number)` pair. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
