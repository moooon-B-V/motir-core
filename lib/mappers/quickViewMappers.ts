import type { IssueDetailDto } from '@/lib/dto/workItems';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';

// Shapes the heavy IssueDetailDto (the SAME aggregate read the full detail page
// uses) into the condensed, serializable QuickViewData the peek modal renders
// (Subtask 2.5.19; moved out of the former IssueQuickViewContent server
// component for bug 8.8.2, where the peek became a client-fetched island).
// Member ids are resolved to display names here (server-side) so the client
// panel stays purely presentational. The readiness verdict is passed through
// unchanged — an item with NO blockers is `ready` (bug-ready-banner-no-deps);
// open blockers are named so the panel can map each to a `?peek=` swap-peek link.
export function toQuickViewData(
  detail: IssueDetailDto,
  members: WorkspaceMemberDTO[],
  locale: Locale,
): QuickViewData {
  const { item, parent, workflow } = detail;
  const nameById = new Map(members.map((m) => [m.userId, m.name || m.email]));
  const status = workflow.statuses.find((s) => s.key === item.status);

  return {
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
    readiness: {
      ready: detail.readiness.ready,
      blockers: detail.readiness.openBlockers.map((b) => b.identifier),
    },
  };
}
