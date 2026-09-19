import type {
  MonitorIssueCandidateDto,
  MonitorIssueHolderDto,
  MonitorIssueLinkResultDto,
  MonitorIssueSearchFailureDto,
  MonitorIssueSearchResultDto,
} from '@/lib/dto/monitorIssueLink';
import { readOrgSlug } from '@/lib/mappers/monitorMappers';
import { getMonitorProvider } from '@/lib/monitors';
import {
  MonitorConnectionNotFoundError,
  MonitorIssueAlreadyLinkedError,
  MonitorIssueGoneError,
  MonitorIssueLinkNotFoundError,
  MonitorProviderCallError,
} from '@/lib/monitors/errors';
import { MONITOR_SEARCH_ISSUES_LIMIT } from '@/lib/monitors/provider';
import type { NormalizedMonitorIssue, NormalizedMonitorIssueContext } from '@/lib/monitors/types';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import {
  monitorIssueRepository,
  type MonitorIssueFacts,
} from '@/lib/repositories/monitorIssueRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// LINK and UNLINK by hand (Story MOTIR-4932 · Subtask MOTIR-5731) — a person
// says "this existing work item IS that error", and can take it back.
//
// ⚠️ A MANUAL LINK IS AN ORDINARY `monitor_issue` ROW. Not a separate relation:
// one issue per connection is one row (`@@unique([connectionId,
// externalIssueId])`), `workItemId` is not unique, so ONE issue is linked to at
// most one card and a card may carry many. That is what makes the link USEFUL —
// the next poll updates a hand-linked card's count instead of filing a
// duplicate, and completing the card resolves the error, through the
// reconciler's dedup and MOTIR-4931's sync with no special case.
//
// ⚠️ LINK AND UNLINK SHIP TOGETHER. A link a person can make and cannot retract
// is the trap `unlink_pull_request` had to be added to escape.
//
// ⚠️ CONSEQUENCES OF "A MANUAL LINK IS A LINK", stated rather than guarded:
// linking a card ALREADY in a done-category status makes MOTIR-5703's backstop
// sweep resolve the issue at the next poll; and with the assignee direction on,
// the monitor's assignee may overwrite the card's (MOTIR-5705). The design draws
// neither as a warning, and neither is a defect.
//
// Every door asserts `work_item:edit` on the card's project — a SEARCH too,
// because it spends provider calls on the caller's behalf.

/** How many of a project's monitored projects ONE search fans out to. A project
 *  past this searches its first ones by creation and says so (`truncated`). */
export const MONITOR_LINK_SEARCH_MAX_CONNECTIONS = 10;

/** The card, resolved under the caller's binding and gated on `work_item:edit`.
 *  Another workspace's card is {@link WorkItemNotFoundError}. */
async function editableItem(
  workItemId: string,
  ctx: ServiceContext,
): Promise<{ id: string; projectId: string; identifier: string }> {
  const item = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findById(workItemId, tx),
  );
  if (!item || item.workspaceId !== ctx.workspaceId) {
    throw new WorkItemNotFoundError(workItemId);
  }
  await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');
  return { id: item.id, projectId: item.projectId, identifier: item.identifier };
}

function factsOf(
  issue: NormalizedMonitorIssue,
  context: NormalizedMonitorIssueContext | null,
): MonitorIssueFacts {
  return {
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    permalink: issue.permalink,
    eventCount: issue.eventCount,
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
    ...(context ? { environment: context.environment, release: context.release } : {}),
  };
}

