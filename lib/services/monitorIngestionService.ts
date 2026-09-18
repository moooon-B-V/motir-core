import type { MonitorIssue } from '@/generated/prisma/client';
import { MonitorBinderUnavailableError } from '@/lib/monitors/errors';
import type { NormalizedMonitorIssue } from '@/lib/monitors/types';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  monitorIssueRepository,
  type MonitorIssueFacts,
} from '@/lib/repositories/monitorIssueRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DuplicateLinkError } from '@/lib/workItems/linkErrors';
import { relationshipToLink } from '@/lib/workItems/linkRelationships';
import { ReporterNotInWorkspaceError } from '@/lib/workItems/errors';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// The monitor-issue INGESTION service (Story MOTIR-4929) — the reconciler that
// turns a production error into a `bug` work item and keeps it in agreement with
// the monitor.
//
// This file is the ONLY place a monitor issue files, updates or re-files a bug.
// `reconcileIssue` (MOTIR-5578) decides for ONE issue; the poll (MOTIR-5580)
// decides which issues reach it.
//
// ⚠️ IT IS A RECONCILER, NOT AN IMPORT. It brings Motir into agreement with the
// provider's issue as it stands now, so a first sighting, a recurrence, a
// back-fill after an outage and a re-run are all the same code path — keyed on
// the provider's own ISSUE id, which the `monitor_issue` row's unique index
// makes a database fact rather than a read.

/** The create path's title limit. `workItemsService.createWorkItem` enforces
 *  none itself; every interactive creator caps at 200 (`app/(authed)/items/
 *  actions.ts` `MAX_TITLE_LENGTH`, `CreateIssueModal`), so a filed bug is held
 *  to the same bound a person is. */
export const MONITOR_BUG_TITLE_MAX_LENGTH = 200;

/** What one reconcile did. */
export type MonitorReconcileOutcome = 'filed' | 'updated' | 'refiled';

export interface MonitorReconcileResult {
  outcome: MonitorReconcileOutcome;
  /** The bug the issue now points at. */
  workItemId: string;
  identifier: string;
}

/** The binding a reconcile runs for — the columns it reads, and no more. */
export interface MonitorReconcileConnection {
  id: string;
  projectId: string;
  workspaceId: string;
  /** Whose identity files the bug. `null` ⇒ {@link MonitorBinderUnavailableError}. */
  boundByUserId: string | null;
  /** The monitored project's slug, named in the bug body. */
  externalProjectSlug: string;
}

/** Why a bug is being filed AGAIN for an issue that already had one. */
interface PreviousBug {
  identifier: string;
  /** Present when the previous bug still exists (it was completed). */
  workItemId: string | null;
  reason: 'deleted' | 'completed';
}

const BINDER_MISSING =
  'This connection has no binder on record, so its bugs have no one to be filed as. ' +
  'Disconnect it and bind the monitored project again.';

const BINDER_CANNOT_FILE =
  'The person who bound this connection can no longer create work items in this project. ' +
  'Bind the monitored project again as someone who can.';

function factsOf(issue: NormalizedMonitorIssue): MonitorIssueFacts {
  return {
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    permalink: issue.permalink,
    eventCount: issue.eventCount,
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
  };
}

