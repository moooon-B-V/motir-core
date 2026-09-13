'use client';

import { AlertCircle, ArrowUp, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { FolderDeletionPreviewDto } from '@/lib/dto/folders';

// The DELETE-FOLDER confirmation (Story MOTIR-5308 · MOTIR-5346), the design's
// panel 5 — the shipped alertdialog chrome, telling the OPPOSITE story to the
// work-item delete: nothing inside a folder is deleted, its direct contents move
// up. The mint line names exactly what moves and where, from
// `describeFolderDeletion`, which counts the sets `deleteFolder` moves — and
// until that read lands the dialog shows no number and cannot be confirmed.
//
// Presentational: the tree owns the read, the write and the refusal.

export interface FolderDeleteDialogProps {
  folderName: string;
  /** What the delete would move, or `null` while it is being counted. */
  preview: FolderDeletionPreviewDto | null;
  /** A refusal from the write, shown inside the still-open dialog. */
  refusal: string | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FolderDeleteDialog({
  folderName,
  preview,
  refusal,
  pending,
  onConfirm,
  onCancel,
}: FolderDeleteDialogProps) {
  const t = useTranslations('folders');
  const tc = useTranslations('common');
  const empty = preview !== null && preview.childFolderCount === 0 && preview.workItemCount === 0;
  const kinds =
    preview === null
      ? 'both'
      : preview.childFolderCount > 0 && preview.workItemCount > 0
        ? 'both'
        : preview.childFolderCount > 0
          ? 'folders'
          : 'items';

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      role="alertdialog"
      size="md"
      title={t('deleteTitle', { name: folderName })}
      description={
        preview === null
          ? undefined
          : empty
            ? t('deleteEmpty', { name: folderName })
            : t('deleteLead')
      }
      closeLabel={tc('close')}
    >
      <Modal.Body className="gap-3">
        {preview === null ? (
          <p className="flex items-center gap-2 text-sm text-(--el-text-secondary)">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('deleteCounting')}
          </p>
        ) : empty ? null : (
          <div
            data-testid="folder-delete-moves"
            className="flex items-start gap-2.5 rounded-(--radius-control) bg-(--el-tint-mint) p-3 text-[13px] leading-normal text-(--el-text-strong)"
          >
            <ArrowUp className="mt-px h-4 w-4 shrink-0 text-(--el-success)" aria-hidden />
            <span>
              {t.rich('deleteMoves', {
                kinds,
                folders: preview.childFolderCount,
                items: preview.workItemCount,
                destination: preview.destination.name ?? t('projectRoot'),
                strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
              })}
            </span>
          </div>
        )}
        {refusal ? (
          <p role="alert" className="flex items-start gap-1.5 text-[13px] text-(--el-text)">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-danger)" aria-hidden />
            <span>{refusal}</span>
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button
          variant="danger"
          disabled={preview === null || pending}
          loading={pending}
          onClick={onConfirm}
        >
          {t('deleteConfirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
