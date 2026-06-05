import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { workspacesService } from '@/lib/services/workspacesService';
import { jobsDashboardService, JOBS_PAGE_SIZE } from '@/lib/services/jobsDashboardService';
import { EmptyState } from '@/components/ui/EmptyState';
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

  const role = await workspacesService.getMemberRole(ctx.userId, ctx.workspaceId);
  const isOwner = isOwnerRole(role);

  // The pre-Epic-6 platform-admin escape hatch (Subtask 1.6.3): the System tab
  // is visible only when the request user's email matches PLATFORM_ADMIN_EMAIL.
  // Tracked for replacement with real platform-admin roles in Epic 6
  // (PRODECT_FINDINGS #36).
  const adminEmail = process.env['PLATFORM_ADMIN_EMAIL'];
  const showSystemTab = Boolean(adminEmail) && session.user.email === adminEmail;

  const sp = await searchParams;
  const status = parseStatus(sp.status);
  const page = parsePage(sp.page);
  const offset = (page - 1) * JOBS_PAGE_SIZE;
  // Fetch one extra row to know whether a "next page" exists without a count.
  const fetchLimit = JOBS_PAGE_SIZE + 1;

  let requestedTab: JobsTab = sp.tab === 'dlq' || sp.tab === 'system' ? sp.tab : 'runs';
  // Fall back to "runs" if a non-admin lands on ?tab=system (e.g. a shared URL).
  if (requestedTab === 'system' && !showSystemTab) requestedTab = 'runs';

  // The DLQ badge count is always shown, regardless of the active tab.
  const dlqCount = await jobsDashboardService.countDLQ({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });

  let runs: Awaited<ReturnType<typeof jobsDashboardService.listJobRuns>> = [];
  let dlq: Awaited<ReturnType<typeof jobsDashboardService.listDLQ>> = [];

  if (requestedTab === 'dlq') {
    dlq = await jobsDashboardService.listDLQ({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      limit: fetchLimit,
      offset,
    });
  } else if (requestedTab === 'system') {
    runs = await jobsDashboardService.listSystemRuns({ status, limit: fetchLimit, offset });
  } else {
    runs = await jobsDashboardService.listJobRuns({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      status,
      limit: fetchLimit,
      offset,
    });
  }

  const list = requestedTab === 'dlq' ? dlq : runs;
  const hasNext = list.length > JOBS_PAGE_SIZE;

  return (
    <div className="mx-auto flex max-w-[60rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('jobs.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('jobs.subtitle')}</p>
      </header>

      <JobsDashboard
        activeTab={requestedTab}
        status={status}
        page={page}
        hasNext={hasNext}
        dlqCount={dlqCount}
        isOwner={isOwner}
        showSystemTab={showSystemTab}
        runs={requestedTab === 'dlq' ? [] : runs.slice(0, JOBS_PAGE_SIZE)}
        dlq={requestedTab === 'dlq' ? dlq.slice(0, JOBS_PAGE_SIZE) : []}
      />
    </div>
  );
}
