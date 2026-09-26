import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Stamp } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { parsePage } from '@/lib/issues/issueListView';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { parseRoomView, ROOM_VIEW_PARAM, type RoomView } from '@/lib/rooms/roomView';
import type { ApprovalRecordsPageDto } from '@/lib/dto/approvalGate';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { RoomViewSwitch } from '@/components/rooms/RoomViewSwitch';
import { ApprovalRecordsList } from './_components/ApprovalRecordsList';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';

// THE APPROVAL RECORDS ROOM (Story MOTIR-5299 · MOTIR-5302) — every approval record
// the reader may see in the active project, pending first then decided, built to
// `design/approvals/approvals-room.mock.html`, with the Mine / Project switch of
// `approvals-room--view-tabs.mock.html` (Story MOTIR-6179 · MOTIR-6333).
//
// A Server Component that resolves the session and the active project and calls
// `approvalGatesService.listRecords` DIRECTLY — the server-component 4-layer path
// every project page takes (`/ready`, `/workbench`). No route, no client fetch.
//
// ⚠️ THIS PAGE DOES NOT DECIDE WHO SEES WHAT. It passes the `?view=` the reader
// ASKED for; the read resolves what that request may show from the reader's
// permissions and returns the SERVED `scope` and the `views` the reader has. The
// switch is drawn only when both are available; one view is drawn alone; none is
// the not-found face (MOTIR-6332 hides the nav door onto it too). A reader who may
// not see a record cannot address it here by any URL.
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
  const requested = parseRoomView(params[ROOM_VIEW_PARAM]);

  // A FAILED READ IS NOT AN EMPTY ONE (design MOTIR-6327 § the failed read): the
  // read is caught here and the shipped `ErrorState` renders under the header,
  // the switch staying, so the other view is one press away.
  let records: ApprovalRecordsPageDto | null = null;
  try {
    records = await approvalGatesService.listRecords(ctx, {
      page: parsePage(params['page']),
      view: requested,
    });
  } catch {
    records = null;
  }
  const views: RoomView[] = records
    ? records.views
    : await approvalGatesService.recordViews(ctx).catch(() => []);
  if (views.length === 0 && records) notFound();
  const served: RoomView =
    records?.scope ?? (requested && views.includes(requested) ? requested : (views[0] ?? 'mine'));

  return (
    <div data-testid="approval-records" className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-secondary)">
            {served === 'project' ? t('subtitle.full') : t('subtitle.own')}
          </p>
        </div>
        {views.length > 1 ? (
          // A switch drops `page`: each view has its own pager and clamp.
          <RoomViewSwitch value={served} label={t('viewAria')} drop={['page']} />
        ) : null}
      </header>

      {records === null ? (
        <ErrorState title={t('readFailedTitle')} description={t('readFailedBody')} />
      ) : records.total === 0 ? (
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
          every other parameter — the room's own `?page=` and `?view=` included. */}
      <IssueQuickViewController />
    </div>
  );
}
