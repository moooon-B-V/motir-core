import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  motirAiConfigured,
  workItemEmbeddingsService,
  type WitnessProbe,
} from '@/lib/services/workItemEmbeddingsService';
import { withSystemContext } from '@/lib/workspaces/context';

// The work-item EMBEDDING SWEEP (Story MOTIR-8226 · MOTIR-8227) — the safety net
// under the event-driven write path. A work item is embedded by a job its create
// or edit enqueues; when that job is lost (dead-lettered, enqueued before the
// feature existed, never enqueued because a call site was missed) nothing ever
// looks at the item again, and it silently stops being a search candidate. This
// sweep is the "looks again": it embeds every live item whose vector is missing or
// whose stored hash no longer matches its text.
//
// THE TENANCY SHAPE (the same split `dispatchRunSweepService` states): discovering
// projects reads across tenants under `withSystemContext`; every read and write of
// an item's rows then runs inside THAT project's own workspace context, via
// `workItemEmbeddingsService.backfillBatch`.
//
// BOUNDED, NOT EXHAUSTIVE. One run embeds at most {@link EMBEDDING_SWEEP_MAX_EMBEDS_PER_RUN}
// items and scans at most {@link EMBEDDING_SWEEP_MAX_PAGES_PER_RUN} pages, because
// every embedded item is a metered call onto a tenant's credit ledger and a
// backlog must drain over several runs, not in one burst. The hash comparison
// makes a finished item free, so the next run simply continues where this left
// off. `truncated` says the cap, not the end of the data, stopped the run.
//
// AN OUTAGE FAILS THE RUN; A POISON ITEM DOES NOT. `backfillBatch` isolates an
// item the provider refuses and records the attempt on the item; anything else it
// throws (transport, 5xx, auth, a witness probe that also fails) propagates, so
// the job's retry policy and dead-letter see a real outage as one.

/** Items one run may embed across all projects (metered calls). */
export const EMBEDDING_SWEEP_MAX_EMBEDS_PER_RUN = 500;
/** Pages of 200 items one run may scan across all projects (cheap local reads). */
export const EMBEDDING_SWEEP_MAX_PAGES_PER_RUN = 1_000;
/** Projects discovered per read. */
export const EMBEDDING_SWEEP_PROJECT_PAGE = 100;

export interface WorkItemEmbeddingSweepSummary {
  /** False when motir-ai is not configured here: nothing was attempted. */
  configured: boolean;
  projectsVisited: number;
  scanned: number;
  embedded: number;
  /** Items the provider refused in THIS run (attempt recorded on the item). */
  failed: number;
  failedIds: string[];
  /** Items at the attempt limit (skipped, or reaching it in this run). */
  givenUp: number;
  givenUpIds: string[];
  /** The per-run cap, not the end of the data, stopped the sweep. */
  truncated: boolean;
}

export const workItemEmbeddingSweepService = {
  async sweep(
    caps: { maxEmbeds?: number; maxPages?: number } = {},
  ): Promise<WorkItemEmbeddingSweepSummary> {
    const maxEmbeds = caps.maxEmbeds ?? EMBEDDING_SWEEP_MAX_EMBEDS_PER_RUN;
    const maxPages = caps.maxPages ?? EMBEDDING_SWEEP_MAX_PAGES_PER_RUN;
    const summary: WorkItemEmbeddingSweepSummary = {
      configured: motirAiConfigured(),
      projectsVisited: 0,
      scanned: 0,
      embedded: 0,
      failed: 0,
      failedIds: [],
      givenUp: 0,
      givenUpIds: [],
      truncated: false,
    };
    if (!summary.configured) return summary;

    const witness: WitnessProbe = { confirmed: false };
    let pages = 0;
    let projectCursor: string | undefined;

    for (;;) {
      const projects = await withSystemContext((tx) =>
        projectRepository.listLiveAcrossWorkspaces(
          {
            take: EMBEDDING_SWEEP_PROJECT_PAGE,
            ...(projectCursor ? { cursor: projectCursor } : {}),
          },
          tx,
        ),
      );
      if (projects.length === 0) break;

      for (const project of projects) {
        summary.projectsVisited += 1;
        let afterId: string | null = null;
        do {
          if (summary.embedded >= maxEmbeds || pages >= maxPages) {
            summary.truncated = true;
            return summary;
          }
          const batch = await workItemEmbeddingsService.backfillBatch({
            workspaceId: project.workspaceId,
            projectId: project.id,
            afterId,
            witness,
          });
          pages += 1;
          summary.scanned += batch.scanned;
          summary.embedded += batch.embedded;
          summary.failed += batch.failed;
          summary.failedIds.push(...batch.failedIds);
          summary.givenUp += batch.givenUp;
          summary.givenUpIds.push(...batch.givenUpIds);
          afterId = batch.nextAfterId;
        } while (afterId !== null);
      }

      if (projects.length < EMBEDDING_SWEEP_PROJECT_PAGE) break;
      projectCursor = projects[projects.length - 1]!.id;
    }
    return summary;
  },
};
