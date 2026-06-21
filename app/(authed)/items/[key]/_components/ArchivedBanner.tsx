'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Archive, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import {
  unarchiveWorkItem,
  WorkItemActionError,
} from '@/components/issues/actions/workItemActionsClient';

// The archived banner on the work-item detail page (Story 2.9 · Subtask 2.9.6),
// per design/work-items/detail-archived.mock.html + design-notes "Archived
// banner on the detail page". An archived item's detail page RENDERS (the read
// `getIssueDetail → findByIdentifier` does NOT filter `archivedAt`), so this
// banner is the page's archived-state signal — the FIRST element of the main
// column, above Description. Tone is neutral/factual (NOT a tint, NOT danger):
// `--el-surface-soft` fill + `--el-border` hairline, the archive glyph + copy
// carry the meaning (colour-blind-safe — state in text + glyph, never hue).
//
// It is a CLIENT ISLAND because Restore mutates: it POSTs the SAME
// `unarchiveWorkItem` (`DELETE /api/work-items/[id]/archive`, `canEdit`-gated)
// the 2.9.3 list view uses — no new path. Per the page-state-after-mutation
// contract, the detail page is SERVER-rendered, so on the authoritative
// unarchive 200 we `router.refresh()`: the server re-reads the now-active item
// and the banner + eyebrow chip disappear. A success Toast reuses the list
// view's `restoredToast` ("{key} restored") so the two surfaces share one
// vocabulary; an error keeps the banner and surfaces the archive-error toast.
//
// Restore is `canEdit`-gated: a browse-only viewer sees the banner WITHOUT the
// button (hidden, never shown-disabled — the WorkItemActionsMenu pattern,
// mirroring the list view's dropped Restore column), and the meta line drops its
// "Restore it to bring it back." tail (that viewer can't restore).

export interface ArchivedBannerProps {
  /** The work-item id — the target of the `unarchiveWorkItem` restore call. */
  itemId: string;
  /** The `PROD-N` key — the Restore `aria-label` ("Restore {key}"). */
  identifier: string;
  /**
   * Who archived it (latest `'archived'` revision), or `null` when unresolved —
   * the meta line falls back to a generic "a former member" so the sentence
   * stays grammatical.
   */
  archivedByName: string | null;
  /** Pre-formatted archived date ("Jun 15, 2026"), formatted server-side. */
  archivedAtLabel: string;
  /** Whether the viewer may restore — drops the Restore button + tail when false. */
  canEdit: boolean;
}

export function ArchivedBanner({
  itemId,
  identifier,
  archivedByName,
  archivedAtLabel,
  canEdit,
}: ArchivedBannerProps) {
  const t = useTranslations('issueViews');
  const ta = useTranslations('workItemActions');
  const { toast } = useToast();
  const router = useRouter();
  const [restoring, setRestoring] = useState(false);

  const onRestore = useCallback(async () => {
    setRestoring(true);
    try {
      await unarchiveWorkItem(itemId);
      // Page-state-after-mutation: the detail page is server-rendered, so the
      // refresh re-reads the now-active item and clears the banner + eyebrow chip.
      toast({ variant: 'success', title: ta('restoredToast', { key: identifier }) });
      router.refresh();
    } catch (err) {
      void (err instanceof WorkItemActionError);
      toast({
        variant: 'error',
        title: ta('restoreErrorTitle'),
        description: ta('archiveErrorBody'),
      });
      // Nothing changed server-side — the banner stays so the viewer can retry.
      setRestoring(false);
    }
  }, [itemId, identifier, router, toast, ta]);

  return (
    <div
      role="status"
      data-testid="archived-banner"
      className="flex items-start gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-3.5 py-3"
    >
      <Archive className="mt-0.5 h-[18px] w-[18px] shrink-0 text-(--el-text-muted)" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-sans text-sm font-semibold text-(--el-text-strong)">
          {t('archivedBannerHeadline')}
        </span>
        <span className="font-sans text-[13px] text-(--el-text-secondary)">
          {t.rich('archivedBannerMeta', {
            name: archivedByName ?? t('archivedByUnknownActor'),
            date: archivedAtLabel,
            strong: (chunks: ReactNode) => (
              <span className="font-medium text-(--el-text-strong)">{chunks}</span>
            ),
          })}
          {canEdit ? <> {t('archivedBannerRestoreTail')}</> : null}
        </span>
      </div>
      {canEdit ? (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          loading={restoring}
          leftIcon={restoring ? undefined : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
          aria-label={t('archivedRestoreAria', { key: identifier })}
          onClick={() => void onRestore()}
        >
          {restoring ? t('archivedRestoring') : t('archivedRestore')}
        </Button>
      ) : null}
    </div>
  );
}
