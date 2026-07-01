'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';

// Delete-sprint confirm (Story 4.2 · Subtask 4.2.5 — enabled + wired in bug
// MOTIR-1492). The sprint `⋯` menu's Delete action opens this focus-trapped
// confirm, then calls the shipped `DELETE /api/sprints/[id]`
// (`sprintsService.deleteSprint`). Deleting a planned/complete sprint does NOT
// lose its work items — `work_item.sprint_id` is `onDelete: SetNull`, so they
// fall back to the backlog — and the modal states that consequence in text
// (never colour-only, finding #35). An ACTIVE sprint can't be deleted (409); the
// menu disables the action there, so this dialog only opens for a planned/
// complete sprint, but the 409 path is kept as a backstop toast. Mirrors the
// shipped filters/DeleteFilterDialog danger-confirm vocabulary.

export interface DeleteSprintDialogProps {
  sprint: SprintDto;
  onClose: () => void;
  /** Run after a successful delete — the backlog refetches: the sprint drops out
   *  of the planning view AND its issues re-appear in the backlog list. */
  onDeleted: () => void | Promise<void>;
}

export function DeleteSprintDialog({ sprint, onClose, onDeleted }: DeleteSprintDialogProps) {
  const t = useTranslations('backlog');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);

  async function confirm() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/sprints/${sprint.id}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        const description =
          data.code === 'NOT_SPRINT_ADMIN'
            ? t('deleteSprintFlow.errorNotAdmin')
            : data.code === 'CANNOT_DELETE_ACTIVE_SPRINT'
              ? t('deleteSprintFlow.errorActive')
              : t('deleteSprintFlow.errorDescription');
        toast({ variant: 'error', title: t('deleteSprintFlow.errorTitle'), description });
        setDeleting(false);
        return;
      }
      toast({
        variant: 'success',
        title: t('deleteSprintFlow.deletedToast', { name: sprint.name }),
      });
      await onDeleted();
    } catch {
      toast({
        variant: 'error',
        title: t('deleteSprintFlow.errorTitle'),
        description: t('deleteSprintFlow.errorDescription'),
      });
      setDeleting(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('deleteSprintFlow.title')}
      size="md"
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-3">
          <span
            aria-hidden
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-rose)"
          >
            <TriangleAlert className="size-4 text-(--el-danger)" />
          </span>
          <div className="flex flex-col gap-1 text-sm text-(--el-text-secondary)">
            <p>{t('deleteSprintFlow.body', { name: sprint.name })}</p>
            <p>{t('deleteSprintFlow.itemsReturn')}</p>
          </div>
        </div>

        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={deleting}>
            {tc('cancel')}
          </Button>
          <Button type="button" variant="danger" loading={deleting} onClick={() => void confirm()}>
            {t('deleteSprintFlow.confirm')}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}
