'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('settings');
  const tc = useTranslations('common');
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
        toast({ variant: 'success', title: t('archive.archivedToast') });
        // Re-renders the server tree; getActiveProject falls back to the
        // next non-archived project (or null → empty state).
        router.refresh();
      } catch {
        toast({ variant: 'error', title: t('archive.archiveErrorTitle') });
      }
    });
  }

  return (
    <Modal open={open} onOpenChange={handleOpenChange} size="md">
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--el-tint-rose)' }}
        >
          <TriangleAlert className="h-5 w-5" style={{ color: 'var(--el-danger)' }} />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('archive.modalTitle', { projectName })}
          </h2>
          <p className="text-(--el-text-muted) mt-1 font-sans text-sm">{t('archive.modalDesc')}</p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleArchive();
        }}
      >
        <Input
          label={t('archive.confirmLabel', { identifier: projectIdentifier })}
          placeholder={projectIdentifier}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="font-mono uppercase"
          autoFocus
          disabled={isPending}
        />
        <Modal.Footer>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={!matches} loading={isPending}>
            {t('archive.modalConfirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
