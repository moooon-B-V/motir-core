'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Calendar, ChevronDown, Clock } from 'lucide-react';
import type { WorkItemDto, WorkItemKindDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto, StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { IssueType } from '@/lib/issues/parentRules';
import { cn } from '@/lib/utils/cn';
import { Card } from '@/components/ui/Card';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { TypePicker } from '@/components/issues/TypePicker';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { PRIORITY_LABELS } from '@/lib/issues/priority';
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
            aria-label={`${editing ? 'Close' : 'Edit'} ${label}`}
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
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
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
        toast({ variant: 'error', title: 'This issue changed elsewhere — refreshing.' });
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

  // Free-text fields (due/estimate) commit explicitly: on blur (click/tab away)
  // AND when the chevron collapses them (the chevron no longer blurs the input).
  // patch() closes edit mode on a real change; otherwise just close.
  function commitDue() {
    const next = dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null;
    if (next !== item.dueDate) patch({ dueDate: next });
    else setEditing(null);
  }
  function commitEstimate() {
    const next = estimate === '' ? null : Number(estimate);
    if (next !== item.estimateMinutes) patch({ estimateMinutes: next });
    else setEditing(null);
  }

  const muted = (text: string) => <span className="text-(--el-text-secondary) italic">{text}</span>;
  const priorityPill = PRIORITY_META[item.priority];

  return (
    <div className="flex flex-col gap-3">
      <FieldCard label="Status" editing={editing === 'status'} onToggle={() => toggle('status')}>
        {editing === 'status' ? (
          <StatusPicker
            statuses={workflow.statuses}
            transitions={workflow.transitions}
            policyMode={workflow.policyMode}
            value={item.status}
            onChange={changeStatus}
            disabled={isPending}
          />
        ) : statusMeta ? (
          <Pill status={STATUS_TONE[statusMeta.category]}>{statusMeta.label}</Pill>
        ) : (
          <Pill tone="neutral">{item.status}</Pill>
        )}
      </FieldCard>

      <FieldCard label="Type" editing={editing === 'type'} onToggle={() => toggle('type')}>
        {editing === 'type' ? (
          <TypePicker
            value={item.kind as IssueType}
            onChange={(kind) => patch({ kind: kind as WorkItemKindDto })}
            disabled={isPending}
          />
        ) : (
          <span className="flex items-center gap-1.5">
            <IssueTypeIcon type={item.kind as IssueType} className="h-4 w-4" />
            {typeMeta.label}
          </span>
        )}
      </FieldCard>

      <FieldCard
        label="Priority"
        editing={editing === 'priority'}
        onToggle={() => toggle('priority')}
      >
        {editing === 'priority' ? (
          <PriorityPicker
            value={item.priority}
            onChange={(priority) => patch({ priority })}
            disabled={isPending}
          />
        ) : (
          <Pill {...priorityPill.pill}>
            <priorityPill.icon className="h-3 w-3" aria-hidden />
            {PRIORITY_LABELS[item.priority]}
          </Pill>
        )}
      </FieldCard>

      <FieldCard
        label="Assignee"
        editing={editing === 'assignee'}
        onToggle={() => toggle('assignee')}
      >
        {editing === 'assignee' ? (
          <AssigneePicker
            members={members}
            value={item.assigneeId}
            onChange={(userId) => patch({ assigneeId: userId })}
            disabled={isPending}
          />
        ) : assignee ? (
          <span className="flex items-center gap-2">
            <Avatar name={assignee.name || assignee.email} />
            <span className="truncate">{assignee.name}</span>
          </span>
        ) : (
          muted('Unassigned')
        )}
      </FieldCard>

      <FieldCard label="Reporter" editable={false}>
        {reporter ? (
          <span className="flex items-center gap-2">
            <Avatar name={reporter.name || reporter.email} />
            <span className="truncate">{reporter.name}</span>
            {reporterIsSelf ? <Pill tone="neutral">You</Pill> : null}
          </span>
        ) : (
          muted('Unknown')
        )}
      </FieldCard>

      <FieldCard label="Parent" editing={editing === 'parent'} onToggle={() => toggle('parent')}>
        {editing === 'parent' ? (
          <ParentPicker
            childType={item.kind as IssueType}
            value={item.parentId}
            onChange={(parentId) => patch({ parentId })}
            disabled={isPending}
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
          muted('None')
        )}
      </FieldCard>

      <FieldCard
        label="Due date"
        editing={editing === 'dueDate'}
        onToggle={() => (editing === 'dueDate' ? commitDue() : setEditing('dueDate'))}
      >
        {editing === 'dueDate' ? (
          <input
            type="date"
            className="border-(--el-border) bg-(--el-page-bg) focus-visible:ring-(--focus-ring-color) w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            onBlur={commitDue}
            disabled={isPending}
            aria-label="Due date"
            autoFocus
          />
        ) : item.dueDate ? (
          <span className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDate(item.dueDate)}
          </span>
        ) : (
          muted('No due date')
        )}
      </FieldCard>

      <FieldCard
        label="Estimate"
        editing={editing === 'estimate'}
        onToggle={() => (editing === 'estimate' ? commitEstimate() : setEditing('estimate'))}
      >
        {editing === 'estimate' ? (
          <input
            type="number"
            min={0}
            className="border-(--el-border) bg-(--el-page-bg) focus-visible:ring-(--focus-ring-color) w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            onBlur={commitEstimate}
            disabled={isPending}
            aria-label="Estimate (minutes)"
            autoFocus
          />
        ) : item.estimateMinutes != null ? (
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDurationMinutes(item.estimateMinutes)}
          </span>
        ) : (
          muted('No estimate')
        )}
      </FieldCard>

      {/* Created / updated — read-only audit fields (deterministic en-US/UTC). */}
      <dl className="flex flex-col gap-1 px-1 pt-1 font-sans text-xs text-(--el-text-secondary)">
        <div className="flex justify-between gap-2">
          <dt>Created</dt>
          <dd className="text-(--el-text)">{formatDateTime(item.createdAt)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Updated</dt>
          <dd className="text-(--el-text)">{formatDateTime(item.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}
