'use client';

import { useTransition } from 'react';
import { ServerErrorView } from '@/components/errors/ServerErrorView';
import { useServerErrorCopy } from '@/components/errors/useServerErrorCopy';
import { useReportCaughtError } from '@/lib/monitoring/reportCaughtError';

// STATE 2 of the server-error page (MOTIR-6855 · design MOTIR-6854,
// `design/shell/server-error.mock.html` panel 2): a segment BELOW the root threw
// and no nearer boundary caught it — above all `app/(authed)/layout.tsx` itself,
// which `app/(authed)/error.tsx` cannot catch. That is Bug MOTIR-6776's actual
// event: the shell's `projectsService.listProjects` read hit a P2028 stall and
// the tab was left empty.
//
// It renders under the ROOT layout alone — appearance tokens and the locale, no
// rail, no top bar — so it is a full page the way `app/not-found.tsx` is, and it
// carries its own way out (`showHome`). Retry is `unstable_retry`; why, and why
// `notFound()` / `redirect()` never land here, is written in
// `app/(authed)/error.tsx`.

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useReportCaughtError(error, 'app');
  const copy = useServerErrorCopy('app');
  const [retryPending, startRetry] = useTransition();

  return (
    <main className="mx-auto flex min-h-dvh max-w-[48rem] flex-col items-center justify-center px-(--spacing-lg) py-(--spacing-2xl)">
      <ServerErrorView
        copy={copy}
        digest={error.digest}
        onRetry={() => startRetry(() => unstable_retry())}
        retryPending={retryPending}
        showHome
      />
    </main>
  );
}
