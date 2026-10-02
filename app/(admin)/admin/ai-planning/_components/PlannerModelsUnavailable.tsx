'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * Panel 9 — motir-ai could not be reached. The console's error card with Retry
 * and NO rows, so staff never read a guessed value. Retry re-runs the server
 * read; nothing here holds settings state.
 */
export function PlannerModelsUnavailable() {
  const t = useTranslations('platformAdmin.aiPlanning');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="ai-planning-unavailable"
      title={t('unavailable.title')}
      description={t('unavailable.body')}
      retryLabel={t('unavailable.retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
