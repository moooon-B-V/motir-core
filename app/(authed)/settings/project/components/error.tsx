'use client';

import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

// Route error boundary for the Components settings page — the 5.4.7 mockup's
// load-failure panel: ErrorState ("Couldn't load components") + Retry, which
// re-renders the server segment via Next's reset().

export default function ComponentsSettingsError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('settings.components');
  return (
    <div className="mx-auto max-w-[42rem]">
      <ErrorState title={t('errorTitle')} description={t('errorDescription')} retry={reset} />
    </div>
  );
}