export const monitorIssueLinkService = {
  /**
   * SEARCH every monitored project bound to the card's project for issues a
   * person can link — words from the title, or a pasted short id.
   *
   * Fans out IN PARALLEL, one `searchIssues` per connection through
   * `withFreshCredential` (so an expired token refreshes and a revoked grant is
   * reported, not thrown), capped at {@link MONITOR_LINK_SEARCH_MAX_CONNECTIONS}.
   * A connection that fails does NOT fail the search: it becomes a `failures`
   * entry carrying the provider's own reason, beside the other connections'
   * candidates. Who holds each candidate is read in ONE query afterwards.
   *
   * A project with no connection answers `noConnection: true` and makes no call.
   */
  async searchCandidates(
    workItemId: string,
    query: string,
    ctx: ServiceContext,
  ): Promise<MonitorIssueSearchResultDto> {
    const item = await editableItem(workItemId, ctx);
    const connections = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      monitorConnectionRepository.listForProject(item.projectId, tx),
    );
    if (connections.length === 0) {
      return { candidates: [], failures: [], noConnection: true, truncated: false };
    }
    const searched = [...connections]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, MONITOR_LINK_SEARCH_MAX_CONNECTIONS);

    const settled = await Promise.all(
      searched.map(async (connection) => {
        try {
          const issues = await monitorCredentialService.withFreshCredential(
            connection.installationId,
            (credential) =>
              getMonitorProvider(credential.provider).searchIssues({
                accessToken: credential.token,
                orgSlug: credential.orgSlug ?? '',
                externalProjectId: connection.externalProjectId,
                query,
                limit: MONITOR_SEARCH_ISSUES_LIMIT,
              }),
          );
          return { connection, issues, failure: null };
        } catch (err) {
          const reason =
            err instanceof MonitorProviderCallError
              ? err.providerReason
              : err instanceof Error
                ? err.message
                : String(err);
          const failure: MonitorIssueSearchFailureDto = {
            connectionId: connection.id,
            orgSlug: readOrgSlug(connection.installation.metadata),
            projectSlug: connection.externalProjectSlug,
            reason,
          };
          return { connection, issues: [] as NormalizedMonitorIssue[], failure };
        }
      }),
    );

    const found = settled.flatMap(({ connection, issues }) =>
      issues.map((issue) => ({ connection, issue })),
    );
    const holders = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      monitorIssueRepository.listHoldersForIssues(
        [...new Set(found.map((f) => f.connection.id))],
        [...new Set(found.map((f) => f.issue.externalId))],
        tx,
      ),
    );
    const holderOf = new Map(
      holders.map((h) => [`${h.connectionId}\u0000${h.externalIssueId}`, h] as const),
    );

    const candidates: MonitorIssueCandidateDto[] = found.map(({ connection, issue }) => {
      const holder = holderOf.get(`${connection.id}\u0000${issue.externalId}`);
      let linkedTo: MonitorIssueHolderDto = null;
      if (holder?.workItemId === item.id) linkedTo = 'this';
      else if (holder?.workItemId && holder.workItem) {
        linkedTo = { identifier: holder.workItem.identifier };
      }
      return {
        connectionId: connection.id,
        orgSlug: readOrgSlug(connection.installation.metadata),
        projectSlug: connection.externalProjectSlug,
        externalIssueId: issue.externalId,
        title: issue.title,
        level: issue.level,
        eventCount: issue.eventCount,
        lastSeenAt: issue.lastSeenAt.toISOString(),
        permalink: issue.permalink,
        linkedTo,
      };
    });

    return {
      candidates,
      failures: settled.flatMap((s) => (s.failure ? [s.failure] : [])),
      noConnection: false,
      truncated: connections.length > searched.length,
    };
  },

  /**
   * LINK one provider issue to an existing work item.
   *
   * 1. Gate on the card, and the connection must belong to the card's OWN
   *    project — anything else is {@link MonitorConnectionNotFoundError}, so a
   *    connection id cannot be confirmed across projects.
   * 2. The FACTS come from the provider, OUTSIDE any transaction — the client
   *    sends two ids and a boolean and is never trusted for a count. A gone
   *    issue is {@link MonitorIssueGoneError} and nothing is written. The context
   *    (environment / release) is an enrichment: a failed read of it links
   *    anyway, with none.
   * 3. ONE transaction, under the reconciler's own claim-or-lock
   *    (`insertIfAbsent` + `lockByExternalId`), and exactly one of:
   *
   * | the locked row                                  | outcome                        |
   * |-------------------------------------------------|--------------------------------|
   * | just inserted, or its card was deleted          | `linked`                       |
   * | already this card's                             | `already_linked_here` (no-op)  |
   * | another card's, `move` false                    | {@link MonitorIssueAlreadyLinkedError} |
   * | another card's, `move` true                     | `moved` — sync record cleared  |
   *
   * Two simultaneous links of one NEW issue from two cards therefore end with
   * one row: the loser waits on the lock, reads the winner's card, and is
   * refused naming it — never a unique-violation.
   */
  async linkIssue(
    workItemId: string,
    input: { connectionId: string; externalIssueId: string; move: boolean },
    ctx: ServiceContext,
  ): Promise<MonitorIssueLinkResultDto> {
    const item = await editableItem(workItemId, ctx);
    const connection = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      monitorConnectionRepository.findById(input.connectionId, tx),
    );
    if (!connection || connection.projectId !== item.projectId) {
      throw new MonitorConnectionNotFoundError(input.connectionId);
    }

    const { issue, context } = await monitorCredentialService.withFreshCredential(
      connection.installationId,
      async (credential) => {
        const provider = getMonitorProvider(credential.provider);
        const read = { accessToken: credential.token, orgSlug: credential.orgSlug ?? '' };
        const found = await provider.getIssue({ ...read, externalIssueId: input.externalIssueId });
        if (!found) {
          throw new MonitorIssueGoneError(
            'getIssue',
            input.externalIssueId,
            'The monitor no longer has this issue.',
          );
        }
        let latest: NormalizedMonitorIssueContext | null = null;
        try {
          latest = await provider.getIssueContext({
            ...read,
            externalIssueId: input.externalIssueId,
          });
        } catch (err) {
          if (err instanceof MonitorIssueGoneError) throw err;
          latest = null;
        }
        return { issue: found, context: latest };
      },
    );
    const facts = factsOf(issue, context);

    const outcome = await withWorkspaceContext(
      { ...ctx, projectId: item.projectId },
      async (tx) => {
        await monitorIssueRepository.insertIfAbsent(
          {
            connectionId: connection.id,
            projectId: item.projectId,
            workspaceId: connection.workspaceId,
            externalIssueId: input.externalIssueId,
            ...facts,
          },
          tx,
        );
        const lockedId = await monitorIssueRepository.lockByExternalId(
          connection.id,
          input.externalIssueId,
          tx,
        );
        const row = lockedId ? await monitorIssueRepository.findById(lockedId, tx) : null;
        /* v8 ignore next 3 -- unreachable: the row was inserted (or already present)
           in THIS transaction under the same binding, so the lock finds it. */
        if (!row) {
          throw new Error(`monitor_issue row for ${input.externalIssueId} vanished under its lock`);
        }

        if (row.workItemId === item.id) return 'already_linked_here' as const;

        if (row.workItemId !== null) {
          if (!input.move) {
            const holder = await workItemRepository.findById(row.workItemId, tx);
            throw new MonitorIssueAlreadyLinkedError(
              input.externalIssueId,
              holder?.identifier ?? row.filedWorkItemIdentifier ?? row.workItemId,
            );
          }
          await monitorIssueRepository.updateFacts(row.id, facts, tx);
          await monitorIssueRepository.repoint(row.id, item.id, item.identifier, tx);
          return 'moved' as const;
        }

        await monitorIssueRepository.updateFacts(row.id, facts, tx);
        await monitorIssueRepository.markFiled(row.id, item.id, item.identifier, tx);
        return 'linked' as const;
      },
    );

    return { outcome, links: await monitorIssueService.listForWorkItem(item.id, ctx) };
  },

  /**
   * UNLINK one link from the card: DELETE its row (see
   * `monitorIssueRepository.deleteById` for why not null the pointer). If the
   * error happens again and qualifies, the reconciler files a NEW bug for it —
   * the consequence the unlink confirmation states.
   *
   * `{ removed: false }` is a SUCCESS: the link is already gone (a second press,
   * or somebody else got there first). A link that exists and belongs to ANOTHER
   * card is {@link MonitorIssueLinkNotFoundError} — a stale page cannot unlink
   * another card's error.
   */
  async unlinkIssue(
    workItemId: string,
    monitorIssueId: string,
    ctx: ServiceContext,
  ): Promise<{ removed: boolean }> {
    const item = await editableItem(workItemId, ctx);
    const removed = await withWorkspaceContext(
      { ...ctx, projectId: item.projectId },
      async (tx) => {
        const row = await monitorIssueRepository.lockById(monitorIssueId, tx);
        if (!row) return false;
        if (row.workItemId !== item.id) throw new MonitorIssueLinkNotFoundError(monitorIssueId);
        return (await monitorIssueRepository.deleteById(row.id, tx)) === 1;
      },
    );
    return { removed };
  },
};
