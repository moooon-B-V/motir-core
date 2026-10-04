'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * Model lists Panel 11 — motir-ai could not be reached, so the planning list is
 * not drawn half-known: the console's error card with Retry, and no rows.
 */
export function PlannerModelListUnavailable() {
  const t = useTranslations('platformAdmin');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="planner-model-list-unavailable"
      title={t('planningList.unavailable.title')}
      description={t('planningList.unavailable.body')}
      retryLabel={t('modelLists.retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
