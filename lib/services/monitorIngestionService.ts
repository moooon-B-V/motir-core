import type { MonitorIssue } from '@/generated/prisma/client';
import { getMonitorProvider } from '@/lib/monitors';
import { MonitorBinderUnavailableError, MonitorProviderCallError } from '@/lib/monitors/errors';
import { meetsMinimumLevel } from '@/lib/monitors/levels';
import { MONITOR_ISSUES_PAGE_LIMIT } from '@/lib/monitors/provider';
import type { NormalizedMonitorIssue, NormalizedMonitorIssuePage } from '@/lib/monitors/types';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  monitorIssueRepository,
  type MonitorIssueFacts,
} from '@/lib/repositories/monitorIssueRepository';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DuplicateLinkError } from '@/lib/workItems/linkErrors';
import { relationshipToLink } from '@/lib/workItems/linkRelationships';
import { ReporterNotInWorkspaceError } from '@/lib/workItems/errors';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';

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

/**
 * The most pages ONE poll reads before it stops and says so.
 *
 * A bound, not a budget: a connection that has accumulated more than this many
 * pages of issues since its last check (a first poll on a noisy organisation, or
 * the back-fill after a long outage) records a FAILED outcome naming the count
 * and does NOT advance its watermark — loud, rather than silently reconciling a
 * truncated prefix and moving on as if it had seen everything. Raising the
 * connection's minimum level is the lever a person has.
 */
export const MONITOR_POLL_MAX_PAGES = 20;

/** What one poll did — the per-connection run's ledger output. */
export interface MonitorPollSummary {
  status: 'ok' | 'failed';
  filed: number;
  updated: number;
  refiled: number;
  /** Issues below the connection's minimum level: counted, never reconciled. */
  skipped: number;
  pages: number;
}

/** A poll that never started: the connection is gone (deleted between the tick
 *  and this run). Nothing to record ON, so it is reported as a no-op. */
const NOTHING_POLLED: MonitorPollSummary = {
  status: 'ok',
  filed: 0,
  updated: 0,
  refiled: 0,
  skipped: 0,
  pages: 0,
};

