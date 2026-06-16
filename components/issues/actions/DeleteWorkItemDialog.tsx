'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, Clock, Link2, ListTree, Trash2, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { WorkItemDeletePreviewDto, WorkItemKindDto } from '@/lib/dto/workItems';
import { deleteWorkItem, fetchDeletePreview, WorkItemActionError } from './workItemActionsClient';

// Delete-a-work-item confirm (Story 2.8 · Subtask 2.8.4), per
// design/work-items/delete-confirm.mock.html (panels 2–4). A real
// `role="alertdialog"` reusing the shipped Modal chrome + the 5.3.6
// delete-with-count grammar: the cascade impact (2.8.7 getDeletePreview) is
// NAMED IN TEXT (the count + per-kind breakdown), the destructive button states
// the magnitude ("Delete N items"), and Archive sits inside the dialog as the
// one-click recoverable alternative. Cancel takes default focus; an atomic
// failure (the delete either fully cascades or changes nothing) becomes a
// retryable `role="alert"` error.

// Leaf-most first, so the breakdown reads "5 subtasks, 1 task, 1 bug" (design).
const KIND_BREAKDOWN_ORDER: { kind: WorkItemKindDto; key: string }[] = [
  { kind: 'subtask', key: 'kindSubtask' },
  { kind: 'task', key: 'kindTask' },
  { kind: 'bug', key: 'kindBug' },
  { kind: 'story', key: 'kindStory' },
  { kind: 'epic', key: 'kindEpic' },
];

export function DeleteWorkItemDialog({
  itemId,
  identifier,
  title,
  onClose,
  onDeleted,
  onArchiveInstead,
}: {
  itemId: string;
  /** The `PROD-N` key shown in the body. */
  identifier: string;
  title: string;
  onClose: () => void;
  /** Called after a successful delete — the surface navigates away / refetches. */
  onDeleted: () => void;
  /** The "Archive instead" escape hatch — the surface runs the archive flow. */
  onArchiveInstead: () => void;
}) {
  const t = useTranslations('workItemActions');
  const { toast } = useToast();

  const [preview, setPreview] = useState<WorkItemDeletePreviewDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetchDeletePreview(itemId)
      .then((p) => {
        if (active) setPreview(p);
      })
      .catch(() => {
        // A preview read that fails still lets the user delete — fall back to a
        // leaf-shaped confirm (no count) rather than trapping them in a spinner.
        if (active)
          setPreview({
            totalCount: 1,
            descendantCount: 0,
            byKind: {},
            liveDescendantCount: 0,
            liveByKind: {},
          });
      });
    return () => {
      active = false;
    };
  }, [itemId]);

  async function confirm() {
    setDeleting(true);
    setFailed(false);
    try {
      await deleteWorkItem(itemId);
      toast({ variant: 'success', title: t('deletedToast', { key: identifier }) });
      onDeleted();
    } catch (err) {
      // The delete is atomic (it either fully cascades or changes nothing), so a
      // failure leaves the subtree intact — offer a retry, don't dismiss.
      void (err instanceof WorkItemActionError);
      setFailed(true);
      setDeleting(false);
    }
  }

  const cascade = (preview?.descendantCount ?? 0) > 0;
  const breakdown =
    preview && cascade
      ? KIND_BREAKDOWN_ORDER.filter(({ kind }) => (preview.byKind[kind] ?? 0) > 0)
          .map(({ kind, key }) => t(key, { count: preview.byKind[kind] ?? 0 }))
          .join(', ')
      : '';

  // Bold spans carry consequences in WORDS (never colour-only) — the AA
  // emphasis token on the secondary body.
  const bold = (chunks: ReactNode) => (
    <strong className="font-semibold text-(--el-text-strong)">{chunks}</strong>
  );

  const confirmLabel = !preview
    ? ''
    : cascade
      ? t('deleteConfirmCascade', { count: preview.totalCount })
      : t('deleteConfirmLeaf');

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('deleteTitle')}
      role="alertdialog"
      size="md"
    >
      <div className="flex flex-col gap-4" aria-busy={deleting || undefined}>
        <p className="text-sm text-(--el-text-secondary)">
          {cascade
            ? t.rich('deleteCascadeBody', { key: identifier, title, b: bold })
            : t.rich('deleteLeafBody', { key: identifier, title, b: bold })}
        </p>

        <ul className="flex flex-col gap-2 rounded-(--radius-card) bg-(--el-surface-soft) p-(--spacing-card-padding) text-sm text-(--el-text-secondary)">
          {preview && cascade ? (
            <>
              <li className="flex gap-2">
                <ListTree className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
                <span>
                  {t.rich('deleteCascadeCount', {
                    count: preview.descendantCount,
                    breakdown,
                    b: bold,
                  })}
                </span>
              </li>
              <li className="flex gap-2">
                <Clock className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
                <span>{t.rich('deleteHistoryRow', { count: preview.totalCount, b: bold })}</span>
              </li>
              <li className="flex gap-2">
                <Link2 className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
                <span>{t.rich('deleteLinksRow', { b: bold })}</span>
              </li>
            </>
          ) : (
            <li className="flex gap-2">
              <Clock className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
              <span>{t('deleteLeafHistoryRow')}</span>
            </li>
          )}
        </ul>

        {/* Archive — the reversible alternative, inside the same dialog (the
            mint/success cue, a deliberate contrast to the red delete). */}
        <div className="flex gap-2 rounded-(--radius-card) bg-(--el-tint-mint) p-(--spacing-card-padding) text-sm text-(--el-text-secondary)">
          <Archive className="mt-0.5 size-4 shrink-0 text-(--el-success)" aria-hidden />
          <span>
            {t('archiveAltLead')} {t.rich('archiveAltBody', { b: bold })}{' '}
            <button
              type="button"
              onClick={onArchiveInstead}
              disabled={deleting}
              className="inline-flex items-center gap-1 font-medium text-(--el-link) underline-offset-2 hover:underline focus-visible:rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-50"
            >
              <Archive className="size-3.5" aria-hidden />
              {t('archiveInstead')}
            </button>
          </span>
        </div>

        {failed ? (
          <div
            role="alert"
            className="flex gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-tint-rose) p-(--spacing-card-padding) text-sm text-(--el-text-strong)"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-danger)" aria-hidden />
            <span>{t('deleteErrorBody')}</span>
          </div>
        ) : null}

        <Modal.Footer>
          <Button type="button" variant="secondary" onClick={onClose} disabled={deleting}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={deleting || !preview}
            leftIcon={preview ? <Trash2 className="size-4" aria-hidden /> : undefined}
            onClick={() => void confirm()}
          >
            {failed ? t('tryAgain') : confirmLabel}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}
