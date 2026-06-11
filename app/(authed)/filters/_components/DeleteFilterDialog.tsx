'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { deleteFilter, getDependents, type SavedFilterSummaryDto } from './savedFiltersClient';

// Delete-with-dependents confirm (Story 6.2 · Subtask 6.2.4) — the Cloud-style
// warning that NAMES the dependents before cascading, per
// design/work-items/saved-filters.mock.html panel 4. The dependents read
// (6.2.1 getDependents) enumerates subscriptions now (6.2.5); the 6.3 widget
// line joins in later. Consequences are stated in text (never colour-only);
// the Modal is focus-trapped and the danger action is explicit.

export function DeleteFilterDialog({
  projectKey,
  filter,
  onClose,
  onDeleted,
}: {
  projectKey: string;
  filter: SavedFilterSummaryDto;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('savedFilters');
  const { toast } = useToast();

  const [subscriptionCount, setSubscriptionCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    getDependents(projectKey, filter.id)
      .then((d) => {
        if (active) setSubscriptionCount(d.subscriptionCount);
      })
      .catch(() => {
        if (active) setSubscriptionCount(0);
      });
    return () => {
      active = false;
    };
  }, [projectKey, filter.id]);

  async function confirm() {
    setDeleting(true);
    try {
      await deleteFilter(projectKey, filter.id);
      toast({ variant: 'success', title: t('deleteDialog.deletedToast') });
      onDeleted();
    } catch {
      toast({
        variant: 'error',
        title: t('deleteDialog.errorTitle'),
        description: t('deleteDialog.errorGeneric'),
      });
      setDeleting(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('deleteDialog.title')}
      size="md"
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-3">
          <span
            aria-hidden
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-rose)"
          >
            <TriangleAlert className="size-4 text-(--el-text-strong)" />
          </span>
          <div className="flex flex-col gap-1 text-sm text-(--el-text-secondary)">
            <p>{t('deleteDialog.body', { name: filter.name })}</p>
            <p>
              {subscriptionCount && subscriptionCount > 0
                ? t('deleteDialog.subscriptions', { count: subscriptionCount })
                : t('deleteDialog.noDependents')}
            </p>
          </div>
        </div>

        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={deleting}>
            {t('deleteDialog.cancel')}
          </Button>
          <Button type="button" variant="danger" loading={deleting} onClick={() => void confirm()}>
            {t('deleteDialog.confirm')}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}
