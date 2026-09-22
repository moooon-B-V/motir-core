import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Stamp } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { parsePage } from '@/lib/issues/issueListView';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { EmptyState } from '@/components/ui/EmptyState';
import { ApprovalRecordsList } from './_components/ApprovalRecordsList';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';

// THE APPROVAL RECORDS ROOM (Story MOTIR-5299 · MOTIR-5302) — every approval record
// the reader may see in the active project, pending first then decided, built to
// `design/approvals/approvals-room.mock.html`.
//
// A Server Component that resolves the session and the active project and calls
// `approvalGatesService.listRecords` DIRECTLY — the server-component 4-layer path
// every project page takes (`/ready`, `/workbench`). No route, no client fetch.
//
// ⚠️ THIS PAGE DOES NOT DECIDE WHO SEES WHAT. The read resolves the reader's scope
// from their permissions and returns `fullView` as a fact about its answer; the
// page passes only the page number, and no query parameter reaches the scope. A
// reader who may not see a record cannot address it here by any URL.
//
// ⚠️ A PENDING OR DECIDED ROW OPENS THE APPROVAL OVERLAY that `app/(authed)/layout.tsx`
// mounts once for the whole shell (Story MOTIR-5214), addressed exactly as the
// Workbench's To-approve row addresses it. This room composes no verb.

export default async function ApprovalRecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at the
  // WORKSPACE tier); the guard stays because the type does.
  if (!ctx) redirect('/sign-in');

  const params = await searchParams;
  const t = await getTranslations('approvalRecords');
  const records = await approvalGatesService.listRecords(ctx, { page: parsePage(params['page']) });

  return (
    <div data-testid="approval-records" className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        <p className="text-sm text-(--el-text-secondary)">
          {records.fullView ? t('subtitle.full') : t('subtitle.own')}
        </p>
      </header>

      {records.total === 0 ? (
        // NOTHING AT ALL — never a permission-shaped sentence: a reader with no
        // records has simply not been asked anything yet (`design/approvals` §
        // Empty states). No action, because nothing a reader presses creates one.
        <EmptyState
          icon={<Stamp className="h-12 w-12" aria-hidden />}
          title={t('empty.title')}
          description={records.fullView ? t('empty.bodyFull') : t('empty.bodyOwn')}
        />
      ) : (
        <ApprovalRecordsList records={records} />
      )}
      {/* The quick-view island a row's TITLE opens (Story MOTIR-5996 · MOTIR-6001): the
          same `?peek=` controller /workbench, /items, /ready and the board mount, so a
          title click here is the same interaction as everywhere else. Closing it keeps
          every other parameter — the room's own `?page=` included. */}
      <IssueQuickViewController />
    </div>
  );
}
