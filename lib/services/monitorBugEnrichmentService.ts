import 'server-only';

import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveProjectCodeContext } from '@/lib/ai/codeContext';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { BugAuthoringContext } from '@/lib/ai/types';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { getMonitorProvider } from '@/lib/monitors';
import { MonitorLinkNotYetVisibleError } from '@/lib/monitors/errors';
import type { NormalizedMonitorIssueContext } from '@/lib/monitors/types';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { withSystemContext } from '@/lib/workspaces/context';
import { readProject } from '@/lib/workspaces/tenantRead';

// The bug ENRICHMENT trigger's dispatch (Story MOTIR-4930 · Subtask MOTIR-5849) —
// when the monitor reconciler files a `bug`, ask motir-ai to PLAN it: assemble
// the issue's facts, re-read its latest event for the stack frames, resolve the
// project's repository set, and submit exactly ONE `author_bug` job.
//
// ⚠️ IT WRITES NOTHING ONTO THE CARD AND READS NO RESULT. Its outcome is a
// dispatch, recorded as the job id on the link row. Carrying the answer back onto
// the bug is MOTIR-5851's.
//
// ⚠️ IT RUNS IN ITS OWN JOB, AFTER THE FILING COMMITTED — the whole safety
// property. `lib/jobs/definitions/monitorBugEnrich.ts` rides `work-item/created`,
// which is emitted post-commit, so a model call can never sit inside
// `reconcileIssue`'s transaction, and a dispatch that fails is retried without the
// filing ever knowing. There is no arrangement of this code in which a failed
// enrichment loses a bug, because the bug exists before enrichment can start.
//
// The template is `aiBugTelemetryService.dispatchOutwardAnalysis`: every
// not-a-candidate answer is a VALUE, and only a genuine transport failure (or the
// ordering window below) throws, for the retry budget to absorb.

/** The `work-item/created` fields the trigger forwards. */
export interface MonitorBugEnrichmentTrigger {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  actorId: string;
  /** Monitor provenance — present only when the reconciler FILED the item. */
  viaMonitorConnectionId?: string;
}

/** Why nothing was dispatched. Each is a normal answer, never a failure. */
export type MonitorBugEnrichmentSkip =
  /** No motir-ai backend on this deployment (a self-hosted open-core build). */
  | 'ai-not-configured'
  /** The created item is not a `bug` (or is already gone). */
  | 'not-a-bug'
  /** No monitor link points at it — the bug was filed by hand. */
  | 'no-monitor-link'
  /** The link already carries a dispatched job — a redelivered event. */
  | 'already-dispatched'
  /** The binding has no binder to act as, so there is no identity to submit AS. */
  | 'no-binder';

export type MonitorBugEnrichmentOutcome =
  | { dispatched: true; jobId: string; framesRead: boolean }
  | { dispatched: false; reason: MonitorBugEnrichmentSkip };

/** Whether the closed motir-ai backend is wired for this deployment — the probe
 *  `aiBugTelemetryService` uses. Unconfigured is a VALUE: a self-hosted build must
 *  not dead-letter on every monitor bug. */
function motirAiConfigured(): boolean {
  return Boolean(process.env['MOTIR_AI_URL'] && process.env['MOTIR_AI_SERVICE_TOKEN']);
}

const iso = (d: Date) => d.toISOString();

