'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeft, CircleSlash, ExternalLink } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';

// NOTHING LEFT TO CONNECT (Story MOTIR-8216 · MOTIR-8223), built to
// `design/github/github--multi-org-account.mock.html` Panel A4.
//
// ⚠️ IT REPLACES THE LIST, THE SEARCH AND THE SELECT-ALL. A search box over
// nothing to find, or a checkbox over nothing to tick, would be the empty list
// this panel exists not to be. The counts are counts and nothing more:
// `Connected to other organisations` never becomes a name.

export interface NoReposLeftPanelProps {
  accountLogin: string;
  connectedHere: number;
  connectedElsewhere: number;
  /** The account's installation settings on GitHub — its repository access. */
  manageUrl: string;
  onChooseAnother: () => void;
}

export function NoReposLeftPanel({
  accountLogin,
  connectedHere,
  connectedElsewhere,
  manageUrl,
  onChooseAnother,
}: NoReposLeftPanelProps) {
  const t = useTranslations('github.picker.noneLeft');
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <CircleSlash className="h-8 w-8 text-(--el-icon-muted)" aria-hidden />
      <h3 className="font-sans text-base font-semibold text-(--el-text)">
        {t('title', { account: accountLogin })}
      </h3>
      <p className="max-w-[28rem] font-sans text-sm text-(--el-text-secondary)">
        {t('body', { account: accountLogin })}
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <div className="flex min-w-[9rem] flex-col items-center gap-0.5 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg) px-(--spacing-card-padding) py-3">
          <span className="font-sans text-xl font-semibold text-(--el-text)">{connectedHere}</span>
          <span className="font-sans text-xs text-(--el-text-secondary)">{t('connectedHere')}</span>
        </div>
        <div className="flex min-w-[9rem] flex-col items-center gap-0.5 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg) px-(--spacing-card-padding) py-3">
          <span className="font-sans text-xl font-semibold text-(--el-text)">
            {connectedElsewhere}
          </span>
          <span className="font-sans text-xs text-(--el-text-secondary)">
            {t('connectedElsewhere')}
          </span>
        </div>
      </div>
      <p className="max-w-[28rem] font-sans text-sm text-(--el-text-secondary)">{t('hint')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onChooseAnother}>
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('chooseAnother')}
        </Button>
        <a
          href={manageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          {t('manageOnGithub')}
        </a>
      </div>
    </div>
  );
}
