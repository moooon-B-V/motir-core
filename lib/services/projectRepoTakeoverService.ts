import type { Prisma, ProjectRepoTakeoverState } from '@prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { actionsPermissionsClient } from '@/lib/github/actionsPermissions';
import { repoTransferClient, RepoTransferError } from '@/lib/github/repoTransfer';
import { toProjectRepoDto, type ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import {
  allowedTakeoverTransitions,
  canStartTakeover,
  canTakeover,
} from '@/lib/projectRepos/takeover';
import {
  GithubIdentityRequiredError,
  ProjectRepoNotFoundError,
  ProjectRepoNotTransferableError,
  ProjectRepoTakeoverStateError,
  RepoTransferRefusedError,
} from '@/lib/projectRepos/errors';

// TAKE IT OVER (Story MOTIR-1775 · MOTIR-711) — the saga that moves a Motir-owned
// repository into the user's own GitHub account, and re-establishes the App grant
// so dispatch and the code-graph feed survive the move.
//
// This is the card that makes MOTIR-1775's promise true ("it's yours — move it to
// your own GitHub whenever you want") and the honest SECOND answer when an org's
// CI credits run out: the first is to add credits, and an option that leads
// nowhere is not an option.
//
// ⚠️ THE ORDER OF THE TWO HOST CALLS IS THE WHOLE CARD, and getting it backwards
// is a latent bug that only shows up for an exhausted tenant. `ci-minutes-
// allowance.md` §G: RE-ENABLE ACTIONS **BEFORE** THE TRANSFER. While the
// repository is still in Motir's org the provisioning App holds
// `Administration: write` on it; the instant it moves, that credential no longer
// reaches it and the repo is stranded with Actions disabled — arriving at its new
// owner dead, which is the worst possible first impression of "it's yours". The
// re-enable is unconditional and does NOT consult the credit balance: once GitHub
// bills the user, Motir has no reason to hold their CI off.
//
// ⚠️ THE GITHUB CALLS ARE OUTSIDE THE TRANSACTION (the side-effects-outside-tx
// rule). The saga is therefore a sequence of SHORT locked transactions around
// network work, exactly like the creation primitive (MOTIR-1781) — never one
// method holding a row locked across a round-trip.
//
// ⚠️ WHAT THIS SERVICE DOES **NOT** DO:
//
//   * render anything — the surface is MOTIR-1939, gated by MOTIR-1938's design.
//     The account/org PICKER lives there; here the target owner is an INPUT.
//   * touch the CI METER. `ci-minutes-allowance.md` §5.1/§5.5 gate metering on the
//     RUN's own repository owner, so a transferred repo stops being metered with
//     no branch here at all. There is an assertion for that, deliberately, and no
//     code — the test is what keeps the property from being quietly lost.
//   * rewrite workflow files. §N has the starters select their runner via
//     `runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}`, and `MOTIR_RUNNER`
//     is simply absent in the user's account — so a handed-over repo falls back to
//     GitHub-hosted runners by construction, with nothing for this card to
//     remember to do.

/** How far a takeover got. Returned for the surface + the tests; never thrown. */
export interface TakeoverOutcome {
  row: ProjectRepoDto;
  /** Where the saga now sits. */
  state: ProjectRepoTakeoverState;
  /** True when GitHub reported the repository already sits under the new owner —
   *  an org target that needed no acceptance. False means it is awaiting the new
   *  owner's accept on github.com. */
  transferAccepted: boolean;
}

export const projectRepoTakeoverService = {
  /**
   * Request the handoff of one Motir-owned row to `newOwner`.
   *
   * The shape is CLAIM → host calls → RECORD, and the claim is what makes two
   * simultaneous requests safe: the first transaction locks the row, verifies the
   * takeover machine allows a start, and writes `requested`; the second observes
   * `requested` under the same lock and is rejected with a typed error rather than
   * issuing a second transfer for one repository.
   */
  async requestTakeover(
    rowId: string,
    newOwner: string,
    ctx: ServiceContext,
  ): Promise<TakeoverOutcome> {
    const target = newOwner.trim();

    // The user must have somewhere to put it. A first-class typed error, because
    // the surface's correct response is MOTIR-1900's connect prompt, not a banner.
    const identity = await githubIdentityService.getIdentityForUser(ctx.userId);
    if (!identity) throw new GithubIdentityRequiredError();

    // ── 1 · CLAIM (locked, no network) ──────────────────────────────────────
    const claimed = await inLockedRow(rowId, ctx, async (row, tx) => {
      assertTransferable(rowId, row);
      if (!canStartTakeover(row.takeoverState)) {
        throw new ProjectRepoTakeoverStateError(
          rowId,
          row.takeoverState ?? 'none',
          'requested',
          row.takeoverState ? allowedTakeoverTransitions(row.takeoverState) : ['requested'],
        );
      }
      await projectRepoRepository.setTakeover(
        rowId,
        {
          takeoverState: 'requested',
          takeoverTargetOwner: target,
          takeoverRequestedAt: new Date(),
          // A retry must not inherit the previous attempt's excuse.
          takeoverFailureReason: null,
          takeoverTransferredAt: null,
          takeoverCompletedAt: null,
        },
        tx,
      );
      // Read the mirror's coordinates HERE, under the lock, while the repository is
      // still Motir's — after the transfer the provisioning installation no longer
      // reaches it, so this is the last moment they are usable.
      return {
        projectId: row.projectId,
        installationId: row.githubRepo!.installationId,
        owner: row.githubRepo!.owner,
        repo: row.githubRepo!.name,
      };
    });

    // ── 2 · The host calls, IN ORDER, outside any transaction ────────────────
    try {
      // §G — re-enable FIRST, unconditionally. Idempotent by construction (a PUT
      // of a desired state), so a retry after a lost response is free.
      await actionsPermissionsClient.setActionsEnabled({
        installationId: claimed.installationId,
        owner: claimed.owner,
        repo: claimed.repo,
        enabled: true,
      });
    } catch (err) {
      await this.markFailed(rowId, detailOf(err), ctx);
      throw new RepoTransferRefusedError(
        `could not re-enable Actions before the transfer: ${detailOf(err)}`,
      );
    }

    let accepted = false;
    try {
      const result = await repoTransferClient.transferRepo({
        installationId: claimed.installationId,
        owner: claimed.owner,
        repo: claimed.repo,
        newOwner: target,
      });
      accepted = result.completed;
    } catch (err) {
      await this.markFailed(rowId, detailOf(err), ctx);
      throw new RepoTransferRefusedError(detailOf(err));
    }

    // ── 3 · RECORD what the host told us ────────────────────────────────────
    // An org target usually lands immediately; a personal-account target must be
    // accepted on github.com. Either way the `repository` `transferred` delivery
    // is what CONFIRMS it — this only skips the pending state when GitHub has
    // already reported the new owner, and the webhook remains idempotent over it.
    const next: ProjectRepoTakeoverState = accepted ? 'awaiting_reinstall' : 'transfer_pending';
    const row = await this.transition(rowId, next, ctx, {
      transferredAt: accepted ? new Date() : null,
    });

    // The re-enable above cleared Motir's pause on a repository it is handing over.
    // Clear the stored INTENT too, or MOTIR-1907's sweep would read the row as
    // still-wanting-disabled and re-assert it — for the brief window before the
    // mirror's owner changes, that is a real re-pause of the user's CI.
    await this.clearCiActionsIntent(rowId, ctx);

    return { row, state: next, transferAccepted: accepted };
  },

  /**
   * The `repository` `transferred` delivery landed: the repository has actually
   * moved. Advance the saga and re-stamp the mirror.
   *
   * IDEMPOTENT UNDER REDELIVERY, which GitHub makes routine: a second delivery
   * finds the row already past `transfer_pending` and returns `already_applied`
   * without a second write. Both the state hop and the mirror update are in ONE
   * transaction, so a redelivery can never advance one without the other.
   */
  async applyTransferred(input: {
    providerRepoId: string;
    newOwner: string;
    repoName: string;
    defaultBranch?: string;
  }): Promise<{ outcome: 'applied' | 'already_applied' | 'unknown_repo' | 'owner_mismatch' }> {
    // System context: a webhook has no active workspace, and the row it belongs to
    // is exactly what this read is trying to discover.
    const found = await withSystemContext(async (tx) =>
      projectRepoRepository.findByRealizedProviderRepoId(input.providerRepoId, tx),
    );
    if (!found) return { outcome: 'unknown_repo' };

    // A transfer Motir did not ask for (an operator moving a repo by hand) still
    // updates the mirror — the coordinates are a fact — but must not drive a saga
    // that was never requested, or aim one at the wrong owner.
    const expected = found.takeoverTargetOwner;
    const drivesSaga =
      found.takeoverState === 'requested' || found.takeoverState === 'transfer_pending';

    // The SERVICE flavour of the workspace context: a webhook has no user, and
    // `project_repository`'s policy predicates purely on `app.workspace_id` — the
    // same context the CI-Actions sweep writes its rows under.
    return withWorkspaceServiceContext(found.workspaceId, async (tx) => {
      await githubRepoRepository.updateOwnerByRepoId(
        input.providerRepoId,
        {
          owner: input.newOwner,
          name: input.repoName,
          ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
        },
        tx,
      );

      if (!drivesSaga) return { outcome: 'already_applied' as const };
      if (!sameLogin(expected, input.newOwner)) return { outcome: 'owner_mismatch' as const };

      const locked = await projectRepoRepository.lockById(found.id, tx);
      if (!locked) return { outcome: 'unknown_repo' as const };
      const fresh = await projectRepoRepository.findById(found.id, found.workspaceId, tx);
      // Re-read under the lock: a concurrent redelivery may have advanced it
      // between the unlocked read above and this one.
      if (
        !fresh ||
        !fresh.takeoverState ||
        !canTakeover(fresh.takeoverState, 'awaiting_reinstall')
      ) {
        return { outcome: 'already_applied' as const };
      }
      await projectRepoRepository.setTakeover(
        found.id,
        {
          takeoverState: 'awaiting_reinstall',
          takeoverTransferredAt: new Date(),
          takeoverFailureReason: null,
        },
        tx,
      );
      return { outcome: 'applied' as const };
    });
  },

  /**
   * Probe whether the handoff is COMPLETE — i.e. the user finished installing the
   * Motir App on the new owner — and settle the row when it is.
   *
   * ⚠️ `done` REQUIRES AN INSTALLATION, never merely a completed transfer. A
   * repository the App can no longer reach is a BROKEN loop dressed up as a
   * finished handoff: dispatch would fail and the code-graph index would go stale,
   * silently. This probe is the assertion that the loop survived.
   *
   * Safe to call repeatedly (the surface polls it, and a resume pass may too): a
   * row that is not `awaiting_reinstall` is returned untouched.
   */
  async completeIfReinstalled(rowId: string, ctx: ServiceContext): Promise<ProjectRepoDto> {
    return inLockedRow(rowId, ctx, async (row, tx) => {
      if (row.takeoverState !== 'awaiting_reinstall') return toProjectRepoDto(row);
      const owner = row.takeoverTargetOwner;
      if (!owner) return toProjectRepoDto(row);

      const installation = await githubInstallationRepository.findByAccountLogin(owner, tx);
      if (!installation) return toProjectRepoDto(row);

      const updated = await projectRepoRepository.setTakeover(
        rowId,
        {
          takeoverState: 'done',
          takeoverCompletedAt: new Date(),
          takeoverFailureReason: null,
        },
        tx,
      );
      return toProjectRepoDto({ ...updated, githubRepo: row.githubRepo });
    });
  },

  /**
   * Move a row's takeover to `state` if that hop is legal, rejecting with a typed
   * error naming the legal targets otherwise — the same self-correcting shape the
   * establish machine's `transitionRow` uses.
   */
  async transition(
    rowId: string,
    state: ProjectRepoTakeoverState,
    ctx: ServiceContext,
    options: { failureReason?: string; transferredAt?: Date | null } = {},
  ): Promise<ProjectRepoDto> {
    return inLockedRow(rowId, ctx, async (row, tx) => {
      const from = row.takeoverState;
      if (!from || !canTakeover(from, state)) {
        throw new ProjectRepoTakeoverStateError(
          rowId,
          from ?? 'none',
          state,
          from ? allowedTakeoverTransitions(from) : [],
        );
      }
      const updated = await projectRepoRepository.setTakeover(
        rowId,
        {
          takeoverState: state,
          takeoverFailureReason:
            state === 'failed' ? (options.failureReason ?? '').slice(0, 2000) : null,
          ...(options.transferredAt !== undefined
            ? { takeoverTransferredAt: options.transferredAt }
            : {}),
        },
        tx,
      );
      return toProjectRepoDto({ ...updated, githubRepo: row.githubRepo });
    });
  },

  /** Record a failed step WITHOUT letting the bookkeeping mask the real failure:
   *  the caller is about to throw the upstream error, and a throw from here would
   *  replace it with a less useful one. */
  async markFailed(rowId: string, reason: string, ctx: ServiceContext): Promise<void> {
    try {
      await this.transition(rowId, 'failed', ctx, { failureReason: reason });
    } catch (err) {
      console.error(
        `[projectRepoTakeoverService] could not record takeover failure on row ${rowId}:`,
        err instanceof Error ? err.message : 'unknown',
      );
    }
  },

  /** Drop the CI-Actions pause INTENT on a row being handed over, so MOTIR-1907's
   *  sweep does not re-assert a disable Motir has just deliberately lifted. Marks
   *  it applied in the same breath — the desired state IS asserted on the host
   *  (that was the re-enable), so leaving the stamp behind would re-pend it. */
  async clearCiActionsIntent(rowId: string, ctx: ServiceContext): Promise<void> {
    try {
      await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        async (tx) => {
          const at = new Date();
          await projectRepoRepository.setCiActionsIntent([rowId], false, at, tx);
          await projectRepoRepository.markCiActionsApplied(rowId, tx);
        },
      );
    } catch (err) {
      // Best-effort: the repository is already transferred and its Actions are
      // already on. A stale intent costs one no-op sweep call, never the handoff.
      console.error(
        `[projectRepoTakeoverService] could not clear the CI-Actions intent on row ${rowId}:`,
        err instanceof Error ? err.message : 'unknown',
      );
    }
  },
};

