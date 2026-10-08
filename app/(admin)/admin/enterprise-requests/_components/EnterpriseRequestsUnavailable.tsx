'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * Design § Enterprise requests Panel 3c — the requests could not be read. The
 * console's error card with Retry and NO rows; Retry re-runs the server read.
 */
export function EnterpriseRequestsUnavailable() {
  const t = useTranslations('platformAdmin.enterpriseRequests.error');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="enterprise-requests-unavailable"
      title={t('title')}
      description={t('body')}
      retryLabel={t('retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
