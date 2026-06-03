'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { createIssueAction } from '../issues/actions';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';

// The create-issue modal (Subtask 2.3.3). Collects the lean field set and
// dispatches the `createIssueAction` Server Action; the service owns key
// allocation + the create revision. Open state lives in CreateIssueProvider
// (so the top-nav "+" button, the global "C" shortcut, and the ⌘K command all
// drive the same dialog) — this component reads it via props.
//
// STUBS (per the 2.3.3 card — swapped when their owning subtasks land):
//   - Type: a plain <select>. The filtered type+parent combobox is 2.3.4.
//   - Description: a plain <textarea>. The MarkdownEditor primitive is 2.3.5.
// DEFERRED (no shipped surface yet, both optional on the service):
//   - Parent: needs 2.3.4's canParent-filtered picker.
//   - Assignee: needs a workspace-member combobox.
// Until those land an issue is created top-level + unassigned. Reporter is
// never a field — the Server Action sets it to the session user.

const MAX_TITLE_LENGTH = 200;

const KIND_OPTIONS: ReadonlyArray<{ value: WorkItemKindDto; label: string }> = [
  { value: 'task', label: 'Task' },
  { value: 'story', label: 'Story' },
  { value: 'bug', label: 'Bug' },
  { value: 'epic', label: 'Epic' },
  { value: 'subtask', label: 'Subtask' },
];

const PRIORITY_OPTIONS: ReadonlyArray<{ value: WorkItemPriorityDto; label: string }> = [
  { value: 'highest', label: 'Highest' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'lowest', label: 'Lowest' },
];

export interface CreateIssueModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateIssueModal({ open, onOpenChange }: CreateIssueModalProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const [kind, setKind] = useState<WorkItemKindDto>('task');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<WorkItemPriorityDto>('medium');
  const [titleError, setTitleError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && trimmedTitle.length <= MAX_TITLE_LENGTH;

  function reset() {
    setKind('task');
    setTitle('');
    setDescription('');
    setPriority('medium');
    setTitleError(null);
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTitleError(null);
    if (trimmedTitle.length === 0) {
      setTitleError('Give the issue a title.');
      return;
    }
    if (trimmedTitle.length > MAX_TITLE_LENGTH) {
      setTitleError(`Title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
      return;
    }
    startTransition(async () => {
      const result = await createIssueAction({
        kind,
        title: trimmedTitle,
        descriptionMd: description.trim() ? description : null,
        priority,
      });
      if (result.ok) {
        toast({
          variant: 'success',
          title: `${result.identifier} created`,
          description: trimmedTitle,
        });
        close();
        router.refresh();
      } else if (result.field === 'parent') {
        // Parent isn't a field yet (deferred); a parent error can't originate
        // here today, but keep the inline path wired for when 2.3.4 adds it.
        toast({ variant: 'error', title: result.error });
      } else {
        toast({ variant: 'error', title: result.error });
      }
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      size="lg"
      title="Create issue"
    >
      <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
        {/* STUB (2.3.4 swaps this for the filtered type combobox). */}
        <label className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-foreground font-medium">Type</span>
          <select
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as WorkItemKindDto)}
            disabled={isPending}
            aria-label="Type"
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>

        <Input
          label="Title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (titleError) setTitleError(null);
          }}
          error={titleError ?? undefined}
          maxLength={MAX_TITLE_LENGTH}
          placeholder="Summarize the work in a line"
          disabled={isPending}
          autoFocus
          required
        />

        {/* STUB (2.3.5 swaps this for the MarkdownEditor in "min" mode). */}
        <label className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-foreground font-medium">Description</span>
          <textarea
            className="border-border bg-background min-h-24 rounded-md border px-3 py-2 text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isPending}
            placeholder="Add more detail (optional)"
            aria-label="Description"
          />
        </label>

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

        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={isPending}>
            Create
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
