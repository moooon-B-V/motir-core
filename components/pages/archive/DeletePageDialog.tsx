'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, History, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { DeletePageResultDto } from '@/lib/dto/pages';
import { deletePageRequest } from './archiveClient';

// THE PERMANENT-DELETE CONFIRM (Story MOTIR-5755 · MOTIR-7423) — design
// MOTIR-7416, surface 7, after `DeleteWorkItemDialog`'s `archived` variant. Used
// from the archived page's banner here and from a row of the Archived pages
// list (MOTIR-7424); only a Manager (`page:delete`) ever reaches it.
//
// `Modal` sm as an `alertdialog`, focus on Cancel. The body says what goes —
// the page, its sub-pages and every saved version and image — and that it
// cannot be undone; the impact box states the number of pages and that they are
// all already archived (a page archive takes its whole live sub-tree, so the
// set holds no live page). The action is the DANGER button, stating the
// magnitude ("Delete 5 pages" / "Delete page") — `bg-(--el-danger)` with
// `--el-danger-text`, that ink's one legal pairing.
//
// While it runs, Cancel and × are disabled: the delete is atomic and cannot be
// abandoned half way. A failure keeps the dialog open with a callout saying
// nothing was deleted, and the action retries. A 409 `PAGE_NOT_ARCHIVED` (it was
// restored in another tab) says so in the dialog, disables the action and asks
// the surface to re-read (`onStale`). Success toasts "Deleted …" and hands the
// answer to `onDeleted` — the page navigates away, the list drops the row.

export interface DeletePageDialogProps {
  page: { id: string; title: string };
  /** The sub-pages that go with it — the rest of its archive set. */
  subPageCount: number;
  onClose: () => void;
  onDeleted: (result: DeletePageResultDto) => void;
  /** It is no longer archived (restored elsewhere): the surface re-reads. */
  onStale?: () => void;
}

const bold = (chunks: ReactNode) => (
  <strong className="font-semibold text-(--el-text-strong)">{chunks}</strong>
);

export function DeletePageDialog({
  page,
  subPageCount,
  onClose,
  onDeleted,
  onStale,
}: DeletePageDialogProps) {
  const t = useTranslations('pages.archive');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<'failed' | 'notArchived' | null>(null);
  // A double click lands twice in one render, before `deleting` disables the action.
  const inFlight = useRef(false);
  const title = page.title;
  const total = subPageCount + 1;
  const single = subPageCount === 0;

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    setError(null);
    const outcome = await deletePageRequest(page.id);
    inFlight.current = false;
    setDeleting(false);
    if (outcome.ok) {
      toast({ variant: 'success', title: t('delete.deleted', { title, count: subPageCount }) });
      onDeleted(outcome.result);
      return;
    }
    if (outcome.kind === 'notArchived') {
      setError('notArchived');
      onStale?.();
      return;
    }
    setError('failed');
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onClose();
      }}
      size="sm"
      role="alertdialog"
      title={t('delete.title', { title })}
    >
      <Modal.Body className="gap-4" aria-busy={deleting || undefined}>
        <p className="text-sm text-(--el-text-secondary)">
          {single
            ? t.rich('delete.bodyOne', { title, b: bold })
            : t.rich('delete.body', { title, count: subPageCount, b: bold })}
        </p>
        <ul className="flex flex-col gap-2 rounded-(--radius-card) bg-(--el-surface-soft) p-(--spacing-card-padding) text-sm text-(--el-text-secondary)">
          <li className="flex gap-2">
            <Archive className="mt-0.5 size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            <span>
              {single
                ? t.rich('delete.impactOne', { b: bold })
                : t.rich('delete.impact', { total, b: bold })}
            </span>
          </li>
          <li className="flex gap-2">
            <History className="mt-0.5 size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            <span>{t('delete.history')}</span>
          </li>
        </ul>
        {error ? (
          <div
            role="alert"
            className="flex gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) p-(--spacing-card-padding) text-sm text-(--el-danger-surface-text)"
          >
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-(--el-danger-on-surface)"
              aria-hidden
            />
            <span>
              {error === 'notArchived'
                ? t('refusal.notArchived', { title })
                : t('delete.failed', { title })}
            </span>
          </div>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onClose} disabled={deleting} autoFocus>
          {tc('cancel')}
        </Button>
        <Button
          type="button"
          variant="danger"
          loading={deleting}
          disabled={error === 'notArchived'}
          leftIcon={<Trash2 className="size-4" aria-hidden />}
          onClick={() => void confirm()}
        >
          {deleting
            ? t('delete.deleting')
            : single
              ? t('delete.actionOne')
              : t('delete.action', { total })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
