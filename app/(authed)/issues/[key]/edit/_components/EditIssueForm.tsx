'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { uploadIssueAttachment } from '@/lib/blob/uploadClient';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { TypePicker } from '@/components/issues/TypePicker';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemDto, WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import { updateIssueAction, changeStatusAction } from '../actions';

// The full edit form (Subtask 2.3.6). Status and non-status fields submit via
// TWO distinct Server Actions (finding #46): `changeStatusAction` → the gated
// updateStatus, everything else → updateWorkItem. Optimistic concurrency: the
// `updatedAt` read at render is submitted + checked server-side; a 409 surfaces
// a refresh banner. Type (kind) is editable — a change re-validates against the
// current parent + children via assertValidParent (an illegal pair 422s and
// surfaces on the Parent field). Parent + Explanation are editable too; Reporter
// is read-only.

const isoToDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export interface EditIssueFormProps {
  issue: WorkItemDto;
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
}

export function EditIssueForm({ issue, workflow, members }: EditIssueFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  // Concurrency token — bumped after each successful save so a follow-up edit
  // in the same session doesn't conflict with the row this form just wrote.
  const [updatedAt, setUpdatedAt] = useState(issue.updatedAt);
  const [stale, setStale] = useState(false);

  const [kind, setKind] = useState<WorkItemKindDto>(issue.kind);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.descriptionMd ?? '');
  const [explanation, setExplanation] = useState(issue.explanationMd ?? '');
  const [parentId, setParentId] = useState<string | null>(issue.parentId);
  const [status, setStatus] = useState(issue.status);
  const [priority, setPriority] = useState<WorkItemPriorityDto>(issue.priority);
  const [assigneeId, setAssigneeId] = useState<string | null>(issue.assigneeId);
  const [dueDate, setDueDate] = useState(isoToDateInput(issue.dueDate));
  const [estimate, setEstimate] = useState(
    issue.estimateMinutes != null ? String(issue.estimateMinutes) : '',
  );

  const [titleError, setTitleError] = useState<string | null>(null);
  const [parentError, setParentError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // A frozen snapshot of what's on the server, so we only submit real changes.
  const initial = issue;
  const reporter = members.find((m) => m.userId === issue.reporterId);

  const nonStatusDirty =
    kind !== initial.kind ||
    title !== initial.title ||
    (description || null) !== (initial.descriptionMd ?? null) ||
    (explanation || null) !== (initial.explanationMd ?? null) ||
    parentId !== initial.parentId ||
    priority !== initial.priority ||
    assigneeId !== initial.assigneeId ||
    isoToDateInput(initial.dueDate) !== dueDate ||
    (estimate === '' ? null : Number(estimate)) !== initial.estimateMinutes;
  const statusDirty = status !== initial.status;
  const canSubmit = title.trim().length > 0 && (nonStatusDirty || statusDirty);

  function clearErrors() {
    setTitleError(null);
    setParentError(null);
    setStatusError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    clearErrors();
    if (title.trim().length === 0) {
      setTitleError('Title is required.');
      return;
    }

    startTransition(async () => {
      // 1) Non-status fields → updateWorkItem (carries the concurrency token).
      let token = updatedAt;
      if (nonStatusDirty) {
        const res = await updateIssueAction({
          id: issue.id,
          expectedUpdatedAt: token,
          kind,
          title: title.trim(),
          descriptionMd: description.trim() ? description : null,
          explanationMd: explanation.trim() ? explanation : null,
          parentId,
          assigneeId,
          priority,
          dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null,
          estimateMinutes: estimate === '' ? null : Number(estimate),
        });
        if (!res.ok) {
          if (res.stale) setStale(true);
          else if (res.field === 'parent') setParentError(res.error);
          else toast({ variant: 'error', title: res.error });
          return;
        }
        token = res.updatedAt;
        setUpdatedAt(res.updatedAt);
      }

      // 2) Status → the gated changeStatusAction.
      if (statusDirty) {
        const res = await changeStatusAction({ id: issue.id, toStatusKey: status });
        if (!res.ok) {
          if (res.field === 'status') setStatusError(res.error);
          else toast({ variant: 'error', title: res.error });
          return;
        }
        setUpdatedAt(res.updatedAt);
      }

      toast({ variant: 'success', title: `${issue.identifier} saved` });
      router.refresh();
    });
  }

  return (
    <form className="flex w-full flex-col gap-4" onSubmit={handleSubmit}>
      <div className="flex items-center gap-2">
        <IssueTypeIcon type={kind as IssueType} className="h-4 w-4" />
        <span className="text-(--el-text-muted) font-mono text-sm">{issue.identifier}</span>
      </div>

      {stale ? (
        <div
          role="alert"
          className="border-(--el-danger) bg-card text-(--el-text) flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
        >
          <span>This issue was edited by someone else. Refresh to see the latest.</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => router.refresh()}>
            Refresh
          </Button>
        </div>
      ) : null}

      <Input
        label="Title"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          if (titleError) setTitleError(null);
        }}
        error={titleError ?? undefined}
        maxLength={200}
        disabled={isPending}
        required
      />

      {/* The MarkdownEditor renders its own label (also its aria-label) — no
          wrapping <label>/span, else "Description" shows twice. */}
      <MarkdownEditor
        label="Description"
        value={description}
        onChange={setDescription}
        size="full"
        onFileUpload={uploadIssueAttachment}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">Type</span>
          <TypePicker
            value={kind as IssueType}
            onChange={(t) => {
              setKind(t);
              // A kind change re-validates against the current parent + children;
              // a conflict surfaces on the Parent field (IllegalParentTypeError).
              if (parentError) setParentError(null);
            }}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">Status</span>
          <StatusPicker
            statuses={workflow.statuses}
            transitions={workflow.transitions}
            policyMode={workflow.policyMode}
            value={status}
            onChange={(s) => {
              setStatus(s);
              if (statusError) setStatusError(null);
            }}
            error={statusError}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">Parent</span>
          <ParentPicker
            childType={issue.kind as IssueType}
            value={parentId}
            onChange={(id) => {
              setParentId(id);
              if (parentError) setParentError(null);
            }}
            error={parentError}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">Assignee</span>
          <AssigneePicker
            members={members}
            value={assigneeId}
            onChange={setAssigneeId}
            disabled={isPending}
          />
        </div>

        <label className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">Priority</span>
          <select
            className="border-(--el-border) bg-(--el-page-bg) rounded-md border px-3 py-2 text-sm"
            value={priority}
            onChange={(e) => setPriority(e.target.value as WorkItemPriorityDto)}
            disabled={isPending}
            aria-label="Priority"
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">Due date</span>
          <input
            type="date"
            className="border-(--el-border) bg-(--el-page-bg) rounded-md border px-3 py-2 text-sm"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={isPending}
            aria-label="Due date"
          />
        </label>

        <label className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">Estimate (minutes)</span>
          <input
            type="number"
            min={0}
            className="border-(--el-border) bg-(--el-page-bg) rounded-md border px-3 py-2 text-sm"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            disabled={isPending}
            aria-label="Estimate (minutes)"
          />
        </label>
      </div>

      {/* Editable now (the design treats explanation as a first-class authored
          field; editing an ai_draft auto-flips its source to user_edited in
          the service). AI drafting/regeneration is the Epic-7 planning layer.
          The gloss + AI-drafted badge ride the editor's own label via
          labelAccessory — no external "Explanation" span, else it shows twice. */}
      <MarkdownEditor
        label="Explanation"
        labelAccessory={
          <>
            <span className="text-(--el-text-secondary) font-normal">— why it matters</span>
            {issue.explanationSource === 'ai_draft' ? (
              <Pill severity="info">AI-drafted</Pill>
            ) : null}
          </>
        }
        value={explanation}
        onChange={setExplanation}
        size="full"
        onFileUpload={uploadIssueAttachment}
      />

      <div className="text-(--el-text-muted) font-sans text-xs">
        Reporter: {reporter ? reporter.name : issue.reporterId} · created{' '}
        {issue.createdAt.slice(0, 10)}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push('/issues')}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit} loading={isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}
