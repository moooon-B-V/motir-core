import type { MonitorIssue } from '@/generated/prisma/client';
import { getMonitorProvider } from '@/lib/monitors';
import { MonitorIssueGoneError, MonitorProviderCallError } from '@/lib/monitors/errors';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { commentsService } from '@/lib/services/commentsService';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { workflowsService } from '@/lib/services/workflowsService';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// The monitor SYNC service (Story MOTIR-4931) — what Motir writes BACK to a
// monitor, and what it takes from one, once ingestion (MOTIR-4929) has linked a
// provider issue to a bug.
//
// RESOLVE BACK (Subtask MOTIR-5703) lives here: a bug reaching a done-category
// status resolves each linked issue at the provider, exactly once. It is called
// from two places and only two — the `monitor-issue-resolve` job off
// `work-item/transitioned` (the fast path), and the backstop sweep at the end of
// every poll (`monitorIngestionService.pollConnection`).
//
// ⚠️ COMMIT-THEN-EFFECT. Nothing here runs inside the transition's transaction:
// the job consumes an event emitted AFTER the status write committed, so a slow
// or broken provider can never roll back, or hang, a completion a person made.
// A provider refusal is RECORDED on the link and the connection, never thrown.
//
// ⚠️ EXACTLY ONCE IS THE LINK'S CLAIM, NOT THE EVENT'S DELIVERY. The event is
// at-least-once and the sweep runs as well, so the same completion can reach
// {@link resolveLink} several times. `monitorIssueRepository.claimResolve` is ONE
// conditional UPDATE, and only its winner calls the provider; a `resolved` or
// `gone` link is never claimed again.

/**
 * A `pending` claim older than this is a crashed attempt, and the sweep may take
 * it over. Well above the resolve call's own bound
 * (`MONITOR_RESOLVE_ISSUE_TIMEOUT_MS`, plus one credential refresh and retry), so
 * a live attempt is never mistaken for a dead one.
 */
export const MONITOR_RESOLVE_STALE_MS = 15 * 60 * 1000;

/**
 * The most links ONE poll's backstop sweep resolves. A bound, not a budget: the
 * first poll after the deploy may find a backlog of already-done bugs, and 25 a
 * half-hour clears a few hundred in a working day without making any one poll
 * slow. The rest wait for the next poll, oldest first.
 */
export const MONITOR_RESOLVE_SWEEP_MAX = 25;

/** What one resolve attempt did — the job's and the sweep's ledger output. */
export type MonitorResolveOutcome = 'resolved' | 'gone' | 'failed' | 'switched_off' | 'not_claimed';

export interface MonitorResolveSummary {
  links: number;
  resolved: number;
  gone: number;
  failed: number;
  skipped: number;
}

const EMPTY: MonitorResolveSummary = { links: 0, resolved: 0, gone: 0, failed: 0, skipped: 0 };

/** The bug a link points at — what the comment and the failure record name. */
export interface LinkedBug {
  id: string;
  identifier: string;
  projectId: string;
  workspaceId: string;
}

/** The done-category keys of a project's OWN workflow — the rule
 *  `reconcileIssue` applies, so a team's custom terminal status (and
 *  `cancelled`) counts. */
async function doneKeysOf(projectId: string, workspaceId: string): Promise<Set<string>> {
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
}

/** The link's bug, read with the link's own workspace bound (`work_item` has no
 *  system arm, so an unbound read would see nothing and say nothing). */
async function readBug(link: MonitorIssue): Promise<LinkedBug | null> {
  if (!link.workItemId) return null;
  const workItemId = link.workItemId;
  return withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, link.workspaceId);
    const bug = await workItemRepository.findById(workItemId, tx);
    return bug
      ? {
          id: bug.id,
          identifier: bug.identifier,
          projectId: bug.projectId,
          workspaceId: bug.workspaceId,
        }
      : null;
  });
}

