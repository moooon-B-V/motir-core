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
import {
  contextFactsOf,
  MONITOR_CONTEXT_SKIPPED,
  writeLinkFacts,
  type MonitorContextRead,
} from '@/lib/services/monitorContextRead';
import {
  monitorCredentialService,
  type MonitorAccessToken,
} from '@/lib/services/monitorCredentialService';
import { monitorSyncService } from '@/lib/services/monitorSyncService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DuplicateLinkError } from '@/lib/workItems/linkErrors';
import { relationshipToLink } from '@/lib/workItems/linkRelationships';
import { ReporterNotInWorkspaceError } from '@/lib/workItems/errors';
import {
  bindWorkspaceContext,
  withSystemContext,
  withWorkspaceContext,
} from '@/lib/workspaces/context';

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

/**
 * The facts a visit writes. The latest event's environment and release
 * (MOTIR-5729) ride on a `read`, and a `failed` read stamps only the evidence's
 * last check (MOTIR-5979) — `contextFactsOf` decides, so a read that was never
 * made (`null` / `skipped`) leaves every context column standing. The EVIDENCE
 * itself is written beside these facts by `writeLinkFacts`, never through them.
 */
function factsOf(
  issue: NormalizedMonitorIssue,
  read: MonitorContextRead | null,
): MonitorIssueFacts {
  return {
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    permalink: issue.permalink,
    eventCount: issue.eventCount,
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
    ...contextFactsOf(read ?? MONITOR_CONTEXT_SKIPPED),
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

/**
 * The most CONTEXT reads (an issue's latest event — its environment and release)
 * ONE poll makes for ONE connection (Story MOTIR-4932 · Subtask MOTIR-5729).
 *
 * ⚠️ THE COST IS ONE PROVIDER REQUEST PER ISSUE VISITED: the issue list carries
 * neither fact, and the only documented read that does is addressed by one issue
 * (`MonitorProvider.getIssueContext`). So a noisy poll is capped here; an issue
 * past the cap reconciles exactly as it always has and its context is refreshed
 * on a later visit. An ENRICHMENT, never a gate on filing.
 */
export const MONITOR_CONTEXT_READS_PER_POLL = 50;

/** What one poll did — the per-connection run's ledger output. */
export interface MonitorPollSummary {
  status: 'ok' | 'failed';
  filed: number;
  updated: number;
  refiled: number;
  /** Issues below the connection's minimum level: counted, never reconciled. */
  skipped: number;
  /**
   * Issues below the minimum level that a person LINKED to a live work item —
   * their facts refreshed, nothing filed (MOTIR-5729). Counted apart so `filed`
   * keeps its meaning.
   */
  refreshed: number;
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
  refreshed: 0,
  pages: 0,
};

/**
 * Read ONE issue's latest-event context with the credential the poll ALREADY
 * holds — never inside a transaction, never with a refresh of its own.
 *
 * ⚠️ EVERY FAILURE IS ABSORBED, AND THAT IS THE RULE, NOT A SHORTCUT: a refusal,
 * a timeout and a gone issue all answer `failed`, which leaves the stored
 * environment, release and evidence exactly as they were and records only WHEN
 * the check failed — what makes the evidence read as stale (MOTIR-5979). Filing must not become less
 * reliable because an enrichment failed (MOTIR-5729; the degrade principle
 * MOTIR-4930 states for the bug body). It deliberately does not go through
 * `withFreshCredential`, so an enrichment's 401 can never be the thing that
 * marks a working connection `degraded` — the listing that just succeeded with
 * this credential is the health signal.
 */
async function readContextQuietly(
  credential: MonitorAccessToken,
  externalIssueId: string,
): Promise<MonitorContextRead> {
  try {
    const context = await getMonitorProvider(credential.provider).getIssueContext({
      accessToken: credential.token,
      orgSlug: credential.orgSlug ?? '',
      externalIssueId,
    });
    return { outcome: 'read', context, at: new Date() };
  } catch {
    return { outcome: 'failed', at: new Date() };
  }
}

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

/**
 * RESOLVE BACK's BACKSTOP (Story MOTIR-4931 · MOTIR-5703), at the end of a
 * successful poll: every claimable link on this connection whose bug is done is
 * resolved, capped. The event is the fast path; this is what makes the loop
 * self-healing — a failed resolve, a crashed one, and a done bug whose status
 * writer emitted no event are all caught here.
 *
 * ⚠️ A SWEEP FAILURE NEVER FAILS THE POLL. The ingestion outcome is already
 * recorded; an unexpected sweep error is caught and recorded on the connection's
 * SYNC failure, where the room shows it, and the poll's summary stands.
 */
async function sweepResolveBack(connectionId: string, resolveOnDone: boolean): Promise<void> {
  if (!resolveOnDone) return;
  try {
    await monitorSyncService.sweepConnection(connectionId);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await withSystemContext((tx) =>
      monitorConnectionRepository.recordSyncFailure(
        connectionId,
        {
          reason: `Resolving done bugs in the monitor stopped: ${why}`,
          workItemIdentifier: null,
          at: new Date(),
        },
        tx,
      ),
    );
  }
}

async function doneKeysOf(projectId: string, workspaceId: string): Promise<Set<string>> {
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
}

/** Record an unexpected assignee-sync error on the connection's SYNC failure —
 *  never on the poll's ingestion outcome, which stands. */
async function recordAssigneeError(connectionId: string, err: unknown): Promise<void> {
  const why = err instanceof Error ? err.message : String(err);
  await withSystemContext((tx) =>
    monitorConnectionRepository.recordSyncFailure(
      connectionId,
      {
        reason: `Taking assignees from the monitor stopped: ${why}`,
        workItemIdentifier: null,
        at: new Date(),
      },
      tx,
    ),
  );
}

/** One reconcile visit's assignee (MOTIR-5705). A failure here never turns a
 *  filed issue into a failed one. */
async function applyAssigneeQuietly(
  target: MonitorReconcileConnection,
  issue: NormalizedMonitorIssue,
  doneKeys: ReadonlySet<string>,
): Promise<void> {
  try {
    await monitorSyncService.applyAssignee(target, issue.externalId, issue.assignee, doneKeys);
  } catch (err) {
    await recordAssigneeError(target.id, err);
  }
}

/** The bounded assignee refresh at the end of a successful poll (MOTIR-5705).
 *  One link's refusal is absorbed inside the refresh; an unexpected error is
 *  recorded on the connection and the poll's outcome stands. */
async function refreshAssigneesQuietly(
  connection: {
    id: string;
    projectId: string;
    workspaceId: string;
    boundByUserId: string | null;
    installationId: string;
  },
  doneKeys: ReadonlySet<string>,
): Promise<void> {
  try {
    await monitorSyncService.refreshAssignees(connection, doneKeys);
  } catch (err) {
    await recordAssigneeError(connection.id, err);
  }
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
    /**
     * The issue's latest-event context read, MADE BY THE CALLER before this
     * method takes its row lock (MOTIR-5729) — a provider call held inside the
     * lock would hold a row lock across a network round trip. Its facts and its
     * evidence (MOTIR-5979) are written with the other facts on every outcome;
     * absent, `null` or `skipped` leaves the stored values alone. It changes no
     * DECISION below.
     */
    read?: MonitorContextRead | null,
  ): Promise<MonitorReconcileResult> {
    const binderId = connection.boundByUserId;
    if (!binderId) throw new MonitorBinderUnavailableError(connection.id, BINDER_MISSING);

    const { projectId, workspaceId } = connection;
    const ctx = { userId: binderId, workspaceId };
    // Reference data, read before the lock: the project's own workflow decides
    // what "done" means, so a team's custom terminal status counts.
    const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
    const doneKeys = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));

    const contextRead = read ?? MONITOR_CONTEXT_SKIPPED;
    const facts = factsOf(issue, contextRead);

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
        await writeLinkFacts(row.id, facts, contextRead, tx);
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
          await writeLinkFacts(row.id, facts, contextRead, tx);
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
          // The provenance stamp the bug ENRICHMENT trigger reads (MOTIR-5849):
          // this create commits before the link below does, so the event must say
          // the link is coming. It changes nothing about the create itself.
          { ...ctx, viaMonitorConnectionId: connection.id },
        );
      } catch (err) {
        if (isBinderRefusal(err)) {
          throw new MonitorBinderUnavailableError(connection.id, BINDER_CANNOT_FILE);
        }
        throw err;
      }

      await writeLinkFacts(row.id, facts, contextRead, tx);
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
   * The FACTS-ONLY refresh of an issue below the connection's minimum level
   * that a person has LINKED to a work item (Story MOTIR-4932 · Subtask
   * MOTIR-5729). Returns whether it wrote.
   *
   * The minimum level is a FILING filter, and it stays one: nothing here files,
   * re-files or re-points. But a hand-made link below the level would otherwise
   * freeze its count and last-seen at the moment it was linked — the one number
   * the Errors section exists to keep honest. So under the SAME claim-or-lock the
   * reconciler takes (lock the row, re-read it), the facts are written when, and
   * only when, the row still points at a LIVE bug: not in a done-category status,
   * not deleted (an archived one is live, as it is for the reconciler). A done
   * bug is skipped exactly as today — re-filing an issue the filter excludes
   * would defeat the filter.
   *
   * SYSTEM context with the workspace bound: `monitor_issue` has a system arm and
   * `work_item` has none, and an unbound read of the bug would come back empty
   * and read as "deleted" (the `monitorSyncService` idiom).
   */
  async refreshLinkedFacts(
    connection: Pick<MonitorReconcileConnection, 'id' | 'projectId' | 'workspaceId'>,
    issue: NormalizedMonitorIssue,
    read?: MonitorContextRead | null,
  ): Promise<boolean> {
    const doneKeys = await doneKeysOf(connection.projectId, connection.workspaceId);
    return withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, connection.workspaceId);
      const lockedId = await monitorIssueRepository.lockByExternalId(
        connection.id,
        issue.externalId,
        tx,
      );
      if (lockedId === null) return false;
      const row = await monitorIssueRepository.findById(lockedId, tx);
      if (!row?.workItemId) return false;
      const bug = await workItemRepository.findById(row.workItemId, tx);
      if (!bug || doneKeys.has(bug.status)) return false;
      const contextRead = read ?? MONITOR_CONTEXT_SKIPPED;
      await writeLinkFacts(row.id, factsOf(issue, contextRead), contextRead, tx);
      return true;
    });
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
   * 3. FILTER: an issue below the minimum level is counted as skipped —
   *    UNLESS a person linked it to a live work item, when its facts are
   *    refreshed and nothing is filed ({@link refreshLinkedFacts}, counted as
   *    `refreshed`; MOTIR-5729). Before each visit the issue's latest-event
   *    context is read OUTSIDE any lock, at most
   *    {@link MONITOR_CONTEXT_READS_PER_POLL} times, and a failed read changes
   *    nothing but those two columns' freshness.
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
    // The credential the LAST successful page was read with — the one the
    // context reads reuse (MOTIR-5729), so they cost no credential round trip.
    let listingCredential: MonitorAccessToken | null = null;
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
          async (credential) => {
            const read = await getMonitorProvider(credential.provider).listIssuesSince({
              accessToken: credential.token,
              orgSlug: credential.orgSlug ?? '',
              externalProjectId: connection.externalProjectId,
              lastSeenAfter,
              cursor: pageCursor,
            });
            listingCredential = credential;
            return read;
          },
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
    // The project's done category, read once — only when the assignee direction
    // is on, so a switched-off connection makes no read on its behalf.
    const assigneeDoneKeys = connection.syncAssignee
      ? await doneKeysOf(connection.projectId, connection.workspaceId)
      : null;
    const target: MonitorReconcileConnection = {
      id: connection.id,
      projectId: connection.projectId,
      workspaceId: connection.workspaceId,
      boundByUserId: connection.boundByUserId,
      externalProjectSlug: connection.externalProjectSlug,
    };
    // A below-minimum issue is worth a visit only when a person linked it to a
    // work item (MOTIR-5729) — ONE read tells those apart from the ones merely
    // skipped, so an unlinked noisy issue never costs a context read.
    const belowMinimum = listed.filter(
      (issue) => !meetsMinimumLevel(issue.level, minimumLevelAtStart),
    );
    const linkedBelowMinimum = new Set(
      belowMinimum.length === 0
        ? []
        : (
            await withSystemContext((tx) =>
              monitorIssueRepository.listLinkedByExternalIds(
                connection.id,
                belowMinimum.map((issue) => issue.externalId),
                tx,
              ),
            )
          ).map((link) => link.externalIssueId),
    );
    // Context reads happen HERE, before `reconcileIssue` / `refreshLinkedFacts`
    // take their row lock, and never more than the cap per poll.
    let contextReads = 0;
    const credentialForContext: MonitorAccessToken | null = listingCredential;
    const contextFor = async (issue: NormalizedMonitorIssue): Promise<MonitorContextRead> => {
      if (!credentialForContext || contextReads >= MONITOR_CONTEXT_READS_PER_POLL) {
        return MONITOR_CONTEXT_SKIPPED;
      }
      contextReads += 1;
      return readContextQuietly(credentialForContext, issue.externalId);
    };
    for (const issue of listed) {
      if (!meetsMinimumLevel(issue.level, minimumLevelAtStart)) {
        if (!linkedBelowMinimum.has(issue.externalId)) {
          summary.skipped += 1;
          continue;
        }
        try {
          const context = await contextFor(issue);
          const wrote = await monitorIngestionService.refreshLinkedFacts(target, issue, context);
          if (wrote) summary.refreshed += 1;
          else summary.skipped += 1;
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          failures.push(`Issue ${issue.externalId} (“${issue.title}”) was not refreshed: ${why}`);
        }
        continue;
      }
      try {
        const context = await contextFor(issue);
        const result = await monitorIngestionService.reconcileIssue(target, issue, context);
        summary[result.outcome] += 1;
        // ASSIGNEE FROM THE MONITOR (MOTIR-4931 · MOTIR-5705), on every reconcile
        // visit, with the assignee the page already carried. A hook BESIDE
        // `reconcileIssue`, never inside it (the loop guard edits that method).
        if (assigneeDoneKeys) {
          await applyAssigneeQuietly(target, issue, assigneeDoneKeys);
        }
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
    await sweepResolveBack(connection.id, connection.resolveOnDone);
    if (assigneeDoneKeys) {
      await refreshAssigneesQuietly(connection, assigneeDoneKeys);
    }
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
