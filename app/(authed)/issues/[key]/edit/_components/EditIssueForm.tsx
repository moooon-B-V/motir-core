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
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import { updateIssueAction, changeStatusAction } from '../actions';

// The full edit form (Subtask 2.3.6). Status and non-status fields submit via
// TWO distinct Server Actions (finding #46): `changeStatusAction` → the gated
// updateStatus, everything else → updateWorkItem. Optimistic concurrency: the
// `updatedAt` read at render is submitted + checked server-side; a 409 surfaces
// a refresh banner. Type is read-only (kind is immutable post-creation in the
// shipped model — changing an issue's type is a future "move" feature); Parent
// stays editable. Reporter + Explanation are read-only.

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
  const typeMeta = ISSUE_TYPE_META[issue.kind as IssueType];
  const TypeIcon = typeMeta.icon;
  const reporter = members.find((m) => m.userId === issue.reporterId);

  const nonStatusDirty =
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
    <form className="mx-auto flex max-w-[44rem] flex-col gap-4" onSubmit={handleSubmit}>
      <div className="flex items-center gap-2">
        <TypeIcon
          className="h-4 w-4"
          aria-hidden
          style={{ color: `var(--color-${typeMeta.colorToken})` }}
        />
        <span className="text-muted-foreground font-mono text-sm">{issue.identifier}</span>
        <Pill tone="neutral">{typeMeta.label}</Pill>
      </div>

      {stale ? (
        <div
          role="alert"
          className="border-(--color-destructive) bg-card text-foreground flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
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

      <label className="flex flex-col gap-1 font-sans text-sm">
        <span className="text-foreground font-medium">Description</span>
        <MarkdownEditor
          label="Description"
          value={description}
          onChange={setDescription}
          size="full"
          onFileUpload={uploadIssueAttachment}
        />
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-foreground font-medium">Status</span>
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
          <span className="text-foreground font-medium">Parent</span>
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
          <span className="text-foreground font-medium">Assignee</span>
          <AssigneePicker
            members={members}
            value={assigneeId}
            onChange={setAssigneeId}
            disabled={isPending}
          />
        </div>

        <label className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-foreground font-medium">Priority</span>
          <select
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
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
          <span className="text-foreground font-medium">Due date</span>
          <input
            type="date"
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={isPending}
            aria-label="Due date"
          />
        </label>

        <label className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-foreground font-medium">Estimate (minutes)</span>
          <input
            type="number"
            min={0}
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            disabled={isPending}
            aria-label="Estimate (minutes)"
          />
        </label>
      </div>

      <div className="flex flex-col gap-1 font-sans text-sm">
        <span className="text-foreground flex items-center gap-2 font-medium">
          Explanation <span className="text-(--color-slate) font-normal">— why it matters</span>
          {issue.explanationSource === 'ai_draft' ? <Pill severity="info">AI-drafted</Pill> : null}
        </span>
        {/* Editable now (the design treats explanation as a first-class authored
            field; editing an ai_draft auto-flips its source to user_edited in
            the service). AI drafting/regeneration is the Epic-7 planning layer. */}
        <MarkdownEditor
          label="Explanation"
          value={explanation}
          onChange={setExplanation}
          size="full"
          onFileUpload={uploadIssueAttachment}
        />
      </div>

      <div className="text-muted-foreground font-sans text-xs">
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