async function recordOutcome(
  connectionId: string,
  outcome: { status: 'ok' | 'failed'; error: string | null; filedCount: number | null },
): Promise<void> {
  await withSystemContext((tx) =>
    monitorConnectionRepository.recordPollOutcome(
      connectionId,
      { ...outcome, polledAt: new Date() },
      tx,
    ),
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
   * | bug done, and MOTIR resolved the issue with no   | `updated` — facts only (the     |
   * |   sighting since (MOTIR-5704's loop guard)       |   loop guard)                   |
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
      /* v8 ignore next 3 -- unreachable: the row was inserted (or already
         present) in THIS transaction, under the same binding, so the lock finds
         it. Asserted by `tests/monitors/monitor-issue-store.test.ts` › "two
         simultaneous claims of one issue leave ONE row, and the loser reads the
         winner’s". */
      if (lockedId === null) {
        throw new Error(`monitor_issue row for ${issue.externalId} vanished under its own lock`);
      }
      const row: MonitorIssue | null = await monitorIssueRepository.findById(lockedId, tx);
      /* v8 ignore next 3 -- unreachable for the same reason: it was just locked. */
      if (!row) {
        throw new Error(`monitor_issue row for ${issue.externalId} vanished under its own lock`);
      }

      // The bug the row points at, if any. A DELETED bug cannot be found here:
      // the FK is ON DELETE SET NULL, so deleting it cleared `workItemId` in the
      // same statement — and it keeps `filedWorkItemIdentifier`, which is how
      // "deleted" is told from "never filed" below.
      const bug = row.workItemId ? await workItemRepository.findById(row.workItemId, tx) : null;
      if (bug && !doneKeys.has(bug.status)) {
        await monitorIssueRepository.updateFacts(row.id, facts, tx);
        return {
          outcome: 'updated' as const,
          workItemId: bug.id,
          identifier: bug.identifier,
          relatesTo: null,
        };
      }
      // ── THE LOOP GUARD (Story MOTIR-4931 · Subtask MOTIR-5704) ──────────────
      // A done bug whose issue MOTIR ITSELF resolved, and which nobody has seen
      // since, is already reconciled — not a recurrence. Two orderings reach
      // this branch with no recurrence at all: a STALE PAGE (fetched while the
      // issue was unresolved, reconciled after the bug completed and the resolve
      // landed) and an IN-FLIGHT resolve (claimed `pending`, provider call not
      // yet returned). Both carry a resolve attempt and a `lastSeenAt` at or
      // before Motir's write, so both take `updated` — facts only, no work item
      // written. The guard reads MOTIR-side state only: on a shared credential
      // "we resolved it" and "they resolved it" are one identity to the
      // provider, so the provider's actor cannot tell them apart.
      //
      // ⚠️ THE ONE WINDOW IT ACCEPTS: the provider's `lastSeen` and Motir's clock
      // are different clocks. A regression whose ONLY event lands within the
      // clock skew of Motir's resolve reads as settled until its next event, and
      // that event then re-files normally.
      //
      // `updated` rather than a new outcome member, deliberately: it already
      // means "facts only, no card", and a new member would thread through the
      // poll summary and the room's poll line for no difference a person sees.
      if (bug && row.resolveAttemptedAt !== null) {
        const motirWrite = Math.max(
          row.resolveAttemptedAt.getTime(),
          row.resolvedByMotirAt?.getTime() ?? 0,
        );
        if (issue.lastSeenAt.getTime() <= motirWrite) {
          await monitorIssueRepository.updateFacts(row.id, facts, tx);
          return {
            outcome: 'updated' as const,
            workItemId: bug.id,
            identifier: bug.identifier,
            relatesTo: null,
          };
        }
      }

      const previous: PreviousBug | null = bug
        ? { identifier: bug.identifier, workItemId: bug.id, reason: 'completed' }
        : row.filedWorkItemIdentifier
          ? { identifier: row.filedWorkItemIdentifier, workItemId: null, reason: 'deleted' }
          : null;

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

  /**
   * Run ONE reconcile pass for ONE binding, and record on that binding what
   * happened (Story MOTIR-4929 · Subtask MOTIR-5580). The scheduled job calls
   * it (MOTIR-5581) and nothing else does.
   *
   * 1. READ the binding in system context. The watermark in effect is
   *    `lastSeenWatermark ?? createdAt` — the NEW-issue rule: nothing from before
   *    the binding is back-filled. The minimum level read HERE is what the final
   *    advance compares against.
   * 2. LIST every page since the watermark through
   *    `monitorCredentialService.withFreshCredential` — it refreshes an expired
   *    token, retries once on a 401, and writes `degraded` with the provider's
   *    reason on a second refusal. Stops at a `null` cursor or at
   *    {@link MONITOR_POLL_MAX_PAGES}, which is a FAILED outcome with the
   *    watermark left where it was — loud, never a silent truncation.
   * 3. FILTER: an issue below the minimum level is counted as skipped.
   * 4. RECONCILE each remaining issue through {@link reconcileIssue}. One issue
   *    failing (a binder refusal included) does not stop the others.
   * 5. RECORD: all reconciled ⇒ advance the watermark (compare-and-set on the
   *    level read at 1, so a lowering that landed mid-poll is NOT undone), record
   *    `ok`, and write the grant's health `connected` — a working poll is
   *    evidence the credential works, so "checked N minutes ago" stays true. Any
   *    failure ⇒ record `failed` naming it and do NOT advance, so the failed
   *    issue is read again next time. A PROVIDER refusal records `failed` with
   *    the provider's own reason and RETURNS rather than throws, so a revoked
   *    credential does not burn the job's retries. Anything else is thrown for
   *    the job's retry and terminal path.
   *
   * ⚠️ IT NEVER PROBES. `monitorCredentialService.probeHealth` is the settings
   * room's door, and it asserts a person's permission; a job reaching for it is
   * the boundary MOTIR-5261 drew. The poll's own success is its health signal.
   */
  async pollConnection(connectionId: string): Promise<MonitorPollSummary> {
    const connection = await withSystemContext((tx) =>
      monitorConnectionRepository.findById(connectionId, tx),
    );
    if (!connection) return NOTHING_POLLED;

    const minimumLevelAtStart = connection.minimumLevel;
    const lastSeenAfter = connection.lastSeenWatermark ?? connection.createdAt;

    // ── 2. LIST ────────────────────────────────────────────────────────────────
    const listed: NormalizedMonitorIssue[] = [];
    let pages = 0;
    let cursor: string | null = null;
    try {
      do {
        if (pages === MONITOR_POLL_MAX_PAGES) {
          const reason =
            `More than ${MONITOR_POLL_MAX_PAGES * MONITOR_ISSUES_PAGE_LIMIT} issues ` +
            `(${MONITOR_POLL_MAX_PAGES} pages) since the last check. Nothing was skipped silently: ` +
            'raise the minimum level, or the next check reads them again.';
          await recordOutcome(connection.id, { status: 'failed', error: reason, filedCount: null });
          return { ...NOTHING_POLLED, status: 'failed', pages };
        }
        const pageCursor: string | null = cursor;
        const page: NormalizedMonitorIssuePage = await monitorCredentialService.withFreshCredential(
          connection.installationId,
          (credential) =>
            getMonitorProvider(credential.provider).listIssuesSince({
              accessToken: credential.token,
              orgSlug: credential.orgSlug ?? '',
              externalProjectId: connection.externalProjectId,
              lastSeenAfter,
              cursor: pageCursor,
            }),
        );
        pages += 1;
        listed.push(...page.issues);
        cursor = page.nextCursor;
      } while (cursor !== null);
    } catch (err) {
      if (!(err instanceof MonitorProviderCallError)) throw err;
      // `withFreshCredential` has already written `degraded` where the refusal
      // was the credential's. Either way the reason is the PROVIDER's own words.
      await recordOutcome(connection.id, {
        status: 'failed',
        error: err.providerReason,
        filedCount: null,
      });
      return { ...NOTHING_POLLED, status: 'failed', pages };
    }

    // ── 3–4. FILTER + RECONCILE ──────────────────────────────────────────────
    const summary: MonitorPollSummary = { ...NOTHING_POLLED, pages };
    const failures: string[] = [];
    const target: MonitorReconcileConnection = {
      id: connection.id,
      projectId: connection.projectId,
      workspaceId: connection.workspaceId,
      boundByUserId: connection.boundByUserId,
      externalProjectSlug: connection.externalProjectSlug,
    };
    for (const issue of listed) {
      if (!meetsMinimumLevel(issue.level, minimumLevelAtStart)) {
        summary.skipped += 1;
        continue;
      }
      try {
        const result = await monitorIngestionService.reconcileIssue(target, issue);
        summary[result.outcome] += 1;
      } catch (err) {
        const why =
          err instanceof MonitorBinderUnavailableError
            ? err.reason
            : err instanceof Error
              ? err.message
              : String(err);
        failures.push(`Issue ${issue.externalId} (“${issue.title}”) was not filed: ${why}`);
      }
    }

    // ── 5. RECORD ─────────────────────────────────────────────────────────────
    if (failures.length > 0) {
      const error =
        failures.length === 1
          ? failures[0]!
          : `${failures[0]!} (and ${failures.length - 1} more issue${failures.length === 2 ? '' : 's'})`;
      await recordOutcome(connection.id, { status: 'failed', error, filedCount: null });
      return { ...summary, status: 'failed' };
    }

    if (listed.length > 0) {
      const newest = new Date(Math.max(...listed.map((issue) => issue.lastSeenAt.getTime())));
      await withSystemContext((tx) =>
        monitorConnectionRepository.advanceWatermark(
          connection.id,
          newest,
          minimumLevelAtStart,
          tx,
        ),
      );
    }
    await recordOutcome(connection.id, {
      status: 'ok',
      error: null,
      filedCount: summary.filed + summary.refiled,
    });
    await withSystemContext((tx) =>
      monitorInstallationRepository.updateHealth(
        connection.installationId,
        { health: 'connected', healthReason: null, healthCheckedAt: new Date() },
        tx,
      ),
    );
    return summary;
  },

  /**
   * Every binding the scheduled tick should poll — its id and whose it is —
   * across every workspace (MOTIR-5581). SYSTEM context: the tick does not know
   * whose bindings exist until it has read them.
   */
  async listPollableConnections(): Promise<Array<{ id: string; workspaceId: string }>> {
    const rows = await withSystemContext((tx) => monitorConnectionRepository.listForPolling(tx));
    return rows.map((row) => ({ id: row.id, workspaceId: row.workspaceId }));
  },

  /**
   * Write a TERMINAL poll failure onto the binding (MOTIR-5581) — the job's final
   * attempt calls this before rethrowing into the dead-letter queue, so the
   * failure is visible in the Monitoring room and not only in a table nobody
   * reads (MOTIR-4918). A binding deleted in the meantime has nowhere to show
   * it, so that write is skipped rather than thrown over the real error.
   */
  async recordTerminalFailure(connectionId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await withSystemContext(async (tx) => {
      const row = await monitorConnectionRepository.findById(connectionId, tx);
      if (!row) return;
      await monitorConnectionRepository.recordPollOutcome(
        connectionId,
        {
          status: 'failed',
          error: `The check stopped after repeated failures: ${message}`,
          filedCount: null,
          polledAt: new Date(),
        },
        tx,
      );
    });
  },
};
