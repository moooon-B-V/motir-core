import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Archive } from 'lucide-react';

// The archived-state banner — the PRESENTATIONAL half of the detail page's
// archived banner (Story 2.9 · 2.9.6), extracted so every surface that shows an
// archived work item speaks ONE archived language (bug MOTIR-2050, which added
// the second surface: the quick-view peek).
//
// Design: design/work-items/detail-archived.mock.html + design-notes "Archived
// banner on the detail page". Tone is neutral/factual — NOT a tint, NOT danger:
// `--el-surface-soft` fill + `--el-border` hairline + `--radius-card`, with the
// archive glyph and the copy carrying the meaning (state in text + glyph, never
// hue — colour-blind-safe).
//
// The MUTATION stays with the consumer: the detail page's ArchivedBanner passes
// its Restore button in as `action` (and turns the "Restore it to bring it back."
// tail on with `restorable`), while the read-only peek passes neither. This
// component itself is pure — no router, no toast, no fetch — so it renders in any
// surface without dragging a write path along.
export interface ArchivedNoticeProps {
  /**
   * Who archived it (latest `'archived'` revision), or `null` when unresolved —
   * the meta line falls back to a generic "a former member" so the sentence stays
   * grammatical.
   */
  archivedByName: string | null;
  /** Pre-formatted archived date ("Jun 15, 2026"), formatted server-side. */
  archivedAtLabel: string;
  /**
   * Add the "Restore it to bring it back." tail — only for a viewer who actually
   * can (the detail banner's `canEdit`). A surface with no restore path (the
   * read-only peek) leaves it off rather than promising an action it doesn't offer.
   */
  restorable?: boolean;
  /** The restore affordance, when the surface offers one. */
  action?: ReactNode;
  /** Test hook — each surface names its own instance (a peek can open OVER the detail page). */
  testId?: string;
  className?: string;
}

export function ArchivedNotice({
  archivedByName,
  archivedAtLabel,
  restorable = false,
  action,
  testId = 'archived-banner',
  className,
}: ArchivedNoticeProps) {
  const t = useTranslations('issueViews');
  return (
    <div
      role="status"
      data-testid={testId}
      className={`flex items-start gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-3.5 py-3${
        className ? ` ${className}` : ''
      }`}
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
          {restorable ? <> {t('archivedBannerRestoreTail')}</> : null}
        </span>
      </div>
      {action}
    </div>
  );
}
