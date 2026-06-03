'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { uploadIssueAttachment } from '@/lib/blob/uploadClient';
import { TypePicker } from '@/components/issues/TypePicker';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { createIssueAction } from '../issues/actions';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';

// The create-issue modal (Subtask 2.3.3, pickers wired in 2.3.4). Collects the
// field set and dispatches the `createIssueAction` Server Action; the service
// owns key allocation + the create revision. Open state lives in
// CreateIssueProvider (so the top-nav "+" button, the global "C" shortcut, and
// the ⌘K command all drive the same dialog) — this component reads it via props.
//
// Type + Parent are the 2.3.4 pickers (filtered so an illegal parent can't be
// constructed; an illegal pair from a forged payload still 422s and surfaces
// inline on the Parent field). STILL a stub: Description is a plain <textarea>
// (2.3.6 swaps in the 2.3.5 MarkdownEditor). DEFERRED: Assignee (needs a
// workspace-member combobox). Reporter is never a field — set server-side.

const MAX_TITLE_LENGTH = 200;

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
  const [parentId, setParentId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<WorkItemPriorityDto>('medium');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [parentError, setParentError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && trimmedTitle.length <= MAX_TITLE_LENGTH;

  function reset() {
    setKind('task');
    setParentId(null);
    setTitle('');
    setDescription('');
    setPriority('medium');
    setTitleError(null);
    setParentError(null);
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
        parentId,
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
        // The picker pre-filters to legal parents, so this only fires on a
        // forged/edge payload (e.g. subtask + no parent) — surface it inline.
        setParentError(result.error);
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
        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-foreground font-medium">Type</span>
          <TypePicker
            value={kind}
            onChange={(v) => {
              setKind(v);
              setParentError(null); // a type change re-scopes the parent picker
            }}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-foreground font-medium">Parent</span>
          <ParentPicker
            childType={kind}
            value={parentId}
            onChange={(id) => {
              setParentId(id);
              setParentError(null);
            }}
            error={parentError}
            disabled={isPending}
          />
        </div>

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

        {/* The MarkdownEditor (min, with file upload) renders its own label
            (also its aria-label) — no external span, else it shows twice. */}
        <MarkdownEditor
          label="Description"
          value={description}
          onChange={setDescription}
          size="min"
          onFileUpload={uploadIssueAttachment}
        />

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
