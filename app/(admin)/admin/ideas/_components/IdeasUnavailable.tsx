'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * Design § Ideas Panel 3c — the idea store could not be read. The console's
 * error card with Retry and NO rows; Retry re-runs the server read.
 */
export function IdeasUnavailable() {
  const t = useTranslations('platformAdmin.ideas.error');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="ideas-unavailable"
      title={t('title')}
      description={t('body')}
      retryLabel={t('retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
