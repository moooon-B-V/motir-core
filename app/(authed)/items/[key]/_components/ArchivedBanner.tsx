'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ArchivedNotice } from '@/components/issues/ArchivedNotice';
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
//
// MOTIR-2050: the banner's MARKUP + copy now live in the shared, presentational
// `ArchivedNotice` (so the quick-view peek shows the same archived language, not
// a second one). This file keeps what is detail-page-specific: the Restore
// mutation, its toasts, and the server-refresh that clears the banner.

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
    <ArchivedNotice
      archivedByName={archivedByName}
      archivedAtLabel={archivedAtLabel}
      restorable={canEdit}
      action={
        canEdit ? (
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
        ) : null
      }
    />
  );
}
