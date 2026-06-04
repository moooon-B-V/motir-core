'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { WorkItemDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { IssueType } from '@/lib/issues/parentRules';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import { formatDateTime } from '@/lib/utils/datetime';
import { changeStatusAction, updateIssueAction, type UpdateIssueInput } from '../edit/actions';

// The issue detail metadata rail (Story 2.4 · Subtasks 2.4.2 + 2.4.4). Per the
// mockup `design/work-items/detail.png`: a vertical stack of field cards, each
// label-over-control, INLINE-EDITABLE — status / priority / assignee / parent /
// due date / estimate commit on change through the shipped Server Actions
// (changeStatusAction → the gated 2.2.4 transition path; updateIssueAction → the
// concurrency-checked updateWorkItem). Type + reporter + created/updated are
// read-only. Each save refreshes the server-rendered page so values re-resolve.

export interface CoreFieldsPanelProps {
  item: WorkItemDto;
  members: WorkspaceMemberDTO[];
  workflow: WorkflowDto;
  /** True when the reporter is the signed-in viewer (renders a "You" chip). */
  reporterIsSelf?: boolean;
}

// A field card — compact Card with a shadow so it reads as an elevated card,
// not a borderless box on the same-color page (the --shadow-card token). The
// caption is a plain <div> (each control carries its own accessible name via
// aria-label / the picker's label), so there's no orphan <label>.
function FieldBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card className="px-3.5 py-2.5 shadow-(--shadow-card)">
      <div className="font-sans text-[11px] font-semibold tracking-wide text-(--color-slate) uppercase">
        {label}
      </div>
      <div className="text-foreground mt-1.5 font-sans text-sm">{children}</div>
    </Card>
  );
}

export function CoreFieldsPanel({ item, members, workflow, reporterIsSelf }: CoreFieldsPanelProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  // Optimistic-concurrency token, advanced after each successful save.
  const [updatedAt, setUpdatedAt] = useState(item.updatedAt);
  // Locally-edited free-text fields commit on blur (not per keystroke).
  const [dueDate, setDueDate] = useState(item.dueDate ? item.dueDate.slice(0, 10) : '');
  const [estimate, setEstimate] = useState(
    item.estimateMinutes != null ? String(item.estimateMinutes) : '',
  );

  const typeMeta = ISSUE_TYPE_META[item.kind];
  const TypeIcon = typeMeta.icon;
  const reporter = members.find((m) => m.userId === item.reporterId);

  function patch(input: Omit<UpdateIssueInput, 'id' | 'expectedUpdatedAt'>) {
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

  return (
    <div className="flex flex-col gap-3">
      <FieldBox label="Status">
        <StatusPicker
          statuses={workflow.statuses}
          transitions={workflow.transitions}
          policyMode={workflow.policyMode}
          value={item.status}
          onChange={changeStatus}
          disabled={isPending}
        />
      </FieldBox>

      <FieldBox label="Type">
        <span className="flex items-center gap-1.5">
          <TypeIcon className="h-4 w-4" aria-hidden />
          {typeMeta.label}
        </span>
      </FieldBox>

      <FieldBox label="Priority">
        <select
          id="field-priority"
          className="border-border bg-background focus-visible:ring-(--focus-ring-color) w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
          value={item.priority}
          onChange={(e) => patch({ priority: e.target.value as WorkItemPriorityDto })}
          disabled={isPending}
          aria-label="Priority"
        >
          {PRIORITY_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </FieldBox>

      <FieldBox label="Assignee">
        <AssigneePicker
          members={members}
          value={item.assigneeId}
          onChange={(userId) => patch({ assigneeId: userId })}
          disabled={isPending}
        />
      </FieldBox>

      <FieldBox label="Reporter">
        {reporter ? (
          <span className="flex items-center gap-2">
            <span
              className="bg-foreground text-background inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              aria-hidden
            >
              {(reporter.name || reporter.email).charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{reporter.name}</span>
            {reporterIsSelf ? <Pill tone="neutral">You</Pill> : null}
          </span>
        ) : (
          <span className="text-(--color-slate) italic">Unknown</span>
        )}
      </FieldBox>

      <FieldBox label="Parent">
        <ParentPicker
          childType={item.kind as IssueType}
          value={item.parentId}
          onChange={(parentId) => patch({ parentId })}
          disabled={isPending}
        />
      </FieldBox>

      <FieldBox label="Due date">
        <input
          id="field-due"
          type="date"
          className="border-border bg-background focus-visible:ring-(--focus-ring-color) w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          onBlur={() => {
            const next = dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null;
            if (next !== item.dueDate) patch({ dueDate: next });
          }}
          disabled={isPending}
          aria-label="Due date"
        />
      </FieldBox>

      <FieldBox label="Estimate (minutes)">
        <input
          id="field-estimate"
          type="number"
          min={0}
          className="border-border bg-background focus-visible:ring-(--focus-ring-color) w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
          onBlur={() => {
            const next = estimate === '' ? null : Number(estimate);
            if (next !== item.estimateMinutes) patch({ estimateMinutes: next });
          }}
          disabled={isPending}
          aria-label="Estimate (minutes)"
        />
      </FieldBox>

      {/* Created / updated — read-only audit fields via the deterministic
          en-US/UTC formatter (no hydration drift). */}
      <dl className="flex flex-col gap-1 px-1 pt-1 font-sans text-xs text-(--color-slate)">
        <div className="flex justify-between gap-2">
          <dt>Created</dt>
          <dd className="text-foreground">{formatDateTime(item.createdAt)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Updated</dt>
          <dd className="text-foreground">{formatDateTime(item.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}
