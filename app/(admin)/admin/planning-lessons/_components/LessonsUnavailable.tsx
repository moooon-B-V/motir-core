'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * Panel 3c — motir-ai could not be reached. The console's error card with Retry
 * and NO rows; Retry re-runs the server read.
 */
export function LessonsUnavailable() {
  const t = useTranslations('platformAdmin.lessons');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="planning-lessons-unavailable"
      title={t('unavailable.title')}
      description={t('unavailable.body')}
      retryLabel={t('unavailable.retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