/** The words the gone-comment says — the issue by its permalink, or its provider
 *  id when there is none. Carries nothing from the credential. */
export function monitorIssueGoneComment(link: {
  externalIssueId: string;
  permalink: string | null;
}): string {
  const issue = link.permalink
    ? `[the linked monitor issue](${link.permalink})`
    : `the linked monitor issue \`${link.externalIssueId}\``;
  return (
    `Nothing was resolved in the monitor: ${issue} no longer exists there. ` +
    'It was deleted at the provider, so there is nothing left to close.'
  );
}

async function recordConnectionFailure(
  connectionId: string,
  reason: string,
  workItemIdentifier: string | null,
): Promise<void> {
  await withSystemContext((tx) =>
    monitorConnectionRepository.recordSyncFailure(
      connectionId,
      { reason, workItemIdentifier, at: new Date() },
      tx,
    ),
  );
}

export const monitorSyncService = {
  /**
   * Resolve every issue linked to ONE bug — the `work-item/transitioned` job's
   * entry point.
   *
   * CHEAPEST EXIT FIRST: the links are read before anything else, because almost
   * every transition in the product is on a work item no monitor filed. Then the
   * transition's `toStatusKey` must be in the project's done category.
   */
  async resolveLinkedIssues(
    workItemId: string,
    toStatusKey: string,
  ): Promise<MonitorResolveSummary> {
    const links = await withSystemContext((tx) =>
      monitorIssueRepository.listByWorkItem(workItemId, tx),
    );
    if (links.length === 0) return EMPTY;

    const bug = await readBug(links[0]!);
    if (!bug) return EMPTY;
    const doneKeys = await doneKeysOf(bug.projectId, bug.workspaceId);
    if (!doneKeys.has(toStatusKey)) return { ...EMPTY, links: links.length };

    const summary: MonitorResolveSummary = { ...EMPTY, links: links.length };
    for (const link of links) {
      tally(summary, await monitorSyncService.resolveLink(link, bug));
    }
    return summary;
  },

  /**
   * Resolve ONE link, if this caller wins its claim. The per-link path the job
   * and the sweep share.
   *
   * | the connection / claim / provider says      | recorded                                  |
   * |---------------------------------------------|-------------------------------------------|
   * | `resolveOnDone` off                         | nothing — `resolve_state` stays as it was |
   * | claim lost (held, resolved or gone)         | nothing                                   |
   * | provider accepted                           | `resolved` + time; connection failure cleared |
   * | provider no longer has it (`MonitorIssueGoneError`) | `gone`, and ONE comment on the bug as the binder |
   * | provider refused (`MonitorProviderCallError`) | `failed` + reason; connection failure + bug key |
   *
   * Anything else THROWS, leaving the claim `pending` — the job's retry and
   * dead-letter apply, and the sweep re-claims it once it is stale.
   */
  async resolveLink(link: MonitorIssue, bug: LinkedBug): Promise<MonitorResolveOutcome> {
    const connection = await withSystemContext((tx) =>
      monitorConnectionRepository.findById(link.connectionId, tx),
    );
    if (!connection || !connection.resolveOnDone) return 'switched_off';

    const now = new Date();
    const won = await withSystemContext((tx) =>
      monitorIssueRepository.claimResolve(
        link.id,
        now,
        new Date(now.getTime() - MONITOR_RESOLVE_STALE_MS),
        tx,
      ),
    );
    if (!won) return 'not_claimed';

    try {
      await monitorCredentialService.withFreshCredential(connection.installationId, (credential) =>
        getMonitorProvider(credential.provider).resolveIssue({
          accessToken: credential.token,
          externalIssueId: link.externalIssueId,
        }),
      );
    } catch (err) {
      if (err instanceof MonitorIssueGoneError) {
        await withSystemContext((tx) => monitorIssueRepository.recordGone(link.id, tx));
        await sayGoneOnTheCard(link, bug, connection.id, connection.boundByUserId);
        return 'gone';
      }
      if (err instanceof MonitorProviderCallError) {
        await withSystemContext((tx) =>
          monitorIssueRepository.recordResolveFailed(link.id, err.providerReason, tx),
        );
        await recordConnectionFailure(connection.id, err.providerReason, bug.identifier);
        return 'failed';
      }
      throw err;
    }

    await withSystemContext(async (tx) => {
      await monitorIssueRepository.recordResolved(link.id, new Date(), tx);
      await monitorConnectionRepository.clearSyncFailure(connection.id, tx);
    });
    return 'resolved';
  },

  /**
   * The BACKSTOP: resolve every claimable link on one connection whose bug is
   * done, capped at {@link MONITOR_RESOLVE_SWEEP_MAX}. Called at the end of every
   * poll when the connection resolves on done.
   *
   * It catches what the event cannot: a `failed` link (retried here), a stale
   * `pending` one (a crashed attempt), and a done bug whose transition emitted no
   * event — several status writers do not announce themselves, so the event is
   * the fast path and this is the guarantee. The first sweep after the deploy
   * resolves every link whose bug was ALREADY done, which is intended.
   */
  async sweepConnection(connectionId: string): Promise<MonitorResolveSummary> {
    const connection = await withSystemContext((tx) =>
      monitorConnectionRepository.findById(connectionId, tx),
    );
    if (!connection || !connection.resolveOnDone) return EMPTY;

    const doneKeys = await doneKeysOf(connection.projectId, connection.workspaceId);
    // The listing JOINS `work_item` (the bug must be done), which has no system
    // arm — so the connection's own workspace is bound, or the join sees nothing
    // and says nothing.
    const links = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, connection.workspaceId);
      return monitorIssueRepository.listResolvableForConnection(
        connectionId,
        [...doneKeys],
        new Date(Date.now() - MONITOR_RESOLVE_STALE_MS),
        MONITOR_RESOLVE_SWEEP_MAX,
        tx,
      );
    });
    const summary: MonitorResolveSummary = { ...EMPTY, links: links.length };
    for (const link of links) {
      const bug = await readBug(link);
      /* v8 ignore next 4 -- unreachable: the listing joins the link to a work item
         in a done status, in the same workspace. Asserted by
         `monitorResolveBack.test.ts` › "the sweep resolves a done bug that emitted
         no event". */
      if (!bug) {
        summary.skipped += 1;
        continue;
      }
      tally(summary, await monitorSyncService.resolveLink(link, bug));
    }
    return summary;
  },
};

