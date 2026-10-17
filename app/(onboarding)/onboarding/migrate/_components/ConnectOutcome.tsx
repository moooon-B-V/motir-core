'use client';

import { useTranslations } from 'next-intl';
import { Check, Info } from 'lucide-react';
import { WarmButton as Button } from '@/components/onboarding/layout';
import { cn } from '@/lib/utils/cn';
import type { LinkResult } from './useLinkInstallation';

// WHAT A LINK DID, said on the connect step (Story MOTIR-8245 · MOTIR-8764),
// built on `design/onboarding-migrate/` Revision 8, panels 2s.i–2s.vii.
//
// PRESENTATIONAL, and benign throughout: a refusal is a sky-tinted notice with
// an `Info` glyph, never a danger tone, and no sentence blames the person. Each
// outcome has exactly ONE next action, and only one of them lives here — the
// retry of a write that did not land. The others are already on screen where
// the outcome sits: Continue (linked), Connect N on the refreshed picker (taken,
// the two 422s), the install row (no longer accessible, not an admin).

export function ConnectOutcome({
  result,
  onRetry,
}: {
  result: LinkResult;
  /** Post the same selection again — only `failed` offers it. */
  onRetry?: () => void;
}) {
  const t = useTranslations('onboardingMigrate.connect.existing');

  switch (result.kind) {
    case 'linked':
      return (
        <Notice
          tone="success"
          title={t('outcome.linkedTitle')}
          hint={t('outcome.linkedHint')}
          testId="link-outcome-linked"
        />
      );
    case 'taken':
      return (
        <Notice
          title={t('outcome.takenTitle')}
          hint={t('outcome.takenHint', {
            repos: result.repos.map((r) => r.fullName).join(', '),
          })}
          testId="link-outcome-taken"
        />
      );
    case 'not_accessible':
      return (
        <Notice
          title={t('outcome.notAccessibleTitle')}
          hint={t('outcome.notAccessibleHint')}
          testId="link-outcome-not-accessible"
        />
      );
    case 'not_admin':
      return (
        <Notice
          title={t('outcome.notAdminTitle')}
          hint={t('outcome.notAdminHint')}
          testId="link-outcome-not-admin"
        />
      );
    case 'selection_required':
      return (
        <Notice
          title={t('outcome.selectionRequiredTitle')}
          hint={t('outcome.selectionRequiredHint')}
          testId="link-outcome-selection-required"
        />
      );
    case 'not_visible':
      return (
        <Notice
          title={t('outcome.notVisibleTitle')}
          hint={t('outcome.notVisibleHint')}
          testId="link-outcome-not-visible"
        />
      );
    case 'failed':
      return (
        <div data-testid="link-outcome-failed" className="grid gap-3">
          <Notice title={t('loadErrorTitle')} hint={t('loadErrorHint')} />
          {onRetry ? (
            <span>
              <Button variant="secondary" size="md" onClick={onRetry}>
                {t('retryCta')}
              </Button>
            </span>
          ) : null}
        </div>
      );
  }
}

function Notice({
  title,
  hint,
  tone = 'info',
  testId,
}: {
  title: string;
  hint: string;
  tone?: 'info' | 'success';
  testId?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'flex items-start gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)',
        tone === 'success' ? 'bg-(--el-tint-mint)' : 'bg-(--el-tint-sky)',
      )}
    >
      {tone === 'success' ? (
        <Check className="mt-0.5 size-4 flex-none" aria-hidden />
      ) : (
        <Info className="mt-0.5 size-4 flex-none" aria-hidden />
      )}
      <span className="grid gap-0.5">
        <span className="font-semibold">{title}</span>
        <span className="leading-normal">{hint}</span>
      </span>
    </div>
  );
}
