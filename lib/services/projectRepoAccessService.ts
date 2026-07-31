import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { repoCollaboratorClient } from '@/lib/github/repoCollaborators';
import { needsCollaboratorInvite } from '@/lib/projectRepos/access';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';

// COLLABORATOR ACCESS — getting the user INTO the code Motir made them (Story
// MOTIR-1775 · MOTIR-1900).
//
// ⚠️ THE GAP THIS CLOSES. The ADR's ownership amendment (MOTIR-1893) made every
// new project's repositories Motir-owned and PRIVATE. The user is not a member of
// Motir's org, so from that moment they could not clone their own code — under the
// previous model access was implicit, and reversing ownership removed it silently.
// Everything else in this Story works and dead-ends one step later at `git clone`.
//
// ⚠️ WHOSE ACCOUNT. The APPROVING USER's — the acting member's connected
// `GithubIdentity`, never a typed handle (a typo would invite a stranger to a
// private repository, and Motir needs the verified identity for dispatch and
// attribution anyway). Giving the REST of the workspace access is deliberately not
// here: it cannot reuse this mechanism (Motir cannot OAuth on a teammate's
// behalf), it resolves against membership instead, and it multiplies the CI spend
// MOTIR-1901 / MOTIR-1907 meter — MOTIR-1910 carries all of it.
//
// ⚠️ `created` ROWS ONLY (`needsCollaboratorInvite`). A `connected` row is a
// repository the user already owns and granted Motir; inviting them to their own
// repository is at best a no-op. A `skipped` or `failed` row has nothing to be
// invited to.
//
// ⚠️ NEVER FAILS THE ROW. Access is granted AFTER the repository exists and after
// its row is committed, so an invite that fails leaves a `created` row `created`
// and a real repository on GitHub — degrading to "not invited yet", which the UI
// renders with a way back to it. The card is explicit: a side effect after commit,
// degrading gracefully. That is also why the post-establish hook swallows and logs
// rather than throwing.
//
// SCOPE. Granting and observing access. It does not create repositories
// (MOTIR-1781), own the rows or the ADR §4.1 machine (MOTIR-1780), or render
// anything (the step, MOTIR-1782 + this card's UI half).

/** What one access pass did, and what the UI needs to render next. */
export interface GrantAccessResult {
  /** The project's rows AFTER the pass, in set order — so a caller renders from
   *  one result rather than re-reading to find out what changed. */
  rows: ProjectRepoDto[];
  /**
   * The GitHub login the pass invited, or null when the actor has none connected.
   *
   * Null is the CONNECT-PROMPT signal and the whole reason the prompt belongs
   * here rather than before approval: a user who has not connected cannot be
   * invited, so the ask is framed as "connect GitHub to get access to your code"
   * AFTER their plan is safe and their code exists — never as a gate in front of
   * either.
   */
  login: string | null;
  /** How many rows this pass sent (or re-sent) an invitation for. */
  invited: number;
  /** How many rows this pass could not invite because GitHub refused. Their state
   *  is unchanged and they stay retryable — nothing is rolled back. */
  failed: number;
}

