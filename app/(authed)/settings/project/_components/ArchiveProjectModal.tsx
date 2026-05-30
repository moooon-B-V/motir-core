'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { archiveProjectAction } from '../../../_project-actions';

export interface ArchiveProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  projectIdentifier: string;
}

export function ArchiveProjectModal({
  open,
  onOpenChange,
  projectId,
  projectName,
  projectIdentifier,
}: ArchiveProjectModalProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [typed, setTyped] = useState('');
  const [isPending, startTransition] = useTransition();

  // Reset state on close — done in the onOpenChange wrapper rather than a
  // useEffect (React 19's react-hooks/set-state-in-effect lint rule
  // disallows the latter; the existing workspace DeleteConfirmModal uses
  // this pattern too).
  function handleOpenChange(next: boolean) {
    if (!next) setTyped('');
    onOpenChange(next);
  }

  // Case-sensitive exact match — identifiers are A-Z 0-9 uppercase, so a
  // case-insensitive check would let the user past on a typo'd lowercase
  // entry. Matching the workspace delete grammar.
  const matches = typed === projectIdentifier;

  function handleArchive() {
    if (!matches) return;
    startTransition(async () => {
      try {
        await archiveProjectAction(projectId);
        handleOpenChange(false);
        toast({ variant: 'success', title: 'Project archived' });
        // Re-renders the server tree; getActiveProject falls back to the
        // next non-archived project (or null → empty state).
        router.refresh();
      } catch {
        toast({ variant: 'error', title: 'Could not archive project' });
      }
    });
  }

  return (
    <Modal open={open} onOpenChange={handleOpenChange} size="md">
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--color-tint-rose)' }}
        >
          <TriangleAlert className="h-5 w-5" style={{ color: 'var(--color-destructive)' }} />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-foreground">
            Archive {projectName}?
          </h2>
          <p className="text-muted-foreground mt-1 font-sans text-sm">
            Archiving hides this project from the switcher and lists. Its work items and history are
            preserved — you can restore the project later. This does not delete any data.
          </p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleArchive();
        }}
      >
        <Input
          label={`Type ${projectIdentifier} to confirm`}
          placeholder={projectIdentifier}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="font-mono uppercase"
          autoFocus
          disabled={isPending}
        />
        <Modal.Footer>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!matches} loading={isPending}>
            Archive project
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