/** The issue's own title, held to the create path's bound. */
export function monitorBugTitle(title: string): string {
  const trimmed = title.trim() || 'Untitled monitor issue';
  return trimmed.length <= MONITOR_BUG_TITLE_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MONITOR_BUG_TITLE_MAX_LENGTH - 1)}…`;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The THIN body, written once at filing and never rewritten: the error's own
 * words and where to see it. Making the bug PLANNED — both content axes, a
 * sizing, context refs — is MOTIR-4930's job, not this one's.
 */
export function monitorBugBody(
  issue: NormalizedMonitorIssue,
  externalProjectSlug: string,
  previous: PreviousBug | null,
): string {
  const lines: string[] = [];
  const culprit = issue.culprit ? `\`${issue.culprit}\`` : 'An unknown location';
  lines.push(`${culprit} · level \`${issue.level ?? 'unknown'}\``);
  lines.push(
    `Seen ${issue.eventCount} ${issue.eventCount === 1 ? 'time' : 'times'}, ` +
      `first ${day(issue.firstSeenAt)}, last ${day(issue.lastSeenAt)}.`,
  );
  const source = `monitored project \`${externalProjectSlug}\``;
  lines.push(
    issue.permalink ? `[Open the issue](${issue.permalink}) in ${source}.` : `From ${source}.`,
  );
  if (previous) {
    lines.push(
      previous.reason === 'deleted'
        ? `Filed again: the earlier bug ${previous.identifier} was deleted.`
        : `Filed again: the earlier bug ${previous.identifier} was completed, and the error has recurred since.`,
    );
  }
  return lines.join('\n\n');
}

/** Is this refusal the create path telling us the BINDER cannot file here? */
function isBinderRefusal(err: unknown): boolean {
  return (
    err instanceof ReporterNotInWorkspaceError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof ProjectNotFoundError
  );
}

