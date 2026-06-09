'use client';

import { GripVertical, MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Avatar, StatusValue } from '../../issues/_components/issueCellPrimitives';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { StatusByKey } from './backlogShared';

// One backlog / sprint issue row (Story 4.2 · Subtask 4.2.3, read render). Reuses
// the Story-2.x work-items list-row vocabulary — the `IssueTypeIcon` in its
// `--el-type-*` hue, the mono key, the truncating summary, the assignee avatar,
// the status `Pill` (via `StatusValue`) — and is rendered IDENTICALLY in the
// backlog and inside sprint containers (one global `backlog_rank`).
//
// Slot order (design/backlog/backlog.mock.html panel 2): grip · type icon · key
// · summary · estimate SEAM · assignee · status. The reserved **estimate seam**
// (a labelled `--el-text-faint` em-dash) holds the place Story 4.3 drops the
// inline estimate badge into — so 4.3 needs no relayout (4.2.1 design notes).
//
// Read render ONLY — the interactions are later subtasks of this story:
//   * the GRIP is a decorative hover cue here; drag wiring is Subtask 4.2.4;
//   * SELECTION (the row checkbox) is Subtask 4.2.5 (not rendered yet);
//   * the `⋯` menu is PLACED (disabled) here; its actions are Subtask 4.2.5.
// The EPIC chip the design draws needs the epic key/title, which the bound
// `WorkItemSummaryDto` (getBacklog / getSprintIssues) does NOT carry and the
// reused /issues list row does not render either — see PRODECT_FINDINGS (the
// read needs enriching before the chip can render; deferred, not improvised).

const EM_DASH = '—';

export function BacklogRow({
  item,
  statusByKey,
  assigneeNameById,
}: {
  item: WorkItemSummaryDto;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
}) {
  const t = useTranslations('backlog');
  const status = statusByKey.get(item.status);
  const assigneeName = item.assigneeId ? (assigneeNameById.get(item.assigneeId) ?? null) : null;

  return (
    <div
      role="row"
      data-testid={`backlog-row-${item.identifier}`}
      className="group flex items-center gap-2 rounded-(--radius-control) border border-transparent px-(--spacing-control-x) py-(--spacing-control-y) hover:border-(--el-border-soft) hover:bg-(--el-surface-soft)"
    >
      {/* Decorative drag cue — drag is wired in Subtask 4.2.4. */}
      <GripVertical
        className="h-4 w-4 shrink-0 text-(--el-text-faint) opacity-0 group-hover:opacity-100"
        aria-hidden
      />
      <IssueTypeIcon type={item.kind as IssueType} className="h-4 w-4 shrink-0" />
      <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">{item.identifier}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-(--el-text)">{item.title}</span>
      {/* Reserved estimate seam (→ Story 4.3) — labelled, not a number yet. */}
      <span
        className="shrink-0 text-xs text-(--el-text-faint)"
        title={t('estimateSeam')}
        aria-label={t('estimateSeam')}
      >
        {EM_DASH}
      </span>
      {assigneeName ? (
        <span className="shrink-0" title={assigneeName}>
          <Avatar name={assigneeName} />
        </span>
      ) : (
        <span
          className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-dashed border-(--el-border-strong) text-[10px] text-(--el-text-faint)"
          title={t('unassigned')}
          aria-label={t('unassigned')}
        >
          {EM_DASH}
        </span>
      )}
      <span className="shrink-0">
        {status ? (
          <StatusValue category={status.category} label={status.label} />
        ) : (
          <StatusValue category={null} label={item.status} />
        )}
      </span>
      {/* `⋯` row menu — PLACED; its actions are wired in Subtask 4.2.5. */}
      <button
        type="button"
        disabled
        aria-label={t('rowActions')}
        title={t('rowActionsComingSoon')}
        className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) disabled:opacity-40"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
