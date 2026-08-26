import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { workspacesService } from '@/lib/services/workspacesService';
import { jobsDashboardService, JOBS_PAGE_SIZE } from '@/lib/services/jobsDashboardService';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import type { JobRunStatus } from '@/lib/dto/jobs';
import { JobsDashboard, type JobsTab } from './_components/JobsDashboard';

// Operator dashboard — server component (Subtask 1.6.5). Reads the active
// workspace + the caller's role, resolves the requested tab/filter/page from
// searchParams, fetches just the active tab's data (+ the DLQ badge count) via
// the service layer, and hands typed, serializable data to the client
// JobsDashboard. All reads are workspace-scoped in the service (the system tab
// is gated to a PLATFORM_ADMIN_EMAIL operator both here and in the service).

const VALID_STATUSES: JobRunStatus[] = ['running', 'succeeded', 'failed'];

function parseStatus(raw: string | undefined): JobRunStatus | undefined {
  return raw && (VALID_STATUSES as string[]).includes(raw) ? (raw as JobRunStatus) : undefined;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

interface JobsPageProps {
  searchParams: Promise<{ tab?: string; status?: string; page?: string }>;
}

export default async function WorkspaceJobsPage({ searchParams }: JobsPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[60rem]">
        <EmptyState
          title={t('workspace.empty.title')}
          description={t('workspace.empty.description')}
        />
      </div>
    );
  }

  // The pre-Epic-6 platform-admin escape hatch (Subtask 1.6.3): the System tab
  // is visible only when the request user's email matches PLATFORM_ADMIN_EMAIL.
  // Tracked for replacement with real platform-admin roles in Epic 6
  // (PRODECT_FINDINGS #36).
  const adminEmail = process.env['PLATFORM_ADMIN_EMAIL'];
  const showSystemTab = Boolean(adminEmail) && session.user.email === adminEmail;

  const sp = await searchParams;
  const status = parseStatus(sp.status);
  const page = parsePage(sp.page);

  let requestedTab: JobsTab = sp.tab === 'dlq' || sp.tab === 'system' ? sp.tab : 'runs';
  // Fall back to "runs" if a non-admin lands on ?tab=system (e.g. a shared URL).
  if (requestedTab === 'system' && !showSystemTab) requestedTab = 'runs';

  // MOTIR-3448 — allocation row 11: SERIAL → ONE WAVE, plus the frame.
  //
  // ⚠️ THE MEASUREMENT DIFFERS FROM THE ALLOCATION, and it is one wave rather
  // than the two the asset expected. The asset has `getMemberRole` PRECEDING the
  // other reads, on the reasoning that "the role selects which list is fetched".
  // It does not: which list is fetched is decided by `requestedTab`, and the only
  // thing that can narrow that is `showSystemTab` — which is an env var compared
  // against the session email, with no read behind it at all. `role` is consumed
  // once, as `isOwner`, and it is a PROP on the dashboard. So all THREE reads are
  // independent and go in one wave. This is the heaviest page in the settings
  // family at nine awaits, and it is the one where the difference is worth most.
  //
  // The gate is done at this line, so the boundary is safe here.
  return (
    <div className="mx-auto flex max-w-[60rem] flex-col gap-6">
      {/* REAL, painted from the gate: both strings are `t(...)` with no
          interpolation from a pending read. */}
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('jobs.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('jobs.subtitle')}</p>
      </header>

      <Suspense fallback={<SettingsPaneFrame />}>
        <JobsPaneBody
          userId={ctx.userId}
          workspaceId={ctx.workspaceId}
          requestedTab={requestedTab}
          status={status}
          page={page}
          showSystemTab={showSystemTab}
        />
      </Suspense>
    </div>
  );
}

/**
 * The dashboard's three reads, below the boundary and now in ONE wave: the
 * member role, the DLQ badge count, and whichever list the requested tab names.
 *
 * `allSettledOrThrow` rather than a bare `Promise.all`: every arm opens a
 * transaction, so a rejection on one must not leave the others running
 * unobserved (MOTIR-3066).
 */
async function JobsPaneBody({
  userId,
  workspaceId,
  requestedTab,
  status,
  page,
  showSystemTab,
}: {
  userId: string;
  workspaceId: string;
  requestedTab: JobsTab;
  status: ReturnType<typeof parseStatus>;
  page: number;
  showSystemTab: boolean;
}) {
  const offset = (page - 1) * JOBS_PAGE_SIZE;
  // Fetch one extra row to know whether a "next page" exists without a count.
  const fetchLimit = JOBS_PAGE_SIZE + 1;

  // The DLQ badge count is always shown, regardless of the active tab.
  const [role, dlqCount, list] = await allSettledOrThrow([
    workspacesService.getMemberRole(userId, workspaceId),
    jobsDashboardService.countDLQ({ workspaceId, userId }),
    requestedTab === 'dlq'
      ? jobsDashboardService.listDLQ({ workspaceId, userId, limit: fetchLimit, offset })
      : requestedTab === 'system'
        ? jobsDashboardService.listSystemRuns({ status, limit: fetchLimit, offset })
        : jobsDashboardService.listJobRuns({
            workspaceId,
            userId,
            status,
            limit: fetchLimit,
            offset,
          }),
  ]);

  const isOwner = isOwnerRole(role);
  const dlq =
    requestedTab === 'dlq'
      ? (list as Awaited<ReturnType<typeof jobsDashboardService.listDLQ>>)
      : [];
  const runs =
    requestedTab === 'dlq'
      ? []
      : (list as Awaited<ReturnType<typeof jobsDashboardService.listJobRuns>>);
  const hasNext = list.length > JOBS_PAGE_SIZE;

  return (
    <JobsDashboard
      activeTab={requestedTab}
      status={status}
      page={page}
      hasNext={hasNext}
      dlqCount={dlqCount}
      isOwner={isOwner}
      showSystemTab={showSystemTab}
      runs={runs.slice(0, JOBS_PAGE_SIZE)}
      dlq={dlq.slice(0, JOBS_PAGE_SIZE)}
    />
  );
}