export const monitorIngestionService = {
  /**
   * Bring Motir into agreement with ONE provider issue for ONE binding.
   *
   * The `monitor_issue` row is CLAIMED and LOCKED first (insert-if-absent, then
   * `SELECT … FOR UPDATE`), and exactly one outcome applies to its state:
   *
   * | row state                                       | outcome                        |
   * |-------------------------------------------------|--------------------------------|
   * | no bug ever filed                               | `filed`                        |
   * | bug live (not done-category; ARCHIVED counts)   | `updated` — facts only         |
   * | bug in a done-category status                   | `refiled`, `relates_to` the old |
   * | bug deleted (null pointer, key remembered)      | `refiled`, body names the key  |
   *
   * An ARCHIVED bug is live: a person chose to archive it, and filing again
   * would override that choice. A DONE one is never re-opened — the poll only
   * hands this method an issue seen after its watermark, so a done bug here is a
   * recurrence after completion, and we plan forward.
   *
   * ⚠️ WHOSE NAME: the binder's, through `workItemsService.createWorkItem` with
   * the binder's context — every create guard (the edit gate, the reporter
   * membership check, key allocation) runs unchanged. NOT
   * `aiWorkItemsService.fileBug`: it acts as the system principal, which exists
   * only in Motir's own META workspace (`lib/ai/serviceAuth.ts`
   * `resolveSystemPrincipal`) and so cannot file into a customer project. A
   * missing binder, or one the create refuses, is
   * {@link MonitorBinderUnavailableError} and NOTHING is created — the claim is
   * rolled back with it.
   *
   * ⚠️ THE LOCK IS HELD ACROSS THE CREATE — the `filePlannerBug` pattern.
   * `createWorkItem` owns its own transaction and takes no `tx`, so this OUTER
   * transaction holds the `monitor_issue` row while the INNER one inserts the
   * bug on disjoint rows. A second reconciler of the same issue blocks on the
   * lock, then reads the row with `workItemId` set and takes `updated`: two
   * concurrent reconciles of one new issue produce exactly `{filed, updated}`.
   *
   * ⚠️ THE ONE WINDOW THIS ACCEPTS, and it is bounded: a crash after the inner
   * create commits and before the outer transaction commits leaves an unlinked
   * bug, and the next run files a second one. It is the same window
   * `filePlannerBug` accepts for the same reason — closing it would need the
   * create to join a caller's transaction, which it deliberately does not.
   *
   * The `relates_to` edge on a re-file of a COMPLETED bug is written after the
   * outer transaction commits: a failure there leaves a correctly linked row
   * missing only its cross-reference, rather than an unmarked bug the next run
   * would duplicate.
   */
  async reconcileIssue(
    connection: MonitorReconcileConnection,
    issue: NormalizedMonitorIssue,
  ): Promise<MonitorReconcileResult> {
    const binderId = connection.boundByUserId;
    if (!binderId) throw new MonitorBinderUnavailableError(connection.id, BINDER_MISSING);

    const { projectId, workspaceId } = connection;
    const ctx = { userId: binderId, workspaceId };
    // Reference data, read before the lock: the project's own workflow decides
    // what "done" means, so a team's custom terminal status counts.
    const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
    const doneKeys = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));

    const facts = factsOf(issue);

    const settled = await withWorkspaceContext({ ...ctx, projectId }, async (tx) => {
      await monitorIssueRepository.insertIfAbsent(
        {
          connectionId: connection.id,
          projectId,
          workspaceId,
          externalIssueId: issue.externalId,
          ...facts,
        },
        tx,
      );
      const lockedId = await monitorIssueRepository.lockByExternalId(
        connection.id,
        issue.externalId,
        tx,
      );
      const row: MonitorIssue | null = lockedId
        ? await monitorIssueRepository.findById(lockedId, tx)
        : null;
      /* v8 ignore next 3 -- unreachable: the row was inserted or found in THIS
         transaction, under the same binding. */
      if (!row) {
        throw new Error(`monitor_issue row for ${issue.externalId} vanished under its own lock`);
      }

      let previous: PreviousBug | null = null;
      if (row.workItemId) {
        const bug = await workItemRepository.findById(row.workItemId, tx);
        if (bug && !doneKeys.has(bug.status)) {
          await monitorIssueRepository.updateFacts(row.id, facts, tx);
          return {
            outcome: 'updated' as const,
            workItemId: bug.id,
            identifier: bug.identifier,
            relatesTo: null,
          };
        }
        previous = bug
          ? { identifier: bug.identifier, workItemId: bug.id, reason: 'completed' }
          : {
              identifier: row.filedWorkItemIdentifier ?? row.workItemId,
              workItemId: null,
              reason: 'deleted',
            };
      } else if (row.filedWorkItemIdentifier) {
        previous = { identifier: row.filedWorkItemIdentifier, workItemId: null, reason: 'deleted' };
      }

      // Placement comes from the resolver and NOWHERE else (MOTIR-4927): its
      // folder, or the project root when that is what the project chose.
      const { folderId } = await bugDestinationService.resolve(projectId, tx);
      let created;
      try {
        created = await workItemsService.createWorkItem(
          {
            projectId,
            kind: 'bug',
            title: monitorBugTitle(issue.title),
            folderId,
            descriptionMd: monitorBugBody(issue, connection.externalProjectSlug, previous),
          },
          ctx,
        );
      } catch (err) {
        if (isBinderRefusal(err)) {
          throw new MonitorBinderUnavailableError(connection.id, BINDER_CANNOT_FILE);
        }
        throw err;
      }

      await monitorIssueRepository.updateFacts(row.id, facts, tx);
      await monitorIssueRepository.markFiled(row.id, created.id, created.identifier, tx);
      return {
        outcome: previous ? ('refiled' as const) : ('filed' as const),
        workItemId: created.id,
        identifier: created.identifier,
        relatesTo: previous?.reason === 'completed' ? previous.workItemId : null,
      };
    });

    if (settled.relatesTo) {
      // The body names the completed key, and a body that REFERENCES another
      // item already gets a `relates_to` mention edge from the create path
      // (Subtask 5.8.3). The explicit link is what makes the edge a property of
      // this method rather than of the body's wording — so a duplicate is the
      // edge already being there: success, exactly as `link_work_items` treats it.
      try {
        await workItemsService.linkWorkItems(
          relationshipToLink('relates_to', settled.workItemId, settled.relatesTo),
          ctx,
        );
      } catch (err) {
        if (!(err instanceof DuplicateLinkError)) throw err;
      }
    }

    return {
      outcome: settled.outcome,
      workItemId: settled.workItemId,
      identifier: settled.identifier,
    };
  },
};
