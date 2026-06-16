'use client';

import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';

// The square's fetch-error state (Story 6.13 · Subtask 6.13.6 · design Panel 5).
// A route-segment error boundary: if the server read of the directory throws
// something unrecoverable (not a stale cursor / unknown category, which
// `loadSquare` handles), this renders the recoverable ErrorState with a "Try
// again" that re-runs the server component. Client component (error boundaries
// must be), inside the marketing chrome from the layout.

export default function ExploreError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('projectSquare');
  return (
    <div className="py-10">
      <ErrorState
        title={t('errorTitle')}
        description={t('errorBody')}
        error={error}
        retry={reset}
      />
    </div>
  );
}