function tally(summary: MonitorResolveSummary, outcome: MonitorResolveOutcome): void {
  if (outcome === 'resolved') summary.resolved += 1;
  else if (outcome === 'gone') summary.gone += 1;
  else if (outcome === 'failed') summary.failed += 1;
  else summary.skipped += 1;
}

/**
 * "The issue is gone" is said ONCE, on the bug, as the connection's BINDER — the
 * identity ingestion files as (MOTIR-4929). A missing binder, or a comment the
 * create path refuses, leaves the link `gone` and records a NAMED failure on the
 * connection instead. It never substitutes another identity.
 */
async function sayGoneOnTheCard(
  link: MonitorIssue,
  bug: LinkedBug,
  connectionId: string,
  binderId: string | null,
): Promise<void> {
  if (!binderId) {
    await recordConnectionFailure(
      connectionId,
      `The monitor issue for ${bug.identifier} no longer exists, and this connection has no binder to say so on the bug. Bind the monitored project again.`,
      bug.identifier,
    );
    return;
  }
  try {
    await commentsService.addComment(
      bug.id,
      { bodyMd: monitorIssueGoneComment(link) },
      { userId: binderId, workspaceId: bug.workspaceId },
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await recordConnectionFailure(
      connectionId,
      `The monitor issue for ${bug.identifier} no longer exists, and saying so on the bug failed: ${why}`,
      bug.identifier,
    );
  }
}