/**
 * Reject a row that is not Motir's to hand over, distinguishing the two shapes so
 * the surface can render "already yours" as a calm no-op rather than a failure.
 *
 * `state === 'created'` is the ownership test and it is EXACT, for the same reason
 * `listMotirCreatedByWorkspace` uses it: that state is reachable only through
 * `proposed → creating → created`, i.e. only via the creation primitive. A
 * `connected` row is a repository the USER already owned and merely pointed Motir
 * at — there is nothing to transfer.
 */
function assertTransferable(rowId: string, row: ProjectRepoWithRealized): void {
  if (row.state === 'connected') {
    throw new ProjectRepoNotTransferableError(rowId, 'already_yours');
  }
  if (row.state !== 'created' || !row.githubRepo) {
    throw new ProjectRepoNotTransferableError(rowId, 'not_realized');
  }
}

/** Find the row, check the caller may edit its project, lock it, and re-read it
 *  under the lock — the lost-update guard for every read-derived takeover write
 *  (the lock-before-read-derived-update rule; mirrors the set service's own). */
async function inLockedRow<T>(
  rowId: string,
  ctx: ServiceContext,
  fn: (row: ProjectRepoWithRealized, tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const existing = await projectRepoRepository.findById(rowId, ctx.workspaceId);
  if (!existing) throw new ProjectRepoNotFoundError(rowId);
  await projectAccessService.assertCanEdit(existing.projectId, ctx);
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: existing.projectId },
    async (tx) => {
      const locked = await projectRepoRepository.lockById(rowId, tx);
      if (!locked) throw new ProjectRepoNotFoundError(rowId);
      const fresh = await projectRepoRepository.findById(rowId, ctx.workspaceId, tx);
      if (!fresh) throw new ProjectRepoNotFoundError(rowId);
      return fn(fresh, tx);
    },
  );
}

/** GitHub logins are case-insensitive; the payload's casing need not match what
 *  was recorded at request time. */
function sameLogin(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The short sentence a failed row records — never a raw GitHub body. */
function detailOf(err: unknown): string {
  if (err instanceof RepoTransferError) return err.message;
  return err instanceof Error ? err.message : 'unknown';
}
