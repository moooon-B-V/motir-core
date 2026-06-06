import { getLocale } from 'next-intl/server';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { Locale } from '@/lib/i18n/locales';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { IssueQuickViewPanel, type QuickViewData } from './IssueQuickViewPanel';

// The data half of the quick-view peek (Subtask 2.5.19) — an async Server
// Component the /issues page renders INSIDE the IssueQuickView modal frame,
// behind a <Suspense> so the modal opens immediately with the skeleton while
// this fetches. It reuses the shipped detail aggregate read
// `getIssueDetail(projectId, key, ctx)` (2.4) — so the workspace/membership gate
// and the not-found / no-access path are INHERITED, not re-implemented: a stale,
// deleted, or cross-workspace `peek` key throws WorkItemNotFoundError, which we
// render as the design's not-found state (never a crash, never an existence
// leak). The peek shows the full description + the condensed core-fields rail,
// so it shapes a serializable slice of the detail DTO for the presentational
// IssueQuickViewPanel (no new read added — the card's reuse contract).

export interface IssueQuickViewContentProps {
  projectId: string;
  ctx: { userId: string; workspaceId: string };
  peekKey: string;
  /** Workspace members — resolve assignee / reporter ids to display names. */
  members: WorkspaceMemberDTO[];
}

export async function IssueQuickViewContent({
  projectId,
  ctx,
  peekKey,
  members,
}: IssueQuickViewContentProps) {
  const locale = (await getLocale()) as Locale;

  let detail;
  try {
    detail = await workItemsService.getIssueDetail(projectId, peekKey, ctx);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return <IssueQuickViewPanel state="notfound" peekKey={peekKey} />;
    }
    throw err;
  }

  const { item, parent, workflow } = detail;
  const nameById = new Map(members.map((m) => [m.userId, m.name || m.email]));
  const status = workflow.statuses.find((s) => s.key === item.status);

  const data: QuickViewData = {
    identifier: item.identifier,
    title: item.title,
    kind: item.kind,
    statusLabel: status?.label ?? item.status,
    statusCategory: status?.category ?? null,
    descriptionMd: item.descriptionMd,
    assigneeName: item.assigneeId ? (nameById.get(item.assigneeId) ?? null) : null,
    reporterName: nameById.get(item.reporterId) ?? item.reporterId,
    priority: item.priority,
    dueLabel: item.dueDate ? formatDate(item.dueDate, locale) : null,
    estimateLabel:
      item.estimateMinutes != null ? formatDurationMinutes(item.estimateMinutes) : null,
    parent: parent
      ? { identifier: parent.identifier, title: parent.title, kind: parent.kind }
      : null,
  };

  return <IssueQuickViewPanel state="ready" data={data} />;
}