export const projectRepoAccessService = {
  /**
   * Invite the acting member's connected GitHub account to this project's
   * Motir-created repositories.
   *
   * IDEMPOTENT AND RESUMABLE. Already-accepted rows are left alone; every other
   * eligible row is invited, and GitHub treats a repeat on a pending invitation as
   * an update rather than a duplicate — so this is equally the first pass, the
   * pass after the user connects, and a single row's **Resend invitation**.
   *
   * SEQUENTIAL, like the creation primitive it follows: a set is 2–5 rows, so
   * serialising costs nothing and keeps the path clear of GitHub's secondary
   * limits. Each row's outcome is committed as it resolves — no transaction spans
   * the host calls — so a crash mid-set leaves a readable partial state the next
   * pass finishes.
   *
   * Throws only for a CALLER-level failure (the project not existing, or the actor
   * not being allowed to edit it — the gate `projectRepoSetService` already owns).
   * A row-level GitHub refusal is counted, never thrown.
   */
  async grantAccess(
    projectId: string,
    ctx: ServiceContext,
    options: { rowId?: string } = {},
  ): Promise<GrantAccessResult> {
    // The set read is the access gate: a missing project — or one in another
    // workspace, or one the actor may not browse — throws before anything reaches
    // GitHub or the identity table.
    const rows = await projectRepoSetService.listByProject(projectId, ctx);

    const identity = await githubIdentityService.getIdentityForUser(ctx.userId);
    if (!identity) return { rows, login: null, invited: 0, failed: 0 };

    let invited = 0;
    let failed = 0;
    for (const row of rows) {
      if (options.rowId !== undefined && row.id !== options.rowId) continue;
      if (!isInvitable(row)) continue;
      // Settled: the account can already clone. Re-inviting would be a request
      // that can only answer "already a collaborator".
      if (row.access.state === 'accepted' && row.access.login === identity.githubLogin) continue;

      const realized = row.realizedRepo;
      if (!realized) continue;
      try {
        const result = await repoCollaboratorClient.invite({
          // The REALIZED repo's own coordinates, in GitHub's casing — not the
          // row's authored name and not the configured org, so a repository that
          // was renamed or moved on the host still resolves.
          owner: realized.owner,
          repo: realized.name,
          login: identity.githubLogin,
        });
        await projectRepoSetService.recordCollaboratorInvite(
          row.id,
          {
            login: identity.githubLogin,
            invitationUrl: result.invitationUrl,
            alreadyHasAccess: result.alreadyHasAccess,
          },
          ctx,
        );
        invited += 1;
      } catch (err) {
        // The repository EXISTS and the row is untouched. Losing the whole pass
        // because row 2 of 3 could not be invited is the one thing per-row
        // independence forbids, so this is counted and the loop continues.
        failed += 1;
        console.error(
          `[projectRepoAccessService] could not invite ${identity.githubLogin} to row ${row.id}:`,
          err,
        );
      }
    }

    return {
      rows: await projectRepoSetService.listByProject(projectId, ctx),
      login: identity.githubLogin,
      invited,
      failed,
    };
  },

  /**
   * Re-read GitHub for every PENDING invitation and stamp the ones that have been
   * accepted.
   *
   * GitHub owns acceptance and tells Motir nothing when it happens, so a read is
   * the only honest way to learn it — which is why this is an explicit call the
   * access surface makes rather than something folded into the set read that the
   * establish step polls every 1.5s. Bounded by the pending rows of ONE set (2–5),
   * and best-effort per row: a refresh that cannot reach GitHub leaves the row
   * saying what it last knew, which is better than reporting a granted account as
   * uninvited.
   */
  async refreshAccess(projectId: string, ctx: ServiceContext): Promise<ProjectRepoDto[]> {
    const rows = await projectRepoSetService.listByProject(projectId, ctx);

    let changed = false;
    for (const row of rows) {
      if (row.access.state !== 'invited') continue;
      const login = row.access.login;
      const realized = row.realizedRepo;
      if (!login || !realized) continue;
      try {
        if (
          await repoCollaboratorClient.hasAccepted({
            owner: realized.owner,
            repo: realized.name,
            login,
          })
        ) {
          await projectRepoSetService.recordCollaboratorAccepted(row.id, ctx);
          changed = true;
        }
      } catch (err) {
        console.error(`[projectRepoAccessService] could not read access for row ${row.id}:`, err);
      }
    }

    return changed ? projectRepoSetService.listByProject(projectId, ctx) : rows;
  },

  /**
   * The POST-ESTABLISH hook: invite the actor to a row that has just become
   * `created`, if they have an identity to invite.
   *
   * Wired into `attachRealizedRepo` — the ONE seam every establish path goes
   * through — for the same reason the repo-pin resolution is (MOTIR-1913): neither
   * caller has to remember it and neither can drift.
   *
   * ⚠️ SWALLOWS EVERYTHING. The repository exists and the row is established by
   * the time this runs; reporting a settled row as failed because an invitation
   * did not go out would be a worse lie than "not invited yet", which the UI
   * renders with its own way forward. On the default path the actor usually has NO
   * identity yet — the connect prompt comes AFTER the code exists — so the common
   * outcome here is deliberately "nothing happened", and the access step is what
   * completes it.
   */
  async inviteAfterEstablish(rowId: string, projectId: string, ctx: ServiceContext): Promise<void> {
    try {
      await this.grantAccess(projectId, ctx, { rowId });
    } catch (err) {
      console.error(
        `[projectRepoAccessService] could not grant access after establishing row ${rowId}:`,
        err,
      );
    }
  },
};

/** A row that CAN be invited to: Motir made the repository, and the repository is
 *  still there. Both halves — a `created` row whose mirror row has since been
 *  deleted has no coordinates to invite against. */
function isInvitable(row: ProjectRepoDto): boolean {
  return needsCollaboratorInvite(row.state) && row.realizedRepo !== null;
}
