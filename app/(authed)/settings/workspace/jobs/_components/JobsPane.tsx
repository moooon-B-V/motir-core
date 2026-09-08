import type { JobRunStatus } from '@/lib/dto/jobs';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { jobsDashboardService, JOBS_PAGE_SIZE } from '@/lib/services/jobsDashboardService';
import { workspacesService } from '@/lib/services/workspacesService';
import { JobsDashboard, type JobsTab } from './JobsDashboard';

// The jobs dashboard's PANE — the three reads and the props they become, in ONE
// place because there are TWO doors onto this surface and they must not drift
// (Story MOTIR-4843 · MOTIR-4849).
//
// ⚠️ THIS EXISTS BECAUSE THE FOLD-IN SHIPPED HALF-WIRED, and the shape of that
// bug is worth stating. MOTIR-4861 relocated the dashboard to
// `/settings/organization` below the workspace-tier reveal, which §6d requires —
// but it mounted it with `activeTab="runs"`, `page={1}` and no status, and
// `JobsDashboard` built every tab, filter and pagination link from a
// module-level `BASE = '/settings/workspace/jobs'`. So the section RENDERED, the
// DLQ badge showed a count, and every link inside it pointed at the route the
// same card had just made `notFound()`. The capability was relocated in
// appearance and not in fact — and the DLQ is the one thing a tenant actually
// needs from this surface (a teammate's invite bounced; an owner replays it).
//
// It survived MOTIR-4861's own tests because those MOCK `JobsDashboard` and
// assert the props handed to it. That is the right instrument for "did the gates
// travel" and it is structurally blind to "does the thing you handed them work".
//
// So the pane is shared rather than copied: both hosts parse the same params
// through `parseJobsParams`, make the same reads here, and differ only in the
// `basePath` their links are built from.

const VALID_STATUSES: JobRunStatus[] = ['running', 'succeeded', 'failed', 'abandoned'];

export interface JobsSearchParams {
  tab?: string;
  status?: string;
  page?: string;
}

export interface ParsedJobsParams {
  tab: JobsTab;
  status: JobRunStatus | undefined;
  page: number;
}

/**
 * Read a host's `searchParams` into the pane's three inputs.
 *
 * `showSystemTab` is a parameter rather than something this reads, because the
 * two hosts resolve it from different places (a session on the standalone
 * route, an actor email on the fold-in) and must nonetheless agree: a non-admin
 * arriving on `?tab=system` — from a shared URL, on either door — falls back to
 * `runs` rather than being refused.
 */
export function parseJobsParams(sp: JobsSearchParams, showSystemTab: boolean): ParsedJobsParams {
  const status =
    sp.status && (VALID_STATUSES as string[]).includes(sp.status)
      ? (sp.status as JobRunStatus)
      : undefined;
  const n = Number(sp.page);
  const page = Number.isInteger(n) && n > 0 ? n : 1;
  let tab: JobsTab = sp.tab === 'dlq' || sp.tab === 'system' ? sp.tab : 'runs';
  if (tab === 'system' && !showSystemTab) tab = 'runs';
  return { tab, status, page };
}

/**
 * The dashboard's three reads, in ONE wave.
 *
 * `allSettledOrThrow` rather than a bare `Promise.all`: every arm opens a
 * transaction, so a rejection on one must not leave the others running
 * unobserved (MOTIR-3066).
 */
export async function JobsPane({
  userId,
  workspaceId,
  tab,
  status,
  page,
  showSystemTab,
  basePath,
}: {
  userId: string;
  workspaceId: string;
  showSystemTab: boolean;
  /** Where this pane's own links point — the host that renders it. */
  basePath: string;
} & ParsedJobsParams) {
  const offset = (page - 1) * JOBS_PAGE_SIZE;
  // Fetch one extra row to know whether a "next page" exists without a count.
  const fetchLimit = JOBS_PAGE_SIZE + 1;

  // The DLQ badge count is always shown, regardless of the active tab.
  const [role, dlqCount, list] = await allSettledOrThrow([
    workspacesService.getMemberRole(userId, workspaceId),
    jobsDashboardService.countDLQ({ workspaceId, userId }),
    tab === 'dlq'
      ? jobsDashboardService.listDLQ({ workspaceId, userId, limit: fetchLimit, offset })
      : tab === 'system'
        ? jobsDashboardService.listSystemRuns({ status, limit: fetchLimit, offset })
        : jobsDashboardService.listJobRuns({
            workspaceId,
            userId,
            status,
            limit: fetchLimit,
            offset,
          }),
  ]);

  const dlq =
    tab === 'dlq' ? (list as Awaited<ReturnType<typeof jobsDashboardService.listDLQ>>) : [];
  const runs =
    tab === 'dlq' ? [] : (list as Awaited<ReturnType<typeof jobsDashboardService.listJobRuns>>);

  return (
    <JobsDashboard
      basePath={basePath}
      activeTab={tab}
      status={status}
      page={page}
      hasNext={list.length > JOBS_PAGE_SIZE}
      dlqCount={dlqCount}
      isOwner={isOwnerRole(role)}
      showSystemTab={showSystemTab}
      runs={runs.slice(0, JOBS_PAGE_SIZE)}
      dlq={dlq.slice(0, JOBS_PAGE_SIZE)}
    />
  );
}