export const monitorBugEnrichmentService = {
  /**
   * Decide whether a freshly-created work item is a monitor bug awaiting
   * enrichment and, if so, dispatch ONE `author_bug` job for it.
   *
   * Eligibility, in order, each a cheap read before an expensive one: motir-ai
   * configured → the item is a `bug` → the reconciler filed it (provenance) and a
   * link row points at it → that row has no `authoringJobId` → the binding has a
   * binder. Only then is anything assembled.
   *
   * ⚠️ IDEMPOTENT ON THE LINK ROW. `authoringJobId` is read before the submit and
   * written after it, so a sequentially redelivered event dispatches nothing. Two
   * CONCURRENT deliveries of one event are not a shape the job engine produces
   * (it claims one run at a time), so the check-submit-mark sequence is not
   * locked; the conditional write still refuses a second key.
   */
  async dispatchEnrichment(
    trigger: MonitorBugEnrichmentTrigger,
  ): Promise<MonitorBugEnrichmentOutcome> {
    if (!motirAiConfigured()) return { dispatched: false, reason: 'ai-not-configured' };

    // The event omits `kind`, so the item is read — AS its creator, who for a
    // monitor bug is the binder. Reading it here is also the proof that this runs
    // after the create committed: an uncommitted row is not visible to this read.
    let item: WorkItemDto;
    try {
      item = await workItemsService.getWorkItem(trigger.workItemId, {
        userId: trigger.actorId,
        workspaceId: trigger.workspaceId,
      });
    } catch (err) {
      if (err instanceof WorkItemNotFoundError) return { dispatched: false, reason: 'not-a-bug' };
      throw err;
    }
    if (item.kind !== 'bug') return { dispatched: false, reason: 'not-a-bug' };

    // A bug filed by hand carries no provenance and cannot have a link at the
    // moment of its creation (a hand-made link is made afterwards, to an EXISTING
    // card) — so there is nothing to look up.
    const connectionId = trigger.viaMonitorConnectionId;
    if (!connectionId) return { dispatched: false, reason: 'no-monitor-link' };

    const { link, connection } = await withSystemContext(async (tx) => ({
      link: await monitorIssueRepository.findByWorkItemId(connectionId, item.id, tx),
      connection: await monitorConnectionRepository.findById(connectionId, tx),
    }));
    // The ordering window: the reconciler's link commits just after the create.
    if (!link) {
      if (!connection) return { dispatched: false, reason: 'no-monitor-link' };
      throw new MonitorLinkNotYetVisibleError(connectionId, item.id);
    }
    if (link.authoringJobId) return { dispatched: false, reason: 'already-dispatched' };
    if (!connection?.boundByUserId) return { dispatched: false, reason: 'no-binder' };

    const binder = { userId: connection.boundByUserId, workspaceId: trigger.workspaceId };

    // The latest event, for the frames. A failed or refused read DEGRADES the
    // envelope — frames are the best input, not a required one — exactly as the
    // reconciler's own context read degrades. The stored environment and release
    // then stand in.
    const context = await readLatestEventQuietly(connection.installationId, link.externalIssueId);

    const project = await readProject(trigger.projectId, binder);
    if (!project?.identifier) return { dispatched: false, reason: 'not-a-bug' };

    const code = await resolveProjectCodeContext({ ...binder, projectId: trigger.projectId });

    const bugAuthoring: BugAuthoringContext = {
      issue: {
        title: link.title,
        culprit: link.culprit,
        level: link.level,
        eventCount: link.eventCount,
        firstSeenAt: iso(link.firstSeenAt),
        lastSeenAt: iso(link.lastSeenAt),
        permalink: link.permalink,
      },
      environment: context ? context.environment : link.environment,
      release: context ? context.release : link.release,
      frames: context?.frames ?? [],
      monitoredProjectSlug: connection.externalProjectSlug,
    };

    const { organizationId, isMeta, internalBilling } = await resolveTenantOrg(binder);
    const { jobId } = await submitJob(
      'author_bug',
      {
        organizationId,
        isMeta,
        internalBilling,
        workspaceId: trigger.workspaceId,
        projectId: trigger.projectId,
        projectKey: project.identifier,
      },
      // `code` absent — not an empty set — for a project with no established
      // repository: motir-ai reads that as `no_repos` and degrades.
      { bugAuthoring, ...(code ? { code } : {}) },
      // AS THE BINDER: the identity the bug was filed as, so the job token is
      // scoped to a user who can actually see this project.
      { userId: binder.userId },
    );

    await withSystemContext((tx) =>
      monitorIssueRepository.markAuthoringDispatched(link.id, jobId, tx),
    );
    return { dispatched: true, jobId, framesRead: context !== null };
  },
};

/**
 * ONE latest-event read through `withFreshCredential` — `null` on ANY failure (a
 * refused or degraded credential, a timeout, a gone issue). Never inside a
 * transaction. An enrichment's failure must never be louder than the filing it
 * enriches.
 */
async function readLatestEventQuietly(
  installationRowId: string,
  externalIssueId: string,
): Promise<NormalizedMonitorIssueContext | null> {
  try {
    return await monitorCredentialService.withFreshCredential(installationRowId, (credential) =>
      getMonitorProvider(credential.provider).getIssueContext({
        accessToken: credential.token,
        orgSlug: credential.orgSlug ?? '',
        externalIssueId,
      }),
    );
  } catch {
    return null;
  }
}
