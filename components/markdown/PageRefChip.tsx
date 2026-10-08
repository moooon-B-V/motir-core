'use client';

import Link from 'next/link';
import { FileText, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { PageRefSummaryDto } from '@/lib/dto/pages';

// The LIVE page chip (Story MOTIR-7694 · MOTIR-7698), per
// `design/work-items/internal-links--page-tag.mock.html` panels 6–7. A
// `[<title>](motir-page:<id>)` token in a Description or Explanation renders
// inline as this chip, from the summary the surface resolved — never from the
// token's stored label, so a rename shows the new title and a page the reader
// may not see shows nothing of itself.
//
//  · available   → a link to the page (same tab): page glyph + CURRENT title;
//  · unavailable → a non-interactive span: lock glyph + "Page unavailable". One
//    state for three causes (no `page:view`, archived, deleted), and the title
//    appears nowhere — not in text, `title`, sr-only copy or a data attribute.
//
// Styled as `.page-chip` in markdown-editor.css, beside `.mention-chip` and
// `.wi-chip`: `--el-tint-sky` with `--el-text-strong`, `--radius-badge`,
// `--spacing-chip-x/y`; the unavailable state is `--el-muted` with
// `--el-text-secondary`.

export function PageRefChip({
  summary,
  untitled,
}: {
  /** The resolved summary for this id; undefined renders as unavailable. */
  summary: PageRefSummaryDto | undefined;
  /** The name an untitled page reads by, when the host already holds it. */
  untitled?: string;
}) {
  const t = useTranslations('markdownEditor');

  if (!summary || summary.state === 'unavailable') {
    return (
      <span className="page-chip is-unavailable">
        <Lock className="page-chip-glyph" aria-hidden />
        <span className="page-chip-title">{t('pageUnavailable')}</span>
      </span>
    );
  }

  return (
    <Link href={`/pages/${encodeURIComponent(summary.id)}`} className="page-chip">
      <FileText className="page-chip-glyph" aria-hidden />
      <span className="page-chip-title">{summary.title || untitled || t('pageUntitled')}</span>
    </Link>
  );
}
