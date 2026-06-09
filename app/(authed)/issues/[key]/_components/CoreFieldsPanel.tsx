'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Calendar, ChevronDown, Clock } from 'lucide-react';
import type { WorkItemDto, WorkItemKindDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto, StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { IssueType } from '@/lib/issues/parentRules';
import type { Locale } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils/cn';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@/components/ui/DatePicker';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { TypePicker } from '@/components/issues/TypePicker';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import { formatDateTime, formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { changeStatusAction, updateIssueAction, type UpdateIssueInput } from '../edit/actions';

// The issue detail metadata rail (Story 2.4 · Subtasks 2.4.2 + 2.4.4). Per the
// mockup `design/work-items/detail.png`: a stack of field cards that DISPLAY the
// value normally, each with a chevron in the top-right corner to edit it inline.
// Clicking the chevron swaps the value for the field's control; picking a new
// value commits through the shipped Server Actions (changeStatusAction → the
// gated 2.2.4 transition path; updateIssueAction → the concurrency-checked
// updateWorkItem) and refreshes the route. Status / type / priority / assignee /
// parent / due / estimate are editable; reporter + created/updated are read-only.

export interface CoreFieldsPanelProps {
  item: WorkItemDto;
  members: WorkspaceMemberDTO[];
  workflow: WorkflowDto;
  /** The resolved parent summary (for the Parent card's display). */
  parent: WorkItemSummaryDto | null;
  /** True when the reporter is the signed-in viewer (renders a "You" chip). */
  reporterIsSelf?: boolean;
}

type EditableKey = 'status' | 'type' | 'priority' | 'assignee' | 'parent' | 'dueDate' | 'estimate';

const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

// Priority chip presentation now lives in the shared `PRIORITY_META` (reused by
// the issue-list row, 2.5.3) — imported above.

function Avatar({ name }: { name: string }) {
  return (
    <span
      className="bg-(--el-text) text-(--el-text-inverted) inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

// A field card: caption + value (display mode) with a corner chevron that
// toggles into the control (edit mode). The chevron is a real button with an
// accessible name; the caption is a plain <div> (the control carries its own
// accessible name). `editable={false}` drops the chevron (read-only fields).
function FieldCard({
  label,
  editable = true,
  editing,
  onToggle,
  children,
}: {
  label: string;
  editable?: boolean;
  editing?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const t = useTranslations('issueViews');
  const tc = useTranslations('common');
  return (
    <Card className="px-3.5 py-2.5 shadow-(--shadow-card)">
      <div className="flex items-start justify-between gap-2">
        <div className="font-sans text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
          {label}
        </div>
        {editable ? (
          <button
            type="button"
            // Don't steal focus on click: otherwise clicking the chevron to
            // collapse a focused free-text field (due/estimate) blurs it first,
            // which closes edit mode, and the click then re-opens it — the field
            // never collapses. Keyboard users still reach it via Tab.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggle}
            aria-expanded={editing}
            aria-label={`${editing ? tc('close') : t('edit')} ${label}`}
            className="-mt-0.5 rounded p-0.5 text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', editing && 'rotate-180')}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
      <div className="text-(--el-text) mt-1.5 font-sans text-sm">{children}</div>
    </Card>
  );
}

export function CoreFieldsPanel({
  item,
  members,
  workflow,
  parent,
  reporterIsSelf,
}: CoreFieldsPanelProps) {
  const router = useRouter();
  const t = useTranslations('issueViews');
  const tl = useTranslations('labels');
  const locale = useLocale() as Locale;
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  // Story 6.4.6 — a read-only actor (viewer, or member on a limited project)
  // sees every field control disabled. The server (6.4.3) rejects the write
  // regardless; disabling here makes the affordance honest rather than letting
  // a viewer edit then bounce off a 403.
  const { canEdit } = useProjectAccess();
  const readOnly = !canEdit;
  const [editing, setEditing] = useState<EditableKey | null>(null);
  const [updatedAt, setUpdatedAt] = useState(item.updatedAt);
  const [dueDate, setDueDate] = useState(item.dueDate ? item.dueDate.slice(0, 10) : '');
  const [estimate, setEstimate] = useState(
    item.estimateMinutes != null ? String(item.estimateMinutes) : '',
  );

  const typeMeta = ISSUE_TYPE_META[item.kind];
  const reporter = members.find((m) => m.userId === item.reporterId);
  const assignee = members.find((m) => m.userId === item.assigneeId);
  const statusMeta = workflow.statuses.find((s) => s.key === item.status);

  const toggle = (key: EditableKey) => setEditing((cur) => (cur === key ? null : key));

  function patch(input: Omit<UpdateIssueInput, 'id' | 'expectedUpdatedAt'>) {
    setEditing(null);
    startTransition(async () => {
      const res = await updateIssueAction({ id: item.id, expectedUpdatedAt: updatedAt, ...input });
      if (res.ok) {
        setUpdatedAt(res.updatedAt);
        router.refresh();
      } else if (res.stale) {
        toast({ variant: 'error', title: t('changedElsewhereRefreshing') });
        router.refresh();
      } else {
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  function changeStatus(toStatusKey: string) {
    setEditing(null);
    if (toStatusKey === item.status) return;
    startTransition(async () => {
      const res = await changeStatusAction({ id: item.id, toStatusKey });
      if (res.ok) {
        setUpdatedAt(res.updatedAt);
        router.refresh();
      } else {
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  // Due date commits as soon as the DatePicker fires (a day picked or cleared);
  // the picker owns its own open/close, so there's no blur/chevron commit. patch()
  // closes edit mode on a real change; an unchanged pick just closes.
  function commitDue(next: string | null) {
    setDueDate(next ?? '');
    const iso = next ? new Date(`${next}T00:00:00.000Z`).toISOString() : null;
    if (iso !== item.dueDate) patch({ dueDate: iso });
    else setEditing(null);
  }
  // Estimate stays a free-text field: commits on blur AND when the chevron
  // collapses it (the chevron no longer blurs the input).
  function commitEstimate() {
    const next = estimate === '' ? null : Number(estimate);
    if (next !== item.estimateMinutes) patch({ estimateMinutes: next });
    else setEditing(null);
  }

  const muted = (text: string) => <span className="text-(--el-text-secondary) italic">{text}</span>;
  const priorityPill = PRIORITY_META[item.priority];

  return (
    <div className="flex flex-col gap-3">
      <FieldCard
        label={t('status')}
        editing={editing === 'status'}
        onToggle={() => toggle('status')}
      >
        {editing === 'status' ? (
          <StatusPicker
            statuses={workflow.statuses}
            transitions={workflow.transitions}
            policyMode={workflow.policyMode}
            value={item.status}
            onChange={changeStatus}
            disabled={isPending || readOnly}
          />
        ) : statusMeta ? (
          <Pill status={STATUS_TONE[statusMeta.category]}>{statusMeta.label}</Pill>
        ) : (
          <Pill tone="neutral">{item.status}</Pill>
        )}
      </FieldCard>

      <FieldCard label={t('type')} editing={editing === 'type'} onToggle={() => toggle('type')}>
        {editing === 'type' ? (
          <TypePicker
            value={item.kind as IssueType}
            onChange={(kind) => patch({ kind: kind as WorkItemKindDto })}
            disabled={isPending || readOnly}
          />
        ) : (
          <span className="flex items-center gap-1.5">
            <IssueTypeIcon type={item.kind as IssueType} className="h-4 w-4" />
            {typeMeta.label}
          </span>
        )}
      </FieldCard>

      <FieldCard
        label={t('priority')}
        editing={editing === 'priority'}
        onToggle={() => toggle('priority')}
      >
        {editing === 'priority' ? (
          <PriorityPicker
            value={item.priority}
            onChange={(priority) => patch({ priority })}
            disabled={isPending || readOnly}
          />
        ) : (
          <Pill {...priorityPill.pill}>
            <priorityPill.icon className="h-3 w-3" aria-hidden />
            {tl('priority.' + item.priority)}
          </Pill>
        )}
      </FieldCard>

      <FieldCard
        label={t('assignee')}
        editing={editing === 'assignee'}
        onToggle={() => toggle('assignee')}
      >
        {editing === 'assignee' ? (
          <AssigneePicker
            members={members}
            value={item.assigneeId}
            onChange={(userId) => patch({ assigneeId: userId })}
            disabled={isPending || readOnly}
          />
        ) : assignee ? (
          <span className="flex items-center gap-2">
            <Avatar name={assignee.name || assignee.email} />
            <span className="truncate">{assignee.name}</span>
          </span>
        ) : (
          muted(t('unassigned'))
        )}
      </FieldCard>

      <FieldCard label={t('reporter')} editable={false}>
        {reporter ? (
          <span className="flex items-center gap-2">
            <Avatar name={reporter.name || reporter.email} />
            <span className="truncate">{reporter.name}</span>
            {reporterIsSelf ? <Pill tone="neutral">{t('you')}</Pill> : null}
          </span>
        ) : (
          muted(t('unknown'))
        )}
      </FieldCard>

      <FieldCard
        label={t('parent')}
        editing={editing === 'parent'}
        onToggle={() => toggle('parent')}
      >
        {editing === 'parent' ? (
          <ParentPicker
            childType={item.kind as IssueType}
            value={item.parentId}
            onChange={(parentId) => patch({ parentId })}
            disabled={isPending || readOnly}
          />
        ) : parent ? (
          <Link
            href={`/issues/${parent.identifier}`}
            className="flex items-center gap-1.5 hover:underline"
          >
            <span className="text-(--el-text-secondary) font-mono text-xs">
              {parent.identifier}
            </span>
            <span className="truncate">{parent.title}</span>
          </Link>
        ) : (
          muted(t('none'))
        )}
      </FieldCard>

      <FieldCard
        label={t('dueDate')}
        editing={editing === 'dueDate'}
        onToggle={() => toggle('dueDate')}
      >
        {editing === 'dueDate' ? (
          <DatePicker
            aria-label={t('dueDate')}
            value={dueDate || null}
            onChange={commitDue}
            disabled={isPending || readOnly}
            autoOpen
          />
        ) : item.dueDate ? (
          <span className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDate(item.dueDate, locale)}
          </span>
        ) : (
          muted(t('noDueDate'))
        )}
      </FieldCard>

      {/* Story points (Subtask 4.3.4) — the agile estimate, DISTINCT from the
          TIME Estimate below (design panel 2). The badge owns its own
          click-to-edit picker, so this card has no chevron (editable={false});
          `forceStoryPoints` keeps it a story-points field regardless of the
          project's display statistic. */}
      <FieldCard label={t('storyPoints')} editable={false}>
        <EstimateBadge
          itemId={item.id}
          storyPoints={item.storyPoints}
          estimateMinutes={item.estimateMinutes}
          forceStoryPoints
        />
      </FieldCard>

      <FieldCard
        label={t('estimate')}
        editing={editing === 'estimate'}
        onToggle={() => (editing === 'estimate' ? commitEstimate() : setEditing('estimate'))}
      >
        {editing === 'estimate' ? (
          <Input
            type="number"
            min={0}
            aria-label={t('estimateMinutes')}
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            onBlur={commitEstimate}
            disabled={isPending || readOnly}
            autoFocus
          />
        ) : item.estimateMinutes != null ? (
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDurationMinutes(item.estimateMinutes)}
          </span>
        ) : (
          muted(t('noEstimate'))
        )}
      </FieldCard>

      {/* Created / updated — read-only audit fields (locale-aware date, UTC zone). */}
      <dl className="flex flex-col gap-1 px-1 pt-1 font-sans text-xs text-(--el-text-secondary)">
        <div className="flex justify-between gap-2">
          <dt>{t('created')}</dt>
          <dd className="text-(--el-text)">{formatDateTime(item.createdAt, locale)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t('updated')}</dt>
          <dd className="text-(--el-text)">{formatDateTime(item.updatedAt, locale)}</dd>
        </div>
      </dl>
    </div>
  );
}
