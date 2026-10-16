'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * Panel 12 — the setting or its readiness could not be read. The console's error
 * card with Retry and NO switch and NO verdict, so a superadmin never reads a
 * guessed state. Retry re-runs the server read; nothing here holds state.
 */
export function FleetSettingsUnavailable() {
  const t = useTranslations('platformAdmin.fleetSettings');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ErrorState
      data-testid="fleet-settings-unavailable"
      title={t('unavailable.title')}
      description={t('unavailable.body')}
      retryLabel={t('unavailable.retry')}
      retry={() => startTransition(() => router.refresh())}
      retryPending={pending}
    />
  );
}
