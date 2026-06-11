'use client';

import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

// Route error boundary for the Fields settings page — the 5.3.4 mockup's
// load-failure panel: ErrorState ("Couldn't load fields") + Retry, which
// re-renders the server segment via Next's reset().

export default function FieldsSettingsError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('settings.customFields');
  return (
    <div className="mx-auto max-w-[42rem]">
      <ErrorState title={t('errorTitle')} description={t('errorDescription')} retry={reset} />
    </div>
  );
}
